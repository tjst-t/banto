/**
 * 会話面の体験（Vercel AI Elements に合わせた振る舞い）を、実際のブラウザで確かめる。
 *
 * **番頭ホストもLLMも立てない**——ビルド済みのUIを配る小さなサーバと、Banto の
 * プロトコルを喋るだけの偽ホストを立てて、イベントをこちらから発火する。
 * 見たいのは「イベントが来たとき画面がどう振る舞うか」だけなので、これで足りる。
 *
 * 前提: `npm run build:web` 済み（packages/banto-web/dist）。
 * 実行:  npx playwright test tests/chat-ux.spec.ts
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
/** 切替の検証用にもう1本。中身は接続時に history で流す。 */
const OTHER_THREAD_ID = "t-2";
const MODEL_A = { provider: "huihui", id: "qwen3.6-35b", vision: false, contextWindow: 200000 };
const MODEL_B = { provider: "anthropic", id: "claude-opus-5", vision: true };

/** 会話1本分の姿（ThreadView）。 */
const thread = (
  threadId: string,
  title: string,
  isDefault: boolean
): Record<string, unknown> => ({
  threadId,
  title,
  sessionId: "fake",
  isDefault,
  state: "open",
  streaming: false,
});

/** 偽ホスト。UIを配り、`/ws` で Banto のイベントを流す。 */
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
      // 中核の Tool 面。モデル選択が一覧を取りに来る
      if (url === "/api/core/tools/llm.list") {
        res.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            content: [{ type: "text", text: "2 モデル" }],
            details: {
              models: [
                {
                  providerId: "huihui",
                  id: "qwen3.6-35b",
                  name: "Qwen 3.6 35B",
                  tier: "standard",
                  vision: false,
                  contextWindow: 200000,
                  free: true,
                  hostUsable: true,
                  workerUsable: true,
                },
                {
                  providerId: "anthropic",
                  id: "claude-opus-5",
                  name: "Claude Opus 5",
                  tier: "reasoning",
                  vision: true,
                  free: false,
                  hostUsable: true,
                  workerUsable: true,
                },
                {
                  providerId: "huihui",
                  id: "worker-only",
                  name: "職人専用",
                  tier: "fast",
                  vision: false,
                  free: true,
                  hostUsable: false,
                  workerUsable: true,
                },
              ],
            },
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
        // 新しい会話を開く経路。**一覧にモデルを載せて返す**のが本物と同じ形
        if (message["type"] === "thread_open") {
          const id = `t-${host.received.length + 2}`;
          host.opened.push(id);
          host.broadcast({
            type: "thread_state",
            threads: [
              { ...thread(THREAD_ID, "会話", true), model: MODEL_A },
              { ...thread(OTHER_THREAD_ID, "別の会話", false), model: MODEL_B },
              { ...thread(id, "新しい会話", false), model: MODEL_A },
            ],
          });
          host.broadcast({ type: "history", threadId: id, entries: [] });
          host.broadcast({ type: "canvas_state", threadId: id, tabs: [], activeTabId: undefined });
        }
      });
      // 接続直後に流れるもの（UIが会話面を描き始めるのに要る最小限）
      host.sendTo(socket, {
        type: "welcome",
        sessionId: "fake",
        threads: [
          { ...thread(THREAD_ID, "会話", true), model: MODEL_A },
          { ...thread(OTHER_THREAD_ID, "別の会話", false), model: MODEL_B },
        ],
        defaultThreadId: THREAD_ID,
        tools: [],
        catalog: [],
        modules: [],
      });
      // 会話ごとに1通ずつ（別の会話は別のモデルで始まっている）
      host.sendTo(socket, {
        type: "model_state",
        threadId: THREAD_ID,
        provider: "huihui",
        id: "qwen3.6-35b",
        vision: false,
        contextWindow: 200000,
      });
      host.sendTo(socket, {
        type: "model_state",
        threadId: OTHER_THREAD_ID,
        provider: "anthropic",
        id: "claude-opus-5",
        vision: true,
      });
      host.sendTo(socket, { type: "history", threadId: THREAD_ID, entries: [] });
      // 切替先には画面より高い中身を入れておく（滑るかどうかは高さがないと見えない）
      host.sendTo(socket, {
        type: "history",
        threadId: OTHER_THREAD_ID,
        // **コードブロックを混ぜる**——shiki のハイライトは非同期で降ってきて、
        // 届いた時点で高さが変わる。切替の滑りはここで起きるので、無いと再現しない
        entries: Array.from({ length: 20 }, (_, i) => ({
          role: "banto",
          text:
            `別の会話の ${i} 行目。\n\n` +
            "```ts\nconst x = " + i + ";\nfunction f() { return x * 2; }\n```\n\n",
        })),
      });
      for (const threadId of [THREAD_ID, OTHER_THREAD_ID]) {
        host.sendTo(socket, { type: "canvas_state", threadId, tabs: [], activeTabId: undefined });
      }
    });
    return host;
  }

  private sendTo(socket: WebSocket, event: unknown): void {
    socket.send(JSON.stringify(event));
  }

  /** クライアントから届いたメッセージ（送信・モデル切替の検証に使う）。 */
  readonly received: Record<string, unknown>[] = [];
  /** thread_open で開いた会話。 */
  readonly opened: string[] = [];

  /** スレッドIDを付けずに全員へ配る（thread_state 等）。 */
  broadcast(event: Record<string, unknown>): void {
    for (const socket of this.sockets) this.sendTo(socket, event);
  }

  /** 全クライアントへ配る（本物の broadcast と同じ）。 */
  emit(event: Record<string, unknown>): void {
    for (const socket of this.sockets) {
      this.sendTo(socket, { threadId: THREAD_ID, ...event });
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
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`http://127.0.0.1:${host.port}/`);
  await page.waitForSelector(".chat-scroll");
});

