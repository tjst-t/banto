/**
 * T3: 知らせを用件ごとの枝へ配る（docs/proposals/2026-08-15-trunk-availability-plan.md）。
 *
 * PO の方針は **「知らせで幹のターンを起こさない」**。対応をやめるのではなく、対応の場所を
 * 幹から枝へ移す——幹はいつでも PO の入力を受けられる待ち状態でいてほしい。幹へ返るのは、
 * 枝を畳むときの結論1行だけになる。
 *
 * 受け皿の形（PO 指示 2026-08-15）:
 *   - 枝の単位は**用件**。出所ごとの常設1本でも、知らせ1件ごとでもない
 *   - 鍵は知らせが指す対象——職人の `sessionId`／`projectTag/taskId`／`envId`
 *   - 鍵が割り出せないものは**その1件のための枝**。常設の落ち先は作らない
 *     （溜め place にすると「古い文脈を抱えたまま知らせに対応する」形へ戻る）
 *   - 閉じるのは**鍵が終端に達したとき**。知らせ1件ごとには閉じない
 *
 * ここで確かめるのは
 *   - 幹宛ての知らせが**鍵の枝**へ行き、**幹のターンが0本**（T1 の台帳で数える）
 *   - 同じ鍵の2件目は同じ枝（枝が増えない）／別の鍵は別の枝
 *   - **枝宛ての知らせはそのまま**（枝の中で委譲した報告は、既に正しい場所へ返っている）
 *   - 鍵の無い知らせ2件で、**別々の枝が2本**立つ（1本に相乗りしない）
 *   - 他の幹からの言伝と PO の発話は**幹のまま**（会話であって知らせではない）
 *   - 畳んだ用件の枝に同じ鍵が来たら、T2 で**その枝が開き直って捌き**、ターンの後に
 *     **機構が畳み直す**（幹は回らない・task-0227）
 *   - 終端の知らせにだけ「畳んでよい」と分かる印が付く
 *   - 鍵は**再起動をまたいで残る**（索引に保存される）
 *
 * server は FakeSession（プロバイダを一切呼ばない）で組む。土台は closed-thread-delivery.spec.ts と同じ。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { BantoHarness, HarnessEvent } from "@banto/core";
import { JsonlMemoryStore, ScopedMemory } from "@banto/core";
import {
  ThreadRegistry,
  ThreadStore,
  BantoHostServer,
  BantoHostClient,
  BANTO_WS_PATH,
  createMemoryTools,
  createRestartTool,
  type Thread,
  type ServerEvent,
} from "@banto/host";
import { TRUNK, branchSpec } from "./threadSpecs.js";
import { TurnLog } from "../../packages/banto-host/src/turn-log.js";
import { subjectOfWorkerEvent } from "../../packages/banto-host/src/worker-notice.js";
import { subjectOfKoboEvent } from "../../packages/banto-host/src/kobo-notice.js";
import { subjectOfEnvEvent } from "../../packages/banto-host/src/env-notice.js";

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
async function startHost(): Promise<string> {
  server = await BantoHostServer.start({ threads, port: 0, turnLog: ledger });
  return `ws://localhost:${server.port}${BANTO_WS_PATH}`;
}

/** その幹にぶら下がっている枝（開いている・畳んだの両方）。 */
function branchesOf(trunkId: string): Thread[] {
  return threads.list({ kind: "branch" }).filter((t) => t.parentId === trunkId);
}

/** 開き直しの印（`reopenForNotice` が積む system の知らせ）の本数（task-0227）。 */
function reopenNotes(thread: Thread): number {
  return thread.transcript.filter(
    (e) => e.role === "notice" && e.source === "system" && e.text.includes("開き直しました")
  ).length;
}

/** そのスレッドで回ったターンの本数（T1 の台帳から）。 */
function turnsOf(threadId: string): number {
  return ledger.readAll().filter((e) => e.threadId === threadId).length;
}

