/**
 * 知らせを「まとめて閉じる」（PO要望 2026-08-16）を、実際のブラウザで確かめる。
 *
 * 取次は3段（ADR-0022 決定110）。真ん中の**知らせ**は判断ではない——読めば片付く
 * ものなので、一通ずつ押させる意味がない。その段の区切り行の**同じ高さ・右側**に
 * 「まとめて閉じる」を置く。
 *
 * ここで見るのは、押したときに**何が巻き込まれないか**：
 *
 *   - 判断を求めている札（`notice` でないもの）は1件も答えられない
 *   - 選択肢が2つ以上ある知らせは、機械がどれを選んだことにしてよいか決められない
 *     ので巻き込まない。**件数にも数えない**（数字と結果を食い違わせない）
 *
 * **番頭ホストもLLMも立てない**——ビルド済みのUIを配る小さなサーバと、Banto の
 * プロトコルを喋るだけの偽ホストを立てる（他のブラウザ試験と同じ形）。
 *
 * 前提: `npm run build:web` 済み。
 * 実行: npx playwright test tests/inbox-notices-bulk-close.spec.ts
 */

import { test, expect, type Page } from "@playwright/test";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.join(here, "..", "packages", "banto-web", "dist");
const THREAD_ID = "t-1";

const thread = (threadId: string, title: string): Record<string, unknown> => ({
  threadId,
  title,
  sessionId: "fake",
  isDefault: true,
  kind: "trunk",
  state: "open",
  streaming: false,
});

/** 判断を求める札。**まとめて閉じるに巻き込まれてはいけない**（選択肢が1つでも）。 */
const DECISION_ITEM = {
  id: "in-decide",
  source: { id: "worker", label: "職人 w-9" },
  kind: "番頭では決められない",
  rule: "D1",
  title: "外部の依存を足してよいか",
  why: "変換の実装を短くしたい",
  what: "職人が npm の依存を1つ足そうとしています。",
  ask: "足すことを許しますか。",
  // 選択肢が1つでも、**判断は判断**。notice が無いものは対象外
  actions: [{ id: "approve", label: "許す", tone: "call" }],
  createdAt: new Date().toISOString(),
};

/** 知らせ（決定109）。選択肢が1つなので、まとめて閉じられる。 */
const NOTICE_ONE = {
  id: "in-n1",
  source: { id: "kobo", label: "工房" },
  kind: "知らせ",
  title: "task-0100 が通りました",
  what: "マージキューを抜けました。",
  ask: "読んだら片付きます。",
  actions: [{ id: "ack", label: "了解", tone: "quiet" }],
  notice: true,
  createdAt: new Date().toISOString(),
};

/** もう一通の知らせ。**全件**答えられることを見るため。 */
const NOTICE_TWO = {
  id: "in-n2",
  source: { id: "banto", label: "番頭" },
  kind: "知らせ",
  title: "記憶を1つ書きました",
  what: "PO の指示を記憶に残しました。",
  ask: "読んだら片付きます。",
  actions: [{ id: "read", label: "読んだ", tone: "quiet" }],
  notice: true,
  createdAt: new Date().toISOString(),
};

/** 選択肢が2つある知らせ。**巻き込まない・数えない**（安全側）。 */
const NOTICE_MULTI = {
  id: "in-n3",
  source: { id: "env", label: "環境" },
  kind: "知らせ",
  title: "検証の器を作り直しました",
  what: "イメージを焼き直しました。",
  ask: "このまま使いますか。",
  actions: [
    { id: "keep", label: "このまま使う", tone: "call" },
    { id: "rebuild", label: "もう一度焼く", tone: "quiet" },
  ],
  notice: true,
  createdAt: new Date().toISOString(),
};

class FakeHost {
  private constructor(
    private readonly server: http.Server,
    private readonly wss: WebSocketServer,
    readonly port: number
  ) {}

  private sockets = new Set<WebSocket>();
  /** クライアントから届いたメッセージ（押した結果の検証に使う）。 */
  readonly received: Record<string, unknown>[] = [];

