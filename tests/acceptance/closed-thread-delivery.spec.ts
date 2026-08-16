/**
 * T2: 畳んだ枝への配達を塞ぐ（docs/proposals/2026-08-15-trunk-availability-plan.md）。
 *
 * `ThreadRegistry.resolve` は畳んだスレッドも返す（決定35b）。**それは変えない**——
 * 知らせを届けるための意図的な設計である。塞ぐのは配り方のほう：畳んだままターンを
 * 回すと、レールのどこにも出ていない会話が独りでに喋る。
 *
 * ここで確かめるのは
 *   - 畳んだ枝へ知らせが来たら**枝が開き直り、その枝のターンが回る**（親の幹は0本）
 *   - 知らせの中身が失われない（番頭に渡る文字列に本文がそのまま入る）
 *   - 開いている枝への配達はこれまでどおり（開き直しの印が付かない・2件目以降も）
 *   - `nudge` と worker / kobo / env / system の**どれでも**同じように塞がれる
 *     （＝関所が `deliverToThread` の1箇所であること）
 *   - 畳んだ幹に届いたときは**その幹を開き直す**（帳場など別の幹は起こさない）
 * の5点と、T1 の台帳に**幹の行が増えず枝の行が増える**こと。
 *
 * **task-0227（後半のブロック）**：開き直した枝を**開いたまま残さない**。
 * 開き直した枝に渡るのは畳んだときまでの記録なので、枝は「私はもう畳んだ枝だ」と
 * 思ったまま返事をし、`thread.merge` を呼ばない——畳む口を叩く者が誰も居らず、
 * 畳んだはずの枝が一覧に開いたまま残り続けた（PO 実観測 2026-08-16）。
 * **枝の自己申告に頼らず、ターンの後に機構が畳み直す**ことをここで固定する。
 *
 * server は FakeSession（プロバイダを一切呼ばない）で組む。土台は turn-ledger.spec.ts と同じ。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { BantoHarness, HarnessEvent } from "@banto/core";
import { JsonlMemoryStore, ScopedMemory } from "@banto/core";
import { ThreadRegistry, BantoHostServer, createMemoryTools, type Thread } from "@banto/host";
import { TRUNK, branchSpec } from "./threadSpecs.js";
import { TurnLog } from "../../packages/banto-host/src/turn-log.js";

/** テスト用セッション。プロバイダを呼ばず、渡された文字列だけ控える。 */
class FakeSession implements BantoHarness {
  readonly sessionId = "test-session";
  isStreaming = false;
  prompts: string[] = [];
  /** ターンの**最中**に割り込む口（枝が道具を叩く様子を真似る）。 */
  onPrompt: ((text: string) => void | Promise<void>) | undefined;

