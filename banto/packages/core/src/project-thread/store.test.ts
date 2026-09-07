import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore, MemoryLimitExceededError, InvalidProjectRootError, NotFoundError } from "./store.js";

async function withStore(fn: (store: ProjectThreadStore, dir: string, log: EventLog) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "banto-pt-test-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const store = new ProjectThreadStore(dir, log);
    await store.load();
    await fn(store, dir, log);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("create project and base thread", async () => {
  await withStore(async (store, dir) => {
    const project = await store.createProject("demo", dir);
    const thread = await store.createBaseThread(project.id);
    assert.equal(thread.projectId, project.id);
    assert.equal(thread.kind, "base");
    assert.equal(store.listThreadsForProject(project.id).length, 1);
  });
});

test("fork thread's system prompt memory is fixed at fork time; later decisions arrive as pending", async () => {
  await withStore(async (store, dir) => {
    const project = await store.createProject("demo", dir);
    const base = await store.createBaseThread(project.id);
    await store.appendMemory(project.id, "decided: use TypeScript", base.id);

    const fork = await store.forkThread(base.id);
    assert.equal(store.memoryForThread(fork.id).established.length, 1);

    // 分岐後にProjectへ追記しても、Forkのsystem promptには入らない（§2.2 item6）。
    // ただし「別の枝でこう決まった」として届ける分（pending）には出る（§2.3）。
    await store.appendMemory(project.id, "decided: use Rust for landlock", base.id);
    const forkAfter = store.memoryForThread(fork.id);
    assert.equal(forkAfter.established.length, 1, "確定した分は動かない");
    assert.deepEqual(
      forkAfter.pending.map((p) => [p.kind, p.text, p.originThreadId]),
      [["appended", "decided: use Rust for landlock", base.id]],
    );

    // MemoryはProjectが持つ——Baseから見ても同じ1つの列
    assert.equal(store.getProjectMemory(project.id).length, 2);
  });
});

test("memory invalidated after the baseline stays in the system prompt and arrives as pending", async () => {
  await withStore(async (store, dir) => {
    const project = await store.createProject("demo", dir);
    await store.appendMemory(project.id, "decided: ship on Friday");
    // Threadはこの1件を確定した状態で始まる
    const thread = await store.createBaseThread(project.id);
    const seq = store.getProjectMemory(project.id)[0]!.seq;

    await store.invalidateMemory(project.id, seq);

    const view = store.memoryForThread(thread.id);
    // 走行中の枝の先頭は変えない（§3）——確定済みの見え方は無効化前のまま
    assert.deepEqual(view.established, [{ seq, text: "decided: ship on Friday", invalidated: false }]);
    // 取り消されたことはターンに添えて届ける（§2.3）
    assert.deepEqual(
      view.pending.map((p) => [p.kind, p.text]),
      [["invalidated", "decided: ship on Friday"]],
    );
  });
});

test("a delivered difference is not delivered again; a later invalidation is", async () => {
  await withStore(async (store, dir) => {
    const project = await store.createProject("demo", dir);
    const thread = await store.createBaseThread(project.id);
    await store.appendMemory(project.id, "decided elsewhere");

    const first = store.memoryForThread(thread.id).pending;
    assert.equal(first.length, 1);

    // 届けたら繰り返さない——メッセージ列は追記なので会話に残っている
    await store.markMemoryDelivered(thread.id, first[0]!.changedAtSeq);
    assert.equal(store.memoryForThread(thread.id).pending.length, 0);

    // 届けた後に取り消されたら、それは新しい知らせとして届ける
    await store.invalidateMemory(project.id, first[0]!.seq);
    assert.deepEqual(
      store.memoryForThread(thread.id).pending.map((p) => p.kind),
      ["invalidated"],
    );
  });
});

test("a decision added and withdrawn before delivery is never delivered", async () => {
  await withStore(async (store, dir) => {
    const project = await store.createProject("demo", dir);
    const thread = await store.createBaseThread(project.id);
    await store.appendMemory(project.id, "decided then withdrawn");
    const seq = store.getProjectMemory(project.id)[0]!.seq;
    await store.invalidateMemory(project.id, seq);

    assert.equal(store.memoryForThread(thread.id).pending.length, 0);
  });
});

test("clearing a thread re-establishes the memory baseline", async () => {
  await withStore(async (store, dir) => {
    const project = await store.createProject("demo", dir);
    const thread = await store.createBaseThread(project.id);
    await store.appendMemory(project.id, "decided later", thread.id);
    assert.equal(store.memoryForThread(thread.id).pending.length, 1);

    // 畳むと新しいキャッシュ境界から始まる——そこで確定し直す（§2.2）
    await store.clearThread(thread.id);
    const after = store.memoryForThread(thread.id);
    assert.equal(after.pending.length, 0);
    assert.equal(after.established.length, 1);
  });
});

test("a fork does not own the inherited session until it runs its own turn (§2.2)", async () => {
  await withStore(async (store, dir) => {
    const project = await store.createProject("demo", dir);
    const base = await store.createBaseThread(project.id);
    await store.updateResumePoint(base.id, "session-parent");
    assert.equal(store.getThread(base.id)!.ownsSession, true, "自分のsessionを持っている");

    const fork = await store.forkThread(base.id);
    // 借りているだけ——このままresumeすると親と同じセッションを共有し、
    // 両方の会話が1本に混ざる（実測・2026-09-05）。最初のターンで枝を分ける。
    assert.equal(fork.resumePoint, "session-parent");
    assert.equal(fork.ownsSession, false);

    // 最初のターンでSDKが返した新しいsession idを受け取ったら、自分のものになる
    await store.updateResumePoint(fork.id, "session-forked");
    assert.equal(store.getThread(fork.id)!.ownsSession, true);
    assert.equal(store.getThread(base.id)!.resumePoint, "session-parent", "親は元のまま");
  });
});

test("two threads pointing at the same session is detected (data written before forkSession)", async () => {
  await withStore(async (store, dir) => {
    const project = await store.createProject("demo", dir);
    const base = await store.createBaseThread(project.id);
    const fork = await store.forkThread(base.id);

    await store.updateResumePoint(base.id, "shared-session");
    // 2026-09-05以前は、forkが自分のターンを走らせても同じidを返していた
    await store.updateResumePoint(fork.id, "shared-session");

    assert.equal(store.getThread(fork.id)!.ownsSession, true, "自分のものだと思っている");
    assert.equal(store.resumePointSharedWithOtherThread(fork.id), true, "でも共有されている");
    assert.equal(store.resumePointSharedWithOtherThread(base.id), true);

    // 分かれれば共有は解消する
    await store.updateResumePoint(fork.id, "own-session");
    assert.equal(store.resumePointSharedWithOtherThread(fork.id), false);
    assert.equal(store.resumePointSharedWithOtherThread(base.id), false);
  });
});

test("fork thread inherits the parent's current resume-point by default (v4-architecture.md §2.2)", async () => {
  await withStore(async (store, dir) => {
    const project = await store.createProject("demo", dir);
    const base = await store.createBaseThread(project.id);
    await store.updateResumePoint(base.id, "sdk-session-abc");

    const fork = await store.forkThread(base.id);
    assert.equal(fork.resumePoint, "sdk-session-abc");

    // 明示的に渡せば「やり直す」用に過去のresume-pointへ差し替えられる
    const forkAtOldPoint = await store.forkThread(base.id, "sdk-session-older");
    assert.equal(forkAtOldPoint.resumePoint, "sdk-session-older");
  });
});

test("memory invalidation is append-only, not physical deletion", async () => {
  await withStore(async (store, dir) => {
    const project = await store.createProject("demo", dir);
    await store.appendMemory(project.id, "wrong decision");
    const entrySeq = store.getProjectMemory(project.id)[0]!.seq;

    await store.invalidateMemory(project.id, entrySeq);
    const after = store.getProjectMemory(project.id);
    assert.equal(after.length, 1, "entry still present, not deleted");
    assert.ok(after[0]!.invalidatedAtSeq !== undefined);
  });
});

test("memory events written before the Project-owned decision (threadId only) still fold", async () => {
  await withStore(async (store, dir, log) => {
    const project = await store.createProject("demo", dir);
    const thread = await store.createBaseThread(project.id);

    // 2026-09-05以前の形——`projectId`が無く`threadId`だけ。書き換えずに
    // 読み替える（Event Storeは追記のみ、規則3）。
    await log.append("memory.appended", { threadId: thread.id, text: "old-style decision" });

    const reloaded = new ProjectThreadStore(dir, log);
    await reloaded.load();
    const memory = reloaded.getProjectMemory(project.id);
    assert.equal(memory.length, 1, "threadIdからProjectを解決して読める");
    assert.equal(memory[0]!.text, "old-style decision");
    assert.equal(memory[0]!.originThreadId, thread.id);
  });
});

test("a snapshot written in the old shape is ignored, not fed into the new fold", async () => {
  await withStore(async (store, dir, log) => {
    const project = await store.createProject("demo", dir);
    await store.appendMemory(project.id, "decided: keep the log as the truth");
    await store.save();

    // 2026-09-05より前の形（MemoryがThread側にあり、Projectにmemoryが無い）を
    // 置いてみる。読み込まれてしまうと、Project.memoryがundefinedのまま
    // 新しいfoldに流れ込んで壊れる——版を分けているので読まれない。
    await writeFile(
      join(dir, "project-thread.snapshot.json"),
      JSON.stringify({ seq: 999_999, state: { projects: {}, threads: {} } }),
    );

    const reloaded = new ProjectThreadStore(dir, log);
    await reloaded.load();
    assert.equal(reloaded.getProject(project.id)?.name, "demo", "ログから作り直せている");
    assert.equal(reloaded.getProjectMemory(project.id).length, 1);
  });
});

test("memory entries over the char limit are rejected", async () => {
  await withStore(async (store, dir) => {
    const project = await store.createProject("demo", dir);
    await assert.rejects(
      () => store.appendMemory(project.id, "x".repeat(20_001)),
      MemoryLimitExceededError,
    );
  });
});

test("project root is expanded/validated, not passed through raw (regression: '~/' broke FileSystem relative paths)", async () => {
  await withStore(async (store, dir) => {
    // "~/"はホームディレクトリへ展開されて通る——展開せず生文字列のまま
    // 各所（FileSystem Moduleのpath.resolve・Landlockのrealpath）へ渡していたのが
    // 実際のバグだった（"."が".../packages/core/~"に化けた、2026-09-04報告）。
    const home = await store.createProject("home", "~/");
    assert.ok(isAbsolute(home.root));
    assert.ok(!home.root.includes("~"));

    await assert.rejects(() => store.createProject("demo", "relative/path"), InvalidProjectRootError);
    await assert.rejects(
      () => store.createProject("demo", "/definitely/does/not/exist/xyz"),
      InvalidProjectRootError,
    );
    // 実在するディレクトリはそのまま通る（realpath化されるだけ）
    const project = await store.createProject("demo", dir);
    assert.equal(project.root, dir);
  });
});

test("thread close/reopen round-trips status, closing an unknown thread throws NotFoundError", async () => {
  await withStore(async (store, dir) => {
    const project = await store.createProject("demo", dir);
    const thread = await store.createBaseThread(project.id);

    await store.closeThread(thread.id);
    assert.equal(store.getThread(thread.id)!.status, "closed");

    await store.reopenThread(thread.id);
    assert.equal(store.getThread(thread.id)!.status, "active");

    await assert.rejects(() => store.closeThread("does-not-exist"), NotFoundError);
    await assert.rejects(() => store.reopenThread("does-not-exist"), NotFoundError);
  });
});

test("project close/reopen round-trips status, closing an unknown project throws NotFoundError", async () => {
  await withStore(async (store, dir) => {
    const project = await store.createProject("demo", dir);

    await store.closeProject(project.id);
    assert.equal(store.getProject(project.id)!.status, "closed");

    await store.reopenProject(project.id);
    assert.equal(store.getProject(project.id)!.status, "active");

    await assert.rejects(() => store.closeProject("does-not-exist"), NotFoundError);
    await assert.rejects(() => store.reopenProject("does-not-exist"), NotFoundError);
  });
});

test("state survives a restart via snapshot + log replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-pt-restart-"));
  try {
    let projectId: string;
    {
      const log = new EventLog(dir);
      await log.init();
      const store = new ProjectThreadStore(dir, log);
      await store.load();
      const project = await store.createProject("demo", dir);
      projectId = project.id;
      await store.save();
    }
    {
      const log2 = new EventLog(dir);
      await log2.init();
      const store2 = new ProjectThreadStore(dir, log2);
      await store2.load();
      assert.ok(store2.getProject(projectId));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("走行中のClearは、そのターンのresume-point更新で取り消されない", async () => {
  await withStore(async (store) => {
    const project = await store.createProject("P", "/tmp");
    const thread = await store.createBaseThread(project.id);
    await store.updateResumePoint(thread.id, "session-1");

    // ターンが走っている最中に人が Clear した
    await store.clearThread(thread.id);
    assert.equal(store.getThread(thread.id)?.resumePoint, undefined);

    // そのターンが終わり、開始時のセッションidで resume-point を更新しようとする
    // ——**Clear を取り消してはいけない**（実装前はここで復活し、画面には
    // 横線だけ残って文脈は畳まれていなかった。見直し・2026-09-06）
    await store.updateResumePoint(thread.id, "session-1");
    assert.equal(
      store.getThread(thread.id)?.resumePoint,
      undefined,
      "Clear のあとに、畳む前のセッションが復活している",
    );

    // Clear のあとに始まった新しいターンの resume-point は、当然入る
    await store.updateResumePoint(thread.id, "session-2");
    assert.equal(store.getThread(thread.id)?.resumePoint, "session-2");
  });
});

test("ターンのキャッシュの内訳（使い回し・覚え直し）を記録に残す", async () => {
  await withStore(async (store) => {
    const project = await store.createProject("P", "/tmp");
    const thread = await store.createBaseThread(project.id);

    // Runner が返した usage をそのまま残す——加工しない（規則3・規則12）
    await store.recordUsage(thread.id, { totalTokens: 1000 }, 0, {
      input_tokens: 12,
      output_tokens: 34,
      cache_read_input_tokens: 21177,
      cache_creation_input_tokens: 344,
    });

    const entry = store.getThread(thread.id)!.usage.at(-1)!;
    assert.deepEqual(entry.apiUsage, {
      input_tokens: 12,
      output_tokens: 34,
      cache_read_input_tokens: 21177,
      cache_creation_input_tokens: 344,
    });
  });
});

test("**正規化より前に作られた Project の root も、読むときに正しく返る**", async () => {
  // 実データに `~/` のまま残っている Project がある（正規化を入れる前の作成）。
  // 会話側（turn-runner の cwd）だけ防御的に正規化していたため、**Module の
  // 起動には生のまま渡り**、`<どこか>/~` を読もうとして落ちた
  // （ユーザー報告・2026-09-07：ENOENT scandir '.../banto/~'）。
  // **読むところで1回だけ直す**——使う側それぞれが直すと、いつかまた漏れる（規則3）。
  const dir = await mkdtemp(join(tmpdir(), "banto-root-legacy-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const store = new ProjectThreadStore(dir, log);
    await store.load();

    // 正規化を通さずに、生の `~/` を直接イベントとして積む（古いデータの再現）
    const created = await log.append("project.created", {
      id: "legacy-project",
      name: "古い Project",
      root: "~/",
      createdAt: new Date(0).toISOString(),
    });
    store["projection"].applyOne(created);

    const project = store.getProject("legacy-project");
    assert.ok(project);
    assert.ok(
      project.root.startsWith("/"),
      `root が絶対パスになっていない: ${JSON.stringify(project.root)}`,
    );
    assert.ok(!project.root.includes("~"), `root に ~ が残っている: ${project.root}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
