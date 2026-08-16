/**
 * **常駐する SDK セッションを畳む安全弁**（task-0165）。
 *
 * ホスト（`banto.service`）が 4 回 OOM で殺された直接の原因は、畳まれないまま
 * 積み上がった Claude Code の子プロセスだった——カーネルの Tasks state ダンプで
 * 12〜13 本が 2.29〜2.40 GiB（unit の上限 3.00 GiB の 76〜80%）。1本あたり
 * anon 189〜200 MiB でほぼ一定なので、**上限に当たるのは時間ではなく本数**。
 *
 * ここで固定するのは6点:
 *   1. 触られなくなった会話の中身が畳まれる（値は設定で変えられる）
 *   2. 畳んだ会話は**札で戻る**（記録も札も購読も失わない・断り書きも喋らない）
 *   3. 応答を流している最中は畳まない（返事が途中で切れる）
 *   4. 章を畳んでいる最中も畳まない
 *   5. 本数の上限があり、超えたら**最も長く触られていないもの**から畳まれる
 *   6. 畳めなかったときに例外を握り潰さない（会話はそのまま続く）
 *
 * 実際に Claude を叩かない——中身は偽物に差し替え、**畳む／戻すの筋道だけ**を見る。
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { BantoHarness, ChapterOpening, HarnessEvent } from "@banto/core";
import {
  DEFAULT_SDK_IDLE_MS,
  DEFAULT_SDK_MAX_LIVE,
  PooledSdkHarness,
  SdkSessionPool,
} from "@banto/host";

/** 中身の代わり。子プロセスは持たないが、札と後始末の振る舞いだけ真似る。 */
class FakeInner implements BantoHarness {
  readonly backendId = "claude-agent-sdk";
  static built: FakeInner[] = [];

  disposed = false;
  streaming = false;
  turns = 0;
  /** 解決を握っておくと「応答を流している最中」を作れる。 */
  private pending: (() => void) | undefined;
  private readonly listeners = new Set<(event: HarnessEvent) => void>();
  private readonly token: string;
  /** `dispose()` を失敗させる（a7）。 */
  failDispose = false;

  constructor(readonly params: { resume?: string; model?: string; token: string }) {
    this.token = params.token;
    FakeInner.built.push(this);
  }

  get sessionId(): string {
    return this.token;
  }
  get isStreaming(): boolean {
    return this.streaming;
  }
  subscribe(handler: (event: HarnessEvent) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }
  emit(event: HarnessEvent): void {
    for (const l of [...this.listeners]) l(event);
  }
  async prompt(text: string): Promise<void> {
    this.turns++;
    // 一度往復すれば SDK 側のセッションは実在する＝札が取れる
    this.exists = true;
    this.streaming = true;
    if (this.params.model === "hold") {
      // 返らないターン（走行中を作る）
      await new Promise<void>((resolve) => {
        this.pending = resolve;
      });
    }
    this.streaming = false;
    this.emit({ type: "text", text } as unknown as HarnessEvent);
  }
  /** 握っていたターンを終わらせる。 */
  finish(): void {
    this.pending?.();
    this.pending = undefined;
  }
  async abort(): Promise<void> {
    this.streaming = false;
  }
  contextTokens(): number | undefined {
    return this.turns * 1000;
  }
  messageCount(): number {
    return this.turns;
  }
  transcript(): string {
    return `turns=${this.turns}`;
  }
  /** 掛かった章の種。**掛け直されたか**を見るために覚える。 */
  seededWith: ChapterOpening | undefined;
  /** `startChapter` の後は「まだ実在しないセッション」＝札が無い（決定97）。 */
  private exists = true;
  async startChapter(opening: ChapterOpening): Promise<void> {
    this.turns = 0;
    this.seededWith = opening;
    this.exists = false;
  }
  resumeToken(): string | undefined {
    return this.exists ? this.token : undefined;
  }
  async dispose(): Promise<void> {
    if (this.failDispose) throw new Error("子プロセスを終われませんでした");
    this.disposed = true;
  }
}

/** 試験用の時計。器へ差し込んで進める。 */
function makeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let at = start;
  return { now: () => at, advance: (ms) => (at += ms) };
}

interface Wired {
  pool: SdkSessionPool;
  logs: string[];
  clock: ReturnType<typeof makeClock>;
  /** 中身を組むのにかかる時間。試験の途中で書き換えられる（a10）。 */
  wakeCost: { ms: number };
  open(threadId: string, model?: string): PooledSdkHarness;
}

