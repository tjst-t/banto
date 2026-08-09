/**
 * task-0088 a1〜a4・a10〜a13: 幹と枝、器、判断待ちの出し方、作業する面（ADR-0017）。
 *
 * **番頭ホストもLLMも立てない**——ビルド済みのUIを配る小さなサーバと、Banto の
 * プロトコルを喋るだけの偽ホストを立てて、イベントをこちらから発火する。
 * 見たいのは「イベントが来たとき画面がどう振る舞うか」だけ。
 *
 * 前提: `npm run build:web` 済み（packages/banto-web/dist）。
 */

import { test, expect, type Page } from "@playwright/test";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.join(here, "..", "packages", "banto-web", "dist");

const TRUNK = "t-trunk";
const BRANCH = "t-branch";

/** 幹1本（畳めない）と枝1本（還す条件を持つ）。 */
const THREADS = [
  {
    threadId: TRUNK,
    title: "banto",
    kind: "trunk",
    sessionId: "fake",
    isDefault: true,
    state: "open",
    streaming: false,
    model: { provider: "huihui", id: "qwen3.6-35b", vision: false, contextWindow: 200000 },
  },
  {
    threadId: BRANCH,
    title: "間欠的に落ちる試験",
    kind: "branch",
    parentId: TRUNK,
    returnCondition: "再現条件が特定できたら",
    openedBy: "banto",
    openReason: "往復が続くので枝にする",
    sessionId: "fake",
    isDefault: false,
    state: "open",
    streaming: false,
    model: { provider: "huihui", id: "qwen3.6-35b", vision: false },
  },
];

/** 幹の中身。**開いた1行と還った1行だけ**が幹に載る（決定77）。 */
const TRUNK_HISTORY = [
  { role: "po", text: "ファイル面、開くとタブは増えるのに中身が出ないことがある" },
  { role: "banto", text: "手元で再現しました。**30 回中 11 回**です。枝にします。" },
  // 器（決定78・81）。「いつの」を持ち、凍る
  {
    role: "utsuwa",
    utsuwa: {
      kind: "list",
      at: "2026-08-09T02:05:00.000Z",
      from: { module: "environment-pool", tool: "env.list", artifact: "a-0007" },
      title: "止まっていない検証環境",
      items: [
        { label: "env-31 · task-0086 の検証", state: "warn", meta: "6日" },
        { label: "env-29 · inc-0041 の再現", state: "warn", meta: "6日" },
      ],
      total: 2,
    },
  },
  // 描けなかったとき（決定81(d)）。出どころと足りないものが揃う
  {
    role: "utsuwa",
    utsuwa: {
      kind: "broken",
      at: "2026-08-09T02:06:00.000Z",
      from: { module: "environment-pool", tool: "env.list", artifact: "a-0008" },
      wanted: "table",
      missing: "`cols` がありません（`rows` はあります）",
      raw: '{ "rows": [["env-31", 6]] }',
    },
  },
  // 面への口（決定78）。これがあるから他の器は小さいままでいられる
  {
    role: "utsuwa",
    utsuwa: {
      kind: "open",
      at: "2026-08-09T02:07:00.000Z",
      from: { module: "core", tool: "canvas.show", artifact: "-" },
      view: "file.browser",
      label: "ファイルを見る",
      meta: "banto · main · 探す作業",
    },
  },
  // 枝の札（参照）と、還った1行（記録）
  { role: "branch", branchId: BRANCH },
  {
    role: "branch_result",
    branchId: "t-old",
    title: "カタログの名前",
    conclusion: "spec-canvas-ui §5 に寄せた",
    at: "2026-08-08T09:00:00.000Z",
  },
];

const BRANCH_HISTORY = [
  { role: "po", text: "Slack のスレッドだと枝が埋没するけど、そこはどうする？" },
  { role: "banto", text: "埋没の原因は4つで、うち2つはこの店では起きません。" },
];