/** 会話を画面より高くする（追従の検証には、スクロールできる高さが要る）。 */
async function fillConversation(page: import("@playwright/test").Page): Promise<void> {
  host.emit({ type: "turn_start" });
  for (let i = 0; i < 40; i++) {
    host.emit({ type: "text_delta", delta: `${i} 行目の応答です。\n\n` });
  }
  host.emit({ type: "turn_end" });
  await expect(page.locator(".msg--banto")).toBeVisible();
  // spring で降りるので、止まるまで待つ
  await page.waitForTimeout(700);
}

/** いま最下部にいるか（追従の判定と同じ 70px の余裕で見る）。 */
function atBottom(page: import("@playwright/test").Page): Promise<boolean> {
  return page
    .locator(".chat-scroll")
    .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight <= 70);
}

test.describe("末尾追従（use-stick-to-bottom）", () => {
  test("最下部にいる間は、届いた分だけ追いかける", async ({ page }) => {
    await fillConversation(page);
    expect(await atBottom(page)).toBe(true);

    host.emit({ type: "turn_start" });
    for (let i = 0; i < 20; i++) host.emit({ type: "text_delta", delta: `追記 ${i}\n\n` });
    host.emit({ type: "turn_end" });
    await page.waitForTimeout(900);

    expect(await atBottom(page)).toBe(true);
  });

  test("上へ動かした瞬間に追従が止まり、↓ボタンが出る", async ({ page }) => {
    await fillConversation(page);
    await expect(page.locator(".chat-to-bottom")).toBeHidden();

    // 読み返す距離まで上げる。↓ボタンは「最下部にいない」ときに出る
    await page.locator(".chat-scroll").hover();
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(200);

    await expect(page.locator(".chat-to-bottom")).toBeVisible();

    // 止まっている間に届いても、勝手に下へ飛ばされない
    const before = await page.locator(".chat-scroll").evaluate((el) => el.scrollTop);
    host.emit({ type: "turn_start" });
    for (let i = 0; i < 20; i++) host.emit({ type: "text_delta", delta: `割り込み ${i}\n\n` });
    host.emit({ type: "turn_end" });
    await page.waitForTimeout(700);
    const after = await page.locator(".chat-scroll").evaluate((el) => el.scrollTop);
    expect(after).toBe(before);
  });

  test("わずかに上げただけでも追従は止まる（70px の内側でも）", async ({ page }) => {
    await fillConversation(page);

    // 60px——「一番下にいる」と見なされる範囲の内側。それでも追従は切れるのが
    // AI Elements の呼吸で、閾値を超えるまで追い続けるのとは体験が違う
    await page.locator(".chat-scroll").hover();
    await page.mouse.wheel(0, -60);
    await page.waitForTimeout(200);
    const before = await page.locator(".chat-scroll").evaluate((el) => el.scrollTop);

    host.emit({ type: "turn_start" });
    for (let i = 0; i < 20; i++) host.emit({ type: "text_delta", delta: `割り込み ${i}\n\n` });
    host.emit({ type: "turn_end" });
    await page.waitForTimeout(700);

    const after = await page.locator(".chat-scroll").evaluate((el) => el.scrollTop);
    expect(after).toBe(before);
  });

  test("↓ボタンを押すと最下部へ戻り、また追いかけ始める", async ({ page }) => {
    await fillConversation(page);
    await page.locator(".chat-scroll").hover();
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(200);
    await page.locator(".chat-to-bottom").click();
    await page.waitForTimeout(700);

    expect(await atBottom(page)).toBe(true);
    await expect(page.locator(".chat-to-bottom")).toBeHidden();

    host.emit({ type: "turn_start" });
    for (let i = 0; i < 10; i++) host.emit({ type: "text_delta", delta: `再開 ${i}\n\n` });
    host.emit({ type: "turn_end" });
    await page.waitForTimeout(900);
    expect(await atBottom(page)).toBe(true);
  });
});