  subscribe(_listener: (event: HarnessEvent) => void): () => void {
    return () => {};
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
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
let store: JsonlMemoryStore;
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

/** そのスレッドで回ったターンの本数（T1 の台帳から）。 */
function turnsOf(threadId: string): number {
  return ledger.readAll().filter((e) => e.threadId === threadId).length;
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-closed-delivery-"));
  store = new JsonlMemoryStore(path.join(dir, "memory.jsonl"));
  ledger = new TurnLog(path.join(dir, "turns.jsonl"));
  threads = new ThreadRegistry(async () => ({
    harness: new FakeSession(),
    tools: createMemoryTools(new ScopedMemory(store)),
  }));
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("[T2] 畳んだ枝への配達", () => {
  it("[T2] 畳んだ枝へ知らせが届くと枝が開き直り、その枝のターンが回る（親の幹は0本）", async () => {
    const { trunk, branch } = await closedBranch("電卓の調べ物");
    await startHost();

    // ターンの**最中**の状態を控える：知らせを捌いている間、枝は確かに開いている
    const stateWhileSpeaking: string[] = [];
    sessionOf(branch).onPrompt = () => {
      stateWhileSpeaking.push(branch.state);
    };

    await server!.notify("職人から完了の報告が届きました", {
      threadId: branch.id,
      source: "worker",
    });

    // 枝は開き直り、そのターンの間は開いている
    assert.equal(reopenNotes(branch), 1);
    assert.deepEqual(stateWhileSpeaking, ["open"]);

    // ターンは枝で回り、親の幹では1本も回らない（知らせの本文はそのまま渡る）
    assert.equal(sessionOf(branch).prompts.length, 1);
    assert.ok(sessionOf(branch).prompts[0]!.includes("職人から完了の報告が届きました"));
    assert.deepEqual(sessionOf(trunk).prompts, []);
    assert.equal(turnsOf(branch.id), 1);
    assert.equal(turnsOf(trunk.id), 0);
  });

  it("[T2] 知らせの中身は失われない（番頭にも会話の記録にも残る）", async () => {
    const { branch } = await closedBranch("環境の後片付け");
    await startHost();

    const text = "検証環境 env-42 の期限が切れました（残り0分）";
    await server!.notify(text, { threadId: branch.id, source: "env" });

    // 番頭へ渡った文字列（機構の前置きは付くが、本文は一字も削らない）
    assert.equal(sessionOf(branch).prompts.length, 1);
    assert.ok(sessionOf(branch).prompts[0]!.includes(text));
    // 会話の記録（開き直しの印 → 知らせ本体 → 畳み直しの印、の順）
    const notices = branch.transcript.filter((e) => e.role === "notice");
    assert.equal(notices.length, 3);
    const body = notices[1];
    assert.equal(body?.role === "notice" && body.source, "env");
    assert.equal(body?.role === "notice" && body.text, text);
  });

  it("[T2] T1 の台帳に幹の行は増えず、枝の行だけが増える", async () => {
    const { trunk, branch } = await closedBranch("台帳で測る");
    await startHost();

    await server!.notify("1件目", { threadId: branch.id, source: "worker" });
    await server!.notify("2件目", { threadId: branch.id, source: "kobo" });

    assert.equal(turnsOf(trunk.id), 0);
    assert.equal(turnsOf(branch.id), 2);
    const rows = ledger.readAll().filter((e) => e.threadId === branch.id);
    assert.deepEqual(
      rows.map((e) => e.threadKind),
      ["branch", "branch"]
    );
    assert.deepEqual(
      rows.map((e) => e.parentId),
      [trunk.id, trunk.id]
    );
    assert.deepEqual(
      rows.map((e) => e.ok),
      [true, true]
    );
  });

  it("[T2] 開いている枝への配達はこれまでどおり（開き直しは走らない）", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("開いたままの相談"));
    await startHost();

    await server!.notify("開いている枝への知らせ", { threadId: branch.id, source: "worker" });

    assert.equal(branch.state, "open");
    assert.equal(reopenNotes(branch), 0);
    // 開いている枝は機構が畳まない（畳むのは番頭の仕事・決定77）
    assert.equal(refoldNotes(branch), 0);
    assert.deepEqual(sessionOf(branch).prompts, ["開いている枝への知らせ"]);
    assert.deepEqual(sessionOf(trunk).prompts, []);
    assert.equal(turnsOf(trunk.id), 0);
    assert.equal(turnsOf(branch.id), 1);
  });

  it("[T2] 開いている枝には印が積み上がらない（2件目以降も素通し）", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("続けて届く開いた枝"));
    await startHost();

    await server!.notify("1件目", { threadId: branch.id, source: "worker" });
    await server!.notify("2件目", { threadId: branch.id, source: "worker" });
    await server!.notify("3件目", { threadId: branch.id, source: "worker" });

    assert.equal(reopenNotes(branch), 0);
    assert.deepEqual(sessionOf(branch).prompts, ["1件目", "2件目", "3件目"]);
    assert.deepEqual(sessionOf(trunk).prompts, []);
  });

  it("[T2] 関所は1箇所——worker / kobo / env / system のどの出所でも塞がる", async () => {
    const trunk = await threads.open(TRUNK);
    await startHost();

    for (const source of ["worker", "kobo", "env", "system"] as const) {
      const branch = await threads.open(branchSpec(`${source} の件`));
      threads.merge(branch.id, "片付いた");
      assert.equal(branch.state, "closed");

      await server!.notify(`${source} からの知らせ`, { threadId: branch.id, source });

      assert.equal(reopenNotes(branch), 1, `${source}: 開き直しの印が無い`);
      assert.equal(sessionOf(branch).prompts.length, 1);
      assert.ok(sessionOf(branch).prompts[0]!.includes(`${source} からの知らせ`));
      assert.equal(turnsOf(branch.id), 1, `${source}: 枝のターンが回っていない`);
    }

    // どの出所でも幹は起きない
    assert.deepEqual(sessionOf(trunk).prompts, []);
    assert.equal(turnsOf(trunk.id), 0);
  });