/** 判断待ち。**会話の流れの中に立つ**（決定80）。 */
const INBOX = [
  {
    id: "in-1",
    source: { id: "banto", label: "番頭" },
    kind: "番頭では決められない",
    rule: "D1",
    title: "この形で ADR-0017 を起こしてよいか",
    why: "会話とキャンバスの主従が未決のまま残っていた",
    what: "見本を 11 枚組んで比べました",
    ask: "起こしてよいか決めてください",
    actions: [
      { id: "go", label: "起こしてよい", tone: "call" },
      { id: "more", label: "もう1案見たい" },
    ],
    opens: { threadId: TRUNK },
    createdAt: new Date().toISOString(),
  },
];

class FakeHost {
  private constructor(
    private readonly server: http.Server,
    private readonly wss: WebSocketServer,
    readonly port: number
  ) {}

  private sockets = new Set<WebSocket>();
  /** クライアントから届いたメッセージ。何を投げ返したかを見る。 */
  readonly received: Array<Record<string, unknown>> = [];
  /** キャンバスの状態（会話ごと）。**面はどこから開いたかを覚える**（決定79・a12）。 */
  private canvas: Record<string, { tabs: unknown[]; activeTabId?: string }> = {
    [TRUNK]: { tabs: [] },
    [BRANCH]: { tabs: [] },
  };

  /**
   * 試験ごとに手を戻す。**偽ホストは1つを使い回す**ので、前の試験で開いた面が
   * 残っていると次の試験が別の前提で走る（P6：間欠的に落ちる試験を作らない）。
   */
  reset(): void {
    this.received.length = 0;
    this.canvas = { [TRUNK]: { tabs: [] }, [BRANCH]: { tabs: [] } };
  }

  static async start(): Promise<FakeHost> {
    const server = http.createServer((req, res) => {
      const url = (req.url ?? "/").split("?")[0] ?? "/";
      if (url.startsWith("/api/")) {
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ content: [], details: { path: ".", entries: [], total: 0 } }));
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
    wss.on("connection", (socket) => host.onConnection(socket));
    return host;
  }

  private onConnection(socket: WebSocket): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("message", (raw) => this.onMessage(socket, String(raw)));
    const send = (event: unknown): void => socket.send(JSON.stringify(event));
    send({
      type: "welcome",
      sessionId: "fake",
      threads: THREADS,
      defaultThreadId: TRUNK,
      tools: [],
      catalog: [
        {
          kind: "file.browser",
          title: "ファイル",
          description: "探す・移動する",
          component: "FileBrowser",
          category: "workspace",
          module: "file",
          endpoint: "/api/file",
        },
        {
          kind: "file.viewer",
          title: "ファイルを読む",
          description: "1つを読む",
          component: "FileViewer",
          category: "workspace",
          module: "file",
          endpoint: "/api/file",
        },
      ],
      modules: [{ name: "file", title: "ファイル", description: "見る", baseUrl: "/api/file" }],
    });
    send({ type: "history", threadId: TRUNK, entries: TRUNK_HISTORY });
    send({ type: "history", threadId: BRANCH, entries: BRANCH_HISTORY });
    send({ type: "inbox_state", items: INBOX });
    for (const [threadId, state] of Object.entries(this.canvas)) {
      send({ type: "canvas_state", threadId, tabs: state.tabs, activeTabId: state.activeTabId });
    }
  }

  private onMessage(socket: WebSocket, raw: string): void {
    const message = JSON.parse(raw) as Record<string, unknown>;
    this.received.push(message);
    const send = (event: unknown): void => socket.send(JSON.stringify(event));
    if (message["type"] === "history_request") {
      const threadId = String(message["threadId"]);
      send({
        type: "history",
        threadId,
        entries: threadId === TRUNK ? TRUNK_HISTORY : BRANCH_HISTORY,
      });
      return;
    }
    // **キャンバスは会話ごと**（決定2）。どこから開いたかはここに現れる
    if (message["type"] === "canvas_open") {
      const threadId = String(message["threadId"] ?? TRUNK);
      const kind = String(message["kind"]);
      const tab = { id: `tab-${kind}-${threadId}`, kind, title: kind, params: {}, rev: 1 };
      this.canvas[threadId] = { tabs: [tab], activeTabId: tab.id };
      send({ type: "canvas_state", threadId, tabs: [tab], activeTabId: tab.id });
      return;
    }
    if (message["type"] === "canvas_close") {
      const threadId = String(message["threadId"] ?? TRUNK);
      this.canvas[threadId] = { tabs: [] };
      send({ type: "canvas_state", threadId, tabs: [], activeTabId: undefined });
      return;
    }
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.close();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

let host: FakeHost;
test.beforeAll(async () => {
  host = await FakeHost.start();
});
test.afterAll(async () => {
  await host.close();
});
test.beforeEach(() => {
  host.reset();
});

async function open(page: Page, width = 1400, height = 900): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto(`http://127.0.0.1:${host.port}/`);
  await page.waitForSelector(".room--trunk");
}

