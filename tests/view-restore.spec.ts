/**
 * 見ていた画面が残ること（URL・戻る／進む・リロード）を実際のブラウザで確かめる。
 *
 * **番頭ホストもLLMも立てない**——ビルド済みのUIを配る小さなサーバと、Banto の
 * プロトコルを喋るだけの偽ホストを立てる（`chat-ux.spec.ts` と同じ作り）。
 * 見たいのは「どこを見ていたかが残るか」だけなので、これで足りる。
 *
 * 前提: `npm run build:web` 済み（packages/banto-web/dist）。
 * 実行:  npx playwright test tests/view-restore.spec.ts
 */

import { test, expect, type Page } from "@playwright/test";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.join(here, "..", "packages", "banto-web", "dist");
const THREAD_A = "t-a";
const THREAD_B = "t-b";
/** 会話Aのキャンバスに最初から開いているタブ2枚。 */
const TAB_HELLO = "tab-hello";
const TAB_CLOCK = "tab-clock";

const thread = (threadId: string, title: string, isDefault: boolean): Record<string, unknown> => ({
  threadId,
  title,
  sessionId: "fake",
  isDefault,
  // ADR-0017 決定77: 既定の宛先＝幹。それ以外は枝（還す条件を持って生まれる）
  kind: isDefault ? "trunk" : "branch",
  ...(isDefault ? {} : { returnCondition: `${title} の結論が出たら`, openedBy: "po", openReason: "往復が続く" }),
  state: "open",
  streaming: false,
  model: { provider: "huihui", id: "qwen3.6-35b", vision: false, contextWindow: 200000 },
});

/**
 * キャンバスに出せるGUI（カタログ）。**見ているのはタブの出し入れだけ**なので、
 * 実体は解決表にある適当な2つで足りる（データ取得は 404 になるが、この試験は中身を見ない）。
 */
const CATALOG = [
  {
    kind: "demo.hello",
    title: "デモ",
    description: "テスト用",
    component: "MemoryViewer",
    category: "テスト",
    module: "demo",
    endpoint: "/api/demo",
  },
  {
    kind: "demo.clock",
    title: "時計",
    description: "テスト用",
    component: "SkillViewer",
    category: "テスト",
    module: "demo",
    endpoint: "/api/demo",
  },
];

/** 設定の区画（settings.describe の返り）。区画が残るかを見るので2つ要る。 */
const SETTINGS_SECTIONS = [
  {
    id: "general",
    title: "全般",
    origin: "core",
    originTitle: "Banto 本体",
    fields: [{ key: "name", label: "名前", type: "text" }],
    values: { name: "番頭" },
  },
  {
    id: "notify",
    title: "通知",
    origin: "core",
    originTitle: "Banto 本体",
    fields: [{ key: "enabled", label: "通知する", type: "boolean" }],
    values: { enabled: true },
  },
];

/** 偽ホスト。UIを配り、`/ws` で Banto のイベントを流す。 */
class FakeHost {
  private constructor(
    private readonly server: http.Server,
    private readonly wss: WebSocketServer,
    readonly port: number
  ) {}

  private sockets = new Set<WebSocket>();
  /** クライアントから届いたメッセージ（canvas_switch が飛んだかを見る）。 */
  readonly received: Record<string, unknown>[] = [];
  /** 会話ごとのキャンバス。ホストが真実を持つ側なので、ここで動かす。 */
  private canvas: Record<string, { tabs: Array<Record<string, unknown>>; activeTabId?: string }> = {
    [THREAD_A]: {
      tabs: [
        { id: TAB_HELLO, kind: "demo.hello", title: "デモ", params: {}, rev: 1 },
        { id: TAB_CLOCK, kind: "demo.clock", title: "時計", params: {}, rev: 1 },
      ],
      activeTabId: TAB_HELLO,
    },
    [THREAD_B]: { tabs: [], activeTabId: undefined },
  };