function wire(options: { idleMs?: number; maxLive?: number } = {}): Wired {
  const clock = makeClock();
  const logs: string[] = [];
  /**
   * 中身を組むのにかかる時間（a10）。**試験の中で書き換えられる**——初回の起動と
   * 起こし直しで別の値を入れると、測っているのがどちらなのかが見分けられる。
   * 既定は 0＝時計を進めない（他の試験の勘定を狂わせない）。
   */
  const wakeCost = { ms: 0 };
  const pool = new SdkSessionPool({
    ...(options.idleMs !== undefined ? { idleMs: options.idleMs } : {}),
    ...(options.maxLive !== undefined ? { maxLive: options.maxLive } : {}),
    now: clock.now,
    log: (m) => logs.push(m),
  });
  let seq = 0;
  const open = (threadId: string, model?: string): PooledSdkHarness =>
    new PooledSdkHarness({
      threadId,
      pool,
      ...(model ? { model } : {}),
      log: (m) => logs.push(m),
      create: ({ resume, model: chosen }) => {
        // 子プロセスの立ち上がりぶん。測る側から見れば「待たされる時間」そのもの
        if (wakeCost.ms > 0) clock.advance(wakeCost.ms);
        return new FakeInner({
          ...(resume !== undefined ? { resume } : {}),
          ...(chosen !== undefined ? { model: chosen } : {}),
          token: `${threadId}#${++seq}`,
        });
      },
    });
  return { pool, logs, clock, open, wakeCost };
}

beforeEach(() => {
  FakeInner.built = [];
});