test.describe("[task-0088/a1] 幹はプロジェクトに1本で、畳めない", () => {
  test("[task-0088/a1] 会話のタブが無い。幹は常にそこに在る", async ({ page }) => {
    await open(page);
    // 会話のタブ列そのものを作らない（決定77）
    await expect(page.locator(".thread-tab")).toHaveCount(0);
    await expect(page.locator(".room--trunk .room-title")).toHaveText("banto");
    // 幹を畳む口は出ない
    await expect(page.locator(".room--trunk .room-back")).toHaveCount(0);
  });

  test("[task-0088/a1] 開いている枝はレールの点に出ている（埋没しない不変条件③）", async ({ page }) => {
    await open(page);
    await expect(page.locator(".rail-hold .hold")).toHaveCount(1);
    await expect(page.locator(".rail-hold .hold")).toContainText("間欠的に落ちる試験");
    // 幹（＝プロジェクト）はレールの列。1つだけ並んでいる
    await expect(page.locator(".rail-trunk")).toHaveCount(1);
    await expect(page.locator(".rail-trunk")).toContainText("banto");
  });
});

test.describe("[task-0088/a2,a3] 枝の札と、還った1行", () => {
  test("[task-0088/a2] 幹の札に還す条件と、誰が開いたかが出る", async ({ page }) => {
    await open(page);
    const card = page.locator(".room--trunk .bcard").first();
    await expect(card).toContainText("間欠的に落ちる試験");
    await expect(card).toContainText("還す条件：再現条件が特定できたら");
    await expect(card).toContainText("番頭の判断で");
  });

  test("[task-0088/a3] 還った1行は結論を持ち、記録として凍っている", async ({ page }) => {
    await open(page);
    const result = page.locator(".room--trunk .bresult");
    await expect(result).toContainText("カタログの名前");
    await expect(result).toContainText("spec-canvas-ui §5 に寄せた");
  });

  test("[task-0088/a2] 枝の札を押すと、幹の隣に枝が開く（幹は消えない）", async ({ page }) => {
    await open(page);
    await page.locator(".room--trunk .bcard").first().click();
    await expect(page.locator(".room--branch")).toBeVisible();
    await expect(page.locator(".room--trunk")).toBeVisible();
    await expect(page.locator(".room--branch .room-title")).toHaveText("間欠的に落ちる試験");
    await expect(page.locator(".room--branch .room-sub")).toContainText("還す条件");
  });

  test("[task-0088/a3] 畳むときは結論を書かせる（保留も結論の一種）", async ({ page }) => {
    await open(page);
    await page.locator(".room--trunk .bcard").first().click();
    await page.getByRole("button", { name: "畳んで幹に回収" }).first().click();
    const submit = page.locator(".nb").getByRole("button", { name: "畳んで幹に回収" });
    await expect(submit).toBeDisabled();
    await page.locator(".nb input").first().fill("保留：計測が足りない");
    await expect(submit).toBeEnabled();
    await submit.click();
    // ホストへ結論つきで投げる（真実はホスト・D3）
    await expect
      .poll(() => host.received.find((m) => m["type"] === "thread_merge"))
      .toMatchObject({ threadId: BRANCH, conclusion: "保留：計測が足りない" });
  });
});

