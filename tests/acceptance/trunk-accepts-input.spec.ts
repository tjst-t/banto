/**
 * imp-0048「幹は常に入力を受ける」（提案 `2026-08-15-trunk-availability.md` §4 案I）。
 *
 * 「幹で会話できない」の直接原因は機構ではなく **Web UI の門番**だった。サーバは
 * 走行中の入力を前から受けられる（`promptEvenWhileBusy` が `steer` で差し込む）のに、
 * `Room.tsx` の `submit()` が `|| busy` で**黙って捨てていた**（提案 §2.2）。
 *
 * ここで固定するのは3つ:
 *   1. 走行中に送った発話が捨てられない（画面の門番・サーバの受け口の両方）
 *   2. 中断のあと、列に残った知らせより **PO の発話が先**に処理される
 *   3. 「止めて話す」は**ホストが1通で**捌く（画面が abort と prompt を別々に送らない）
 *
 * 3つ目の `PromptQueue` の取りこぼし（§2.6-2）は `claude-agent-harness.spec.ts` 側。
 * あちらはバックエンド固有の待ち行列の話なので、置き場を分けている。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { BantoHarness, HarnessEvent } from "@banto/core";
import { JsonlMemoryStore } from "@banto/core";
import {
  ThreadRegistry,
  BANTO_WS_PATH,
  BantoHostClient,
  BantoHostServer,
  type ServerEvent,
} from "@banto/host";
import { TRUNK } from "./threadSpecs.js";

/**
 * ターンの終わりを**こちらで決められる**ハーネス。
 *
 * `FakeSession`（banto-host-server.spec.ts）の `prompt` は即座に返るので、
 * 「走っている最中」という状態が作れない。本物は `prompt()` がターンの終わりまで
 * 返らない約束なので（決定89）、そこを再現する。
 */
class GatedHarness implements BantoHarness {
  readonly backendId = "gated";
  readonly sessionId = "gated-session";
  isStreaming = false;
  /**
   * 受けた順。**捨てられていないこと**も**順番**もここで見る。
   * 中断は `[abort]` として同じ列に載せる——「止めてから話した」のか
   * 「走っているターンに融合した」のかは、順番でしか見分けられない。
   */
  readonly received: string[] = [];
  aborted = 0;
  private waiters: Array<() => void> = [];
  private readonly listeners = new Set<(event: HarnessEvent) => void>();

