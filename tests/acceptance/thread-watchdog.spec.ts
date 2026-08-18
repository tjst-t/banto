/**
 * task-0278: 幹・枝の定期監視（watchdog）と、終端に達した枝の自動畳み
 * （docs/proposals/2026-08-18-thread-watchdog-and-auto-fold.md・PO 裁定 2026-08-18）。
 *
 * banto は幹・枝を「知らせ（イベント駆動）」でしか起こさない。イベントの出所
 * （職人・Kobo・環境プール）が消えると誰もその枝を起こさない——この穴を **時間で
 * 定期的に見る** watchdog が塞ぐ。既知の欠陥 imp-0059（返らないターンに見張りが無い）
 * もここで塞ぐ。
 *
 * ここで確かめるのは work/tasks/task-0278.md の受け入れ条件 a1〜a7：
 *   a1 周期監視（既定10分・設定可能）が存在し、起動時にも1回走る（tick は冪等）
 *   a2 待ち先（worker session）が消えた枝を、事実を添えて nudge する
 *   a3 ターンが返らない（turn_started から一定時間 turn_ended が無い）枝を nudge する
 *   a4 鍵（taskId / sessionId / envId）が終端に達した T3 用件の枝を自動で畳む
 *      （結論は事実由来で捏造しない・即畳み・走行中は畳まない）
 *   a5 手開きの議論枝は自動畳みしない（nudge のみ）
 *   a6 未処理（remaining）を抱えた枝は所在が決まるまで畳まない
 *   a7 同一枝への連打をしない（履歴を記録し間隔を空ける）
 *
 * 台帳（サーバ）は持ち上げない。watchdog は ThreadRegistry と、呼び出し側が渡す事実
 * （`ThreadWatchdogFacts`）だけに依存する——bin.ts の配線は typecheck と既存の
 * 配達テスト（a8: kobo-po-amend-from-inbox.spec.ts）が守る。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { BantoHarness, HarnessEvent } from "@banto/core";
import { ThreadRegistry, type Thread, type ThreadSpec } from "@banto/host";
import {
  ThreadWatchdog,
  DEFAULT_WATCHDOG_INTERVAL_MS,
  DEFAULT_TURN_STALL_MS,
  DEFAULT_NUDGE_COOLDOWN_MS,
  workerGoneMessage,
  turnStallMessage,
  unsettledRemainingFoldMessage,
  inactivityMessage,
  type ThreadWatchdogFacts,
  type ThreadWatchdogOptions,
} from "@banto/host";
import { TRUNK, branchSpec } from "./threadSpecs.js";

/** テスト用セッション。プロバイダを呼ばず、watchdog が壊さないことだけ確かめる。 */
class FakeSession implements BantoHarness {
  readonly sessionId = "test-session";
  isStreaming = false;
  prompts: string[] = [];
  subscribe(_listener: (event: HarnessEvent) => void): () => void {
    return () => {};
  }
  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
  }
  async abort(): Promise<void> {}
  // ── BantoHarness の残り。この試験では使わない ──
  readonly backendId = "fake";
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

let threads: ThreadRegistry;
let nudges: Array<{ threadId: string; text: string }>;
let folds: Array<{ branchId: string; trunkId: string; conclusion: string }>;
let facts: ThreadWatchdogFacts;
/** watchdog の時計。試験から進めて時間を扱う。 */
let fakeNow: number;

function sessionOf(thread: Thread): FakeSession {
  return thread.harness as unknown as FakeSession;
}

/**
 * T3 の用件の枝（機構が知らせのために開いたもの・`thread.open` は subjectKey を
 * 渡さないので、これで「手開き」ではないことを形にする）。
 */
function subjectBranch(title: string, subjectKey: string): ThreadSpec {
  return {
    kind: "branch",
    title,
    returnCondition: `${title} の用件が終わったら、結論を1行で幹へ還す`,
    openedBy: "banto",
    reason: `${title} の知らせを捌く場（T3 の用件の枝）`,
    subjectKey,
  };
}

