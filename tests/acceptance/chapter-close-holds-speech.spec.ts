/**
 * imp-0052「畳んでいる最中の発話が止まらない」。
 *
 * 章の要約には30秒ほどかかる。その最中に PO が話しかけると、**これから捨てる
 * セッション**が答え始め、`startChapter` が走った瞬間に途中で切られていた
 * （トランスクリプトの末尾が `[Request interrupted by user]`・thread-85 第9章）。
 * PO から見ると「返事が出かかって消える」という一番気味の悪い形で出る。
 *
 * 直す向きは **捨てず・答えさせず・待たせる**。ここで固定するのは4つ:
 *   1. 畳んでいる間の発話は**古いセッションへ渡らない**
 *   2. 畳み終わったら**そのまま届く**（消えない）
 *   3. 複数届いても**順序が保たれる**
 *   4. 待たせている間、画面に理由が出る（無反応に見せない）。ただし**畳み1回につき1行**
 *
 * 門番（imp-0048 で外したもの）は戻していない——走行中の入力は今までどおり受ける。
 * 待たせるのは**畳んでいる間だけ**であることも、ここで一緒に見る。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { BantoHarness, HarnessEvent } from "@banto/core";
import {
  ThreadRegistry,
  BANTO_WS_PATH,
  BantoHostClient,
  BantoHostServer,
  type ChapterGate,
  type ServerEvent,
} from "@banto/host";
import { TRUNK } from "./threadSpecs.js";

/** ターンの終わりをこちらで決められるハーネス（`trunk-accepts-input.spec.ts` と同じ形）。 */
class GatedHarness implements BantoHarness {
  readonly backendId = "gated";
  readonly sessionId = "gated-session";
  isStreaming = false;
  /** 受けた順。捨てられていないことも、順番も、ここで見る。 */
  readonly received: string[] = [];
  /** 章を畳んだ回数。畳む前に届いたか後に届いたかを `received` と突き合わせる。 */
  chapters = 0;
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

  finishTurn(): void {
    const waiters = this.waiters;
    this.waiters = [];
    this.isStreaming = false;
    for (const resolve of waiters) resolve();
  }

  async abort(): Promise<void> {
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
  async startChapter(): Promise<void> {
    this.chapters++;
    this.received.push("[章を畳んだ]");
  }
}

/** `ChapterKeeper` の掛け金を、試験から開け閉めできる形にしたもの。 */
class FakeChapterGate implements ChapterGate {
  private gate: { promise: Promise<void>; release: () => void } | undefined;

  isClosing(): boolean {
    return this.gate !== undefined;
  }

  async whenSettled(): Promise<void> {
    const gate = this.gate;
    if (gate) await gate.promise;
  }

  /** 畳み始める（要約に入った）。 */
  begin(): void {
    let release: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.gate = { promise, release };
  }

  /** 畳み終わった（新しい章のセッションが立った）。 */
  end(): void {
    const gate = this.gate;
    this.gate = undefined;
    gate?.release();
  }
}

let server: BantoHostServer | undefined;
let harness: GatedHarness;
let gate: FakeChapterGate;

async function startHost(): Promise<string> {
  const threads = new ThreadRegistry(async () => {
    harness = new GatedHarness();
    gate = new FakeChapterGate();
    return { harness, tools: [], chapterGate: gate };
  });
  await threads.open(TRUNK);
  server = await BantoHostServer.start({ threads, port: 0 });
  return `ws://localhost:${server.port}${BANTO_WS_PATH}`;
}

async function until(what: string, ok: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!ok()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${what}; received: ${harness.received.join(" / ")}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 何も起きないことを確かめるための短い間。 */
async function quiet(ms = 150): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

const holdNotices = (events: ServerEvent[]): ServerEvent[] =>
  events.filter((e) => e.type === "notice" && e.text.includes("章を畳んでいます"));

beforeEach(() => {
  server = undefined;
});

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("[imp-0052] 畳んでいる最中の発話は、捨てず・答えさせず・待たせる", () => {
  it("畳んでいる間の発話は古いセッションへ渡らない", async () => {
    const url = await startHost();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));

    gate.begin();
    client.send({ type: "prompt", text: "畳んでいる最中の話" });

    // **渡っていないこと**を見る。渡ると、これから捨てるセッションが答え始める
    await quiet();
    assert.deepEqual(harness.received, [], "古いセッションに答えさせない");

    // 発話そのものは画面に出ている——捨ててはいない
    assert.ok(
      events.some((e) => e.type === "po_message" && e.text === "畳んでいる最中の話"),
      "待たせるのであって、なかったことにはしない"
    );
    client.close();
  });

  it("畳み終わると、待たせていた発話が新しい章のセッションへ流れる", async () => {
    const url = await startHost();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));

    gate.begin();
    client.send({ type: "prompt", text: "畳んでいる最中の話" });
    await quiet();
    assert.deepEqual(harness.received, []);

    // 新しい章のセッションが立ってから解く（`ChapterKeeper` は startChapter の後で解く）
    await harness.startChapter();
    gate.end();

    await until("待たせた発話が届く", () => harness.received.includes("畳んでいる最中の話"));
    assert.deepEqual(
      harness.received,
      ["[章を畳んだ]", "畳んでいる最中の話"],
      "**畳んだ後**に届く。前に届くと、答えかけたところで切られる"
    );
    client.close();
  });

  it("複数届いても順序が保たれ、1つも失われない", async () => {
    const url = await startHost();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));

    gate.begin();
    client.send({ type: "prompt", text: "ひとつめ" });
    client.send({ type: "prompt", text: "ふたつめ" });
    client.send({ type: "prompt", text: "みっつめ" });
    await quiet();
    assert.deepEqual(harness.received, [], "3つとも待っている");

    await harness.startChapter();
    gate.end();

    await until("3つとも届く", () => harness.received.length === 4);
    assert.deepEqual(harness.received, [
      "[章を畳んだ]",
      "ひとつめ",
      "ふたつめ",
      "みっつめ",
    ]);
    client.close();
  });

  it("待たせている間、理由が画面に出る——ただし畳み1回につき1行", async () => {
    const url = await startHost();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));

    gate.begin();
    client.send({ type: "prompt", text: "ひとつめ" });
    client.send({ type: "prompt", text: "ふたつめ" });
    client.send({ type: "prompt", text: "みっつめ" });
    await until("待たせる理由が出る", () => holdNotices(events).length >= 1);
    await quiet();

    assert.equal(holdNotices(events).length, 1, "3発話で3行並ぶのは知らせではなく雑音");

    await harness.startChapter();
    gate.end();
    await until("3つとも届く", () => harness.received.length === 4);

    // 次の畳みでは、また1行出る（黙り込まない）
    gate.begin();
    client.send({ type: "prompt", text: "次の畳みの最中" });
    await until("2回目の理由が出る", () => holdNotices(events).length === 2);
    client.close();
  });

  it("畳んでいなければ待たせない——門番は戻していない（imp-0048）", async () => {
    const url = await startHost();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));

    client.send({ type: "prompt", text: "はじめの話" });
    await until("最初のターンが走る", () => harness.received.length === 1);

    // **走っている最中**でも受ける。待たせるのは畳んでいる間だけ
    client.send({ type: "prompt", text: "走行中に足した話" });
    await until("走行中の発話が届く", () => harness.received.length === 2);

    assert.deepEqual(harness.received, ["はじめの話", "走行中に足した話"]);
    assert.equal(holdNotices(events).length, 0, "畳んでいないのに理由を出さない");
    client.close();
  });
});
