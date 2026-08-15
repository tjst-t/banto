/**
 * T2: 畳んだ枝への配達を塞ぐ（docs/proposals/2026-08-15-trunk-availability-plan.md）。
 *
 * `ThreadRegistry.resolve` は畳んだスレッドも返す（決定35b）。**それは変えない**——
 * 知らせを届けるための意図的な設計である。塞ぐのは配り方のほう：畳んだままターンを
 * 回すと、レールのどこにも出ていない会話が独りでに喋る。
 *
 * ここで確かめるのは
 *   - 畳んだ枝へ知らせが来たら**枝が開き直り、その枝のターンが回る**（親の幹は0本）
 *   - 知らせの中身が失われない（番頭に渡る文字列がそのまま）
 *   - 開いている枝への配達はこれまでどおり（開き直しの印が付かない・2件目以降も）
 *   - `nudge` と worker / kobo / env / system の**どれでも**同じように塞がれる
 *     （＝関所が `deliverToThread` の1箇所であること）
 *   - 畳んだ幹に届いたときは**その幹を開き直す**（帳場など別の幹は起こさない）
 * の5点と、T1 の台帳に**幹の行が増えず枝の行が増える**こと。
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

/** 開き直しの印（`reopenClosedTarget` が積む system の知らせ）の本数。 */
function reopenNotes(thread: Thread): number {
  return thread.transcript.filter(
    (e) => e.role === "notice" && e.source === "system" && e.text.includes("開き直しました")
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

    await server!.notify("職人から完了の報告が届きました", {
      threadId: branch.id,
      source: "worker",
    });

    // 枝は開き直り、一覧の「開いている側」に出る
    assert.equal(branch.state, "open");
    assert.equal(branch.closedAt, undefined);
    assert.ok(threads.list({ state: "open" }).some((t) => t.id === branch.id));
    assert.equal(reopenNotes(branch), 1);

    // ターンは枝で回り、親の幹では1本も回らない
    assert.deepEqual(sessionOf(branch).prompts, ["職人から完了の報告が届きました"]);
    assert.deepEqual(sessionOf(trunk).prompts, []);
  });

  it("[T2] 知らせの中身は失われない（番頭にも会話の記録にも残る）", async () => {
    const { branch } = await closedBranch("環境の後片付け");
    await startHost();

    const text = "検証環境 env-42 の期限が切れました（残り0分）";
    await server!.notify(text, { threadId: branch.id, source: "env" });

    // 番頭へ渡った文字列
    assert.deepEqual(sessionOf(branch).prompts, [text]);
    // 会話の記録（開き直しの印 → 知らせ本体、の順）
    const notices = branch.transcript.filter((e) => e.role === "notice");
    const last = notices[notices.length - 1];
    assert.equal(last?.role === "notice" && last.source, "env");
    assert.equal(last?.role === "notice" && last.text, text);
    assert.equal(notices.length, 2); // 印1件＋知らせ1件
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
    assert.deepEqual(sessionOf(branch).prompts, ["開いている枝への知らせ"]);
    assert.deepEqual(sessionOf(trunk).prompts, []);
    assert.equal(turnsOf(trunk.id), 0);
    assert.equal(turnsOf(branch.id), 1);
  });

  it("[T2] 開き直すのは1度だけ（2件目以降は普通に配るだけ）", async () => {
    const { branch } = await closedBranch("続けて届く枝");
    await startHost();

    await server!.notify("1件目", { threadId: branch.id, source: "worker" });
    await server!.notify("2件目", { threadId: branch.id, source: "worker" });
    await server!.notify("3件目", { threadId: branch.id, source: "worker" });

    assert.equal(reopenNotes(branch), 1);
    assert.deepEqual(sessionOf(branch).prompts, ["1件目", "2件目", "3件目"]);
  });

  it("[T2] 関所は1箇所——worker / kobo / env / system のどの出所でも塞がる", async () => {
    const trunk = await threads.open(TRUNK);
    await startHost();

    for (const source of ["worker", "kobo", "env", "system"] as const) {
      const branch = await threads.open(branchSpec(`${source} の件`));
      threads.merge(branch.id, "片付いた");
      assert.equal(branch.state, "closed");

      await server!.notify(`${source} からの知らせ`, { threadId: branch.id, source });

      assert.equal(branch.state, "open", `${source}: 枝が開き直っていない`);
      assert.equal(reopenNotes(branch), 1, `${source}: 開き直しの印が無い`);
      assert.deepEqual(sessionOf(branch).prompts, [`${source} からの知らせ`]);
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

    assert.equal(branch.state, "open");
    assert.equal(reopenNotes(branch), 1);
    assert.deepEqual(sessionOf(branch).prompts, ["枝からの相談です"]);
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