  static async start(): Promise<FakeHost> {
    const server = http.createServer((req, res) => {
      const url = (req.url ?? "/").split("?")[0] ?? "/";
      // 設定モジュールのデータAPI（決定25の人側の経路）
      if (url === `/api/settings/tools/${encodeURIComponent("settings.describe")}`) {
        res.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            content: [{ type: "text", text: "2 区画" }],
            details: { sections: SETTINGS_SECTIONS, storedAt: "/tmp/banto/settings.json" },
          })
        );
        return;
      }
      const rel = url === "/" ? "index.html" : url.replace(/^\//, "");
      const file = path.join(WEB_DIST, rel);
      if (!file.startsWith(WEB_DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end("not found");
        return;
      }
      const type = file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : file.endsWith(".html")
            ? "text/html"
            : "application/octet-stream";
      res.writeHead(200, { "Content-Type": type }).end(fs.readFileSync(file));
    });
    const wss = new WebSocketServer({ server, path: "/ws" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const host = new FakeHost(server, wss, port);

    wss.on("connection", (socket) => {
      host.sockets.add(socket);
      socket.on("close", () => host.sockets.delete(socket));
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as Record<string, unknown>;
        host.received.push(message);
        // タブの活性の真実はホスト側。切替を受けたら配り直す（本物と同じ往復）
        if (message["type"] === "canvas_switch") {
          host.switchTab(String(message["threadId"]), String(message["tabId"]));
        }
        // POがカタログから開いた経路。ホストは新しいタブを開いて活性にする
        if (message["type"] === "canvas_open") {
          const kind = String(message["kind"]);
          host.openTab(String(message["threadId"]), {
            id: `tab-open-${host.received.length}`,
            kind,
            title: `開いた:${kind}`,
            params: {},
            rev: 1,
          });
        }
      });
      host.sendTo(socket, {
        type: "welcome",
        sessionId: "fake",
        threads: [thread(THREAD_A, "会話A", true), thread(THREAD_B, "会話B", false)],
        defaultThreadId: THREAD_A,
        tools: [],
        catalog: CATALOG,
        modules: [
          { name: "settings", title: "設定", description: "設定", baseUrl: "/api/settings" },
          { name: "demo", title: "デモ", description: "デモ", baseUrl: "/api/demo" },
        ],
      });
      for (const threadId of [THREAD_A, THREAD_B]) {
        host.sendTo(socket, { type: "history", threadId, entries: [] });
        host.sendTo(socket, {
          type: "canvas_state",
          threadId,
          tabs: host.canvas[threadId]!.tabs,
          activeTabId: host.canvas[threadId]!.activeTabId,
        });
      }
    });
    return host;
  }

  private sendTo(socket: WebSocket, event: unknown): void {
    socket.send(JSON.stringify(event));
  }

  broadcast(event: Record<string, unknown>): void {
    for (const socket of this.sockets) this.sendTo(socket, event);
  }

  /** ホスト側でタブを切り替えて配り直す（POの操作でも番頭の操作でも同じ形）。 */
  switchTab(threadId: string, tabId: string): void {
    const canvas = this.canvas[threadId];
    if (!canvas || !canvas.tabs.some((t) => t["id"] === tabId)) return;
    canvas.activeTabId = tabId;
    this.broadcast({ type: "canvas_state", threadId, tabs: canvas.tabs, activeTabId: tabId });
  }

  /** 番頭が新しいGUIを開いたとき（POは押していない）。 */
  openTab(threadId: string, tab: Record<string, unknown>): void {
    const canvas = this.canvas[threadId];
    if (!canvas) return;
    canvas.tabs = [...canvas.tabs, tab];
    canvas.activeTabId = String(tab["id"]);
    this.broadcast({
      type: "canvas_state",
      threadId,
      tabs: canvas.tabs,
      activeTabId: canvas.activeTabId,
    });
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.close();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

let host: FakeHost;

test.beforeAll(async () => {
  if (!fs.existsSync(WEB_DIST)) {
    throw new Error(`UIのビルドが要る: ${WEB_DIST}（npm run build:web）`);
  }
  host = await FakeHost.start();
});

test.afterAll(async () => {
  await host.close();
});

test.beforeEach(async ({ page }) => {
  host.received.length = 0;
  host.switchTab(THREAD_A, TAB_HELLO);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`http://127.0.0.1:${host.port}/`);
  await page.waitForSelector(".chat-scroll");
});

