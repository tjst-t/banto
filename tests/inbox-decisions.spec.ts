/**
 * 判断を求めるものの見え方（task-0086・決定73〜75）を、実際のブラウザで確かめる。
 *
 * PO報告 2026-08-09：「番頭からの通知が整理しきれていない。フォルダのアクセス許可は
 * そもそも通知に出てこない」。直したのは3点で、ここで見るのはその画面側：
 *
 *   1. 判断待ちは**会話の横（入力欄のすぐ上）にも出る**——取次を開かないと気づけない、
 *      では判断が滞る
 *   2. 取次の一通から**その件の会話へ飛べる**
 *   3. 書き込み許可も同じ枠組みに乗り、細かく決めたいときは**設定**へ飛ぶ
 *      （キャンバスの「書き込み許可」の面は無くなった）
 *
 * **番頭ホストもLLMも立てない**——ビルド済みのUIを配る小さなサーバと、Banto の
 * プロトコルを喋るだけの偽ホストを立てる（他のブラウザ試験と同じ形）。
 *
 * 前提: `npm run build:web` 済み。実行: npx playwright test tests/inbox-decisions.spec.ts
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
const OTHER_THREAD_ID = "t-2";

const thread = (
  threadId: string,
  title: string,
  isDefault: boolean,
  /** 畳んだ会話にするか（決定111 の「読むだけ」を見るため）。 */
  closed = false
): Record<string, unknown> => ({
  threadId,
  title,
  sessionId: "fake",
  isDefault,
  // ADR-0017 決定77: 既定の宛先＝幹。それ以外は枝（還す条件を持って生まれる）
  kind: isDefault ? "trunk" : "branch",
  ...(isDefault
    ? {}
    : {
        // 枝は必ず親（幹）を指す。**指さない枝はレールから消える＝埋没する**（決定77）
        parentId: "t-1",
        returnCondition: `${title} の結論が出たら`,
        openedBy: "po",
        openReason: "往復が続く",
      }),
  ...(closed
    ? { state: "closed", closedAt: new Date().toISOString(), conclusion: "ひとまず畳んだ" }
    : { state: "open" }),
  streaming: false,
});

/** この会話宛の判断待ち（書き込み許可。決定73 で取次に乗るようになった）。 */
const GRANT_ITEM = {
  id: "in-grant",
  source: { id: "place", label: "書き込み許可" },
  kind: "番頭では決められない",
  rule: "D1",
  title: "リポジトリ の docs/** に書かせてほしい",
  why: "決定を記録したい",
  what: "リポジトリ（/tmp/repo）は読み取り専用です。",
  ask: "この範囲で書くことを許しますか。",
  actions: [
    { id: "approve", label: "この範囲で許す", tone: "call" },
    { id: "deny", label: "断る", tone: "quiet" },
  ],
  opens: { threadId: THREAD_ID, settings: { section: "places" } },
  createdAt: new Date().toISOString(),
};

/** 別の会話宛。**この会話の横には出てはいけない**（文脈の無い札を読ませない）。 */
const OTHER_ITEM = {
  id: "in-other",
  source: { id: "worker", label: "職人 w-9" },
  kind: "番頭では決められない",
  title: "別の会話で頼まれた判断",
  what: "別の会話の経過です。",
  ask: "どうしますか。",
  actions: [{ id: "ok", label: "進める" }],
  opens: { threadId: OTHER_THREAD_ID },
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
   * @param options.otherClosed 別の会話（`OTHER_THREAD_ID`）を**畳んだ状態**で配る。
   *   取次の札から押しても開き直らないことを見るため（決定111）。
   */
  static async start(options: { otherClosed?: boolean } = {}): Promise<FakeHost> {
    const server = http.createServer((req, res) => {
      const url = (req.url ?? "/").split("?")[0] ?? "/";
      const json = (details: unknown): void => {
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ content: [{ type: "text", text: "ok" }], details }));
      };

      // 設定画面が描くための区画。場所は専用の面を宣言する（決定43・75）
      if (url === "/api/settings/tools/settings.describe") {
        json({
          storedAt: "/tmp/banto/settings.json",
          sections: [
            {
              id: "places",
              title: "場所と書き込み許可",
              description: "番頭が作業できる場所と、書き込みを許す範囲。",
              origin: "core",
              originTitle: "Banto 本体",
              fields: [],
              view: "PlaceSettings",
              values: { places: ["repo:/tmp/repo"] },
            },
          ],
        });
        return;
      }
      // 場所と許可の全体（決定74・75）
      if (url === "/api/workspace/tools/place.list_requests") {
        json({
          requests: [],
          pending: [
            {
              id: "req-1",
              placeId: "repo",
              patterns: ["docs/**"],
              reason: "決定を記録したい",
              requestedAt: new Date().toISOString(),
              state: "pending",
            },
          ],
          grants: {},
          global: ["work/**"],
          places: [
            { id: "repo", label: "リポジトリ", path: "/tmp/repo", writable: ["work/**"] },
            { id: "desk", label: "書斎（成果物）", path: "/tmp/desk", writable: ["work/**"] },
          ],
        });
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
        host.received.push(JSON.parse(String(raw)) as Record<string, unknown>);
      });
      const send = (event: unknown): void => socket.send(JSON.stringify(event));
      send({
        type: "welcome",
        sessionId: "fake",
        threads: [
          thread(THREAD_ID, "会話", true),
          thread(OTHER_THREAD_ID, "別の会話", false, options.otherClosed === true),
        ],
        defaultThreadId: THREAD_ID,
        tools: [],
        catalog: [],
        // 決定41: GUI を持たないモジュールにも届くよう、到達先はここから引く
        modules: [
          { name: "settings", title: "設定", description: "", baseUrl: "/api/settings" },
          { name: "workspace", title: "ワークスペース", description: "", baseUrl: "/api/workspace" },
        ],
      });
      for (const threadId of [THREAD_ID, OTHER_THREAD_ID]) {
        send({ type: "history", threadId, entries: [] });
        send({ type: "canvas_state", threadId, tabs: [], activeTabId: undefined });
      }
      send({ type: "inbox_state", items: [GRANT_ITEM, OTHER_ITEM] });
    });
    return host;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.close();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

