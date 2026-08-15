/**
 * **枝を開いたら、その枝が自分で動き出す**（inc: thread-104 が自力で動かなかった件）。
 *
 * 起きたこと: `thread.open` の seed を枝へ渡した1秒後にホストが SIGKILL で落ちた。
 * `deliverToThread` は**記録してから prompt する**ので、枝には知らせの行だけが残り、
 * 番頭のターンは1本も回らないまま消えた。台帳（`turns.jsonl`）はターンの**終わり**に
 * 書くので行すら残らず、`[banto]` のログにも何も出ない——PO が話しかけるまで沈黙した。
 *
 * ここで機構として固定するのは4つ:
 *
 *   1. `thread.open({ message })` → **宛先の枝で prompt が1本必ず走る**（出所は `thread`）。
 *      台帳（T1）にも枝の行が1本増え、**親の幹の行は増えない**
 *   2. seed は **fire-and-forget**（`handOff`）——`thread.open` はターンの完走を待たずに返る。
 *      だから「返ってきた＝動き出した」ではない。ここは仕様なので、その形のまま固定する
 *      （返り文もそう名乗るように直した：「最初の一言は渡しました」）
 *   3. **線引き**: seed・`thread.steer` は宛先のターンを起こす／職人・工房・環境の知らせが
 *      幹へ来ても**幹のターンは起こらない**（T3 で用件の枝へ回る）
 *   4. **回収**: 落ちて失われたターンは**次の起動で起こし直される**（`recoverLostTurns`）。
 *      再起動そのものは試験から模せないので、①記録だけ在ってターンが無い会話を作り
 *      ②起動時の回収を呼び ③prompt が1本走って印が1行残る、の形で組む
 *
 * 実プロバイダは呼ばない。ハーネスは偽物に差し替え、配信と台帳の振る舞いだけを見る。
 * 土台は closed-thread-delivery.spec.ts と同じ。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { BantoHarness, HarnessEvent } from "@banto/core";
import { JsonlMemoryStore } from "@banto/core";
import {
  BantoHostServer,
  LOST_TURN_RECOVERED_NOTICE,
  RESTART_RESUME_NOTICE,
  ThreadRegistry,
  createThreadTools,
  recoverLostTurns,
  resetSendCounters,
  type Thread,
} from "@banto/host";
import { TRUNK, branchSpec } from "./threadSpecs.js";
import { TurnLog } from "../../packages/banto-host/src/turn-log.js";

/**
 * 対話ループの偽物。渡された文字列を控えるだけ。
 *
 * `hang` を立てると **prompt が返らなくなる**——「ハーネスが黙って止まる」を再現する口。
 */
class FakeSession implements BantoHarness {
  readonly sessionId: string;
  isStreaming = false;
  prompts: string[] = [];
  hang = false;

  constructor(id: string) {
    this.sessionId = id;
  }

  subscribe(_listener: (event: HarnessEvent) => void): () => void {
    return () => {};
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    // 止まったまま返らないハーネス（実機で疑った形）。試験の後始末で解く必要は無い
    if (this.hang) await new Promise<void>(() => {});
  }