/** URL のクエリ（どこを見ているかの真実）。 */
function query(page: Page): URLSearchParams {
  return new URLSearchParams(new URL(page.url()).search);
}

/** いま活性の会話タブ（活性の印はタブを包む側に付く）。 */
function activeThreadTitle(page: Page) {
  return page.locator(".thread-tab-wrap.is-active");
}

/**
 * URL のクエリが期待どおりになるまで待つ。
 *
 * ホスト起点で動いたとき（番頭がGUIを開いた等）、URL の差し替えは描画のあとの
 * 効果で走る——DOM が変わった瞬間にはまだ古いことがある。
 */
function expectQuery(page: Page, key: string) {
  return expect.poll(() => query(page).get(key), { timeout: 5000 });
}

test.describe("開いている会話", () => {
  test("選んだ会話が URL に残り、リロードしても戻ってくる", async ({ page }) => {
    await expect(activeThreadTitle(page)).toHaveText(/会話A/);

    await page.locator(".thread-tab", { hasText: "会話B" }).click();
    await expect(activeThreadTitle(page)).toHaveText(/会話B/);
    expect(query(page).get("thread")).toBe(THREAD_B);

    await page.reload();
    await page.waitForSelector(".chat-scroll");
    // 一番左（既定）の会話ではなく、見ていた会話に戻る
    await expect(activeThreadTitle(page)).toHaveText(/会話B/);
    await expectQuery(page, "thread").toBe(THREAD_B);
  });

  test("戻る／進むで会話を行き来できる", async ({ page }) => {
    await page.locator(".thread-tab", { hasText: "会話B" }).click();
    await expect(activeThreadTitle(page)).toHaveText(/会話B/);

    await page.goBack();
    await expect(activeThreadTitle(page)).toHaveText(/会話A/);

    await page.goForward();
    await expect(activeThreadTitle(page)).toHaveText(/会話B/);
  });

  test("URL の会話がもう開いていないときは既定へ落ちる（空の面を見せない）", async ({ page }) => {
    await page.goto(`http://127.0.0.1:${host.port}/?thread=t-none`);
    await page.waitForSelector(".chat-scroll");
    await expect(activeThreadTitle(page)).toHaveText(/会話A/);
    await expectQuery(page, "thread").toBe(THREAD_A);
  });
});

