/**
 * 履歴の面の2つのタブ（幹・枝）と、会話の面に枝の一覧を居座らせないこと（PO報告 2026-08-14）。
 *
 * ADR-0022 決定112 で幹の会話の上に「流れない枝一覧」（`.room-branches`）を足したが、
 * これがチャット欄の上を常時占有していた。畳んだ枝を読めることは失わず、置き場を
 * **履歴の面**へ移す——履歴は「幹」「枝」の2タブになり、開いた直後は「枝」。
 *
 * **番頭ホストもLLMも立てない**——ビルド済みのUIを配る小さなサーバと、Banto の
 * プロトコルを喋るだけの偽ホストを立てる（`trunk-branch.spec.ts` と同じ作り）。
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

const MAIN = "t-main";
const TRUNK_A = "t-a";
const TRUNK_B = "t-b";
const TRUNK_OLD = "t-old";
const BRANCH_A_OPEN = "b-a1";
const BRANCH_A_CLOSED = "b-a2";
const BRANCH_B_CLOSED = "b-b1";

const T_TRUNK_A = "banto";
const T_TRUNK_B = "別の店";
const T_TRUNK_OLD = "終えた幹";
const T_BRANCH_A_OPEN = "間欠的に落ちる試験";
const T_BRANCH_A_CLOSED = "畳んだ調べもの";
const T_BRANCH_B_CLOSED = "別の店で畳んだ枝";

const MODEL = { provider: "huihui", id: "qwen3.6-35b", vision: false };

/**
 * 帳場・幹2本・終えた幹1本と、幹Aの枝2本（開きと畳み）・幹Bの枝1本（畳み）。
 *
 * **幹Bの枝**が要る——「いまの幹の枝だけ」を確かめるには、混ざりうるものが要る。
 */
const THREADS = [
  {
    threadId: MAIN,
    title: "帳場",
    kind: "trunk",
    isMain: true,
    sessionId: "fake",
    isDefault: true,
    state: "open",
    streaming: false,
    model: MODEL,
  },
  {
    threadId: TRUNK_A,
    title: T_TRUNK_A,
    kind: "trunk",
    sessionId: "fake",
    isDefault: false,
    state: "open",
    streaming: false,
    model: MODEL,
  },
  {
    threadId: TRUNK_B,
    title: T_TRUNK_B,
    kind: "trunk",
    sessionId: "fake",
    isDefault: false,
    state: "open",
    streaming: false,
    model: MODEL,
  },
  {
    threadId: TRUNK_OLD,
    title: T_TRUNK_OLD,
    kind: "trunk",
    sessionId: "fake",
    isDefault: false,
    state: "closed",
    closedAt: "2026-08-01T02:00:00.000Z",
    preview: "去年の店じまいの相談",
    streaming: false,
    model: MODEL,
  },
  {
    threadId: BRANCH_A_OPEN,
    title: T_BRANCH_A_OPEN,
    kind: "branch",
    parentId: TRUNK_A,
    returnCondition: "再現条件が特定できたら",
    openedBy: "banto",
    openReason: "往復が続くので枝にする",
    sessionId: "fake",
    isDefault: false,
    state: "open",
    streaming: false,
    model: MODEL,
  },
  {
    threadId: BRANCH_A_CLOSED,
    title: T_BRANCH_A_CLOSED,
    kind: "branch",
    parentId: TRUNK_A,
    returnCondition: "原因が分かったら",
    openedBy: "po",
    openReason: "本筋から外れるので枝にする",
    sessionId: "fake",
    isDefault: false,
    state: "closed",
    closedAt: "2026-08-12T04:00:00.000Z",
    conclusion: "30 回中 11 回で再現した",
    streaming: false,
    model: MODEL,
  },
  {
    threadId: BRANCH_B_CLOSED,
    title: T_BRANCH_B_CLOSED,
    kind: "branch",
    parentId: TRUNK_B,
    returnCondition: "見積もりが出たら",
    openedBy: "banto",
    openReason: "別の店の話",
    sessionId: "fake",
    isDefault: false,
    state: "closed",
    closedAt: "2026-08-13T04:00:00.000Z",
    conclusion: "来期に回す",
    streaming: false,
    model: MODEL,
  },
];

/** 畳んだ枝の中身。**一覧を出すだけでは配らない**ので、読むと言われてから返す。 */
const CLOSED_BRANCH_HISTORY = [
  { role: "po", text: "何回落ちるか数えてほしい" },
  { role: "banto", text: "数えました。**30 回中 11 回**です。" },
];

class FakeHost {
  private constructor(
    private readonly server: http.Server,
    private readonly wss: WebSocketServer,
    readonly port: number
  ) {}

