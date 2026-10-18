// `revise_memory`（§2.2「取り消した行は AI に渡さない・AI が取り消しと『改める』を頼める」、2026-10-15）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore } from "../project-thread/store.js";
import { InboxStore } from "../inbox/store.js";
import { PendingApprovalRegistry } from "../inbox/pending-approvals.js";
import { checkMemoryRevision, reviseMemory } from "./memory-tool.js";

async function withSetup(
  fn: (s: {
    store: ProjectThreadStore;
    inbox: InboxStore;
    pending: PendingApprovalRegistry;
    projectId: string;
    threadId: string;
    seqs: number[];
    published: { id: string; toolInput: unknown; choices: string[] }[];
  }) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "banto-memory-tool-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const store = new ProjectThreadStore(dir, log);
    await store.load();
    const inbox = new InboxStore(dir, log);
    await inbox.load();
    const project = await store.createProject("demo", dir);
    const thread = await store.createBaseThread(project.id);
    const seqs = [
      await store.appendMemory(project.id, "置き場は ghq 形式"),
      await store.appendMemory(project.id, "置き場は ~/banto に改める"),
      await store.appendMemory(project.id, "実装して push した"),
    ];
    await fn({ store, inbox, pending: new PendingApprovalRegistry(), projectId: project.id, threadId: thread.id, seqs, published: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("入力の確かめ：番号が無い・二重・取り消し済み・空の理由は人に聞く前に断る", async () => {
  const memory = [
    { seq: 3, text: "a" },
    { seq: 5, text: "b", invalidatedAtSeq: 9 },
  ];
  assert.match(checkMemoryRevision(memory, "", [{ retract: [3] }]) ?? "", /reason/);
  assert.match(checkMemoryRevision(memory, "古い", []) ?? "", /空/);
  assert.match(checkMemoryRevision(memory, "古い", [{ retract: [] }]) ?? "", /remember_decision/);
  assert.match(checkMemoryRevision(memory, "古い", [{ retract: [4] }]) ?? "", /#4 はありません/);
  assert.match(checkMemoryRevision(memory, "古い", [{ retract: [5] }]) ?? "", /もう取り消して/);
  assert.match(checkMemoryRevision(memory, "古い", [{ retract: [3] }, { retract: [3] }]) ?? "", /2回/);
  assert.match(checkMemoryRevision(memory, "古い", [{ retract: [3], text: "  " }]) ?? "", /text が空/);
  assert.equal(checkMemoryRevision(memory, "古い", [{ retract: [3], text: "新しい" }]), undefined);
});

test("許されたら、先に新しい行を足してから取り消し、理由と置き換え先を残す", async () => {
  await withSetup(async ({ store, inbox, pending, projectId, threadId, seqs, published }) => {
    const running = reviseMemory(
      {
        store,
        ask: { inbox, pendingApprovals: pending, publishJudgment: (_t, j) => published.push(j) },
      },
      {
        projectId,
        threadId,
        reason: "改めた古い決まりと経過を畳む",
        changes: [{ retract: [seqs[0]!, seqs[1]!], text: "置き場は ~/banto" }, { retract: [seqs[2]!] }],
      },
    );
    // カードが出るまで待って許す
    while (published.length === 0) await new Promise((r) => setTimeout(r, 5));
    const card = published[0]!;
    assert.deepEqual(card.choices, ["変える", "変えない"]);
    const rows = card.toolInput as Record<string, string>;
    assert.equal(rows["理由"], "改めた古い決まりと経過を畳む");
    assert.match(rows["変更 1"]!, new RegExp(`#${seqs[0]}「置き場は ghq 形式」`));
    assert.match(rows["変更 1"]!, /足す：\n置き場は ~\/banto/);
    assert.ok(!/足す/.test(rows["変更 2"]!));
    assert.equal(inbox.get(card.id)?.kind, "judgment");
    pending.resolve(card.id, { behavior: "allow", updatedInput: {} });

    const result = await running;
    assert.equal(result.ok, true, result.text);
    const memory = store.getProject(projectId)!.memory;
    const added = memory.find((m) => m.text === "置き場は ~/banto")!;
    assert.ok(added, "新しい行が足されている");
    assert.equal(added.originThreadId, threadId);
    for (const seq of seqs) {
      const m = memory.find((e) => e.seq === seq)!;
      assert.ok(m.invalidatedAtSeq !== undefined, `#${seq} が取り消されている`);
      assert.equal(m.invalidatedReason, "改めた古い決まりと経過を畳む");
      // 取り消しは足したあと
      assert.ok(m.invalidatedAtSeq! > added.seq);
    }
    assert.equal(memory.find((e) => e.seq === seqs[0])!.replacedBy, added.seq);
    assert.equal(memory.find((e) => e.seq === seqs[2])!.replacedBy, undefined);
    assert.match(result.text, new RegExp(`#${added.seq} を足し`));
  });
});

test("断られたら何も変えない", async () => {
  await withSetup(async ({ store, inbox, pending, projectId, threadId, seqs, published }) => {
    const running = reviseMemory(
      { store, ask: { inbox, pendingApprovals: pending, publishJudgment: (_t, j) => published.push(j) } },
      { projectId, threadId, reason: "古い", changes: [{ retract: [seqs[0]!], text: "新しい" }] },
    );
    while (published.length === 0) await new Promise((r) => setTimeout(r, 5));
    pending.resolve(published[0]!.id, { behavior: "deny", message: "まだ要る" });
    const result = await running;
    assert.equal(result.ok, false);
    assert.match(result.text, /変えていません/);
    const memory = store.getProject(projectId)!.memory;
    assert.equal(memory.length, 3);
    assert.ok(memory.every((m) => m.invalidatedAtSeq === undefined));
  });
});

test("聞いている間に人が取り消した行は飛ばして結果に書く", async () => {
  await withSetup(async ({ store, inbox, pending, projectId, threadId, seqs, published }) => {
    const running = reviseMemory(
      { store, ask: { inbox, pendingApprovals: pending, publishJudgment: (_t, j) => published.push(j) } },
      { projectId, threadId, reason: "古い", changes: [{ retract: [seqs[0]!, seqs[1]!] }] },
    );
    while (published.length === 0) await new Promise((r) => setTimeout(r, 5));
    await store.invalidateMemory(projectId, seqs[0]!);
    pending.resolve(published[0]!.id, { behavior: "allow", updatedInput: {} });
    const result = await running;
    assert.equal(result.ok, true);
    assert.match(result.text, /1 行は聞いている間にもう取り消されていた/);
    const m0 = store.getProject(projectId)!.memory.find((m) => m.seq === seqs[0])!;
    assert.equal(m0.invalidatedReason, undefined, "人の取り消しはそのまま");
  });
});

test("止められたターンでは聞かずに断る", async () => {
  await withSetup(async ({ store, inbox, pending, projectId, threadId, seqs }) => {
    const ac = new AbortController();
    ac.abort();
    const result = await reviseMemory(
      { store, ask: { inbox, pendingApprovals: pending } },
      { projectId, threadId, reason: "古い", changes: [{ retract: [seqs[0]!] }], signal: ac.signal },
    );
    assert.equal(result.ok, false);
    assert.ok(store.getProject(projectId)!.memory.every((m) => m.invalidatedAtSeq === undefined));
  });
});

// **「承認をすべて自動で許可する」がオンなら聞かずに通す**（改訂・2026-10-18、ユーザー。v4-frontend.md §6.4）。判断待ちは出し、
// host が「自動で許可しました」と答えて決着させる（会話には答え済みのカードが残る）
test("自動で許可がオンなら聞かずに変え、カードは答え済みで残す", async () => {
  await withSetup(async ({ store, inbox, pending, projectId, threadId, seqs, published }) => {
    const answered: { id: string; answer: string }[] = [];
    const result = await reviseMemory(
      {
        store,
        ask: { inbox, pendingApprovals: pending, publishJudgment: (_t, j) => published.push(j), publishAnswered: (_t, a) => answered.push(a) },
        autoApprove: () => true,
      },
      { projectId, threadId, reason: "古い", changes: [{ retract: [seqs[0]!], text: "新しい" }] },
    );
    assert.equal(result.ok, true, result.text);
    assert.equal(published.length, 1, "カードは出す");
    assert.deepEqual(answered, [{ id: published[0]!.id, answer: "自動で許可しました（承認をすべて自動で許可する がオン）" }]);
    const judgment = inbox.get(published[0]!.id);
    assert.equal(judgment?.kind === "judgment" ? judgment.liveness : undefined, "answered", "受信箱に未解決を残さない");
    const memory = store.getProject(projectId)!.memory;
    assert.ok(memory.find((m) => m.seq === seqs[0])!.invalidatedAtSeq !== undefined);
    assert.ok(memory.some((m) => m.text === "新しい"));
  });
});

test("自動で許可がオフなら今どおり聞く", async () => {
  await withSetup(async ({ store, inbox, pending, projectId, threadId, seqs, published }) => {
    const running = reviseMemory(
      { store, ask: { inbox, pendingApprovals: pending, publishJudgment: (_t, j) => published.push(j) }, autoApprove: () => false },
      { projectId, threadId, reason: "古い", changes: [{ retract: [seqs[0]!] }] },
    );
    while (published.length === 0) await new Promise((r) => setTimeout(r, 5));
    assert.equal(store.getProject(projectId)!.memory.find((m) => m.seq === seqs[0])!.invalidatedAtSeq, undefined, "答える前に変えている");
    pending.resolve(published[0]!.id, { behavior: "allow", updatedInput: {} });
    assert.equal((await running).ok, true);
  });
});