let host: FakeHost;

test.beforeEach(async () => {
  host = await FakeHost.start();
});

/** URL のクエリ（どこを見ているかの真実は URL。`viewLocation.ts`）。 */
function query(page: Page): URLSearchParams {
  return new URLSearchParams(new URL(page.url()).search);
}

/** いま前面に出ている会話の頭（＝どの会話に居るか）。 */
function roomTitle(page: Page) {
  return page.locator(".room").last().locator(".room-title");
}

test.afterEach(async () => {
  await host.close();
});

test.describe("判断待ちは会話の横にも出る（決定73）", () => {
  test("この会話宛の判断待ちが、入力欄のすぐ上に出る", async ({ page }) => {
    await page.goto(`http://127.0.0.1:${host.port}/`);
    const card = page.locator(".pend--chat .pend-card");
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("リポジトリ の docs/** に書かせてほしい");
    // 札だけで判断できること（spec-ui §3）：求める判断と、起きたことが出る
    await expect(card).toContainText("この範囲で書くことを許しますか。");
    await expect(card).toContainText("読み取り専用です");

    // **入力欄より上**にある（遡ると消える位置に置かない）
    const cardBox = await card.boundingBox();
    const inputBox = await page.locator(".chat-input").boundingBox();
    expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(inputBox!.y + 1);
  });

  test("別の会話宛の判断待ちは出ない（文脈の無い札を読ませない）", async ({ page }) => {
    await page.goto(`http://127.0.0.1:${host.port}/`);
    await expect(page.locator(".pend--chat .pend-card")).toHaveCount(1);
    await expect(page.locator(".pend--chat")).not.toContainText("別の会話で頼まれた判断");
  });

  test("その会話宛の札に「この件の会話へ」は出ない（既にそこにいる）", async ({ page }) => {
    await page.goto(`http://127.0.0.1:${host.port}/`);
    const go = page.locator(".pend--chat .pend-go");
    await expect(go).toHaveCount(1);
    // 押しても何も動かない導線は出さない。設定への導線だけが残る
    await expect(go).not.toContainText("この件の会話へ");
    await expect(go).toContainText("設定で細かく決める");
  });

  test("押すとホストへ答えが飛ぶ（取次で押したのと同じ）", async ({ page }) => {
    await page.goto(`http://127.0.0.1:${host.port}/`);
    await page.locator(".pend--chat").getByRole("button", { name: "この範囲で許す" }).click();
    await expect
      .poll(() => host.received.filter((m) => m["type"] === "inbox_answer"))
      .toEqual([{ type: "inbox_answer", itemId: "in-grant", actionId: "approve" }]);
  });
});

