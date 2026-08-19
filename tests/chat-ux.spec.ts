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

/**
 * 会話の名前。**真実はホスト側**なので、ここに置いて `thread_rename` で書き換える
 * （UI は投げるだけで楽観更新しない＝返ってきた `thread_state` で初めて字が変わる）。
 */
const titles: Record<string, string> = { [THREAD_ID]: "会話", [OTHER_THREAD_ID]: "別の会話" };

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
                  policy: ["host", "worker"],
                },
                {
                  providerId: "anthropic",
                  id: "claude-opus-5",
                  name: "Claude Opus 5",
                  tier: "reasoning",
                  vision: true,
                  free: false,
                  policy: ["host", "worker"],
                },
                {
                  providerId: "huihui",
                  id: "worker-only",
                  name: "職人専用",
                  tier: "fast",
                  vision: false,
                  free: true,
                  policy: ["worker"],
                },
              ],
            },
          })
        );
        return;
      }
      // モデル選択（PromptInputModelSelect）が取りに来る一覧。バックエンド → プロバイダ
      // → モデル の3段（PO裁定 2026-08-13）。**番頭が使えるものだけ**を返す
      // （職人専用は既にホスト側で弾かれている想定なので、ここにも載せない）
      if (url === "/api/settings/tools/settings.harness_models") {
        res.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            content: [{ type: "text", text: "1 個のバックエンド" }],
            details: {
              backends: [
                {
                  id: "pi",
                  label: "pi",
                  providers: [
                    {
                      id: "huihui",
                      models: [
                        {
                          id: "qwen3.6-35b",
                          name: "Qwen 3.6 35B",
                          vision: false,
                          contextWindow: 200000,
                        },
                      ],
                    },
                    {
                      id: "anthropic",
                      models: [{ id: "claude-opus-5", name: "Claude Opus 5", vision: true }],
                    },
                  ],
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
              { ...thread(THREAD_ID, titles[THREAD_ID]!, true), model: MODEL_A },
              { ...thread(OTHER_THREAD_ID, titles[OTHER_THREAD_ID]!, false), model: MODEL_B },
              { ...thread(id, "新しい会話", false), model: MODEL_A },
            ],
          });
          host.broadcast({ type: "history", threadId: id, entries: [] });
          host.broadcast({ type: "canvas_state", threadId: id, tabs: [], activeTabId: undefined });
        }
        // 名前を付け直す経路（PO要望 2026-08-05）。本物と同じく一覧を配り直して知らせる
        if (message["type"] === "thread_rename") {
          titles[String(message["threadId"])] = String(message["title"]);
          host.broadcast({
            type: "thread_state",
            threads: [
              { ...thread(THREAD_ID, titles[THREAD_ID]!, true), model: MODEL_A },
              { ...thread(OTHER_THREAD_ID, titles[OTHER_THREAD_ID]!, false), model: MODEL_B },
            ],
          });
        }
      });
      // 接続直後に流れるもの（UIが会話面を描き始めるのに要る最小限）
      host.sendTo(socket, {
        type: "welcome",
        sessionId: "fake",
        threads: [
          { ...thread(THREAD_ID, titles[THREAD_ID]!, true), model: MODEL_A },
          { ...thread(OTHER_THREAD_ID, titles[OTHER_THREAD_ID]!, false), model: MODEL_B },
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
  // 名前は次のテストへ持ち越さない（改名のテストが他の検証の前提を壊す）
  titles[THREAD_ID] = "会話";
  titles[OTHER_THREAD_ID] = "別の会話";
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
  // 枝を開くと列は2本になる（決定79）。**見ているのは最後に開いた紙**
  return page
    .locator(".chat-scroll")
    .last()
    .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight <= 70);
}

/**
 * **人が章を区切る口**（提案§3.2 の人側・決定25）。
 *
 * 自動で畳むのは文脈の量が閾値に達したときだけ。「この話は終わった」は量では拾えない
 * ので、人にも同じことができる。**文脈の目盛りの隣**に置く——押す気になるのは
 * 目盛りを見たときなので、離すと探させることになる（D7）。
 */
test.describe("章を区切る（人側）", () => {
  test("目盛りの隣にあり、押すと chapter_close が飛ぶ", async ({ page }) => {
    const button = page.locator(".chapter-close");
    await expect(button).toBeVisible();

    // 入力の脇の並びに居る（文脈の目盛りと同じ列）。**探させない**——目盛りは実測が
    // 届くまで出ないので（I1）、ここでは列そのものを見る
    const actions = page.locator(".chat-actions");
    await expect(actions.locator(".model-select")).toBeVisible();
    await expect(actions.locator(".chapter-close")).toBeVisible();

    await button.click();
    await expect
      .poll(() => host.received.find((m) => m["type"] === "chapter_close"))
      .toEqual({ type: "chapter_close", threadId: THREAD_ID });
  });

  test("番頭が喋っている最中は押せない（道具の途中で文脈を消さない）", async ({ page }) => {
    host.emit({ type: "turn_start" });
    await expect(page.locator(".chapter-close")).toBeDisabled();

    host.emit({ type: "turn_end" });
    await expect(page.locator(".chapter-close")).toBeEnabled();
  });

  /**
   * **押したことが見え、畳んだ場所に線が残る**（PO報告 2026-08-11）。
   *
   * 引き継ぎ資料は別のモデルが書くので十数秒かかることがあり、その間ホストからは
   * 何も来ない——押しても無反応に見えていた。
   */
  test("押している間はそれと分かり、畳めると細い区切りの線が入る", async ({ page }) => {
    const button = page.locator(".chapter-close");
    await button.click();
    // 資料を書いている間。**二度押しできない**（押し直しても2章にはならない）
    await expect(button).toHaveClass(/is-folding/);
    await expect(button).toBeDisabled();
    await expect(page.locator(".chapter-mark")).toHaveCount(0);

    host.emit({ type: "chapter_closed", chapter: 3, topic: "孤児リソースの一掃", at: new Date().toISOString() });

    const mark = page.locator(".chapter-mark");
    await expect(mark).toBeVisible();
    await expect(mark).toContainText("第3章までを畳みました");
    await expect(mark).toContainText("孤児リソースの一掃");
    // **切るのではなく仕切る**——線は左右に伸び、真ん中に何の話だったかが載る
    await expect(mark.locator(".chapter-mark-rule")).toHaveCount(2);
    await expect(button).not.toHaveClass(/is-folding/);
    await expect(button).toBeEnabled();
  });

  test("畳めなかったときも押しっぱなしにしない（理由が会話に出る）", async ({ page }) => {
    const button = page.locator(".chapter-close");
    await button.click();
    await expect(button).toBeDisabled();

    host.emit({ type: "error", message: "畳むものがまだありません" });

    await expect(button).toBeEnabled();
    await expect(page.locator(".chat-scroll")).toContainText("畳むものがまだありません");
  });
});

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

  /**
   * ↓は**帯の真ん中**（PO要望 2026-08-11）。右端は親指から遠い——押すのは
   * 「遡って読んでいて、いまの話に戻りたい」ときなので、手が伸びる場所に置く。
   */
  test("↓は会話の帯の真ん中に出る", async ({ page }) => {
    await fillConversation(page);
    await page.locator(".chat-scroll").hover();
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(200);

    const jump = (await page.locator(".chat-to-bottom").boundingBox())!;
    const room = (await page.locator(".room").first().boundingBox())!;
    const jumpCenter = jump.x + jump.width / 2;
    const roomCenter = room.x + room.width / 2;
    // 帯の中央から半径 2px（丸めの誤差ぶん）に居る
    expect(Math.abs(jumpCenter - roomCenter)).toBeLessThanOrEqual(2);
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

  /**
   * inc-0048。**猶予（時間）ではなく掛け金（状態）で持つ**ことの確かめ。
   *
   * 以前は「直前 400ms に仕草があったか」で見ていたので、上げたまま読んでいる間に
   * 判定が走ると猶予を過ぎていて下へ引き戻された。**何秒経っても・何回届いても**
   * 戻らないことを見る（1回ぶんの待ちでは、時間で見ている実装も通ってしまう）。
   */
  test("上げたまま読んでいる間は、何度届いても戻らない（時間で緩まない）", async ({ page }) => {
    await fillConversation(page);

    await page.locator(".chat-scroll").hover();
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(200);
    const before = await page.locator(".chat-scroll").evaluate((el) => el.scrollTop);

    // 猶予（かつて 400ms）をとうに越える長さで、応答を3回に分けて届ける
    for (let turn = 0; turn < 3; turn++) {
      host.emit({ type: "turn_start" });
      for (let i = 0; i < 15; i++) host.emit({ type: "text_delta", delta: `${turn}-${i} 割り込み\n\n` });
      host.emit({ type: "turn_end" });
      await page.waitForTimeout(700);
      const now = await page.locator(".chat-scroll").evaluate((el) => el.scrollTop);
      expect(now, `${turn + 1} 回目の応答で下へ引き戻された`).toBe(before);
    }

    await expect(page.locator(".chat-to-bottom")).toBeVisible();
  });

  /**
   * 掛け金は**器が上へ動いたとき**だけ掛かる。触っただけ（選ぶ・押す）では掛からない
   * ——掛かると、読んでいるつもりが無いのに追従が止まって「途中で固まった」に見える。
   */
  test("触っただけでは追従は止まらない（押す・選ぶ）", async ({ page }) => {
    await fillConversation(page);

    const scroller = page.locator(".chat-scroll");
    const box = (await scroller.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(150);

    host.emit({ type: "turn_start" });
    for (let i = 0; i < 20; i++) host.emit({ type: "text_delta", delta: `追記 ${i}\n\n` });
    host.emit({ type: "turn_end" });
    await page.waitForTimeout(900);

    expect(await atBottom(page), "触っただけで追従が切れた").toBe(true);
  });

  /**
   * 掛け金が外れるのは最下部へ戻ったときだけ。**自分で下げて戻った**ときも外れる
   * （↓ボタンだけが戻り道ではない）。
   */
  test("自分で最下部まで戻すと、また追いかけ始める", async ({ page }) => {
    await fillConversation(page);

    await page.locator(".chat-scroll").hover();
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(200);
    expect(await atBottom(page)).toBe(false);

    // ↓ボタンではなく、自分で転がして戻る
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(300);
    expect(await atBottom(page), "戻り切れていない").toBe(true);

    host.emit({ type: "turn_start" });
    for (let i = 0; i < 20; i++) host.emit({ type: "text_delta", delta: `再開 ${i}\n\n` });
    host.emit({ type: "turn_end" });
    await page.waitForTimeout(900);

    expect(await atBottom(page), "戻ったのに追いかけ直していない").toBe(true);
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
        // 枝を開くと列は2本になる。**見ているのは最後に開いた紙**（決定79）
        const all = document.querySelectorAll(".chat-scroll");
        const el = all[all.length - 1];
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
    await page.locator(".hold").click();
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
    // 設定を名指しで開く（右端の pin-tab は明暗の切替になった。位置で取ると別のものを押す）
    await page.locator(".rail-btn[data-key='s']").click();
    await expect(page.locator(".chat-scroll")).toBeHidden();

    const samples = await samplePositions(page, () => page.locator(".pj").click());
    const settled = samples[samples.length - 1] ?? 0;
    expect(settled, "戻ったのに中身が無い").toBeGreaterThan(0);
    const slid = samples.filter((v) => v > 0 && v < settled * 0.5);
    expect(slid.length, `戻りが滑っている: ${samples.slice(0, 12).join(", ")}…`).toBe(0);
    expect(await atBottom(page)).toBe(true);
  });
});

test.describe("会話ごとの状態", () => {
  test("下書きは会話ごとに分かれる（移っても混ざらない）", async ({ page }) => {
    // 幹と枝は**同時に画面へ出る**（決定79）ので、どちらの入力かを名指しする
    const trunkInput = page.locator(".room--trunk .chat-input");
    const branchInput = page.locator(".room--branch .chat-input");
    await trunkInput.fill("こちらの会話の書きかけ");

    await page.locator(".hold").click();
    await expect(branchInput).toHaveValue("", { timeout: 2000 });
    await branchInput.fill("あちらの会話の書きかけ");

    // 幹はその場に残っているので、書きかけもそのまま
    await expect(trunkInput).toHaveValue("こちらの会話の書きかけ");
    await page.locator(".pj").click();
    await expect(page.locator(".room--branch")).toHaveCount(0);
    await expect(trunkInput).toHaveValue("こちらの会話の書きかけ");
    await page.locator(".hold").click();
    await expect(branchInput).toHaveValue("あちらの会話の書きかけ");
  });

  test("モデルも会話ごと。枝を開くとその枝のモデルが出る", async ({ page }) => {
    const trunkModel = page.locator(".room--trunk .model-select-trigger");
    await expect(trunkModel).toHaveText(/qwen3\.6-35b/);

    await page.locator(".hold").click();
    await expect(page.locator(".room--branch .model-select-trigger")).toHaveText(/claude-opus-5/);
    // 幹のほうは変わらない（会話ごとに持つ）
    await expect(trunkModel).toHaveText(/qwen3\.6-35b/);
  });

  test("モデルの切替は、その列の会話を宛先にする", async ({ page }) => {
    await page.locator(".hold").click();
    await page.locator(".room--branch .model-select-trigger").click();
    await page.locator(".model-select-search input").fill("Qwen");
    await page.locator(".model-select-item").click();

    await expect
      .poll(() => host.received.find((m) => m["type"] === "set_model"))
      .toEqual({
        type: "set_model",
        threadId: OTHER_THREAD_ID,
        provider: "huihui",
        model: "qwen3.6-35b",
        backend: "pi",
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

  test("使用量は会話ごと。枝には枝の分だけ出る", async ({ page }) => {
    host.emit({ type: "context_state", tokens: 40000 });
    await expect(page.locator(".room--trunk .context-meter")).toHaveText(/20%/);

    await page.locator(".hold").click();
    // 枝はまだターンが回っていない（0% と偽らない・I1）
    await expect(page.locator(".room--branch .context-meter")).toHaveCount(0);
    await expect(page.locator(".room--trunk .context-meter")).toHaveText(/20%/);
  });

  /**
   * [PO報告 2026-08-14] 章を畳んでも前章の値を出し続けていた。
   *
   * ホストは `markChapter` で `tokens` を省略した `context_state` を配る
   * （`server.ts`）。省略＝「まだ分からない」で、`ContextMeter` は
   * 既に `tokens === undefined` を「出さない」で扱っている（0% とも偽らない）。
   */
  test("章を畳むと目盛りは消える（前章の値を出し続けない）", async ({ page }) => {
    const meter = page.locator(".context-meter");
    host.emit({ type: "context_state", tokens: 40000 });
    await expect(meter).toHaveText(/20%/);

    host.emit({ type: "context_state" });
    host.emit({ type: "chapter_closed", chapter: 2, topic: "テスト章", at: new Date().toISOString() });

    await expect(meter).toHaveCount(0);
  });

  test("モデル一覧に文脈の長さが出る", async ({ page }) => {
    await page.locator(".model-select-trigger").click();
    await expect(page.locator(".model-select-item").first()).toContainText("200k");
  });
});

test.describe("枝を開く口は会話の中だけ（PO裁定 2026-08-10）", () => {
  test("レールに枝を開く口も、面を開く口も無い", async ({ page }) => {
    // 枝は番頭が会話の中で開くか、POが会話で指示する。**行き先の帯に「作る」口を混ぜない**
    await expect(page.locator(".hold-new")).toHaveCount(0);
    await expect(page.locator(".rail-work")).toHaveCount(0);
    // 面もレールからは開かない（会話に残る「面への口」から開き直す）
    await expect(page.locator(".canvas-catalog-btn")).toHaveCount(0);
  });
});

/**
 * 会話の名前を変える（PO要望 2026-08-05・決定25 の人側）。
 *
 * **会話のタブが無くなった**（ADR-0017 決定77）ので、名付けの口は列の頭に移した。
 * 見たいのは「題を押して打って Enter」でホストへ `thread_rename` が飛び、
 * **返ってきた一覧で**字が変わること。UI 側で先に書き換えていないことも併せて見る（D3）。
 */
test.describe("会話の名前を変える", () => {
  test("題を押して Enter でホストへ届き、字が変わる", async ({ page }) => {
    await page.locator(".hold").click();
    await page.locator(".room--branch .room-title").click();

    const input = page.locator(".room--branch .tt-rename");
    await expect(input).toBeVisible();
    await expect(input).toHaveValue("別の会話");
    await input.fill("認証の設計");
    await input.press("Enter");

    await expect
      .poll(() => host.received.find((m) => m["type"] === "thread_rename"))
      .toEqual({ type: "thread_rename", threadId: OTHER_THREAD_ID, title: "認証の設計" });
    await expect(page.locator(".room--branch .room-title")).toHaveText("認証の設計");
  });

  test("Esc でやめると、名前は変わらずホストへも投げない", async ({ page }) => {
    await page.locator(".hold").click();
    await page.locator(".room--branch .room-title").click();
    await page.locator(".room--branch .tt-rename").fill("書きかけ");
    await page.locator(".room--branch .tt-rename").press("Escape");

    await expect(page.locator(".tt-rename")).toHaveCount(0);
    await expect(page.locator(".room--branch .room-title")).toHaveText("別の会話");
    await page.waitForTimeout(200);
    expect(host.received.find((m) => m["type"] === "thread_rename")).toBeUndefined();
  });

  test("空にして確定しても、名前は消えない（消す操作ではない）", async ({ page }) => {
    await page.locator(".hold").click();
    await page.locator(".room--branch .room-title").click();
    await page.locator(".room--branch .tt-rename").fill("   ");
    await page.locator(".room--branch .tt-rename").press("Enter");

    await expect(page.locator(".room--branch .room-title")).toHaveText("別の会話");
    await page.waitForTimeout(200);
    expect(host.received.find((m) => m["type"] === "thread_rename")).toBeUndefined();
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
    await expect(page.locator(".model-select-group")).toHaveText(["pi › huihui", "pi › anthropic"]);
    // いま使っているものに印が付く
    await expect(page.locator(".model-select-item.is-current")).toContainText("Qwen 3.6 35B");

    await page.locator(".model-select-search input").fill("opus");
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
        backend: "pi",
      });
    await expect(trigger).toHaveText(/qwen3\.6-35b/);

    // ホストが認めて配り直したら、そこで表示が変わる
    host.emit({ type: "model_state", provider: "anthropic", id: "claude-opus-5", vision: true });
    await expect(trigger).toHaveText(/claude-opus-5/);
  });

  /**
   * 一覧を出しても画面がずれない（PO報告 2026-08-06）。
   *
   * 押した脇に開いていたころは、チャット欄が右端にあるせいで一覧が画面からはみ出し、
   * 横スクロールが生えて**画面全体が横へずれて**いた。狭い画面ほど確実に踏むので、
   * スマホ幅で確かめる。
   */
  test("一覧を出しても横スクロールが生えない（画面がずれない）", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    const overflow = async (): Promise<number> =>
      page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await overflow()).toBeLessThanOrEqual(0);

    await page.locator(".model-select-trigger").click();
    await expect(page.locator(".model-select-menu")).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
  });

  /**
   * 絞ってから、上下と Enter で確定できる（PO要望 2026-08-06）。
   * ⌘K・場所選び・キャンバスに開くものと同じ作法（`listNav.ts`）。
   */
  test("絞り込んだあと、上下と Enter で確定できる", async ({ page }) => {
    await page.locator(".model-select-trigger").click();
    const search = page.locator(".model-select-search input");
    // 開いたらそのまま打ち始められる
    await expect(search).toBeFocused();

    // 何も打っていなくても先頭に当たっている（そのまま Enter で決められる）
    await expect(page.locator(".model-select-item.is-on")).toContainText("Qwen 3.6 35B");

    // 下へ動かすと当たりが移る
    await search.press("ArrowDown");
    await expect(page.locator(".model-select-item.is-on")).toContainText("Claude Opus 5");
    await search.press("ArrowUp");
    await expect(page.locator(".model-select-item.is-on")).toContainText("Qwen 3.6 35B");

    // 絞ると先頭へ戻る（前の位置を覚えていると、打つたびに関係ない行が当たる）
    await search.fill("opus");
    await expect(page.locator(".model-select-item.is-on")).toContainText("Claude Opus 5");

    await search.press("Enter");
    await expect
      .poll(() => host.received.find((m) => m["type"] === "set_model"))
      .toEqual({
        type: "set_model",
        threadId: THREAD_ID,
        provider: "anthropic",
        model: "claude-opus-5",
        backend: "pi",
      });
    // 決めたら閉じる
    await expect(page.locator(".model-select-menu")).toHaveCount(0);
  });
});

/**
 * 履歴で読み返す会話は、チャット欄と同じ姿で出る（PO報告 2026-08-06）。
 *
 * ここだけ素の Markdown を並べ直していたので、番頭の落款も、思考も、道具の呼び出しも
 * 出ていなかった。**同じ会話を2通りの姿で見せない**。
 */
/**
 * 外に出るリンクは別のタブで開く（PO要望 2026-08-06）。
 *
 * Banto は開きっぱなしで使う面（会話・下書き・スクロール位置）を持っているので、
 * 同じタブで外へ出るとそれが丸ごと消える。**同じ面の中の行き先はそのまま**——
 * 押すたびに同じ画面が増えても困る。
 */
test.describe("外部リンク", () => {
  test("番頭の応答の中の外部リンクは別タブ、面の中の行き先はそのまま", async ({ page }) => {
    host.emit({ type: "turn_start" });
    host.emit({
      type: "text_delta",
      delta: "[外](https://example.com/a) と [中](/env/1/) と [印](#見出し)",
    });
    host.emit({ type: "turn_end" });

    const links = page.locator(".msg--banto a");
    await expect(links).toHaveCount(3);
    await expect(links.nth(0)).toHaveAttribute("target", "_blank");
    await expect(links.nth(0)).toHaveAttribute("rel", /noreferrer/);
    // 同じオリジンの行き先は別タブにしない
    await expect(links.nth(1)).not.toHaveAttribute("target", "_blank");
    await expect(links.nth(2)).not.toHaveAttribute("target", "_blank");
  });
});

/**
 * 符牒（spec-design §8.1）と ⌘K から会話へ飛んだら、そのまま話しかけられる
 * （PO要望 2026-08-06）——キーで開いたのに、話しかけるのにマウスへ持ち替えるのでは
 * 近道にならない。
 */
test.describe("キーだけで会話へ入る", () => {
  test("f で符牒が出て、もう一度 f で消える", async ({ page }) => {
    const html = page.locator("html");
    await expect(html).not.toHaveClass(/is-alt/);

    await page.keyboard.press("f");
    await expect(html).toHaveClass(/is-alt/);

    // 出したキーで畳める（Esc や画面のどこかを押すために指を置き直さない）
    await page.keyboard.press("f");
    await expect(html).not.toHaveClass(/is-alt/);
  });

  /**
   * 札は**どの家でも器の内側**に描く（PO報告 2026-08-06）。
   *
   * 器の外へ吊っていたころは、密度の高い家（符牒＝上段が 52px から 44px へ詰まる）で
   * 札の上端が画面の外へ出て切れていた。**外へ吊る限り、家ごとに切れるかどうかが変わる**
   * ——持ち込みの家（spec-design §6.3）はこちらが高さを決められないので、位置で凌げない。
   */
  for (const family of ["washi", "fucho"]) {
    test(`札が器から食み出さない：${family}`, async ({ page }) => {
      await page.evaluate((f) => localStorage.setItem("banto.theme", `${f}:light`), family);
      await page.reload();
      await page.waitForSelector(".shell");
      await page.keyboard.press("f");
      await expect(page.locator("html")).toHaveClass(/is-alt/);
      /* 札は出るときに跳ねる（`key-pop` .12s）。**跳ねている最中は transform が動いている**
         ので、収まったのを待ってから測る——待たないと、途中の姿を測って嘘の答えが出る */
      await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));

      /**
       * 札は `::after` なので `getBoundingClientRect` が取れない。**描かれる矩形を組み立てて**
       * 測る——オフセットの符号だけを見ると、縦の真ん中に置く家（transform を使う）で
       * 嘘の答えが出る（`bottom` が負になるが、実際は器の中にいる）。
       */
      const spilled = await page.evaluate(() => {
        const out: Array<{ key: string; why: string }> = [];
        for (const el of document.querySelectorAll("[data-key]")) {
          const box = el.getBoundingClientRect();
          if (box.width === 0) continue; // 描かれていないもの（狭い画面で畳んだ分）
          const cs = getComputedStyle(el, "::after");
          if (cs.content === "none" || cs.content === "") continue; // 札が出ていない
          const key = el.getAttribute("data-key") ?? "?";
          const shift = new DOMMatrixReadOnly(cs.transform === "none" ? undefined : cs.transform);
          const w = parseFloat(cs.width);
          const h = parseFloat(cs.height);

          const top = box.top + parseFloat(cs.top) + shift.f;
          const left = Number.isNaN(parseFloat(cs.left))
            ? box.right - parseFloat(cs.right) - w + shift.e
            : box.left + parseFloat(cs.left) + shift.e;

          const slack = 0.5;
          if (top < box.top - slack) out.push({ key, why: `上へ食み出す（${top} < ${box.top}）` });
          if (top + h > box.bottom + slack) out.push({ key, why: "下へ食み出す" });
          if (left < box.left - slack) out.push({ key, why: "左へ食み出す" });
          if (left + w > box.right + slack) out.push({ key, why: "右へ食み出す" });
          if (top < 0) out.push({ key, why: "画面の外へ出ている" });
        }
        return out;
      });
      expect(spilled, `器の外へ出ている札: ${JSON.stringify(spilled)}`).toEqual([]);
    });
  }

  test("符牒で会話へ飛ぶと、番頭への入力に移っている", async ({ page }) => {
    await page.keyboard.press("f");
    await page.keyboard.press("2");

    await expect(page.locator(".room--branch .room-title")).toHaveText("別の会話");
    await expect(page.locator(".room--branch .chat-input")).toBeFocused();
    // 符牒は畳まれている（押したら消える）
    await expect(page.locator("html")).not.toHaveClass(/is-alt/);
  });

  test("⌘K から会話を開いても、番頭への入力に移っている", async ({ page }) => {
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.locator(".cp")).toBeVisible();

    await page.locator(".cp-input").fill("別の会話");
    await page.locator(".cp-input").press("Enter");

    await expect(page.locator(".cp")).toHaveCount(0);
    await expect(page.locator(".room--branch .room-title")).toHaveText("別の会話");
    await expect(page.locator(".room--branch .chat-input")).toBeFocused();
  });

  test("面を見に行くときは入力へ移さない（話しかけに行ったのではない）", async ({ page }) => {
    await page.keyboard.press("ControlOrMeta+k");
    await page.locator(".cp-input").fill("設定を開く");
    await page.locator(".cp-input").press("Enter");

    await expect(page.locator(".chat-input")).toHaveCount(0);
  });
});