  async abort(): Promise<void> {}

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

let dir: string;
let threads: ThreadRegistry;
let server: BantoHostServer | undefined;
let ledger: TurnLog;
/** ここから先に開く会話のハーネスを「返らない」ものにする（fire-and-forget の確認用）。 */
let hangNewSessions = false;

function sessionOf(thread: Thread): FakeSession {
  return thread.harness as unknown as FakeSession;
}

/** 番頭が実際に持つ形で thread.* を組む（bin.ts と同じ配線）。 */
function tool(threadId: string, name: string) {
  const found = createThreadTools({
    threads,
    threadId,
    seed: (to, message) => server!.notify(message, { threadId: to, source: "thread" }),
    deliver: (to, message) => server!.notify(message, { threadId: to, source: "thread" }),
    nudge: (to, message) => server!.nudge(to, message),
  }).find((t) => t.name === name);
  assert.ok(found, `${name} が生えていません`);
  return found;
}

/** そのスレッドで回った（＝完走した）ターンの台帳の行。 */
function turnsOf(threadId: string) {
  return ledger.readAll().filter((e) => e.threadId === threadId);
}

/**
 * 条件が満たされるまで待つ。**seed は待てない**（fire-and-forget）ので、試験からは
 * こうやって外から観測するしかない。満たされなければ時間切れで落とす。
 */
async function waitFor(what: string, ok: () => boolean, timeoutMs = 2000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!ok()) {
    if (Date.now() > until) assert.fail(`${what} が ${timeoutMs}ms 以内に起きませんでした`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 直前に開かれた枝（`thread.open` は id を返り文にしか書かないので、帳簿から引く）。 */
function newestBranch(parentId: string): Thread {
  const branches = threads.list().filter((t) => t.kind === "branch" && t.parentId === parentId);
  const last = branches[branches.length - 1];
  assert.ok(last, "枝が1本も開かれていません");
  return last;
}

beforeEach(async () => {
  resetSendCounters();
  hangNewSessions = false;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-branch-seed-"));
  ledger = new TurnLog(path.join(dir, "turns.jsonl"));
  // 記憶はこの試験では使わないが、置き場だけ dir の中に閉じ込める
  new JsonlMemoryStore(path.join(dir, "memory.jsonl"));
  threads = new ThreadRegistry(async (threadId) => {
    const harness = new FakeSession(`session-of-${threadId}`);
    harness.hang = hangNewSessions;
    return { harness, tools: [] };
  });
  server = await BantoHostServer.start({ threads, port: 0, turnLog: ledger });
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("[inc] thread.open の最初の一言で枝が動き出す", () => {
  it("thread.open({ message }) で宛先の枝の prompt が1本走る（幹は0本）", async () => {
    const trunk = await threads.open(TRUNK);

    await tool(trunk.id, "thread.open").execute({
      title: "バックログの仕組み",
      returnCondition: "設計案が2〜3本に絞れたら",
      reason: "幹でやると長く塞ぐ",
      message: "起票をどこに置き、どう Kobo へ流すかを設計してください",
    } as never);

    const branch = newestBranch(trunk.id);
    await waitFor("枝のターン", () => sessionOf(branch).prompts.length > 0);

    // 番頭へ渡った文字列は seed そのまま
    assert.deepEqual(sessionOf(branch).prompts, [
      "起票をどこに置き、どう Kobo へ流すかを設計してください",
    ]);
    // 知らせの行も残っている（出所は「別の会話」）
    const notices = branch.transcript.filter((e) => e.role === "notice");
    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.role === "notice" && notices[0].source, "thread");
    // 幹では1本も回らない
    assert.deepEqual(sessionOf(trunk).prompts, []);
  });

  it("台帳に枝の行が1本増え、出所は thread（幹の行は増えない）", async () => {
    const trunk = await threads.open(TRUNK);

    await tool(trunk.id, "thread.open").execute({
      title: "枝が起動しない",
      returnCondition: "原因が言えたら",
      reason: "調べ物なので枝で持つ",
      message: "seed のターンが回らない原因を追ってください",
    } as never);

    const branch = newestBranch(trunk.id);
    await waitFor("台帳の行", () => turnsOf(branch.id).length > 0);

    const rows = turnsOf(branch.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.source, "thread");
    assert.equal(rows[0]?.threadKind, "branch");
    assert.equal(rows[0]?.parentId, trunk.id);
    assert.equal(rows[0]?.ok, true);
    assert.equal(turnsOf(trunk.id).length, 0);
  });

  it("message を渡さなければ枝は黙って待つ（PO が話しかけるまで動かない）", async () => {
    const trunk = await threads.open(TRUNK);

    await tool(trunk.id, "thread.open").execute({
      title: "あとで話す枝",
      returnCondition: "話が始まって結論が出たら",
      reason: "先に器だけ作る",
    } as never);

    const branch = newestBranch(trunk.id);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(sessionOf(branch).prompts, []);
    assert.equal(turnsOf(branch.id).length, 0);
  });

  it("seed は待たない——thread.open はターンの完走前に返る（handOff）", async () => {
    const trunk = await threads.open(TRUNK);
    // ここから先に開く枝のハーネスは返らない。待つ実装なら thread.open が詰まる
    const seen = new Set(threads.list().map((t) => t.id));
    hangNewSessions = true;

    const opened = tool(trunk.id, "thread.open").execute({
      title: "待たないことの確認",
      returnCondition: "確認できたら",
      reason: "机上ではなく機構で見る",
      message: "この一言のターンは完走しない",
    } as never);

    // 2秒あれば「待つ実装」なら詰まる。返ってくること自体が fire-and-forget の証拠
    await Promise.race([
      opened,
      new Promise((_r, reject) =>
        setTimeout(() => reject(new Error("thread.open がターンの完走を待っている")), 2000)
      ),
    ]);

    const branch = threads.list().find((t) => !seen.has(t.id) && t.kind === "branch");
    assert.ok(branch, "枝が開かれていません");
  });
});

describe("[inc] ターンを起こす／起こさないの線引き", () => {
  it("thread.steer は宛先の枝のターンを起こす（幹は0本）", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("差配される枝"), trunk.id);

    await tool(trunk.id, "thread.steer").execute({
      threadId: branch.id,
      message: "計測は不要になった。再現条件だけで畳んでよい",
    } as never);

    await waitFor("枝のターン", () => sessionOf(branch).prompts.length > 0);
    // 言伝は出どころを名乗って届く（幹「…」から途中の言伝です）。中身は落ちない
    assert.equal(sessionOf(branch).prompts.length, 1);
    assert.match(sessionOf(branch).prompts[0]!, /計測は不要になった。再現条件だけで畳んでよい/u);
    assert.deepEqual(sessionOf(trunk).prompts, []);
  });

  it("職人・工房・環境の知らせは幹のターンを起こさない（T3: 用件の枝へ回る）", async () => {
    const trunk = await threads.open(TRUNK);

    for (const source of ["worker", "kobo", "env"] as const) {
      await server!.notify(`${source} からの知らせ`, { threadId: trunk.id, source });
    }

    assert.deepEqual(sessionOf(trunk).prompts, []);
    assert.equal(turnsOf(trunk.id).length, 0);
    // 回された先（用件の枝）では回っている——握り潰してはいない
    const branches = threads.list().filter((t) => t.kind === "branch" && t.parentId === trunk.id);
    assert.equal(branches.length, 3);
    for (const b of branches) assert.equal(sessionOf(b).prompts.length, 1);
  });
});

describe("[inc] 失われたターンを次の起動で回収する", () => {
  /**
   * **再起動そのものは試験から模せない**ので、落ちたあとに残る**姿**を作る:
   * 記録には知らせの行が在り、番頭は何も返していない会話。ここへ起動時の回収
   * （`recoverLostTurns`）を掛ける。
   */
  function lostTurnBranch(trunk: Thread, title: string): Promise<Thread> {
    return threads.open(branchSpec(title), trunk.id);
  }

  /** 起動時の回収を、本番（bin.ts）と同じ引数で呼ぶ。 */
  function recover(alreadyResumed: string[] = []): string[] {
    return recoverLostTurns({
      threads: threads.list(),
      alreadyResumed: new Set(alreadyResumed),
      nudge: (threadId, message) => server!.nudge(threadId, message),
      // 試験の出力を汚さない（出していること自体は本番の console で確かめる）
      log: () => {},
      onError: () => {},
    });
  }

  it("知らせだけ残ってターンが無い枝は、起動時に起こし直される", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await lostTurnBranch(trunk, "落ちた枝");
    // 落ちる前に record まで走った姿（prompt は届かなかった）
    branch.record({ role: "notice", source: "thread", text: "起票の置き場を設計してください" });

    assert.deepEqual(recover(), [branch.id]);
    await waitFor("回収のターン", () => sessionOf(branch).prompts.length > 0);

    // 失われた一言が、断りつきで渡し直されている
    assert.equal(sessionOf(branch).prompts.length, 1);
    assert.match(sessionOf(branch).prompts[0]!, /前回の再起動で、この一言に対するターンが失われていました/u);
    assert.match(sessionOf(branch).prompts[0]!, /起票の置き場を設計してください/u);
    // I2: なぜ急に動いたかが記録にも残る
    assert.equal(
      branch.transcript.filter(
        (e) => e.role === "notice" && e.text === LOST_TURN_RECOVERED_NOTICE
      ).length,
      1
    );
    // 知らせの行は二重に積まれない（nudge であって notify ではない）
    assert.equal(
      branch.transcript.filter(
        (e) => e.role === "notice" && e.text === "起票の置き場を設計してください"
      ).length,
      1
    );
    // 幹は起こさない（T3: 待ち状態を壊さない）
    assert.deepEqual(sessionOf(trunk).prompts, []);
  });

  it("番頭が既に何か返している会話は起こさない", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await lostTurnBranch(trunk, "答えのある枝");
    branch.record({ role: "notice", source: "thread", text: "調べてください" });
    branch.record({ role: "banto", text: "承知しました" });

    assert.deepEqual(recover(), []);
    assert.deepEqual(sessionOf(branch).prompts, []);
  });

  it("別の回収が既に起こした会話・畳んだ会話は起こさない", async () => {
    const trunk = await threads.open(TRUNK);
    const resumed = await lostTurnBranch(trunk, "もう起きている枝");
    resumed.record({ role: "notice", source: "worker", text: "職人からの報告" });
    const closed = await lostTurnBranch(trunk, "畳んだ枝");
    closed.record({ role: "notice", source: "worker", text: "遅れて届いた報告" });
    threads.merge(closed.id, "片付いた");

    assert.deepEqual(recover([resumed.id]), []);
    assert.deepEqual(sessionOf(resumed).prompts, []);
    assert.deepEqual(sessionOf(closed).prompts, []);
  });

  /**
   * **自分で再起動を撃った会話**（imp-0061）。`restart-tool.ts` は結果を返してから落ちるので
   * 記録は `道具 system.restart（ok）` で止まる——`settleInterrupted` の running は発生しない。
   */
  it("自分で撃った再起動で終わっている会話は、再起動用の文で起こし直す", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await lostTurnBranch(trunk, "再起動を撃った枝");
    branch.record({ role: "notice", source: "thread", text: "反映してください" });
    branch.record({ role: "banto", text: "再起動します" });
    branch.record({ role: "tool", name: "system.restart", state: "ok" });

    assert.deepEqual(recover(), [branch.id]);
    await waitFor("回収のターン", () => sessionOf(branch).prompts.length > 0);
    // 意図した中断なので、失われた一言の投げ直しではなく再起動の断りが渡る
    assert.deepEqual(sessionOf(branch).prompts, [RESTART_RESUME_NOTICE]);
    assert.equal(
      branch.transcript.filter((e) => e.role === "notice" && e.text === RESTART_RESUME_NOTICE)
        .length,
      1
    );
  });

