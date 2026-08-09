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

import { test, expect } from "@playwright/test";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.join(here, "..", "packages", "banto-web", "dist");
const THREAD_ID = "t-1";
const OTHER_THREAD_ID = "t-2";

const thread = (threadId: string, title: string, isDefault: boolean): Record<string, unknown> => ({
  threadId,
  title,
  sessionId: "fake",
  isDefault,
  state: "open",
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

  static async start(): Promise<FakeHost> {
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
          thread(OTHER_THREAD_ID, "別の会話", false),
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
    await page.locator(".inbox-tab").click();
    const letter = page.locator(".ib-letter").first();
    await expect(letter.locator(".ib-go")).toContainText("この件の会話へ");
  });

  test("「設定で細かく決める」で設定の場所の区画が開く", async ({ page }) => {
    await page.goto(`http://127.0.0.1:${host.port}/`);
    await page.locator(".pend--chat .pend-go").click();

    // 面が設定に変わり、区画は URL に残る（リロードしても戻ってこられる）
    await expect(page.locator(".sp-title")).toContainText("場所と書き込み許可");
    expect(page.url()).toContain("section=places");
    // ホストにも「開いた」ことは伝わる（会話と面はホストが動かす）
    await expect
      .poll(() => host.received.some((m) => m["type"] === "inbox_open"))
      .toBe(true);
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