  subscribe(listener: (event: HarnessEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(text: string): Promise<void> {
    this.received.push(text);
    this.isStreaming = true;
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  /** 走っているターンを終わらせる（本物の `run_end`）。待っている `prompt()` を放す。 */
  finishTurn(): void {
    const waiters = this.waiters;
    this.waiters = [];
    this.isStreaming = false;
    for (const resolve of waiters) resolve();
  }

  async abort(): Promise<void> {
    this.aborted++;
    this.received.push("[abort]");
    this.finishTurn();
  }

  contextWindow(): number | undefined {
    return undefined;
  }
  contextTokens(): number | undefined {
    return undefined;
  }
  messageCount(): number {
    return 0;
  }
  transcript(): string {
    return "";
  }
  async startChapter(): Promise<void> {}
}

let dir: string;
let server: BantoHostServer | undefined;
let harness: GatedHarness;

async function startHost(options: { poFloorHoldMs?: number } = {}): Promise<string> {
  const threads = new ThreadRegistry(async () => {
    harness = new GatedHarness();
    return { harness, tools: [] };
  });
  await threads.open(TRUNK);
  server = await BantoHostServer.start({
    threads,
    port: 0,
    // 待ち時間は試験から縮める（既定の2分を待つ試験は書けない）
    poFloorHoldMs: options.poFloorHoldMs ?? 50_000,
  });
  return `ws://localhost:${server.port}${BANTO_WS_PATH}`;
}

/** 条件が満たされるまで待つ。満たされないまま時間切れなら、いま見えている列を添えて落とす。 */
async function until(
  what: string,
  ok: () => boolean,
  timeoutMs = 2000
): Promise<void> {
  const started = Date.now();
  while (!ok()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${what}; received: ${harness.received.join(" / ")}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 何も起きないことを確かめるための短い間。 */
async function quiet(ms = 120): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-trunk-input-"));
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("[imp-0048] 幹は走っている最中でも入力を受ける", () => {
  it("走行中に送った発話が捨てられず、そのままハーネスへ届く", async () => {
    const url = await startHost();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));

    client.send({ type: "prompt", text: "はじめの話" });
    await until("最初のターンが走る", () => harness.received.length === 1);

    // **走っている最中に送る**。画面の門番を外したときに届くのがこの経路
    client.send({ type: "prompt", text: "走行中に足した話" });
    await until("走行中の発話が届く", () => harness.received.length === 2);

    assert.deepEqual(harness.received, ["はじめの話", "走行中に足した話"]);
    assert.equal(harness.aborted, 0, "既定は融合——足すだけで、止めはしない");
    client.close();
  });

  it("[止めて話す] interrupt を付けると、中断してから新しいターンで話す", async () => {
    const url = await startHost();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));

    client.send({ type: "prompt", text: "はじめの話" });
    await until("最初のターンが走る", () => harness.received.length === 1);

    client.send({ type: "prompt", text: "止めて話す", interrupt: true });
    await until("止めて話すが届く", () => harness.received.includes("止めて話す"));

    assert.deepEqual(
      harness.received,
      ["はじめの話", "[abort]", "止めて話す"],
      "**止めてから**話す。融合してから止めるのでは、言ったことが前のターンに混ざる"
    );
    client.close();
  });
});

describe("[imp-0048] 中断のあと、PO の発話は知らせの列より先", () => {
  it("列に残った知らせは PO が話すまで待つ", async () => {
    const url = await startHost();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));

    client.send({ type: "prompt", text: "はじめの話" });
    await until("最初のターンが走る", () => harness.received.length === 1);

    // 知らせA は走っているターンへ融合する。知らせB はその後ろの列で待つ
    void server?.notify("知らせA", { source: "worker" });
    void server?.notify("知らせB", { source: "worker" });
    await until("知らせAが融合する", () => harness.received.length === 2);
    assert.deepEqual(harness.received, ["はじめの話", "知らせA"], "前提：Bはまだ列の中");

    // **止める。** ここで場を取らないと、放されたターンの続きで B がすぐ走り出す
    client.send({ type: "abort" });
    await until("中断が届く", () => harness.aborted === 1);
    await quiet();
    assert.deepEqual(
      harness.received,
      ["はじめの話", "知らせA", "[abort]"],
      "止めた直後に知らせBが走り出していない（＝話す隙が埋まっていない）"
    );

    // PO が話す。ここが知らせBより先に処理されるのが、この直しの眼目
    client.send({ type: "prompt", text: "止めたあとの話" });
    await until("POの発話が届く", () => harness.received.includes("止めたあとの話"));
    assert.ok(
      !harness.received.includes("知らせB"),
      "POのターンの最中にも、待っている知らせは割り込まない"
    );

    // POのターンが終われば、待たせていた知らせが流れ出す（止めっぱなしにはしない）
    harness.finishTurn();
    await until("知らせBが流れ出す", () => harness.received.includes("知らせB"));
    assert.deepEqual(harness.received, [
      "はじめの話",
      "知らせA",
      "[abort]",
      "止めたあとの話",
      "知らせB",
    ]);
    client.close();
  });

  it("PO が話さなくても、待ち時間を過ぎれば知らせは流れ出す（I2：消さない）", async () => {
    const url = await startHost({ poFloorHoldMs: 60 });
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));

    client.send({ type: "prompt", text: "はじめの話" });
    await until("最初のターンが走る", () => harness.received.length === 1);
    void server?.notify("知らせA", { source: "worker" });
    void server?.notify("知らせB", { source: "worker" });
    await until("知らせAが融合する", () => harness.received.length === 2);

    client.send({ type: "abort" });
    await until("中断が届く", () => harness.aborted === 1);

    // 中断だけして席を立った形。場は期限で返り、職人の報告は届く
    await until("待ち時間の後に知らせBが流れ出す", () => harness.received.includes("知らせB"));
    client.close();
  });
});

describe("[imp-0048] 画面の門番（Room.tsx）", () => {
  /** `.tsx` は Node のテストから import しないので、原典を読んで見る（`canvas-view-components.spec.ts` と同じ手）。 */
  function roomSource(): string {
    return fs.readFileSync(
      new URL("../../packages/banto-web/src/Room.tsx", import.meta.url).pathname,
      "utf-8"
    );
  }

  it("submit() に busy の門番が無い（走行中の発話を黙って捨てない）", () => {
    const source = roomSource();
    const submit = source.slice(source.indexOf("const submit = async"));
    const guard = submit.slice(0, submit.indexOf("setAttachError"));
    assert.ok(
      !/\bbusy\b/.test(guard),
      "送信の入口で busy を見ていない（見ていたら、走行中の発話はまた黙って捨てられる）"
    );
  });

  it("走っている間、止めるボタンと送るボタンが併存する", () => {
    const source = roomSource();
    assert.ok(source.includes("composer-stop"), "止めるボタンが独立して出る");
    assert.ok(
      /onClick=\{\(\) => void submit\(\)\}/.test(source),
      "送るボタンは状態に関わらず送る（中断ボタンに化けない）"
    );
    // 割り込みの意味論が画面に出ていること（融合なのか、止めるのか）
    assert.ok(source.includes("いまの作業に足す"), "既定は「足す」だと言っている");
    assert.ok(source.includes("止めて話す"), "「止めて話す」が別の操作として出ている");
  });
});