  it("settleInterrupted が既に起こした会話は、道具で終わっていても二度起こさない", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await lostTurnBranch(trunk, "もう起きている再起動の枝");
    branch.record({ role: "notice", source: "thread", text: "反映してください" });
    branch.record({ role: "tool", name: "system.restart", state: "ok" });
    // `threads.restore` が返した宛先（bin.ts の resumeAfterRestart）がここに入る
    branch.record({ role: "notice", source: "system", text: RESTART_RESUME_NOTICE });

    assert.deepEqual(recover([branch.id]), []);
    assert.deepEqual(sessionOf(branch).prompts, []);
  });

  it("起こしてもまだ番頭が返さなければ、次の起動でまた拾う（回収の印は判定を塞がない）", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await lostTurnBranch(trunk, "二度落ちた枝");
    branch.record({ role: "notice", source: "thread", text: "二度目も落ちる一言" });

    // 1回目。偽物のハーネスは記録を残さない＝「渡したが番頭は何も返さなかった」姿
    assert.deepEqual(recover(), [branch.id]);
    await waitFor("1回目の回収", () => sessionOf(branch).prompts.length === 1);
    // もう一度落ちた体で、次の起動の回収を掛ける
    assert.deepEqual(recover(), [branch.id]);
    await waitFor("2回目の回収", () => sessionOf(branch).prompts.length === 2);
    // 印は起こした回数だけ積まれる（どの起動で起こしたかが読める）
    assert.equal(
      branch.transcript.filter(
        (e) => e.role === "notice" && e.text === LOST_TURN_RECOVERED_NOTICE
      ).length,
      2
    );
  });
});
