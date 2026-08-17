/**
 * task-0246: **畳んだ枝が宛先の「判断待ち」の知らせが届いたら、その枝のターンが
 * 必ず始まる**（inc: 2026-08-16 夜の仕込み thread-167）。
 *
 * 事故: 夜に7本を積んだ枝 thread-167 を畳んだあと、6本の職人が質問を出して
 * paused になった。知らせの宛先は**畳んである thread-167**。朝まで誰も答えず、
 * 職人は待ちくたびれて agent_exited で消え、5〜6時間半止まった。
 *
 * 切り分け（記録で確定）: 昨夜はこの枝のターンが**一度も始まっていない**。
 * 枝を畳んだ記録の次の記録は翌朝ホストを起こし直したあとのもので、間に1件も無い。
 * 6件の質問も 4時間後の `task_stalled` も**枝に1件も届いていない**（届いて何も
 * しなかった、ではない）——**配達か起動の穴**。今朝ホストを起こし直したあと、
 * 同じ経路で枝のターンは実際に始まっている（知らせ→`worker.steer`→`kobo.task`→…）。
 * 要するに昨夜の稼働は **task-0228 の着地より前のコード**だった。
 *
 * だからこの仕事は「作り直す」ではなく、**いま動いている形を機械で釘付けにする**こと。
 * 昨晩の本質は「壊れていることに誰も気づけなかった」——壊れたら気づける試験を残す。
 *
 * ここで固定するのは4つ:
 *   [a1] 畳んだ枝が宛先の「判断待ち」の知らせ → **その枝のターンが実際に始まり、
 *        始まったことが記録から読める**（開き直しの印・知らせ本文・台帳（T1）の枝の行）
 *   [a2] `task_stalled`（paused のまま N 時間）も**同じ扱い**——宛先が畳んだ枝でも
 *        必ずターンが起きる。また、枝を畳み直しても**周回していない**こと
 *        （次の知らせでまた開いて**何もしない**、にならない）
 *   [a3] ターンを起こせず**転んだとき黙らない**——会話に error が残り、台帳に失敗した
 *        ターンが書かれ、**知らせ自体は捨てず元の宛先へ配る**（I2）
 *   [a4] 幹宛て・開いている枝宛て・他の幹からの言伝の既存の振る舞いが**変わっていない**
 *        （幹のターンは相変わらず起きない）
 *
 * server は FakeSession（プロバイダを一切呼ばない）で組む。土台は
 * closed-thread-delivery.spec.ts / branch-seed-turn.spec.ts と同じ。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { BantoHarness, HarnessEvent } from "@banto/core";
import { BantoHostServer, ThreadRegistry, type Thread } from "@banto/host";
import { TRUNK, branchSpec } from "./threadSpecs.js";
import { TurnLog } from "../../packages/banto-host/src/turn-log.js";

/** テスト用セッション。プロバイダを呼ばず、渡された文字列だけ控える。 */
class FakeSession implements BantoHarness {
  readonly sessionId = "test-session";
  isStreaming = false;
  prompts: string[] = [];
  /** ターンの**最中**に割り込む口（枝が道具を叩く様子を真似る）。 */
  onPrompt: ((text: string) => void | Promise<void>) | undefined;
  /** 立てると prompt がこの値で転ぶ（[a3]: ターンを起こせず転んだ形）。 */
  promptError: unknown;