test.describe("取次の一通から飛べる（決定73・75）", () => {
  test("会話へ飛ぶ導線が出る", async ({ page }) => {
    await page.goto(`http://127.0.0.1:${host.port}/`);
    await page.locator(".rail-btn[data-key='i']").click();
    const letter = page.locator(".ib-letter").first();
    await expect(letter.locator(".ib-go")).toContainText("この件の会話へ");
  });

  test("「設定で細かく決める」で設定の場所の区画が開く", async ({ page }) => {
    await page.goto(`http://127.0.0.1:${host.port}/`);
    await page.locator(".pend--chat .pend-go").click();

    // 面が設定に変わり、区画は URL に残る（リロードしても戻ってこられる）
    await expect(page.locator(".sp-title")).toContainText("場所と書き込み許可");
    expect(page.url()).toContain("section=places");
    // ホストにも「開いた」ことは伝わる（キャンバスを開くのはホスト側）
    await expect
      .poll(() => host.received.some((m) => m["type"] === "inbox_open"))
      .toBe(true);
  });

  /**
   * 会話を移すのは**画面側**（task-0175）。ホストの `inbox_open` はキャンバスを開くだけで、
   * 「この会話へ移れ」を伝える型はプロトコルに無い——ここが落ちると、面は閉じるのに
   * **いま見ている会話のまま**になる（PO報告：押しても違う会話が出る）。
   */
  test("別の会話を指す札を押すと、面が閉じてその会話が前面になる", async ({ page }) => {
    await page.goto(`http://127.0.0.1:${host.port}/`);
    await expect(roomTitle(page)).toHaveText("会話");

    await page.locator(".rail-btn[data-key='i']").click();
    await page
      .locator(".ib-letter", { hasText: "別の会話で頼まれた判断" })
      .locator(".ib-go")
      .click();

    // 取次の面は畳まれ、札が指していた会話が前面に出る
    await expect(page.locator(".ib")).toHaveCount(0);
    await expect(roomTitle(page)).toHaveText("別の会話");
    await expect.poll(() => query(page).get("thread")).toBe(OTHER_THREAD_ID);
    expect(query(page).get("view")).toBe(null);
    // 開いたことはホストにも伝わる（キャンバスはホストが開く）
    await expect
      .poll(() => host.received.some((m) => m["type"] === "inbox_open" && m["itemId"] === "in-other"))
      .toBe(true);
  });

  test("会話と設定の両方を指す札は、その会話へ移ったうえで設定が出る", async ({ page }) => {
    // 別の会話を見ているところから押す（移ったことが見えるように）
    await page.goto(`http://127.0.0.1:${host.port}/?thread=${OTHER_THREAD_ID}`);
    await expect(roomTitle(page)).toHaveText("別の会話");

    await page.locator(".rail-btn[data-key='i']").click();
    await page
      .locator(".ib-letter", { hasText: "リポジトリ の docs/** に書かせてほしい" })
      .locator(".ib-go")
      .click();

    // 設定の面が出る
    await expect(page.locator(".sp-title")).toContainText("場所と書き込み許可");
    await expect.poll(() => query(page).get("section")).toBe("places");
    // **会話も移っている**——片方だけ効かせない
    await expect.poll(() => query(page).get("thread")).toBe(THREAD_ID);
    await page.keyboard.press("Escape");
    await expect(roomTitle(page)).toHaveText("会話");
  });

  test("畳まれた会話を指す札を押しても、その会話は開き直らない（履歴で読む）", async ({ page }) => {
    await host.close();
    host = await FakeHost.start({ otherClosed: true });
    await page.goto(`http://127.0.0.1:${host.port}/`);
    await page.locator(".rail-btn[data-key='i']").click();
    await page
      .locator(".ib-letter", { hasText: "別の会話で頼まれた判断" })
      .locator(".ib-go")
      .click();

    // 履歴の面でその会話を読む形になる（決定111・確認しに行っただけで開き直るのは事故）
    await expect.poll(() => query(page).get("view")).toBe("history");
    await expect.poll(() => query(page).get("read")).toBe(OTHER_THREAD_ID);
    // 見ている会話は動かず、ホストへ「開き直せ」も飛ばない
    expect(query(page).get("thread")).not.toBe(OTHER_THREAD_ID);
    expect(host.received.some((m) => m["type"] === "thread_reopen")).toBe(false);
  });
});

test.describe("場所と書き込み許可は設定に1つ（決定74・75）", () => {
  test("保留中の要求・共通の許可・場所ごとの範囲が1画面に出る", async ({ page }) => {
    await page.goto(`http://127.0.0.1:${host.port}/`);
    await page.locator(".pend--chat .pend-go").click();

    const panel = page.locator(".ps");
    // 番頭からの要求は、その場で許せる
    await expect(panel.getByRole("button", { name: "この範囲で許す" })).toBeVisible();
    // 全場所共通の許可（決定74）
    await expect(panel.locator(".ps-global .cv-input")).toHaveValue("work/**");
    // 場所ごとに「いま書ける範囲」と、それがどこから来たか（決定38e）
    await expect(panel).toContainText("リポジトリ");
    await expect(panel).toContainText("書斎（成果物）");
    await expect(panel.locator(".ps-tag.is-global").first()).toContainText("共通");
  });

  test("キャンバスのカタログに「書き込み許可」は無い（かぶりを無くした）", async ({ page }) => {
    await page.goto(`http://127.0.0.1:${host.port}/`);
    // カタログは welcome の catalog がそのまま出る。面が登録されていないことは
    // 受け入れ試験（banto-write-permission）で見ているので、ここでは入口を見る
    await expect(page.locator(".canvas-catalog-btn")).toHaveCount(0);
  });
});