test.describe("キャンバスの開いているGUI", () => {
  test("タブを切り替えると URL に残り、リロードで同じタブに戻る", async ({ page }) => {
    await expect(page.locator(".canvas-tab.is-active")).toHaveText(/デモ/);

    await page.locator(".canvas-tab-label", { hasText: "時計" }).click();
    await expect(page.locator(".canvas-tab.is-active")).toHaveText(/時計/);
    expect(query(page).get("tab")).toBe(TAB_CLOCK);
    // 活性の真実はホスト側。押した結果はホストへ届いている（D3）
    expect(host.received.some((m) => m["type"] === "canvas_switch" && m["tabId"] === TAB_CLOCK)).toBe(
      true
    );

    await page.reload();
    await page.waitForSelector(".canvas-tab");
    await expect(page.locator(".canvas-tab.is-active")).toHaveText(/時計/);
  });

  test("戻るで前に見ていたタブへ帰る", async ({ page }) => {
    await page.locator(".canvas-tab-label", { hasText: "時計" }).click();
    await expect(page.locator(".canvas-tab.is-active")).toHaveText(/時計/);

    await page.goBack();
    await expect(page.locator(".canvas-tab.is-active")).toHaveText(/デモ/);
    // 戻るときも経路は同じ——ホストへ切替を投げ直す
    expect(host.received.some((m) => m["type"] === "canvas_switch" && m["tabId"] === TAB_HELLO)).toBe(
      true
    );
  });

  test("ホスト側で開かれたGUIには追随する（押し戻さない）", async ({ page }) => {
    await page.locator(".canvas-tab-label", { hasText: "時計" }).click();
    await expect(page.locator(".canvas-tab.is-active")).toHaveText(/時計/);

    // 番頭が別のGUIを開いた
    host.openTab(THREAD_A, { id: "tab-new", kind: "demo.hello", title: "番頭が開いた", params: {}, rev: 1 });
    await expect(page.locator(".canvas-tab.is-active")).toHaveText(/番頭が開いた/);
    await expectQuery(page, "tab").toBe("tab-new");

    // 押していない移動なので履歴には積まない——戻ると「時計」ではなく、その前の位置へ
    await page.goBack();
    await expect(page.locator(".canvas-tab.is-active")).toHaveText(/デモ/);
  });

  test("カタログから自分で開いたGUIは履歴に積む（戻ると前のタブへ）", async ({ page }) => {
    await expect(page.locator(".canvas-tab.is-active")).toHaveText(/デモ/);

    await page.locator(".canvas-catalog-btn").click();
    await page.locator(".catalog-item", { hasText: "時計" }).click();
    await expect(page.locator(".canvas-tab.is-active")).toHaveText(/開いた:demo.clock/);

    // 押して開いたものなので、戻ると開く前のタブへ帰る
    await page.goBack();
    await expect(page.locator(".canvas-tab.is-active")).toHaveText(/デモ/);
  });

  test("会話ごとに別のキャンバス。会話を移るとタブの記憶も入れ替わる", async ({ page }) => {
    await page.locator(".canvas-tab-label", { hasText: "時計" }).click();
    await expect(page.locator(".canvas-tab.is-active")).toHaveText(/時計/);

    await page.locator(".thread-tab", { hasText: "会話B" }).click();
    // 会話Bにはタブが無い。前の会話のタブを持ち越さない
    await expect(page.locator(".canvas-tab-empty")).toBeVisible();
    await expectQuery(page, "tab").toBe(null);

    await page.locator(".thread-tab", { hasText: "会話A" }).click();
    await expect(page.locator(".canvas-tab.is-active")).toHaveText(/時計/);
  });
});

test.describe("設定・履歴の面", () => {
  test("開いていた区画までリロードで戻ってくる", async ({ page }) => {
    await page.locator(".pin-tab[data-key='s']").click();
    await expect(page.locator(".sp-nav")).toBeVisible();
    expect(query(page).get("view")).toBe("settings");

    await page.locator(".sp-nav-btn", { hasText: "通知" }).click();
    await expect(page.locator(".sp-nav-on")).toHaveText(/通知/);
    expect(query(page).get("section")).toBe("notify");

    await page.reload();
    await expect(page.locator(".sp-nav-on")).toHaveText(/通知/);
  });

  test("戻るで設定から会話へ帰り、進むでまた設定へ", async ({ page }) => {
    await page.locator(".pin-tab[data-key='s']").click();
    await expect(page.locator(".sp-nav")).toBeVisible();

    await page.goBack();
    await expect(page.locator(".chat-scroll")).toBeVisible();

    await page.goForward();
    await expect(page.locator(".sp-nav")).toBeVisible();
  });

  test("Esc で会話へ戻る（面は履歴に積まれているので進むで開き直せる）", async ({ page }) => {
    await page.locator(".pin-tab[data-key='s']").click();
    await expect(page.locator(".sp-nav")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator(".chat-scroll")).toBeVisible();
    expect(query(page).get("view")).toBe(null);

    await page.goBack();
    await expect(page.locator(".sp-nav")).toBeVisible();
  });

  test("履歴の面もリロードで戻ってくる", async ({ page }) => {
    await page.locator(".pin-tab[data-key='h']").click();
    await expect(page.locator(".history-view")).toBeVisible();
    expect(query(page).get("view")).toBe("history");

    await page.reload();
    await expect(page.locator(".history-view")).toBeVisible();
  });
});