test.describe("[task-0088/a2] 枝は還す条件が無いと開けない", () => {
  test("[task-0088/a2] 3つ揃うまで開けない", async ({ page }) => {
    await open(page);
    await page.locator(".hold-new").click();
    const submit = page.getByRole("button", { name: "この条件で開く" });
    await expect(submit).toBeDisabled();
    const fields = page.locator(".nb input");
    await fields.nth(0).fill("記憶の検索が遅い");
    await expect(submit).toBeDisabled();
    await fields.nth(1).fill("500ms を切ったら");
    await expect(submit).toBeDisabled();
    await fields.nth(2).fill("職人を立てて詰める");
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect
      .poll(() => host.received.find((m) => m["type"] === "thread_open"))
      .toMatchObject({
        threadId: TRUNK,
        returnCondition: "500ms を切ったら",
        reason: "職人を立てて詰める",
      });
  });
});

test.describe("[task-0088/a7,a8,a9] 器", () => {
  test("[task-0088/a8] どの器も「いつの」を出す", async ({ page }) => {
    await open(page);
    const list = page.locator(".u--list").first();
    await expect(list).toContainText("止まっていない検証環境");
    await expect(list.locator(".u-when")).toContainText("時点");
    await expect(list.locator(".u-row")).toHaveCount(2);
  });

  test("[task-0088/a9] 描けない戻り値は出どころ・器・足りないものを添えて会話に出る", async ({ page }) => {
    await open(page);
    const broken = page.locator(".u--broken");
    await expect(broken).toContainText("environment-pool");
    await expect(broken).toContainText("env.list");
    await expect(broken).toContainText("table");
    await expect(broken).toContainText("cols");
    // 素の値は**畳んで置く**（黙って素の JSON を出さない）
    await expect(broken.locator("pre")).toHaveCount(0);
    await broken.getByRole("button", { name: "素の値を見る" }).click();
    await expect(broken.locator("pre")).toContainText("env-31");
    // 会話は止まらない——この後の行がそのまま続いている
    await expect(page.locator(".u-open")).toBeVisible();
  });

  test("[task-0088/a7] 細い帯では器が畳まれ、押すと開く（コンテナクエリ）", async ({ page }) => {
    await open(page);
    // 面を開くと会話は細い帯になる（決定79）→ 器の畳み判定が効く
    await page.locator(".u-open").click();
    await expect(page.locator(".work")).toBeVisible();
    const list = page.locator(".u--list").first();
    await expect(list.locator(".u-fold")).toBeVisible();
    await expect(list.locator(".u-body")).toBeHidden();
    await list.locator(".u-fold").click();
    await expect(list.locator(".u-body")).toBeVisible();
  });
});

test.describe("[task-0088/a10] 判断待ちは常設しない", () => {
  test("[task-0088/a10] 入力欄の直上に固定の帯が無い", async ({ page }) => {
    await open(page);
    const pend = page.locator(".room--trunk .pend-card");
    await expect(pend).toBeVisible();
    // 会話の流れの中（スクロールする器の中）に立っている
    const inScroll = await page.locator(".room--trunk .chat-scroll .pend-card").count();
    expect(inScroll, "判断待ちが会話の流れの中に立っていない").toBe(1);
    // 読みと入力の間に常設は無い
    await expect(page.locator(".room--trunk .chat-composer .pend-card")).toHaveCount(0);
  });

  test("[task-0088/a10] 遡ったときだけ↓が出て、判断待ちがあれば朱になる", async ({ page }) => {
    await open(page);
    await expect(page.locator(".room--trunk .chat-to-bottom")).toBeHidden();
    // **POの仕草で遡る**（ホイール）。仕草でない移動は追従が貼り直す（inc-0045）
    await page.locator(".room--trunk .chat-scroll").hover();
    await page.mouse.wheel(0, -2000);
    const jump = page.locator(".room--trunk .chat-to-bottom");
    await expect(jump).toBeVisible();
    await expect(jump).toHaveClass(/is-turn/);
    await expect(jump).toContainText("判断待ち 1");
  });
});