test.describe("履歴の会話ログ", () => {
  test("チャット欄と同じ部品（落款・思考・道具）で描く", async ({ page }) => {
    // 中身を入れてから、ホストが「畳んだ」と配り直す（畳むのはホストの仕事。D3）
    host.emit({
      type: "history",
      threadId: OTHER_THREAD_ID,
      entries: [
        { role: "po", text: "これを調べてください" },
        { role: "reasoning", text: "まず場所を確かめる", durationMs: 2000 },
        { role: "tool", name: "file.read", state: "ok", input: { path: "a.ts" }, output: "中身" },
        { role: "banto", text: "**調べました**。" },
      ],
    });
    host.broadcast({
      type: "thread_state",
      threads: [
        { ...thread(THREAD_ID, titles[THREAD_ID]!, true), model: MODEL_A },
        {
          ...thread(OTHER_THREAD_ID, titles[OTHER_THREAD_ID]!, false),
          model: MODEL_B,
          // 履歴に並ぶのは**終えた幹**（PO裁定 2026-08-10）
          kind: "trunk",
          parentId: undefined,
          returnCondition: undefined,
          state: "closed",
          closedAt: "2026-08-06T00:00:00.000Z",
        },
      ],
    });
    await page.locator(".rail-btn[data-key='h']").click();
    // 履歴を開いた直後に出ているのは「枝」（PO報告 2026-08-14）。終えた幹は隣のタブ
    await page.locator(".history-tabs .cv-seg-opt", { hasText: "幹" }).click();
    await page.locator(".history-row", { hasText: "別の会話" }).click();

    const log = page.locator(".history-read-scroll");
    // 番頭の発話は落款つき（.msg--banto）。素の Markdown ではない
    await expect(log.locator(".msg--banto")).toContainText("調べました");
    await expect(log.locator(".msg--banto strong")).toHaveText("調べました");
    await expect(log.locator(".msg--po")).toContainText("これを調べてください");
    // 思考と道具の呼び出しも、チャット欄と同じ畳んだ姿で出る
    await expect(log.locator(".msg--reasoning")).toContainText("2秒間考えました");
    await expect(log.locator(".msg--reasoning .reasoning-body")).toBeHidden();
    await expect(log.locator(".msg--tool .tool-name")).toHaveText("file.read");
    // 畳んである道具を開くと、引数と結果まで読める
    await log.locator(".tool-head").click();
    await expect(log.locator(".tool-detail")).toContainText("a.ts");
  });
});