  subscribe(_listener: (event: HarnessEvent) => void): () => void {
    return () => {};
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    if (this.promptError !== undefined) throw this.promptError;
    await this.onPrompt?.(text);
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

let dir: string;
let threads: ThreadRegistry;
let server: BantoHostServer | undefined;
let ledger: TurnLog;

/** そのスレッドに紐づいた FakeSession（スレッドごとに別物）。 */
function sessionOf(thread: Thread): FakeSession {
  return thread.harness as unknown as FakeSession;
}

/** 台帳つきでサーバを立てる。幹は呼び出し側が開く。 */
async function startHost(): Promise<void> {
  server = await BantoHostServer.start({ threads, port: 0, turnLog: ledger });
}

/** 畳んだ枝を1本用意する（幹 → 枝 → merge）。 */
async function closedBranch(title: string): Promise<{ trunk: Thread; branch: Thread }> {
  const trunk = await threads.open(TRUNK);
  const branch = await threads.open(branchSpec(title));
  threads.merge(branch.id, `${title} は片付いた`);
  assert.equal(branch.state, "closed");
  return { trunk, branch };
}

/** そのスレッドで回ったターンの行（T1 の台帳から）。 */
function turnsOf(threadId: string) {
  return ledger.readAll().filter((e) => e.threadId === threadId);
}

/** 開き直しの印（`reopenForNotice` が積む system の知らせ）の本数。 */
function reopenNotes(thread: Thread): number {
  return thread.transcript.filter(
    (e) => e.role === "notice" && e.source === "system" && e.text.includes("開き直しました")
  ).length;
}

/** 畳み直しの印（`closeAfterNotice` が積む system の知らせ）の本数（task-0227）。 */
function refoldNotes(thread: Thread): number {
  return thread.transcript.filter(
    (e) => e.role === "notice" && e.source === "system" && e.text.includes("畳み直しました")
  ).length;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "notice-wakes-folded-"));
  ledger = new TurnLog(path.join(dir, "turns.jsonl"));
  threads = new ThreadRegistry(async () => ({
    harness: new FakeSession(),
    tools: [],
  }));
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("[inc 2026-08-16 thread-167] 畳んだ枝へ判断待ちの知らせが届いたら、その枝のターンが必ず始まる", () => {
  it("[a1] 畳んだ枝が宛先の「判断待ち」の知らせで、その枝のターンが始まり、始まったことが記録から読める", async () => {
    const { trunk, branch } = await closedBranch("ブックマーク同期の設計");
    await startHost();

    const text = "職人が質問を出しました：変換 UI はポップアップ表示か一覧切替か、どちらで進めますか";
    await server!.notify(text, { threadId: branch.id, source: "worker" });

    // ターンが実際に始まった：番頭が開き直して本文を読んだ
    assert.equal(sessionOf(branch).prompts.length, 1, "畳んだ枝のターンが回っていない");
    assert.ok(sessionOf(branch).prompts[0]!.includes(text), "知らせの本文が番頭に渡っていない");

    // 始まったことが**記録から読める**：台帳（T1）に枝の行が1本、開き直しの印も残る
    const rows = turnsOf(branch.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.threadKind, "branch");
    assert.equal(rows[0]!.parentId, trunk.id);
    assert.equal(rows[0]!.source, "worker");
    assert.equal(rows[0]!.ok, true);
    assert.equal(reopenNotes(branch), 1, "開き直したことが記録に無い");

    // 知らせ本体も会話の記録に残っている（開き直しの印 → 本体 → 畳み直しの印、の順）
    const body = branch.transcript.find(
      (e) => e.role === "notice" && e.source === "worker" && e.text === text
    );
    assert.ok(body, "知らせ本体が会話の記録に残っていない");

    // 親の幹のターンは起きない（T3・既存どおり）
    assert.deepEqual(sessionOf(trunk).prompts, []);
    assert.equal(turnsOf(trunk.id).length, 0);
  });

  it("[a2] task_stalled（paused のまま N 時間）も同じ——宛先が畳んだ枝でも必ずターンが起きる", async () => {
    const { trunk, branch } = await closedBranch("夜の仕込み");
    await startHost();

    const stalled = "task-0123 が paused のまま 4時間 止まっています（判断待ち：手順の続きをどうするか）";
    await server!.notify(stalled, { threadId: branch.id, source: "system" });

    // 宛先が畳んだ枝でも必ずターンが起きる
    assert.equal(sessionOf(branch).prompts.length, 1);
    assert.ok(sessionOf(branch).prompts[0]!.includes(stalled), "task_stalled の文面が渡っていない");

    const rows = turnsOf(branch.id);
    assert.equal(rows.length, 1, "task_stalled でも枝のターンが台帳に残っていない");
    assert.equal(rows[0]!.ok, true);

    // 幹は起きない
    assert.deepEqual(sessionOf(trunk).prompts, []);
    assert.equal(turnsOf(trunk.id).length, 0);
  });

  it("[a2-続き] 答えないまま畳み直しても「次の知らせでまた開いて何もしない」の周回になっていない", async () => {
    const { branch } = await closedBranch("夜の仕込み");
    await startHost();

    // 1通目：FakeSession は「何も返さない」＝答えないままターンが終わる
    await server!.notify("task-0099 が paused のまま 3時間 止まっています", {
      threadId: branch.id,
      source: "system",
    });
    // 何も返さなくても、機構が畳み直す（task-0227・開いたまま残さない）
    assert.equal(branch.state, "closed");
    assert.equal(refoldNotes(branch), 1);

    // 2通目：また開いて**実際にターンが回る**（何もしない、ではない）
    await server!.notify("task-0099 が引き続き止まっています（5時間）", {
      threadId: branch.id,
      source: "system",
    });
    assert.equal(sessionOf(branch).prompts.length, 2, "2通目でターンが回っていない＝周回している");
    assert.equal(turnsOf(branch.id).length, 2);
    // 周回のあとも畳んだまま残る（開きっぱなしにならない）
    assert.equal(branch.state, "closed");
  });

  it("[a3] ターンを起こせず転んだとき、黙らない・知らせ自体は捨てず元の宛先へ配る（I2）", async () => {
    const { branch } = await closedBranch("転ぶ枝");
    await startHost();

    const err = new Error("ハーネスがターンの途中で転んだ");
    sessionOf(branch).promptError = err;
    const text = "職人の質問です：設計方針はどちらに寄せますか";
    await server!.notify(text, { threadId: branch.id, source: "worker" });

    // 知らせ自体は捨てていない：元の宛先（この枝）の記録に残り、番頭にも渡っている
    assert.equal(sessionOf(branch).prompts.length, 1);
    assert.ok(
      branch.transcript.some((e) => e.role === "notice" && e.source === "worker" && e.text === text),
      "知らせ本体が記録から消えている"
    );

    // 黙って終わらない：会話に error の行が残る
    const errors = branch.transcript.filter((e) => e.role === "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.text, /ハーネスがターンの途中で転んだ/);

    // 台帳にも、失敗したターンとして書かれる（発生が読める）
    const row = turnsOf(branch.id)[0];
    assert.ok(row, "転んだターンが台帳に残っていない");
    assert.equal(row!.ok, false);
    assert.match(row!.errorMessage ?? "", /ハーネスがターンの途中で転んだ/);

    // 転んでも開いたままにはしない（task-0227）
    assert.equal(branch.state, "closed");
  });

  it("[a4] 幹宛ての知らせは幹のターンを起こさない（T3・既存どおり）", async () => {
    const trunk = await threads.open(TRUNK);
    await startHost();

    await server!.notify("検証環境の期限が切れました", { threadId: trunk.id, source: "env" });

    // 幹のターンは相変わらず起きない
    assert.deepEqual(sessionOf(trunk).prompts, []);
    assert.equal(turnsOf(trunk.id).length, 0);

    // 握り潰してはいない：用件の枝が立てられ、そこで回っている
    const branches = threads.list().filter((t) => t.kind === "branch" && t.parentId === trunk.id);
    assert.equal(branches.length, 1);
    assert.equal(sessionOf(branches[0]!).prompts.length, 1);
  });

  it("[a4] 開いている枝宛ての知らせは素通し（開き直しが走らない・既存どおり）", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("開いたままの相談"), trunk.id);
    await startHost();

    await server!.notify("開いている枝への知らせ", { threadId: branch.id, source: "worker" });

    assert.equal(branch.state, "open");
    assert.equal(reopenNotes(branch), 0, "開いているのに開き直しの印が付いた");
    assert.deepEqual(sessionOf(branch).prompts, ["開いている枝への知らせ"]);
    assert.deepEqual(sessionOf(trunk).prompts, []);
  });

  it("[a4] 他の幹からの言伝は知らせとして扱わず、幹のまま届く（既存どおり）", async () => {
    const trunk = await threads.open(TRUNK);
    await startHost();

    // thread.send の出所は "thread"（routeNotice の素通し条件）。宛先の幹へ会話として届く
    await server!.notify("幹「banto開発」から：設計はそちらへも効きます", {
      threadId: trunk.id,
      source: "thread",
    });

    assert.ok(
      sessionOf(trunk).prompts[0]!.includes("設計はそちらへも効きます"),
      "言伝が宛先の幹へ届いていない（既存の振る舞いが変わった）"
    );
  });
});