test.describe("[task-0088/a11,a12] 作業する面", () => {
  test("[task-0088/a11] 面を開くと会話が細い帯として残り、話しかけられる", async ({ page }) => {
    await open(page);
    const before = (await page.locator(".room--trunk").boundingBox())!.width;
    await page.locator(".u-open").click();
    await expect(page.locator(".work")).toBeVisible();
    const room = page.locator(".room--trunk");
    const after = (await room.boundingBox())!.width;
    expect(after, "会話が細い帯になっていない").toBeLessThan(before);
    expect(after).toBeGreaterThanOrEqual(260);
    // **話しかけられる**——そこで読むのではなく、話しかけるための幅だから
    await expect(room.locator(".chat-input")).toBeVisible();
  });

  test("[task-0088/a11] 帯の幅はつまんで変えられる", async ({ page }) => {
    await open(page);
    await page.locator(".u-open").click();
    await expect(page.locator(".work")).toBeVisible();
    const room = page.locator(".room--trunk");
    const before = (await room.boundingBox())!.width;
    const grip = (await page.locator(".room-grip").boundingBox())!;
    const y = grip.y + grip.height / 2;
    await page.mouse.move(grip.x + grip.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(grip.x + 140, y, { steps: 8 });
    await page.mouse.up();
    const after = (await room.boundingBox())!.width;
    expect(after, "帯をつまめていない").toBeGreaterThan(before + 80);
  });

  test("[task-0088/a12] 幹から開いた面は枝を閉じ、枝から開いた面は枝を残す", async ({ page }) => {
    await open(page);
    // 幹から開く → 枝は視界から外れる
    await page.locator(".room--trunk .u-open").click();
    await expect(page.locator(".work")).toBeVisible();
    await expect(page.locator(".room--branch")).toHaveCount(0);

    // 枝へ移ると、その枝のキャンバスは空なので面は閉じる（面は会話ごと・決定2）
    await page.locator(".rail-hold .hold").click();
    await expect(page.locator(".room--branch")).toBeVisible();
    await expect(page.locator(".work")).toHaveCount(0);

    // 枝から開く → 枝が細い帯として左に残り、幹は背表紙になる
    await page.locator(".rail-work").click();
    await page.locator(".catalog-item", { hasText: "ファイル" }).first().click();
    await expect(page.locator(".work")).toBeVisible();
    await expect(page.locator(".room--branch")).toBeVisible();
    await expect(page.locator(".spine")).toBeVisible();
  });
});

test.describe("[task-0088/a13] 狭い画面では重なる", () => {
  test("[task-0088/a13] 幹が地、枝と面が上がる紙。上端に幹が覗く", async ({ page }) => {
    await open(page, 390, 780);
    // 幹だけのときは覗きも紙も無い
    await expect(page.locator(".peek")).toHaveCount(0);

    await page.locator(".rail-hold .hold").click();
    await expect(page.locator(".room--branch")).toHaveClass(/is-raised/);
    const peek = page.locator(".peek");
    await expect(peek).toBeVisible();
    // 幹は地として在り続ける（消えない）
    await expect(page.locator(".room--trunk")).toBeAttached();

    // 覗きを押すと幹へ戻る
    await peek.click();
    await expect(page.locator(".room--branch")).toHaveCount(0);
  });

  test("[task-0088/a13] 面も下から上がる紙になる。ページごとずれない", async ({ page }) => {
    await open(page, 390, 780);
    await page.locator(".u-open").click();
    await expect(page.locator(".work")).toHaveClass(/is-raised/);
    await expect(page.locator(".peek")).toBeVisible();

    const overflow = await page.evaluate(() => ({
      x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    }));
    expect(overflow.x, "横スクロールが生えている").toBeLessThanOrEqual(0);
    expect(overflow.y, "ページごとスクロールしている").toBeLessThanOrEqual(0);
  });
});