test.describe("思考の表示（AI Elements の Reasoning）", () => {
  test("考えている間も本文は畳んで出し、見出しで開け閉めできる", async ({ page }) => {
    host.emit({ type: "turn_start" });
    host.emit({ type: "reasoning_delta", delta: "まず前提を確かめる。" });
    await expect(page.locator(".msg--reasoning")).toBeVisible();
    // 考えている間は見出しが光る。本文は既定で畳んだまま（PO 2026-08）
    await expect(page.locator(".shimmer")).toHaveText("考えています");
    await expect(page.locator(".reasoning-body")).toBeHidden();

    // 見出しを押すと開き、もう一度押すと閉じる（手動トグル）
    await page.locator(".reasoning-head").click();
    await expect(page.locator(".reasoning-body")).toBeVisible();
    await expect(page.locator(".reasoning-body")).toHaveText("まず前提を確かめる。");
    await page.locator(".reasoning-head").click();
    await expect(page.locator(".reasoning-body")).toBeHidden();

    host.emit({ type: "reasoning_end", durationMs: 3200 });
    host.emit({ type: "turn_end" });

    // 考えていた時間が出る。本文は閉じたまま（既定）
    await expect(page.locator(".reasoning-head")).toContainText("4秒間考えました");
    await expect(page.locator(".reasoning-body")).toBeHidden();
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

/**
 * 届いた分がそのまま画面に出ること。
 *
 * PO報告 2026-08-05：**会話の途中で数文字だけ出て止まり、リロードすると全文が出る**。
 * 差分を既存の行に in-place で書き足していたため、`React.memo` の `ChatRow` が
 * 「props は変わっていない」と判断して描き直しを飛ばしていた——止まったのは通信ではなく
 * 描画の方で、リロードすると history から新しい行として作り直されるので全文が出ていた。
 *
 * ここでは**次の行も turn_end も足さずに**、差分だけで伸びることを見る（それが再現条件）。
 */
test.describe("届いた分がそのまま出る", () => {
  test("本文は差分が届くたびに伸びる", async ({ page }) => {
    host.emit({ type: "turn_start" });
    host.emit({ type: "text_delta", delta: "ブラ" });
    await expect(page.locator(".msg--banto")).toHaveText("ブラ");

    host.emit({ type: "text_delta", delta: "ンチ一覧に " });
    host.emit({ type: "text_delta", delta: "feature/test はありません。" });
    // turn_end を送らないまま確かめる（送ると別の理由で描き直されてしまい、再現しない）
    await expect(page.locator(".msg--banto")).toHaveText(
      "ブランチ一覧に feature/test はありません。"
    );
    host.emit({ type: "turn_end" });
  });

  test("思考も差分が届くたびに伸びる", async ({ page }) => {
    host.emit({ type: "turn_start" });
    host.emit({ type: "reasoning_delta", delta: "まず" });
    // 本文は既定で畳んでいるので、見出しを押して開けてから差分を見る
    await page.locator(".reasoning-head").click();
    await expect(page.locator(".reasoning-body")).toHaveText("まず");
    host.emit({ type: "reasoning_delta", delta: "前提を確かめる。" });
    await expect(page.locator(".reasoning-body")).toHaveText("まず前提を確かめる。");
    host.emit({ type: "turn_end" });
  });

  test("ツールの札は tool_end で切り替わる（次の行を待たない）", async ({ page }) => {
    host.emit({ type: "turn_start" });
    host.emit({ type: "tool_start", toolCallId: "c1", name: "worker.close", input: {} });
    await expect(page.locator(".tool-badge")).toHaveText("実行中");

    host.emit({ type: "tool_end", toolCallId: "c1", name: "worker.close", isError: false, output: "ok" });
    // turn_end も次の行も無しに、札だけで切り替わること
    await expect(page.locator(".tool-badge")).toHaveText("完了");
    host.emit({ type: "turn_end" });
  });

  test("考え終わった時間も、その場で出る", async ({ page }) => {
    host.emit({ type: "turn_start" });
    host.emit({ type: "reasoning_delta", delta: "考える" });
    await expect(page.locator(".msg--reasoning")).toBeVisible();
    host.emit({ type: "reasoning_end", durationMs: 3200 });
    await expect(page.locator(".reasoning-head")).toContainText("4秒間考えました");
    host.emit({ type: "turn_end" });
  });
});

test.describe("コンポーザ（AI Elements の PromptInput）", () => {
  /**
   * 止めるのと送るのを併存させる（imp-0048・提案 §4 案I）。走っている間も
   * `.composer-submit` は送るボタンのまま——独楽を置くと「押せない」に見えるので、
   * 走行中の印は隣に出る `.composer-stop`（止める）が担う（`Room.tsx` のコメント参照）。
   */
  test("走行中は送るボタンの隣に止めるボタンが出る（送るボタン自体は変えない）", async ({ page }) => {
    const submit = page.locator(".composer-submit");
    const stop = page.locator(".composer-stop");
    // 何も書いていなければ押せない
    await expect(submit).toBeDisabled();
    // 送るの姿。絵文字をやめて線の絵にした（spec-design §4）ので、字ではなく絵で見る
    await expect(submit.locator("svg.ico")).toBeVisible();
    await expect(stop).toHaveCount(0);

    await page.locator(".chat-input").fill("お願いします");
    await expect(submit).toBeEnabled();

    // 送ったが返事はまだ＝止めるボタンが並ぶ。送るボタン自体は変わらない
    host.emit({ type: "turn_start" });
    await expect(stop.locator(".composer-submit-stop")).toBeVisible();
    await expect(submit.locator("svg.ico")).toBeVisible();

    // 喋り始めても、止めるボタンは出続ける
    host.emit({ type: "text_delta", delta: "はい" });
    await expect(stop.locator(".composer-submit-stop")).toBeVisible();

    host.emit({ type: "turn_end" });
    await expect(stop).toHaveCount(0);
    await expect(submit.locator("svg.ico")).toBeVisible();
  });

  test("入力欄は 192px までしか伸びない", async ({ page }) => {
    const input = page.locator(".chat-input");
    await input.fill("行\n".repeat(60));
    const height = await input.evaluate((el) => el.getBoundingClientRect().height);
    expect(height).toBeLessThanOrEqual(192);
    expect(height).toBeGreaterThan(120);
  });
});

/**
 * **会話の中の URL とファイルパスは押せる**（PO要望 2026-08-11）。
 *
 * 押せないと、PO は URL をコピーして貼り直し、パスはファイル面を開いて辿り直すことになる
 * ——見えているのに届かない。パスは押すとファイル面がその場所（行番号があればその行）で開く。
 */
test.describe("会話の中の URL とファイルパス", () => {
  test("番頭の応答の中のパスを押すと、ファイル面がその行で開く", async ({ page }) => {
    host.emit({ type: "turn_start" });
    host.emit({
      type: "text_delta",
      delta: "直しました。詳しくは packages/banto-host/src/server.ts:1078 を見てください。\n",
    });
    host.emit({ type: "turn_end" });

    const path = page.locator(".msg--banto .linkify-path");
    await expect(path).toBeVisible();
    await expect(path).toHaveText("packages/banto-host/src/server.ts:1078");

    await path.click();
    await expect
      .poll(() => host.received.find((m) => m["type"] === "canvas_open"))
      .toMatchObject({
        type: "canvas_open",
        kind: "file.browser",
        params: { path: "packages/banto-host/src/server.ts", line: 1078 },
      });
  });

  test("PO 自身の発言の中の URL も押せる（書いたとおりに出しつつ）", async ({ page }) => {
    // 本物のホストは PO の発話を配り返す。その形をそのまま起こす
    host.emit({
      type: "po_message",
      text: "これ見て https://example.com/a と work/tasks/task-0001.md",
    });

    const mine = page.locator(".msg--po").last();
    // 書いたとおりに出る（Markdown で描き直さない）
    await expect(mine).toContainText("これ見て");
    const link = mine.locator("a");
    await expect(link).toHaveAttribute("href", "https://example.com/a");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(mine.locator(".linkify-path")).toHaveText("work/tasks/task-0001.md");
  });

  test("日本語の文や小数を巻き込まない（誤爆したリンクは読みにくい）", async ({ page }) => {
    host.emit({ type: "turn_start" });
    host.emit({ type: "text_delta", delta: "1.5 倍にしました。かつ/または で分けます。\n" });
    host.emit({ type: "turn_end" });

    await expect(page.locator(".msg--banto").last()).toContainText("1.5 倍");
    await expect(page.locator(".msg--banto .linkify-path")).toHaveCount(0);
  });
});