  it("[T2] nudge（枝からの相談）も同じ関所で塞がる", async () => {
    const { trunk, branch } = await closedBranch("相談を寄越す枝");
    await startHost();

    await server!.nudge(branch.id, "枝からの相談です");

    assert.equal(reopenNotes(branch), 1);
    assert.equal(sessionOf(branch).prompts.length, 1);
    assert.ok(sessionOf(branch).prompts[0]!.includes("枝からの相談です"));
    assert.equal(turnsOf(branch.id), 1);
    assert.equal(turnsOf(trunk.id), 0);
    assert.deepEqual(sessionOf(trunk).prompts, []);
  });

  /**
   * T3 が入って、**幹宛ての知らせは幹の下の枝で捌く**ようになった。畳んだ幹でも同じ
   * ——ただし枝は開いている幹にしかぶら下げられない（決定77 の不変条件）ので、
   * 幹は開き直す。**ターンは回らない**：回るのは枝である。
   */
  it("[T2] 畳んだ幹に届いたら、その幹を開き直す（帳場など別の幹は起こさない）", async () => {
    // 帳場（宛先を省いたときの落ち先）と、終えた幹
    const main = await threads.open({ kind: "trunk", main: true });
    const finished = await threads.open(TRUNK);
    threads.closeTrunk(finished.id);
    assert.equal(finished.state, "closed");
    await startHost();

    await server!.notify("終えた案件に遅れて報告が届きました", {
      threadId: finished.id,
      source: "worker",
    });

    // 宛先本人が開き直る。幹には還す親が無く、逃がせば必ず別の幹のターンが回るため
    assert.equal(finished.state, "open");
    assert.equal(reopenNotes(finished), 1);
    // 印の文言は枝と分ける（終えた幹が動き出したと読めるように）
    const note = finished.transcript.find(
      (e) => e.role === "notice" && e.source === "system" && e.text.includes("開き直しました")
    );
    assert.ok(note?.role === "notice" && note.text.includes("終えた幹"));
    // **幹は機構が畳み直さない**（task-0227）。開いている枝は開いている幹にぶら下がる
    // という決定77 の前提を機構が勝手に崩さない。畳み直すのは `thread.close_trunk`
    assert.equal(refoldNotes(finished), 0);
    // 知らせを捌くのは、その幹の下に立った枝（T3）。**幹のターンは回らない**
    assert.deepEqual(sessionOf(finished).prompts, []);
    assert.equal(turnsOf(finished.id), 0);
    const branch = threads.list({ kind: "branch" }).find((t) => t.parentId === finished.id);
    assert.ok(branch, "終えた幹の下に用件の枝が立つこと");
    assert.ok(sessionOf(branch).prompts[0]?.startsWith("終えた案件に遅れて報告が届きました"));
    assert.equal(turnsOf(branch.id), 1);

    // 帳場は起きない（黙って消えもしない）
    assert.deepEqual(sessionOf(main).prompts, []);
    assert.equal(turnsOf(main.id), 0);
  });
});

/**
 * task-0227: **開き直した枝を、ターンの後に機構が畳み直す。**
 *
 * 枝は自分が開き直されたことを知らないので、「捌いたら `thread.merge` で還してください」
 * と書いても誰も還さなかった。畳む口を叩く者が居ないまま、畳んだはずの枝が一覧に開いた
 * まま残る——**枝の自己申告に頼らない**のがここの主題である。
 */