/** 職人の知らせ1通（幹宛て＝ origin を持たない報告）。 */
function workerNotice(sessionId: string, text: string, terminal = false): Promise<void> {
  return server!.notify(text, {
    source: "worker",
    subject: {
      key: `worker:${sessionId}`,
      label: `職人 ${sessionId}`,
      ...(terminal ? { terminal: true } : {}),
    },
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-subject-branch-"));
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

describe("[T3] 幹宛ての知らせは用件の枝で捌く", () => {
  it("[T3] 職人の報告は sessionId の枝へ行き、幹のターンは0本", async () => {
    const trunk = await threads.open(TRUNK);
    await startHost();

    await workerNotice("sess-3", "職人が完了を報告しました");

    const branches = branchesOf(trunk.id);
    assert.equal(branches.length, 1);
    const branch = branches[0]!;
    assert.equal(branch.subjectKey, "worker:sess-3");
    assert.equal(branch.title, "職人 sess-3");
    assert.equal(branch.returnCondition, "職人 sess-3 の件が終わったら、結論を1行で幹へ還す");
    assert.equal(branch.openedBy, "banto");

    // 番頭が読むのは枝。幹は黙ったまま＝PO の入力を待てる
    assert.ok(sessionOf(branch).prompts[0]?.startsWith("職人が完了を報告しました"));
    assert.deepEqual(sessionOf(trunk).prompts, []);

    // T1 の台帳で数える：幹の行は0、枝の行が1
    assert.equal(turnsOf(trunk.id), 0);
    assert.equal(turnsOf(branch.id), 1);
    const row = ledger.readAll()[0]!;
    assert.equal(row.threadKind, "branch");
    assert.equal(row.parentId, trunk.id);
    assert.equal(row.source, "worker");
  });

  it("[T3] 同じ鍵の2件目は同じ枝へ入る（枝は増えない）", async () => {
    const trunk = await threads.open(TRUNK);
    await startHost();

    await workerNotice("sess-3", "1件目：着手しました");
    await workerNotice("sess-3", "2件目：質問があります");

    const branches = branchesOf(trunk.id);
    assert.equal(branches.length, 1, "同じ用件で枝が増えている");
    const prompts = sessionOf(branches[0]!).prompts;
    assert.equal(prompts.length, 2);
    assert.ok(prompts[0]?.startsWith("1件目"));
    assert.ok(prompts[1]?.startsWith("2件目"));
    assert.equal(turnsOf(trunk.id), 0);
    assert.equal(turnsOf(branches[0]!.id), 2);
  });

  it("[T3] 鍵が違えば別の枝（無関係な件が1本に混ざらない）", async () => {
    const trunk = await threads.open(TRUNK);
    await startHost();

    await workerNotice("sess-3", "職人3の報告");
    await workerNotice("sess-9", "職人9の報告");

    const branches = branchesOf(trunk.id);
    assert.equal(branches.length, 2);
    assert.deepEqual(
      branches.map((b) => b.subjectKey).sort(),
      ["worker:sess-3", "worker:sess-9"]
    );
    assert.equal(turnsOf(trunk.id), 0);
  });

  it("[T3] 宛先が枝なら、これまでどおりその枝へ（用件の枝を重ねない）", async () => {
    const trunk = await threads.open(TRUNK);
    const mine = await threads.open(branchSpec("電卓の調べ物"));
    await startHost();

    // 枝の中で委譲した職人の報告は `origin=banto:<threadId>` でこの枝へ返る（既に正しい形）
    await server!.notify("枝から出した職人の報告", {
      threadId: mine.id,
      source: "worker",
      subject: { key: "worker:sess-7", label: "職人 sess-7" },
    });

    assert.deepEqual(branchesOf(trunk.id), [mine], "用件の枝が余計に立っている");
    assert.deepEqual(sessionOf(mine).prompts, ["枝から出した職人の報告"]);
    // 枝宛ては素通し＝畳んでよいの印も付けない（この枝の還す条件は番頭が書いたもの）
    assert.equal(sessionOf(mine).prompts[0]?.includes("thread.merge"), false);
    assert.deepEqual(sessionOf(trunk).prompts, []);
    assert.equal(turnsOf(trunk.id), 0);
  });

  it("[T3] 工房の知らせは taskId の枝へ、環境の知らせは envId の枝へ", async () => {
    const trunk = await threads.open(TRUNK);
    await startHost();

    await server!.notify("task-0151 がレビュー待ちです", {
      source: "kobo",
      subject: { key: "kobo:banto/task-0151", label: "banto/task-0151" },
    });
    await server!.notify("検証環境 env-12 を畳めませんでした", {
      source: "env",
      subject: { key: "env:env-12", label: "検証環境 env-12" },
    });

    const branches = branchesOf(trunk.id);
    assert.equal(branches.length, 2);
    const kobo = branches.find((b) => b.subjectKey === "kobo:banto/task-0151");
    const env = branches.find((b) => b.subjectKey === "env:env-12");
    assert.equal(kobo?.title, "banto/task-0151");
    assert.equal(env?.title, "検証環境 env-12");
    assert.ok(sessionOf(kobo!).prompts[0]?.startsWith("task-0151 がレビュー待ちです"));
    assert.ok(sessionOf(env!).prompts[0]?.startsWith("検証環境 env-12 を畳めませんでした"));
    assert.equal(turnsOf(trunk.id), 0);
  });
});

describe("[T3] 鍵の割り出せない知らせ", () => {
  /**
   * PO 指示 2026-08-15：常設の落ち先は作らない。鍵が割り出せない＝続きが来ても同じ枝へ
   * 結びつけようが無い＝**その1件で終わる用件**なので、1件ごとに枝を立てて畳んでもらう。
   */
  it("[T3] 鍵の無い知らせ2件で、別々の枝が2本立つ（1本に相乗りしない）", async () => {
    const trunk = await threads.open(TRUNK);
    await startHost();

    await server!.notify("再起動しました。続きを進めてください", { source: "system" });
    await server!.notify("章を畳めませんでした（文脈が伸び続けます）", { source: "system" });

    const branches = branchesOf(trunk.id);
    assert.equal(branches.length, 2, "鍵の無い知らせが1本の枝に積まれている");
    // 鍵は持たない——次の鍵無しの知らせが、この枝を掴まないため
    assert.deepEqual(
      branches.map((b) => b.subjectKey),
      [undefined, undefined]
    );
    // 題は知らせの見出し（1行目）。どの枝が何の件かが一覧で分かる
    assert.deepEqual(
      branches.map((b) => b.title).sort(),
      ["再起動しました。続きを進めてください", "章を畳めませんでした（文脈が伸び続けます）"].sort()
    );
    assert.equal(branches[0]!.returnCondition, "この知らせを捌いたら、結論を1行で幹へ還す");

    // 1本ずつが1件だけを読む（古い文脈を抱えたまま次の知らせに対応しない）
    for (const branch of branches) assert.equal(sessionOf(branch).prompts.length, 1);
    assert.deepEqual(sessionOf(trunk).prompts, []);
    assert.equal(turnsOf(trunk.id), 0);
    assert.equal(ledger.readAll().length, 2);
  });

  it("[T3] 鍵の無い知らせには必ず「捌いたら畳む」印が付く", async () => {
    const trunk = await threads.open(TRUNK);
    await startHost();

    await server!.notify("再起動しました", { source: "system" });

    const branch = branchesOf(trunk.id)[0]!;
    const text = sessionOf(branch).prompts[0]!;
    assert.ok(text.startsWith("再起動しました"), "知らせの中身が失われている");
    assert.match(text, /この1件で終わる知らせです/u);
    assert.match(text, /thread\.merge/u);
  });
});

describe("[T3] 会話は幹のまま", () => {
  it("[T3] 他の幹からの言伝は幹へ届く（知らせではなく会話）", async () => {
    const trunk = await threads.open(TRUNK);
    await startHost();

    await server!.notify("別の幹から相談です", { threadId: trunk.id, source: "thread" });

    assert.deepEqual(branchesOf(trunk.id), [], "言伝で枝が立っている");
    assert.deepEqual(sessionOf(trunk).prompts, ["別の幹から相談です"]);
    assert.equal(turnsOf(trunk.id), 1);
  });

  it("[T3] PO の発話は幹のまま（枝へ移されない）", async () => {
    const trunk = await threads.open(TRUNK);
    const url = await startHost();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    await until("接続が済む", () => events.some((e) => e.type === "welcome"));

    client.send({ type: "prompt", text: "電卓の件、進んでる？" });
    await until("ターンが終わる", () => events.some((e) => e.type === "turn_end"));

    assert.deepEqual(branchesOf(trunk.id), [], "PO の発話で枝が立っている");
    assert.deepEqual(sessionOf(trunk).prompts, ["電卓の件、進んでる？"]);
    assert.equal(ledger.readAll()[0]!.source, "po");
    client.close();
  });
});

/**
 * `system.restart` の一言は**知らせではなく、番頭が自分で叩いた道具の続き**（PO裁定
 * 2026-08-15）。幹に固定すれば枝から呼んだときに幹が鳴り、用件の枝を立てれば呼んだ
 * 本人が続きを読めない（しかもその枝は直後にプロセスが落ちて宙に浮く）。
 *
 * 配線は bin.ts と同じ形（`threadId` を渡し、`conversation` を立てる）を組んで確かめる
 * ——bin.ts は読み込むと `main()` が走るので試験から呼べない（imp-0037 で切り出した理由）。
 */
describe("[T3] 番頭が叩いた道具の続きは、呼んだ会話へ返る", () => {
  /** bin.ts の `createRestartTool` の配線をそのまま組む。落ちる代わりに控えるだけ。 */
  function restartToolFor(threadId: string | undefined) {
    return createRestartTool({
      ...(threadId !== undefined ? { threadId } : {}),
      notify: (text, target) =>
        server!.notify(text, { ...target, source: "system", conversation: true }),
      close: async () => {},
      exit: () => {},
      graceMs: 60_000, // 試験の間に落とさない（unref 済みなので待たない）
    });
  }

  it("[T3] 幹から呼べば幹へ届く（枝は立たない）", async () => {
    const trunk = await threads.open(TRUNK);
    await startHost();

    await restartToolFor(trunk.id).execute({}, { toolCallId: "t1" });
    await until("再起動の一言が届く", () => sessionOf(trunk).prompts.length === 1);

    assert.deepEqual(branchesOf(trunk.id), [], "叩いた道具の続きで枝が立っている");
    assert.deepEqual(sessionOf(trunk).prompts, [
      "これから再起動します。会話は保存済みで、再起動後に続きから話せます。",
    ]);
  });

  it("[T3] 枝から呼べばその枝へ届く（幹は鳴らない・枝も増えない）", async () => {
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("枝で作業中"));
    await startHost();

    await restartToolFor(branch.id).execute({}, { toolCallId: "t1" });
    await until("再起動の一言が届く", () => sessionOf(branch).prompts.length === 1);

    assert.deepEqual(branchesOf(trunk.id), [branch], "用件の枝が余計に立っている");
    assert.ok(sessionOf(branch).prompts[0]?.startsWith("これから再起動します"));
    assert.deepEqual(sessionOf(trunk).prompts, []);
    assert.equal(turnsOf(trunk.id), 0);
  });

  it("[T3] 呼んだ会話が分からないときは幹へ固定せず、その1件の枝で捌く", async () => {
    const trunk = await threads.open(TRUNK);
    await startHost();

    await restartToolFor(undefined).execute({}, { toolCallId: "t1" });
    await until(
      "1件の枝が立って知らせが届く",
      () => (branchesOf(trunk.id)[0]?.harness as unknown as FakeSession)?.prompts.length === 1
    );

    const branch = branchesOf(trunk.id)[0]!;
    assert.ok(sessionOf(branch).prompts[0]?.startsWith("これから再起動します"));
    assert.deepEqual(sessionOf(trunk).prompts, []);
    assert.equal(turnsOf(trunk.id), 0);
  });
});

describe("[T3] 閉じ方——鍵の終端まで畳まない", () => {
  it("[T3] 終端の知らせにだけ「畳んでよい」と分かる印が付く", async () => {
    const trunk = await threads.open(TRUNK);
    await startHost();

    await workerNotice("sess-3", "作業中です");
    await workerNotice("sess-3", "職人が落ちました", true);

    const prompts = sessionOf(branchesOf(trunk.id)[0]!).prompts;
    // 1件捌くたびに畳ませない——次の完了報告が「自分の答えを知らない枝」に入るため
    assert.equal(prompts[0], "作業中です");
    assert.match(prompts[1]!, /「職人 sess-3」の最後の知らせです/u);
    assert.match(prompts[1]!, /thread\.merge/u);
  });

  it("[T3] 畳んだ用件の枝に同じ鍵が来たら、その枝が開き直って捌き、ターンの後に畳み直る（幹は回らない）", async () => {
    const trunk = await threads.open(TRUNK);
    await startHost();

    await workerNotice("sess-3", "職人が落ちました", true);
    const branch = branchesOf(trunk.id)[0]!;
    // 番頭が捌いて畳んだ（結論は番頭が書く。機構は畳まない）
    threads.merge(branch.id, "落ちた職人は立て直した");
    assert.equal(branch.state, "closed");

    // 遅れて同じ鍵の知らせが届く
    await workerNotice("sess-3", "遅れて届いた最後の一言");

    assert.equal(branchesOf(trunk.id).length, 1, "畳んだ枝の代わりに新しい枝が立っている");
    // T2: 開き直って**その枝で**捌く（知らせは捨てない・inc-0069）
    assert.equal(reopenNotes(branch), 1, "T2 で開き直っていない");
    assert.equal(sessionOf(branch).prompts.length, 2);
    assert.match(sessionOf(branch).prompts[1]!, /遅れて届いた最後の一言/u, "知らせ本文が届いていない");
    // task-0227: 開いたままにはしない。捌き終えたら機構が畳み直す
    assert.equal(branch.state, "closed", "知らせで開き直した枝が開いたまま残っている");
    assert.equal(branch.conclusion, "落ちた職人は立て直した", "畳み直しで結論が痩せている");
    assert.deepEqual(sessionOf(trunk).prompts, []);
    assert.equal(turnsOf(trunk.id), 0);
  });
});

describe("[T3] 鍵は再起動をまたいで残る", () => {
  it("[T3] 読み戻した枝が同じ鍵の知らせを受ける（二重に立たない）", async () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "banto-subject-restart-"));
    try {
      const factory = async (): Promise<{ harness: BantoHarness; tools: [] }> => ({
        harness: new FakeSession(),
        tools: [],
      });
      threads.dispose();
      threads = new ThreadRegistry(factory, new ThreadStore(dir2));
      const trunk = await threads.open(TRUNK);
      await startHost();
      await workerNotice("sess-3", "落ちる前の報告");
      const before = branchesOf(trunk.id)[0]!;
      assert.equal(before.subjectKey, "worker:sess-3");
      threads.flushAll();
      await server!.close();
      server = undefined;

      // 再起動。索引から読み戻す
      threads = new ThreadRegistry(factory, new ThreadStore(dir2));
      await threads.restore();
      const restored = threads.resolve(before.id);
      assert.equal(restored.subjectKey, "worker:sess-3", "鍵が索引から戻っていない");

      await startHost();
      await workerNotice("sess-3", "再起動後の報告");

      assert.equal(branchesOf(trunk.id).length, 1, "再起動で同じ用件の枝が二重に立っている");
      assert.ok(sessionOf(restored).prompts[0]?.startsWith("再起動後の報告"));
      assert.equal(turnsOf(trunk.id), 0);
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });
});