/**
 * 試験用の watchdog。nudge / fold は控えて配列に残し、fold は実際に
 * `ThreadRegistry.fold`（規律：走行中・未処理・親）も通す——控えだけにすると
 * 「畳んだつもり」で規律を素通りしかねない。
 */
function makeWatchdog(options: Partial<ThreadWatchdogOptions> = {}): ThreadWatchdog {
  return new ThreadWatchdog({
    threads,
    nudge: async (threadId, text) => {
      nudges.push({ threadId, text });
    },
    fold: (branchId, trunkId, conclusion) => {
      folds.push({ branchId, trunkId, conclusion });
      threads.fold(branchId, trunkId, conclusion);
    },
    facts: () => facts,
    now: () => fakeNow,
    ...options,
  });
}

beforeEach(() => {
  nudges = [];
  folds = [];
  facts = {};
  fakeNow = 1_000_000;
  threads = new ThreadRegistry(async () => ({ harness: new FakeSession(), tools: [] }));
});

afterEach(() => {
  threads.dispose();
});

describe("[task-0278] 幹・枝の定期監視（watchdog）", () => {
  it("a1: 周期は既定10分（設定可能）・tick は冪等（2回走っても同じ結果）", async () => {
    assert.equal(DEFAULT_WATCHDOG_INTERVAL_MS, 10 * 60_000, "既定の間隔が10分でない");
    await threads.open(TRUNK);
    await threads.open(subjectBranch("職人 sess-1", "worker:sess-1"));

    const watchdog = makeWatchdog();
    const first = await watchdog.tick();
    const second = await watchdog.tick();
    // 事実も時刻も同じなら結果も同じ（冪等）・事実が無ければ何もしない
    assert.deepEqual(second, first);
    assert.deepEqual(first, { nudged: [], folded: [], suppressed: [] });
  });

  it("a1: start() は起動時に1回走り、間隔ごとに繰り返す（intervalMs で設定可能・止める口を返す）", async (t) => {
    const mock = t.mock.timers;
    mock.enable({ apis: ["setInterval"] });
    try {
      await threads.open(TRUNK);
      await threads.open(subjectBranch("職人 sess-1", "worker:sess-1"));
      facts = { aliveWorkerSessions: new Set() }; // 待ち先が消えている事実
      const watchdog = makeWatchdog({ intervalMs: 3_000, nudgeCooldownMs: 0 });
      const stop = watchdog.start();
      await new Promise((r) => setImmediate(r));
      assert.equal(nudges.length, 1, "起動時にも1回走っていない");

      mock.tick(3_000);
      await new Promise((r) => setImmediate(r));
      assert.equal(nudges.length, 2, "間隔ごとに走っていない");

      stop();
      mock.tick(3_000);
      await new Promise((r) => setImmediate(r));
      assert.equal(nudges.length, 2, "止めたあと走り続けている");
    } finally {
      mock.reset();
    }
  });

  it("a2: 待ち先（worker session）が帳簿から消えた枝を、事実を添えて nudge する", async () => {
    await threads.open(TRUNK);
    const branch = await threads.open(subjectBranch("職人 sess-1", "worker:sess-1"));

    // 待ち先が生きている：起こさない（正常な待ちを邪魔しない）
    facts = { aliveWorkerSessions: new Set(["sess-1"]) };
    const watchdog = makeWatchdog();
    await watchdog.tick();
    assert.deepEqual(nudges, [], "生きている待ち先を起こしている");

    // 待ち先が消えた：事実だけを添えて nudge する
    facts = { aliveWorkerSessions: new Set() };
    const out = await watchdog.tick();
    assert.deepEqual(folds, []);
    assert.deepEqual(out.nudged.map((n) => n.threadId), [branch.id]);
    assert.equal(out.nudged[0]!.message, workerGoneMessage("sess-1", branch.title));
    assert.match(out.nudged[0]!.message, /sess-1/u);
    assert.match(out.nudged[0]!.message, /消えました/u);

    // 測れない（worker 帳簿を引けない）ときは検知しない——推測で起こさない
    facts = {};
    await makeWatchdog().tick();
    assert.equal(nudges.length, 1, "測れないときに起こしている");
  });

  it("a3: ターンが返らない枝を nudge する（imp-0059・turn_started から一定時間 turn_ended が無い）", async () => {
    await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("長考の枝"));

    const watchdog = makeWatchdog();
    watchdog.watchTurnStart(branch.id); // サーバがターンを始めた（onTurnChange → watchTurnStart）
    await watchdog.tick();
    assert.deepEqual(nudges, [], "閾値前の正常な長考を起こしている");

    fakeNow += DEFAULT_TURN_STALL_MS; // 15 分が経過してもターンが返らない
    const out = await watchdog.tick();
    assert.equal(out.nudged.length, 1);
    assert.equal(out.nudged[0]!.message, turnStallMessage(branch.id, 15));

    // ターンが返れば見張りは下りる（watchTurnEnd）——返したあとに起こさない
    watchdog.watchTurnEnd(branch.id);
    const after = await watchdog.tick();
    assert.deepEqual(after.nudged, []);
  });

  it("a4: 鍵が終端に達した T3 用件の枝を、事実由来の結論で即畳む（捏造しない）", async () => {
    await threads.open(TRUNK);
    const worker = await threads.open(subjectBranch("職人 sess-3", "worker:sess-3"));
    const kobo = await threads.open(subjectBranch("task-0151", "kobo:banto/task-0151"));
    const env = await threads.open(subjectBranch("検証環境 env-12", "env:env-12"));
    facts = {
      terminalKeys: new Map([
        ["worker:sess-3", "worker sess-3 は closed になりました"],
        ["kobo:banto/task-0151", "task-0151 は closed になりました"],
        ["env:env-12", "検証環境 env-12 は teardown されました"],
      ]),
    };

    const watchdog = makeWatchdog();
    const out = await watchdog.tick();
    // 3本とも1回の tick で畳まる（猶予なし＝即・PO 裁定 2026-08-18）
    assert.deepEqual(
      folds.map((f) => f.branchId).sort(),
      [worker.id, kobo.id, env.id].sort()
    );
    for (const b of [worker, kobo, env]) {
      assert.equal(b.state, "closed", `${b.title} が畳まれていない`);
    }
    assert.equal(out.folded.length, 3);
    // 結論は事実（terminalKeys の1行）から導く——捏造しない
    for (const f of folds) {
      assert.ok(
        [...facts.terminalKeys!.values()].some((label) => f.conclusion.startsWith(label)),
        `結論「${f.conclusion}」が事実から導かれていない`
      );
      assert.match(f.conclusion, /役目を終えた/u);
    }
    // 冪等：既に畳んだ枝は2回目で畳まない
    const again = await watchdog.tick();
    assert.deepEqual(again.folded, []);
  });

  it("a4: 走行中（ターンが回っている）の枝は畳まない（終われば次の tick で畳む）", async () => {
    await threads.open(TRUNK);
    const branch = await threads.open(subjectBranch("職人 sess-4", "worker:sess-4"));
    sessionOf(branch).isStreaming = true; // ハーネスがトークンを吐いている
    facts = { terminalKeys: new Map([["worker:sess-4", "worker sess-4 は closed になりました"]]) };

    const watchdog = makeWatchdog();
    const out = await watchdog.tick();
    assert.equal(branch.state, "open", "走行中の枝を畳んでいる");
    assert.deepEqual(out.folded, []);
    assert.equal(nudges.length, 1, "走行中の終端枝に一言添えていない");
    assert.match(nudges[0]!.text, /終端に達しています/u);

    sessionOf(branch).isStreaming = false; // ターンが終わった
    const out2 = await watchdog.tick();
    assert.equal(branch.state, "closed");
    assert.equal(out2.folded.length, 1);
  });

  it("a5: 手開きの議論枝（subjectKey 無し）は自動畳みしない（nudge のみ）", async () => {
    await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("手で開いた議論"));
    branch.lastActivityAt = new Date(fakeNow - 48 * 3_600_000).toISOString(); // 2日間沈黙
    // 鍵が終端に達していても、手開きの枝には subjectKey が無いので届かない
    facts = { terminalKeys: new Map([["worker:sess-9", "worker sess-9 は closed になりました"]]) };

    const watchdog = makeWatchdog({ inactivityMs: 24 * 3_600_000 }); // 24時間で無活動の検知
    const out = await watchdog.tick();
    assert.equal(branch.state, "open", "手開きの議論枝を畳んでいる");
    assert.deepEqual(out.folded, []);
    assert.deepEqual(folds, []);
    assert.equal(nudges.length, 1, "nudge していない");
    assert.equal(nudges[0]!.text, inactivityMessage(branch.id, 24));
    assert.match(nudges[0]!.text, /24 時間以上/u);
  });

  it("a6: 未処理（remaining）を抱えた枝は所在が決まるまで畳まない（決まれば畳む）", async () => {
    await threads.open(TRUNK);
    const branch = await threads.open(subjectBranch("職人 sess-6", "worker:sess-6"));
    branch.remainingCount = 1; // 未処理を1件抱えている（所在は未定）
    facts = { terminalKeys: new Map([["worker:sess-6", "worker sess-6 は closed になりました"]]) };

    const watchdog = makeWatchdog();
    const out = await watchdog.tick();
    assert.equal(branch.hasUnsettledRemaining, true);
    assert.equal(branch.state, "open", "所在の無い未処理を抱えた枝を畳んでいる");
    assert.deepEqual(out.folded, []);
    assert.deepEqual(folds, []);
    assert.equal(nudges.length, 1);
    assert.equal(nudges[0]!.text, unsettledRemainingFoldMessage(branch.title));

    // 所在が決まれば、次の tick で畳める
    threads.settle(branch.id, "職人 019fbd87 へ移管した");
    assert.equal(branch.hasUnsettledRemaining, false);
    const out2 = await watchdog.tick();
    assert.equal(branch.state, "closed");
    assert.equal(out2.folded.length, 1);
  });

  it("a7: 同一枝を連打しない（履歴を記録し、間隔が空くまで送らない）", async () => {
    await threads.open(TRUNK);
    const branch = await threads.open(subjectBranch("職人 sess-1", "worker:sess-1"));
    facts = { aliveWorkerSessions: new Set() };

    const watchdog = makeWatchdog({ nudgeCooldownMs: DEFAULT_NUDGE_COOLDOWN_MS });
    const first = await watchdog.tick();
    assert.equal(first.nudged.length, 1, "1回目に送っていない");

    // 同じ時刻のまま tick：cooldown 中は送らない（suppressed に事実が残る）
    const second = await watchdog.tick();
    assert.deepEqual(second.nudged, []);
    assert.deepEqual(second.suppressed, [branch.id], "連打を抑えた事実が残っていない");
    assert.equal(nudges.length, 1, "連打している");

    // 別の枝は cooldown の影響を受けない
    const other = await threads.open(subjectBranch("職人 sess-2", "worker:sess-2"));
    const third = await watchdog.tick();
    assert.equal(third.nudged.length, 1);
    assert.equal(third.nudged[0]!.threadId, other.id);

    // 間隔が明けたら同じ枝にもう一度送る（永久に黙らない）
    fakeNow += DEFAULT_NUDGE_COOLDOWN_MS;
    const fourth = await watchdog.tick();
    assert.deepEqual(fourth.nudged.map((n) => n.threadId).sort(), [branch.id, other.id].sort());
  });
});