  /**
   * @param options.items 配る取次の中身。既定は「判断1・閉じられる知らせ2・
   *   選択肢が2つの知らせ1」。
   */
  static async start(options: { items?: unknown[] } = {}): Promise<FakeHost> {
    const server = http.createServer((req, res) => {
      const url = (req.url ?? "/").split("?")[0] ?? "/";
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
    const items = options.items ?? [DECISION_ITEM, NOTICE_ONE, NOTICE_TWO, NOTICE_MULTI];

    wss.on("connection", (socket) => {
      host.sockets.add(socket);
      socket.on("close", () => host.sockets.delete(socket));
      socket.on("message", (raw) => {
        host.received.push(JSON.parse(String(raw)) as Record<string, unknown>);
      });
      const send = (event: unknown): void => socket.send(JSON.stringify(event));
      send({
        type: "welcome",
        sessionId: "fake",
        threads: [thread(THREAD_ID, "会話")],
        defaultThreadId: THREAD_ID,
        tools: [],
        catalog: [],
        modules: [],
      });
      send({ type: "history", threadId: THREAD_ID, entries: [] });
      send({ type: "canvas_state", threadId: THREAD_ID, tabs: [], activeTabId: undefined });
      send({ type: "inbox_state", items });
    });
    return host;
  }

  /** 飛んだ答え（並び順に依らず見る）。 */
  answers(): Array<{ itemId: unknown; actionId: unknown }> {
    return this.received
      .filter((m) => m["type"] === "inbox_answer")
      .map((m) => ({ itemId: m["itemId"], actionId: m["actionId"] }))
      .sort((a, b) => String(a.itemId).localeCompare(String(b.itemId)));
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.close();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

let host: FakeHost;

test.afterEach(async () => {
  await host.close();
});

/** 取次の面を開く。 */
async function openInbox(page: Page): Promise<void> {
  await page.goto(`http://127.0.0.1:${host.port}/`);
  await page.locator(".rail-btn[data-key='i']").click();
  await expect(page.locator(".ib")).toHaveCount(1);
}

/** 知らせの段の区切り行（1本目の `.ib-sep`）。 */
function noticeSep(page: Page) {
  return page.locator(".ib-sep").first();
}

test.describe("知らせをまとめて閉じる（PO要望 2026-08-16）", () => {
  test("区切りの文言と同じ高さ・その右側にボタンが出る", async ({ page }) => {
    host = await FakeHost.start();
    await openInbox(page);

    const sep = noticeSep(page);
    await expect(sep).toContainText("これより下は、知らせ");
    const button = sep.locator(".ib-sep-btn");
    await expect(button).toHaveCount(1);

    const sepBox = (await sep.boundingBox())!;
    const labelBox = (await sep.locator(".ib-sep-label").boundingBox())!;
    const buttonBox = (await button.boundingBox())!;

    // **同じ高さ**：区切り行の中に収まり、文言と中心が揃っている
    expect(buttonBox.y).toBeGreaterThanOrEqual(sepBox.y - 1);
    expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(sepBox.y + sepBox.height + 1);
    const labelMid = labelBox.y + labelBox.height / 2;
    const buttonMid = buttonBox.y + buttonBox.height / 2;
    expect(Math.abs(labelMid - buttonMid)).toBeLessThanOrEqual(2);

    // **右側**：文言より右に始まり、行の右端に寄っている
    expect(buttonBox.x).toBeGreaterThan(labelBox.x + labelBox.width);
    expect(buttonBox.x + buttonBox.width).toBeGreaterThan(sepBox.x + sepBox.width - 2);
  });

  test("押す前に何件消えるか分かる（選択肢が2つの知らせは数えない）", async ({ page }) => {
    host = await FakeHost.start();
    await openInbox(page);

    // 知らせは3通あるが、閉じられるのは選択肢が1つの2通だけ
    await expect(page.locator(".ib-letter")).toHaveCount(4);
    await expect(noticeSep(page).locator(".ib-sep-btn")).toContainText("2");
  });

  test("押すと、閉じられる知らせが全件・唯一の選択肢で答えられる", async ({ page }) => {
    host = await FakeHost.start();
    await openInbox(page);

    await noticeSep(page).locator(".ib-sep-btn").click();

    await expect.poll(() => host.answers()).toEqual([
      { itemId: "in-n1", actionId: "ack" },
      { itemId: "in-n2", actionId: "read" },
    ]);
  });

  test("判断を求めている札は1件も巻き込まれない", async ({ page }) => {
    host = await FakeHost.start();
    await openInbox(page);

    await noticeSep(page).locator(".ib-sep-btn").click();
    await expect.poll(() => host.answers().length).toBe(2);

    // 判断の札はそのまま残り、その id では1件も飛んでいない
    await expect(page.locator(".ib-letter", { hasText: "外部の依存を足してよいか" })).toHaveCount(1);
    expect(host.answers().filter((a) => a.itemId === "in-decide")).toEqual([]);
    // 選択肢が2つの知らせも同じく残る（機械が選ばない）
    await expect(page.locator(".ib-letter", { hasText: "検証の器を作り直しました" })).toHaveCount(1);
    expect(host.answers().filter((a) => a.itemId === "in-n3")).toEqual([]);
  });

  test("閉じられる知らせが0件ならボタンは出ない", async ({ page }) => {
    // 判断1通と、選択肢が2つの知らせ1通だけ——閉じられるものは無い
    host = await FakeHost.start({ items: [DECISION_ITEM, NOTICE_MULTI] });
    await openInbox(page);

    await expect(noticeSep(page)).toContainText("これより下は、知らせ");
    await expect(page.locator(".ib-sep-btn")).toHaveCount(0);
  });
});