describe("[task-0227] 知らせで開き直した枝は、ターンの後に畳み直される", () => {
  it("[a2] 開き直した枝はターンが終わったら畳み直され、一覧に開いたまま残らない", async () => {
    const { branch } = await closedBranch("一時的に起きる枝");
    const closedAtBefore = branch.closedAt;
    await startHost();

    await server!.notify("職人から完了の報告が届きました", {
      threadId: branch.id,
      source: "worker",
    });

    assert.equal(branch.state, "closed", "ターンの後も開いたまま残っている");
    // 畳んだ時刻は**元のまま**。振り直すと、いつ片付いた枝なのかが知らせのたびにずれる
    assert.equal(branch.closedAt, closedAtBefore);
    assert.ok(
      !threads.list({ state: "open" }).some((t) => t.id === branch.id),
      "開いている側の一覧に残っている"
    );
    assert.ok(threads.list({ state: "closed" }).some((t) => t.id === branch.id));
    assert.equal(refoldNotes(branch), 1);
  });

  it("[a2] 続けて届いた知らせも同じ形で捌ける（開き直す→回る→畳み直す）", async () => {
    const { trunk, branch } = await closedBranch("続けて届く畳んだ枝");
    await startHost();

    await server!.notify("1件目", { threadId: branch.id, source: "worker" });
    await server!.notify("2件目", { threadId: branch.id, source: "worker" });
    await server!.notify("3件目", { threadId: branch.id, source: "worker" });

    // 3通とも届き、3通とも枝で捌かれ、最後は畳んである
    assert.equal(sessionOf(branch).prompts.length, 3);
    assert.ok(sessionOf(branch).prompts[0]!.includes("1件目"));
    assert.ok(sessionOf(branch).prompts[1]!.includes("2件目"));
    assert.ok(sessionOf(branch).prompts[2]!.includes("3件目"));
    assert.equal(branch.state, "closed");
    assert.equal(reopenNotes(branch), 3);
    assert.equal(refoldNotes(branch), 3);
    assert.deepEqual(sessionOf(trunk).prompts, []);
    assert.equal(turnsOf(trunk.id), 0);
  });

  it("[a3] 畳み直しても、結論・詳細・未処理（imp-0036）が保たれる", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("残作業を抱えて畳む枝"));
    threads.merge(branch.id, "電卓の件は A で決めた", {
      detail: "## 調べたこと\nB も試した\n## 決めたこと\nA\n## 残ったこと\n電池の交換",
      remaining: ["電池の交換は imp-0041 で継ぐ"],
    });
    const before = {
      conclusion: branch.conclusion,
      detail: branch.conclusionDetail,
      remainingCount: branch.remainingCount,
      unsettled: branch.hasUnsettledRemaining,
    };
    const trunkRows = trunk.transcript.filter((e) => e.role === "branch_result").length;
    await startHost();

    await server!.notify("遅れて職人の報告が届きました", { threadId: branch.id, source: "worker" });

    assert.equal(branch.conclusion, before.conclusion);
    assert.equal(branch.conclusionDetail, before.detail);
    assert.equal(branch.remainingCount, before.remainingCount);
    assert.equal(branch.hasUnsettledRemaining, before.unsettled);
    assert.equal(branch.remainingCount, 1);
    // 幹へ結論の行を積み直さない（幹は追記のみ・同じ結論が2行並ばない）
    assert.equal(trunk.transcript.filter((e) => e.role === "branch_result").length, trunkRows);
  });

  it("[a4] 開き直した枝の文脈に、何の知らせで起きたかが機構から明示される", async () => {
    const { branch } = await closedBranch("明示される枝");
    await startHost();

    await server!.notify("職人 sess-9 が転びました", { threadId: branch.id, source: "worker" });

    const prompt = sessionOf(branch).prompts[0]!;
    assert.match(prompt, /機構より/u);
    assert.match(prompt, /一時的に開き直しました/u);
    assert.match(prompt, /職人/u, "何の知らせで起きたかが読めない");
    assert.match(prompt, /職人 sess-9 が転びました/u, "知らせの中身が前置きに出ていない");
    assert.match(prompt, /自動で畳み直します/u);
    assert.match(prompt, /thread\.merge/u, "結論を書き換える道が示されていない");
    // 畳んであったときの結論も添える（枝は自分が何を結論したか読み返せる）
    assert.match(prompt, /明示される枝 は片付いた/u);
    // 知らせの本文は前置きの**後ろ**に、そのまま置かれる
    assert.ok(prompt.endsWith("職人 sess-9 が転びました"));
  });

  it("[a4] 開いている枝には前置きが付かない（知らせ本文だけ）", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("開いている枝"));
    await startHost();

    await server!.notify("職人からの報告", { threadId: branch.id, source: "worker" });

    assert.deepEqual(sessionOf(branch).prompts, ["職人からの報告"]);
    assert.deepEqual(sessionOf(trunk).prompts, []);
  });

  it("[a5] 枝が自分で thread.merge を呼んだら枝の結論が勝ち、畳み直しは二重に走らない", async () => {
    const { trunk, branch } = await closedBranch("結論を書き換える枝");
    await startHost();

    // ターンの最中に枝が結論を書き換える（道具 `thread.merge` を叩いた体）
    sessionOf(branch).onPrompt = () => {
      threads.merge(branch.id, "やはり B だった", { detail: "## 決めたこと\nB" });
    };

    await server!.notify("職人から新しい事実が届きました", {
      threadId: branch.id,
      source: "worker",
    });

    assert.equal(branch.state, "closed");
    assert.equal(branch.conclusion, "やはり B だった", "枝の結論が機構に上書きされている");
    assert.equal(branch.conclusionDetail, "## 決めたこと\nB");
    // 機構の畳み直しは走らない（枝が自分で畳んだので、印も1行も積まれない）
    assert.equal(refoldNotes(branch), 0);
    // 幹へ還る結論は枝が書いたもの
    const results = trunk.transcript.filter((e) => e.role === "branch_result");
    const last = results[results.length - 1];
    assert.equal(last?.role === "branch_result" && last.conclusion, "やはり B だった");
  });

  it("[a5] 人が開き直した枝は、走っている知らせのターンに巻き込まれて畳まれない", async () => {
    const { branch } = await closedBranch("PO が開き直した枝");
    await startHost();

    // 知らせを捌いている最中に、PO が `thread.reopen` で開き直す
    sessionOf(branch).onPrompt = () => {
      threads.reopen(branch.id);
    };

    await server!.notify("職人からの報告", { threadId: branch.id, source: "worker" });

    assert.equal(branch.state, "open", "人が開けた枝を機構が畳み直している");
    assert.equal(refoldNotes(branch), 0);
  });

  it("[a5] 枝が相談を還した所在は、畳み直しても消えない", async () => {
    const { trunk, branch } = await closedBranch("相談を還す枝");
    await startHost();

    sessionOf(branch).onPrompt = () => {
      threads.consult(branch.id, { kind: "question", message: "この先はどちらへ進めますか" });
    };

    await server!.notify("職人からの報告", { threadId: branch.id, source: "worker" });

    assert.equal(branch.state, "closed");
    const notes = trunk.transcript.filter((e) => e.role === "branch_note");
    assert.equal(notes.length, 1, "畳み直しで幹に還した相談が消えている");
    assert.equal(
      notes[0]?.role === "branch_note" && notes[0].branchId,
      branch.id
    );
  });

  it("[a6] 判断とデータは帳簿側にある（server を立てずに開き直し→畳み直しが回る）", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("帳簿だけで畳み直す枝"));
    threads.merge(branch.id, "片付いた", { remaining: ["続きは imp-0042 で継ぐ"] });
    const closedAtBefore = branch.closedAt;

    // 開き直し：印も文脈の一文も帳簿が作る（server は繋ぐだけ）
    const reopened = threads.reopenForNotice(branch.id, {
      source: "worker",
      text: "職人からの報告",
    });
    assert.ok(reopened, "畳んだ枝を開き直せていない");
    assert.equal(branch.state, "open");
    assert.match(reopened.note, /開き直しました/u);
    assert.match(reopened.context ?? "", /自動で畳み直します/u);

    // 畳み直し：結論も未処理もそのまま、時刻は元へ戻る
    const closed = threads.closeAfterNotice(branch.id);
    assert.ok(closed, "帳簿だけでは畳み直せていない");
    assert.equal(branch.state, "closed");
    assert.equal(branch.closedAt, closedAtBefore);
    assert.equal(branch.conclusion, "片付いた");
    assert.equal(branch.remainingCount, 1);
    assert.equal(branch.hasUnsettledRemaining, true);
    assert.match(closed.note, /畳み直しました/u);

    // 二度目は何も起きない（印が立っていない）
    assert.equal(threads.closeAfterNotice(branch.id), undefined);
    // 開いている枝は対象外——知らせが来ても畳まない
    assert.equal(threads.reopenForNotice(trunk.id, { source: "worker", text: "x" }), undefined);
  });
});
