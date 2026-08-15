/**
 * PO報告 2026-08-15: 幹を切り替えたり枝を開いたりすると、入力欄へフォーカスが行く。
 * パソコンならよいが、タッチ端末だとソフトウェアキーボードが開いて鬱陶しい。
 *
 * ここで確かめるのは「会話を切り替えたとき」の1点——`.pj`（幹の点）を押して
 * `pressTrunk` → `openThread(threadId, { focus: true })` を通す（App.tsx）。
 * 判定そのもの（`prefersNoAutoFocus`）の単体試験は
 * `tests/acceptance/web-prefers-no-autofocus.spec.ts` にある。
 *
 * **タッチ文脈は `hasTouch: true, isMobile: true` で作る。** `matchMedia("(pointer: coarse)")`
 * が実際に true を返すことを手元で実測してから決めた（Chromium はこの組で pointer:coarse も
 * hover:none も true を返す）。`devices["Pixel 5"]` でも同じだが、ここでは意図が読める
 * 直書きのコンテキストオプションを使う。
 *
 * 偽ホストは trunk-branch.spec.ts の作りに倣うが、見たいのは「幹の切り替え」だけなので
 * 枝・キャンバス・判断待ちは持たない——最小限に絞る。
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
const OTHER = "t-other";

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
    model: { provider: "huihui", id: "qwen3.6-35b", vision: false },
  },
  {
    threadId: OTHER,
    title: "banto",
    kind: "trunk",
    sessionId: "fake",
    isDefault: false,
    state: "open",
    streaming: false,
    model: { provider: "huihui", id: "qwen3.6-35b", vision: false },
  },
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
    send({ type: "history", threadId: MAIN, entries: [] });
    send({ type: "history", threadId: OTHER, entries: [] });
    send({ type: "inbox_state", items: [] });
    send({ type: "canvas_state", threadId: MAIN, tabs: [], activeTabId: undefined });
    send({ type: "canvas_state", threadId: OTHER, tabs: [], activeTabId: undefined });
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

async function switchTrunkAndReadFocus(page: Page): Promise<string | null> {
  await page.goto(`http://127.0.0.1:${host.port}/`);
  await page.waitForSelector(".room--trunk");
  await expect(page.locator(".room--trunk .room-title")).toHaveText("帳場");
  // 幹を切り替える＝ pressTrunk（App.tsx）→ openThread(threadId, { focus: true })
  await page.locator(".pj").nth(1).click();
  await expect(page.locator(".room--trunk .room-title")).toHaveText("banto");
  // 次フレームでの掴み直し（Room.tsx）まで待つ
  await page.waitForTimeout(100);
  return page.evaluate(() => document.activeElement?.className ?? null);
}

test("タッチ端末では、幹を切り替えても入力欄へフォーカスが行かない", async ({ browser }) => {
  const ctx = await browser.newContext({ hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  expect(coarse, "この文脈で (pointer: coarse) が真にならず、前提が崩れている").toBe(true);

  const activeClass = await switchTrunkAndReadFocus(page);
  expect(activeClass).not.toContain("chat-input");
  await ctx.close();
});

test("デスクトップでは、幹を切り替えると入力欄へフォーカスが行く（従来どおり）", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const activeClass = await switchTrunkAndReadFocus(page);
  expect(activeClass).toContain("chat-input");
  await ctx.close();
});