describe("[T3] 出所ごとの鍵の割り出し", () => {
  it("[T3] 職人の鍵は sessionId。終端と言えるのは worker_exited だけ", () => {
    const event = { type: "worker_reported", sessionId: "sess-3" } as never;
    assert.deepEqual(subjectOfWorkerEvent(event), {
      key: "worker:sess-3",
      label: "職人 sess-3",
    });
    // 完了の報告は**主張**であって終端ではない（I1）。畳んでよいのは死んだときだけ
    const exited = { type: "worker_exited", sessionId: "sess-3" } as never;
    assert.equal(subjectOfWorkerEvent(exited)?.terminal, true);
  });

  it("[T3] 工房の鍵はプロジェクト込みのタスク。終端は task_merged", () => {
    const event = { type: "state_transitioned", projectTag: "banto", taskId: "task-0151" } as never;
    assert.deepEqual(subjectOfKoboEvent(event), {
      key: "kobo:banto/task-0151",
      label: "banto/task-0151",
    });
    const merged = { type: "task_merged", projectTag: "banto", taskId: "task-0151" } as never;
    assert.equal(subjectOfKoboEvent(merged)?.terminal, true);
    // タスクが分からない知らせは鍵無し（1件で終わる用件として扱う）
    assert.equal(subjectOfKoboEvent({ type: "task_merged", projectTag: "banto" } as never), undefined);
  });

  it("[T3] 検証環境の鍵は envId。終端は env_expired（畳み損ねは終端でない）", () => {
    const failed = { type: "env_teardown_failed", envId: "env-12", data: {} } as never;
    assert.deepEqual(subjectOfEnvEvent(failed), { key: "env:env-12", label: "検証環境 env-12" });
    const expired = { type: "env_expired", envId: "env-12", data: {} } as never;
    assert.equal(subjectOfEnvEvent(expired)?.terminal, true);
    // 孤児の照合は置き場全体の話で envId を持たない＝鍵無し
    assert.equal(subjectOfEnvEvent({ type: "env_orphans_found", data: {} } as never), undefined);
  });
});

/** 条件が満たされるまで待つ。満たされないまま時間切れなら、何を待っていたかを添えて落とす。 */
async function until(what: string, ok: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!ok()) {
    if (Date.now() - started > timeoutMs) throw new Error(`${what}のを待って時間切れ`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