test.describe("会話の切り替え", () => {
  /** 押した直後から毎フレーム scrollTop を集める。 */
  async function samplePositions(
    page: import("@playwright/test").Page,
    act: () => Promise<void>
  ): Promise<number[]> {
    await page.evaluate(() => {
      const store = (window as unknown as { __samples: number[] });
      store.__samples = [];
      let ticks = 0;
      const tick = (): void => {
        const el = document.querySelector(".chat-scroll");
        if (el) store.__samples.push(Math.round(el.scrollTop));
        if (++ticks < 90) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await act();
    await page.waitForTimeout(1600);
    return page.evaluate(() => (window as unknown as { __samples: number[] }).__samples);
  }

  test("会話を切り替えても滑らない", async ({ page }) => {
    await fillConversation(page);
    // 切替は**押してから**測る（押す前の位置は前の会話のもので、混ぜると判定が濁る）。
    // spring は50フレーム前後続くので、1〜2フレーム遅れても滑っていれば必ず写る
    await page.locator(".thread-tab", { hasText: "別の会話" }).click();
    const samples = await samplePositions(page, async () => {});
    const settled = samples[samples.length - 1] ?? 0;
    // 滑っていれば途中の位置（先頭寄り）が並ぶ。飛んでいれば常に最下部付近
    const slid = samples.filter((v) => v > 0 && v < settled * 0.5);
    expect(slid.length, `切替が滑っている: ${samples.slice(0, 12).join(", ")}…`).toBe(0);
    expect(await atBottom(page)).toBe(true);
  });

  test("設定の面から会話へ戻っても、先頭から滑り落ちない", async ({ page }) => {
    await fillConversation(page);
    // 面を開くとチャットは作り直される。戻ったときが `initial` の出番——
    // ここが spring だと、保存された会話を復元してから最下部まで延々と滑る
    await page.locator(".pin-tab").last().click();
    await expect(page.locator(".chat-scroll")).toBeHidden();

    const samples = await samplePositions(page, () =>
      page.locator(".thread-tab").first().click()
    );
    const settled = samples[samples.length - 1] ?? 0;
    expect(settled, "戻ったのに中身が無い").toBeGreaterThan(0);
    const slid = samples.filter((v) => v > 0 && v < settled * 0.5);
    expect(slid.length, `戻りが滑っている: ${samples.slice(0, 12).join(", ")}…`).toBe(0);
    expect(await atBottom(page)).toBe(true);
  });
});

test.describe("会話ごとの状態", () => {
  test("下書きは会話ごとに分かれる（移っても混ざらない）", async ({ page }) => {
    const input = page.locator(".chat-input");
    await input.fill("こちらの会話の書きかけ");

    await page.locator(".thread-tab", { hasText: "別の会話" }).click();
    await expect(input).toHaveValue("", { timeout: 2000 });
    await input.fill("あちらの会話の書きかけ");

    await page.locator(".thread-tab").first().click();
    await expect(input).toHaveValue("こちらの会話の書きかけ");
    await page.locator(".thread-tab", { hasText: "別の会話" }).click();
    await expect(input).toHaveValue("あちらの会話の書きかけ");
  });

  test("モデルも会話ごと。切り替えると表示も入れ替わる", async ({ page }) => {
    const trigger = page.locator(".model-select-trigger");
    await expect(trigger).toHaveText(/qwen3\.6-35b/);

    await page.locator(".thread-tab", { hasText: "別の会話" }).click();
    await expect(trigger).toHaveText(/claude-opus-5/);

    await page.locator(".thread-tab").first().click();
    await expect(trigger).toHaveText(/qwen3\.6-35b/);
  });

  test("モデルの切替は、いま見ている会話を宛先にする", async ({ page }) => {
    await page.locator(".thread-tab", { hasText: "別の会話" }).click();
    await page.locator(".model-select-trigger").click();
    await page.locator(".model-select-search").fill("Qwen");
    await page.locator(".model-select-item").click();

    await expect
      .poll(() => host.received.find((m) => m["type"] === "set_model"))
      .toEqual({
        type: "set_model",
        threadId: OTHER_THREAD_ID,
        provider: "huihui",
        model: "qwen3.6-35b",
      });
  });
});

test.describe("文脈の使用量", () => {
  test("届くまで出さず、届いたら割合で出す", async ({ page }) => {
    const meter = page.locator(".context-meter");
    // ターンが回っていないうちは何も出さない（0% と偽らない）
    await expect(meter).toHaveCount(0);

    host.emit({ type: "context_state", tokens: 40000 });
    await expect(meter).toHaveText(/20%/);
    await expect(meter).toHaveAttribute("title", /40,000 \/ 200,000/);

    // 逼迫したら色で知らせる
    host.emit({ type: "context_state", tokens: 190000 });
    await expect(meter).toHaveText(/95%/);
    await expect(meter).toHaveClass(/is-full/);
  });

  test("使用量は会話ごと。移ると入れ替わる", async ({ page }) => {
    host.emit({ type: "context_state", tokens: 40000 });
    await expect(page.locator(".context-meter")).toHaveText(/20%/);

    await page.locator(".thread-tab", { hasText: "別の会話" }).click();
    // あちらはまだターンが回っていない
    await expect(page.locator(".context-meter")).toHaveCount(0);

    await page.locator(".thread-tab").first().click();
    await expect(page.locator(".context-meter")).toHaveText(/20%/);
  });

  test("モデル一覧に文脈の長さが出る", async ({ page }) => {
    await page.locator(".model-select-trigger").click();
    await expect(page.locator(".model-select-item").first()).toContainText("200k");
  });
});

test.describe("新しい会話", () => {
  test("開いた直後からモデルが出ている", async ({ page }) => {
    const trigger = page.locator(".model-select-trigger");
    await expect(trigger).toHaveText(/qwen3\.6-35b/);

    // ＋（新しい会話）を押す
    await page.locator(".thread-new-btn").click();
    await expect(page.locator(".thread-tab", { hasText: "新しい会話" })).toBeVisible();

    // 一覧が更新されただけの会話でも、モデルが空にならない
    await expect(trigger).toHaveText(/qwen3\.6-35b/);
    await expect(trigger).not.toHaveText(/^モデル/);
  });
});

test.describe("送信したら最下部へ戻って応答を追う", () => {
  test("上を読んでいる途中でも、自分が送ったら下へ戻る", async ({ page }) => {
    await fillConversation(page);
    await page.locator(".chat-scroll").hover();
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(200);
    expect(await atBottom(page)).toBe(false);

    await page.locator(".chat-input").fill("次はこれをお願いします");
    await page.locator(".composer-submit").click();
    await page.waitForTimeout(800);

    expect(await atBottom(page)).toBe(true);

    // そのまま応答も追いかける
    host.emit({ type: "turn_start" });
    for (let i = 0; i < 20; i++) host.emit({ type: "text_delta", delta: `返事 ${i}\n\n` });
    host.emit({ type: "turn_end" });
    await page.waitForTimeout(900);
    expect(await atBottom(page)).toBe(true);
  });
});

test.describe("モデル選択（AI Elements の PromptInputModelSelect）", () => {
  test("いまのモデルが出て、選ぶとホストへ切替を送る", async ({ page }) => {
    const trigger = page.locator(".model-select-trigger");
    await expect(trigger).toHaveText(/qwen3\.6-35b/);

    await trigger.click();
    // 番頭が使えるものだけ並ぶ（職人専用は出さない）
    await expect(page.locator(".model-select-item")).toHaveCount(2);
    await expect(page.locator(".model-select-menu")).not.toContainText("職人専用");
    // プロバイダごとにまとまる
    await expect(page.locator(".model-select-group")).toHaveText(["huihui", "anthropic"]);
    // いま使っているものに印が付く
    await expect(page.locator(".model-select-item.is-current")).toContainText("Qwen 3.6 35B");

    await page.locator(".model-select-search").fill("opus");
    await expect(page.locator(".model-select-item")).toHaveCount(1);
    await page.locator(".model-select-item").click();

    // UI は自分で切り替えたことにしない。ホストへ送るだけ（D3）
    await expect
      .poll(() => host.received.find((m) => m["type"] === "set_model"))
      .toEqual({
        type: "set_model",
        threadId: THREAD_ID,
        provider: "anthropic",
        model: "claude-opus-5",
      });
    await expect(trigger).toHaveText(/qwen3\.6-35b/);

    // ホストが認めて配り直したら、そこで表示が変わる
    host.emit({ type: "model_state", provider: "anthropic", id: "claude-opus-5", vision: true });
    await expect(trigger).toHaveText(/claude-opus-5/);
  });
});

test.describe("思考の表示（AI Elements の Reasoning）", () => {
  test("考えている間は開いて出し、終わったら1秒ほどで畳む", async ({ page }) => {
    host.emit({ type: "turn_start" });
    host.emit({ type: "reasoning_delta", delta: "まず前提を確かめる。" });
    await expect(page.locator(".msg--reasoning")).toBeVisible();
    // 考えている間は見出しが光り、中身が見えている
    await expect(page.locator(".shimmer")).toHaveText("考えています");
    await expect(page.locator(".reasoning-body")).toBeVisible();

    host.emit({ type: "reasoning_end", durationMs: 3200 });
    host.emit({ type: "turn_end" });

    // 考えていた時間が出る
    await expect(page.locator(".reasoning-head")).toContainText("4秒間考えました");
    // 1秒後に畳まれる（読み終わる頃には本文の邪魔になるため）
    await expect(page.locator(".reasoning-body")).toBeHidden({ timeout: 3000 });
  });
});

test.describe("ツールの表示（AI Elements の Tool）", () => {
  test("名前と状態の札が出て、開くと引数と結果が読める", async ({ page }) => {
    host.emit({ type: "turn_start" });
    host.emit({
      type: "tool_start",
      toolCallId: "c1",
      name: "file.read",
      input: { path: "docs/vision.md" },
    });
    await expect(page.locator(".msg--tool")).toBeVisible();
    await expect(page.locator(".tool-badge")).toHaveText("実行中");

    host.emit({
      type: "tool_end",
      toolCallId: "c1",
      name: "file.read",
      isError: false,
      output: { lines: 42 },
    });
    host.emit({ type: "turn_end" });
    await expect(page.locator(".tool-badge")).toHaveText("完了");

    // 既定では畳んでおく（1ターンに何度も走るので、開いたままだと会話が埋まる）
    await expect(page.locator(".tool-detail")).toBeHidden();
    await page.locator(".tool-head").click();
    await expect(page.locator(".tool-detail")).toContainText("docs/vision.md");
    await expect(page.locator(".tool-detail")).toContainText("42");
  });
});

test.describe("コンポーザ（AI Elements の PromptInput）", () => {
  test("送信ボタンは状態で姿を変える（送る→独楽→中断）", async ({ page }) => {
    const submit = page.locator(".composer-submit");
    // 何も書いていなければ押せない
    await expect(submit).toBeDisabled();
    await expect(submit).toHaveText("↵");

    await page.locator(".chat-input").fill("お願いします");
    await expect(submit).toBeEnabled();

    // 送ったが返事はまだ＝独楽
    host.emit({ type: "turn_start" });
    await expect(submit.locator(".loader")).toBeVisible();

    // 喋り始めたら中断（四角）に変わる
    host.emit({ type: "text_delta", delta: "はい" });
    await expect(submit.locator(".composer-submit-stop")).toBeVisible();

    host.emit({ type: "turn_end" });
    await expect(submit).toHaveText("↵");
  });

  test("入力欄は 192px までしか伸びない", async ({ page }) => {
    const input = page.locator(".chat-input");
    await input.fill("行\n".repeat(60));
    const height = await input.evaluate((el) => el.getBoundingClientRect().height);
    expect(height).toBeLessThanOrEqual(192);
    expect(height).toBeGreaterThan(120);
  });
});