  private sockets = new Set<WebSocket>();

  static async start(): Promise<FakeHost> {
    const server = http.createServer((req, res) => {
      const url = (req.url ?? "/").split("?")[0] ?? "/";
      if (url.startsWith("/api/")) {
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ content: [], details: {} }));
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
      defaultThreadId: MAIN,
      tools: [],
      catalog: [],
      modules: [],
    });
    // 開いている会話の分だけ配る（畳んだものは頼まれてから）
    for (const threadId of [MAIN, TRUNK_A, TRUNK_B, BRANCH_A_OPEN]) {
      send({ type: "history", threadId, entries: [] });
    }
    send({ type: "inbox_state", items: [] });
    for (const threadId of [MAIN, TRUNK_A, TRUNK_B, BRANCH_A_OPEN]) {
      send({ type: "canvas_state", threadId, tabs: [], activeTabId: undefined });
    }
  }

  private onMessage(socket: WebSocket, raw: string): void {
    const message = JSON.parse(raw) as Record<string, unknown>;
    if (message["type"] === "history_request") {
      socket.send(
        JSON.stringify({
          type: "history",
          threadId: String(message["threadId"]),
          entries: CLOSED_BRANCH_HISTORY,
        })
      );
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

/** 幹 A（banto）を見ている状態から始める。既定の宛先は帳場なので、そこから移る。 */
async function open(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`http://127.0.0.1:${host.port}/`);
  await page.waitForSelector(".room--trunk");
  await page.locator(".pj").nth(1).click();
  await expect(page.locator(".room--trunk .room-title")).toHaveText(T_TRUNK_A);
}

/** 履歴の面を開く（レール下端の「履歴」）。 */
async function openHistory(page: Page): Promise<void> {
  await page.locator('.rail-btn[data-key="h"]').click();
  await expect(page.locator(".history-view")).toBeVisible();
}

/** 一覧に並んでいる題。 */
async function listedTitles(page: Page): Promise<string[]> {
  return page.locator(".history-list-scroll .history-row-title").allTextContents();
}

test.describe("会話の面は会話だけ（PO報告 2026-08-14）", () => {
  test("幹の会話の上に、枝の一覧が居座らない", async ({ page }) => {
    await open(page);
    // 枝はこの幹にぶら下がっているが、それでも会話の面には出さない
    await expect(page.locator(".room-branches")).toHaveCount(0);
    await expect(page.locator(".room--trunk .bcard")).toHaveCount(0);
    await expect(page.locator(".room--trunk .bresult")).toHaveCount(0);
  });
});

test.describe("履歴は幹と枝の2タブ（PO報告 2026-08-14）", () => {
  test("開いた直後に選ばれているのは「枝」", async ({ page }) => {
    await open(page);
    await openHistory(page);
    await expect(page.locator(".history-tabs .cv-seg-opt.is-on")).toHaveText("枝");
  });

  test("枝タブに出るのは、いま見ている幹の枝だけ（畳んだ枝も出る）", async ({ page }) => {
    await open(page);
    await openHistory(page);
    const titles = await listedTitles(page);
    expect(titles).toContain(T_BRANCH_A_OPEN);
    // 畳んだ枝を読めることが元々の目的（ADR-0022 決定111）——落とさない
    expect(titles).toContain(T_BRANCH_A_CLOSED);
    // 他の幹の枝は出さない
    expect(titles).not.toContain(T_BRANCH_B_CLOSED);
    // 幹も混ぜない
    expect(titles).not.toContain(T_TRUNK_OLD);
  });

  test("幹タブに枝は混ざらない", async ({ page }) => {
    await open(page);
    await openHistory(page);
    await page.locator(".history-tabs .cv-seg-opt", { hasText: "幹" }).click();
    await expect(page.locator(".history-tabs .cv-seg-opt.is-on")).toHaveText("幹");
    const titles = await listedTitles(page);
    expect(titles).toContain(T_TRUNK_OLD);
    expect(titles).not.toContain(T_BRANCH_A_OPEN);
    expect(titles).not.toContain(T_BRANCH_A_CLOSED);
    expect(titles).not.toContain(T_BRANCH_B_CLOSED);
  });

  test("枝タブから畳んだ枝の中身が読める（結論も一覧に出る）", async ({ page }) => {
    await open(page);
    await openHistory(page);
    await expect(page.locator(".history-list-scroll")).toContainText("30 回中 11 回で再現した");
    await page
      .locator(".history-row", { hasText: T_BRANCH_A_CLOSED })
      .first()
      .click();
    await expect(page.locator(".history-read-scroll")).toContainText("何回落ちるか数えてほしい");
  });
});