describe("SDK セッションの安全弁（task-0165）", () => {
  it("a1: 触られなくなった会話の中身が畳まれる（既定は職人と同じ15分・設定で変えられる）", async () => {
    // 既定は明記されている：職人側の安全弁（DEFAULT_IDLE_TIMEOUT_MS）と同じ 15 分
    assert.equal(DEFAULT_SDK_IDLE_MS, 15 * 60 * 1000);

    const { pool, clock, open } = wire({ idleMs: 60_000 });
    const harness = open("t-1");
    await harness.prompt("こんばんは");
    assert.equal(pool.liveCount(), 1);
    const inner = FakeInner.built[0]!;

    // まだアイドルではない
    clock.advance(59_000);
    await pool.sweep();
    assert.equal(pool.liveCount(), 1);
    assert.equal(inner.disposed, false);

    // 過ぎたら畳む＝中身の dispose が呼ばれる
    clock.advance(2_000);
    await pool.sweep();
    assert.equal(pool.liveCount(), 0);
    assert.equal(inner.disposed, true);
  });

  it("a2: 畳んだ会話は札で戻り、記録も札も購読も失われない", async () => {
    const { pool, clock, open } = wire({ idleMs: 60_000 });
    const harness = open("t-1");
    const seen: HarnessEvent[] = [];
    // 購読は**皮に対して1回だけ**張る（会話の生涯そのまま）
    harness.subscribe((e) => seen.push(e));

    await harness.prompt("一言目");
    const first = FakeInner.built[0]!;
    assert.equal(seen.length, 1);
    const token = harness.resumeToken();
    assert.equal(token, "t-1#1");

    clock.advance(120_000);
    await pool.sweep();
    assert.equal(pool.liveCount(), 0);
    // 畳んでも札は残る（次の起動でも同じ会話へ戻れる）
    assert.equal(harness.resumeToken(), token);

    // 次の発話で戻る。**同じ会話の続き**として札が渡る
    await harness.prompt("二言目");
    const second = FakeInner.built[1]!;
    assert.equal(second.params.resume, token, "札を渡して組み直していない＝別の会話になる");
    assert.equal(pool.liveCount(), 1);
    // 購読は張り直さなくても届く（張り直しを忘れると画面に何も流れてこなくなる）
    assert.equal(seen.length, 2);
    // 畳む前の往復も要約へ渡る文章に残る（畳んだ区間が要約から消えない）
    assert.match(harness.transcript(), /turns=1[\s\S]*turns=1/);
    assert.equal(harness.messageCount(), 2);
    assert.notEqual(first, second);
  });

  it("a3: 応答を流している最中は、アイドルでも上限でも畳まれない", async () => {
    const { pool, clock, open } = wire({ idleMs: 60_000, maxLive: 1 });
    const busy = open("t-busy", "hold");
    const running = busy.prompt("長い調べもの");
    // 起こすのは席を空けた後（`admit` を待つ）なので、一拍おいてから見る
    await new Promise<void>((resolve) => setImmediate(resolve));
    // 走行中（`prompt` が返っていない）
    assert.equal(pool.liveCount(), 1);
    assert.equal(busy.isStreaming, true);

    // アイドル判定では畳まれない
    clock.advance(600_000);
    await pool.sweep();
    assert.equal(pool.liveCount(), 1);
    assert.equal(FakeInner.built[0]!.disposed, false);

    // 本数の上限でも畳まれない（上限は1本だが、走行中は畳めない）
    await pool.enforceLimit("t-other");
    assert.equal(FakeInner.built[0]!.disposed, false);

    FakeInner.built[0]!.finish();
    await running;
  });

  it("a4: 章を畳んでいる最中の会話は畳まれない", async () => {
    const { pool, logs, clock, open } = wire({ idleMs: 60_000 });
    void open; // 掛け金つきの皮はここで直に組む（`held` を差すため）
    let closing = false;
    const harness = new PooledSdkHarness({
      threadId: "t-1",
      pool,
      log: (m) => logs.push(m),
      held: () => closing,
      create: () => new FakeInner({ token: "t-1#1" }),
    });
    await harness.prompt("一言目");

    closing = true;
    clock.advance(600_000);
    await pool.sweep();
    assert.equal(pool.liveCount(), 1, "章を畳んでいる最中に SDK セッションを畳んだ");

    closing = false;
    await pool.sweep();
    assert.equal(pool.liveCount(), 0);
  });

  it("a5: 上限を超えたら、最も長く触られていないものから畳まれる", async () => {
    // 既定の上限は「本数×0.19 GiB ＋ node 本体 0.7 GiB ＜ 3.00 GiB」を満たす
    assert.ok(
      DEFAULT_SDK_MAX_LIVE * 0.19 + 0.7 < 3.0,
      `既定の上限 ${DEFAULT_SDK_MAX_LIVE} 本では unit の上限 3.00 GiB を超える`
    );

    const { pool, clock, open } = wire({ idleMs: 10 * 60 * 1000, maxLive: 2 });
    const a = open("t-a");
    const b = open("t-b");
    const c = open("t-c");

    await a.prompt("あ");
    clock.advance(1_000);
    await b.prompt("い");
    clock.advance(1_000);
    // ここで3本目。一番古い a が畳まれる
    await c.prompt("う");

    assert.equal(pool.liveCount(), 2);
    assert.deepEqual(pool.liveIds().sort(), ["t-b", "t-c"]);
    assert.equal(FakeInner.built[0]!.disposed, true, "最も長く触られていない a が畳まれていない");

    // a に話しかけると、こんどは b（次に古い）が畳まれる
    clock.advance(1_000);
    await a.prompt("あ2");
    assert.deepEqual(pool.liveIds().sort(), ["t-a", "t-c"]);
  });

  it("a6: 畳んだこと・戻したことが記録に残り、いま何本生きているかが読める", async () => {
    const { pool, logs, clock, open } = wire({ idleMs: 60_000, maxLive: 4 });
    const harness = open("t-1");
    await harness.prompt("一言目");
    assert.equal(pool.liveCount(), 1);
    assert.equal(pool.limit(), 4);
    assert.equal(pool.idleTimeout(), 60_000);
    assert.deepEqual(pool.liveIds(), ["t-1"]);

    clock.advance(120_000);
    await pool.sweep();
    await harness.prompt("二言目");

    const folded = logs.find((l) => l.includes("畳みました"));
    const revived = logs.find((l) => l.includes("札から戻しました"));
    assert.ok(folded, `畳んだ記録が無い: ${logs.join(" / ")}`);
    assert.ok(revived, `戻した記録が無い: ${logs.join(" / ")}`);
    // 生存本数がそのまま読める形で載っている
    assert.match(folded, /生存 0\/4 本/);
    assert.match(revived, /生存 1\/4 本/);
  });

  it("a7: 畳めなくても例外を握り潰さず記録し、会話はそのまま続けられる", async () => {
    const { pool, logs, clock, open } = wire({ idleMs: 60_000 });
    const harness = open("t-1");
    await harness.prompt("一言目");
    FakeInner.built[0]!.failDispose = true;

    clock.advance(120_000);
    // 例外は外へ漏れない
    await pool.sweep();
    const failed = logs.find((l) => l.includes("畳めませんでした"));
    assert.ok(failed, `畳めなかったことが記録に無い: ${logs.join(" / ")}`);
    assert.match(failed, /子プロセスを終われませんでした/);

    // それでも会話は続く（次の発話は新しい中身で通る）
    await harness.prompt("二言目");
    assert.equal(FakeInner.built.length, 2);
    assert.equal(pool.liveCount(), 1);
  });

  it("a8: 上限より多い会話を順に触っても、時間を進めずに本数が上限を超えない", async () => {
    const maxLive = 3;
    const { pool, open } = wire({ idleMs: 10 * 60 * 1000, maxLive });
    // 実機と同じ形：開いている会話は上限よりずっと多い
    const harnesses = Array.from({ length: 12 }, (_, i) => open(`t-${i}`));

    let peak = 0;
    for (const [i, harness] of harnesses.entries()) {
      // **時計は進めない**（実測でも上限に当たるのは時間ではなく触った本数だった）
      await harness.prompt(`${i} 言目`);
      peak = Math.max(peak, pool.liveCount());
      assert.ok(
        pool.liveCount() <= maxLive,
        `${i + 1} 本目で ${pool.liveCount()} 本になった（上限 ${maxLive}）`
      );
    }
    assert.equal(peak, maxLive);
    // 畳まれた側も札は残っているので、話しかければ戻る
    await harnesses[0]!.prompt("戻す");
    assert.ok(pool.liveCount() <= maxLive);
    assert.ok(pool.liveIds().includes("t-0"));
  });

  it("a10: 放した会話を起こし直すのにかかった時間が数字で読める", async () => {
    const { pool, logs, clock, open, wakeCost } = wire({ idleMs: 60_000, maxLive: 4 });
    const harness = open("t-1");

    // 初回の起動。ここも測れるが、判断材料にしたいのは「畳んだせいで増えた待ち」
    wakeCost.ms = 40;
    await harness.prompt("一言目");
    assert.equal(harness.lastWakeMs(), 40);
    assert.equal(pool.wakeStats().count, 0, "初回の起動を「起こし直し」に数えている");

    clock.advance(120_000);
    await pool.sweep();
    assert.equal(pool.liveCount(), 0);

    // 起こし直しは子プロセスを立て直すぶん重い。その重さが読めること
    wakeCost.ms = 1_800;
    await harness.prompt("二言目");

    // 皮からも器からも数字で読める
    assert.equal(harness.lastWakeMs(), 1_800, "起こし直しにかかった時間が読めない");
    const stats = pool.wakeStats();
    assert.equal(stats.count, 1);
    assert.equal(stats.lastMs, 1_800);
    assert.equal(stats.maxMs, 1_800);
    assert.equal(stats.totalMs, 1_800);

    // 記録にも数字が載っている（体感が悪いときに「放す条件」を緩める材料になる形）
    const revived = logs.find((l) => l.includes("札から戻しました"));
    assert.ok(revived, `戻した記録が無い: ${logs.join(" / ")}`);
    assert.match(revived, /起こし直しに 1800ms/, `戻すのにかかった時間が数字で載っていない: ${revived}`);

    // 二度目の起こし直しが速ければ、最長と直近が分かれて見える
    clock.advance(120_000);
    await pool.sweep();
    wakeCost.ms = 120;
    await harness.prompt("三言目");
    const after = pool.wakeStats();
    assert.equal(after.count, 2);
    assert.equal(after.lastMs, 120);
    assert.equal(after.maxMs, 1_800);
    assert.equal(after.totalMs, 1_920);
  });

  it("章を畳んだ直後に安全弁が働いても、章の種（引き継ぎ資料）が落ちない", async () => {
    const { pool, clock, open } = wire({ idleMs: 60_000 });
    const harness = open("t-1");
    await harness.prompt("一言目");

    // 章を畳む＝新しいセッションを立てる。まだ一度も話していないので札は無い
    const opening = { text: "前の章の引き継ぎ", tokensBefore: 9, chapter: 2, handoffId: "h-1" };
    await harness.startChapter(opening);
    FakeInner.built[0]!.seededWith = undefined;
    assert.equal(harness.resumeToken(), undefined);

    // ここで安全弁が畳む
    clock.advance(120_000);
    await pool.sweep();
    assert.equal(pool.liveCount(), 0);

    // 起こし直したとき、種が掛かっていること（掛からないと畳んだ章がまるごと落ちる）
    await harness.prompt("新しい章の一言目");
    const revived = FakeInner.built[1]!;
    assert.equal(revived.params.resume, undefined, "札が無いのに resume で立てている");
    assert.deepEqual(revived.seededWith, opening, "章の種が掛け直されていない");
  });

  it("会話ごと畳んだら器の帳簿からも消える（畳んだ会話を掴み続けない）", async () => {
    const { pool, open } = wire({ maxLive: 2 });
    const harness = open("t-1");
    await harness.prompt("一言目");
    assert.equal(pool.liveCount(), 1);

    await harness.dispose();
    assert.equal(pool.liveCount(), 0);
    assert.deepEqual(pool.liveIds(), []);
    assert.equal(FakeInner.built[0]!.disposed, true);
    // I2: 畳んだ会話へ話しかけられたら黙って捨てない
    await assert.rejects(() => harness.prompt("後から"), /畳まれています/);
  });
});
