import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore, MemoryLimitExceededError, InvalidProjectRootError, NotFoundError } from "./store.js";
import { projectThreadFold } from "./fold.js";

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
    const forkAtOldPoint = await store.forkThread(base.id, { resumePoint: "sdk-session-older" });
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

test("画面つき tool の呼び出しに『どの面に出したか』を書き足せる", async () => {
  // **記録が「どの tool をどの引数で呼んだか」だけだと、リロード後に出し直せない**
  // （ユーザー指摘・2026-09-07）。inline は会話の中に埋め、fullscreen は入口だけ
  // 残す——その区別がここに無かったため、復元した画面が毎回「大きく出して」と
  // 言い直し、リロードのたびに Canvas が勝手に開いていた。
  await withStore(async (store) => {
    const project = await store.createProject("表示の記録", "/tmp");
    const thread = await store.createBaseThread(project.id);
    await store.appendMessage(thread.id, "assistant", "一覧を出しました", [
      {
        toolCallId: "call-1",
        toolName: "mcp__filesystem__listDirectory",
        server: "filesystem",
        resourceUri: "ui://banto-filesystem/directory",
        args: { path: "." },
      },
    ]);

    // 記録した時点では「どの面か」はまだ決まっていない（決めるのは画面）
    const before = store.getThread(thread.id)?.messages.at(-1)?.uiToolCalls?.[0];
    assert.equal(before?.displayMode, undefined);

    await store.recordUiToolCallDisplayMode(thread.id, "call-1", "fullscreen");
    const after = store.getThread(thread.id)?.messages.at(-1)?.uiToolCalls?.[0];
    assert.equal(after?.displayMode, "fullscreen");
    // 他の項目を落としていない
    assert.equal(after?.server, "filesystem");
    assert.deepEqual(after?.args, { path: "." });
  });
});

test("Fork は『親のどこで分岐したか』を持つ", async () => {
  // Fork の入口を**親の会話のその場所**に置くために要る（決定・2026-09-07）。
  // 新しいイベント型は足さない——分岐イベント自身の seq をそのまま持つ（規則3）。
  await withStore(async (store) => {
    const project = await store.createProject("分岐の位置", "/tmp");
    const parent = await store.createBaseThread(project.id);
    await store.appendMessage(parent.id, "user", "1つめ");
    await store.appendMessage(parent.id, "assistant", "はい");
    const afterFirstPair = store.getThread(parent.id)!.messages.at(-1)!.seq;

    const fork = await store.forkThread(parent.id);
    assert.ok(
      fork.createdSeq > afterFirstPair,
      `分岐の位置が会話より前になっている（fork=${fork.createdSeq} messages=${afterFirstPair}）`,
    );
    assert.equal(store.getThread(fork.id)?.parentThreadId, parent.id);
  });
});

test("『どの面に出したか』が会話より先に届いても、取りこぼさない", async () => {
  // **実際に踏んだ順番**（実測・2026-09-07）：画面が「大きく出して」と言うのは
  // ターンの**途中**、その tool 呼び出しが会話に書かれるのはターンの**終わり**。
  // 先に届いた記録は宛先がまだ無く、そのまま捨てられていた——結果、リロードすると
  // また会話に画面が埋まり、その画面がまた「大きく出して」と言って勝手に開いた。
  await withStore(async (store) => {
    const project = await store.createProject("順番", "/tmp");
    const thread = await store.createBaseThread(project.id);

    // 先に「大きく出した」が届く（会話はまだ書かれていない）
    await store.recordUiToolCallDisplayMode(thread.id, "call-early", "fullscreen");
    await store.appendMessage(thread.id, "assistant", "出しました", [
      {
        toolCallId: "call-early",
        toolName: "mcp__filesystem__listDirectory",
        server: "filesystem",
        resourceUri: "ui://banto-filesystem/directory",
      },
    ]);

    const call = store.getThread(thread.id)?.messages.at(-1)?.uiToolCalls?.[0];
    assert.equal(call?.displayMode, "fullscreen");
  });
});

// **名前と並び順**（決定・2026-09-11、ユーザー要望）。
// どちらも人の意図であって導出できないので、イベントとして残す。

/** 記録（Event Store）から読み直した別の store。**覚えているのではなく、
 *  記録から出てくる**ことを見るために使う。 */
async function remakeFrom(dir: string, log: EventLog): Promise<ProjectThreadStore> {
  const store = new ProjectThreadStore(dir, log);
  await store.load();
  return store;
}

test("Project の名前を変えられる——記録から読み直しても残る", async () => {
  await withStore(async (store, dir, log) => {
    const project = await store.createProject("まえの名前", dir);
    await store.renameProject(project.id, "あとの名前");
    assert.equal(store.getProject(project.id)!.name, "あとの名前");
    const reloaded = await remakeFrom(dir, log);
    assert.equal(reloaded.getProject(project.id)!.name, "あとの名前", "読み直したら元に戻った");
  });
});

test("Fork の名前は、付けたものだけを持つ（既定の呼び名は持たない）", async () => {
  await withStore(async (store, dir, log) => {
    const project = await store.createProject("p", dir);
    const base = await store.createBaseThread(project.id);
    const fork = await store.forkThread(base.id);
    assert.equal(fork.title, undefined, "付けていない名前を持っている（規則3）");
    await store.renameThread(fork.id, "設計の枝");
    const reloaded = await remakeFrom(dir, log);
    assert.equal(reloaded.getThread(fork.id)!.title, "設計の枝");
  });
});

test("並び順は人が決めたとおりに返る。並びに無いものは後ろへ", async () => {
  await withStore(async (store, dir, log) => {
    const a = await store.createProject("A", dir);
    const b = await store.createProject("B", dir);
    const c = await store.createProject("C", dir);
    await store.setProjectOrder([c.id, a.id, b.id]);
    assert.deepEqual(store.listProjects().map((p) => p.name), ["C", "A", "B"]);

    // **並び替えた後に作ったもの**は、並びの後ろに出る（消えない）
    const d = await store.createProject("D", dir);
    assert.deepEqual(store.listProjects().map((p) => p.name), ["C", "A", "B", "D"]);

    const reloaded = await remakeFrom(dir, log);
    assert.deepEqual(reloaded.listProjects().map((p) => p.name), ["C", "A", "B", "D"]);
    void d;
  });
});

test("知らない id を並びに入れない——順番の中に幽霊を作らない", async () => {
  await withStore(async (store, dir) => {
    const a = await store.createProject("A", dir);
    await assert.rejects(() => store.setProjectOrder([a.id, "存在しない"]));
    // 断られたのだから、並びは変わっていない
    assert.deepEqual(store.listProjects().map((p) => p.name), ["A"]);
  });
});

test("Fork の並びは Project ごと。Base は常に先頭のまま", async () => {
  await withStore(async (store, dir) => {
    const project = await store.createProject("p", dir);
    const base = await store.createBaseThread(project.id);
    const f1 = await store.forkThread(base.id);
    const f2 = await store.forkThread(base.id);
    await store.setForkOrder(project.id, [f2.id, f1.id]);
    const ordered = store.listThreadsForProject(project.id);
    assert.deepEqual(
      ordered.map((t) => t.id),
      [base.id, f2.id, f1.id],
      "Base が先頭でない、または Fork の並びが効いていない",
    );
    // 別の Project の Thread は混ぜない
    const other = await store.createProject("q", dir);
    await assert.rejects(() => store.setForkOrder(other.id, [f1.id]));
  });
});

// **後から足した欄は、無い状態から読み戻される**（実測・2026-09-11、実機で踏んだ）。
// 並び順の欄（`projectOrder` / `threadOrder`）を足した日、**前からある snapshot**
// にはその欄が無く、Project の一覧が 500 を返した（`[...undefined]`）。
// 記録は追記だけで書き換えないので、古い形から読み戻せることは常に要る。

test("並び順の欄が無い snapshot から読み戻しても落ちない", () => {
  const legacy = {
    projects: new Map(),
    threads: new Map(),
    displayModeByToolCall: new Map(),
  } as unknown as Parameters<typeof projectThreadFold.apply>[0];

  const next = projectThreadFold.apply(legacy, {
    seq: 1,
    ts: new Date(0).toISOString(),
    type: "project.created",
    payload: { id: "p1", name: "古い記録", root: "/tmp" },
  } as unknown as Parameters<typeof projectThreadFold.apply>[1]);

  assert.equal(next.projectOrder.length, 0, "無い欄を空として扱えていない");
  assert.equal(next.threadOrder.size, 0);
  assert.equal(next.projects.get("p1")!.name, "古い記録");
});

/** いま入れたばかりのメッセージ（seq を知るため）。 */
function lastMessage(store: ProjectThreadStore, threadId: string) {
  const messages = store.getThread(threadId)!.messages;
  return messages[messages.length - 1]!;
}

// **過去のメッセージの時点から分ける**（決定・2026-09-11、ユーザー要望）。
// 「Clear した後でも、Clear する前のセッションの Fork を作れるように」が要望の核心。

test("過去のメッセージの時点から分けると、その時点のセッションに戻る", async () => {
  await withStore(async (store, dir) => {
    const project = await store.createProject("p", dir);
    const base = await store.createBaseThread(project.id);

    // 1ターン目
    await store.appendMessage(base.id, "user", "ひとつめ");
    await store.updateResumePoint(base.id, "session-1");
    await store.appendMessage(base.id, "assistant", "こたえ1");
    const first = lastMessage(store, base.id);
    // 2ターン目
    await store.appendMessage(base.id, "user", "ふたつめ");
    await store.updateResumePoint(base.id, "session-2");
    await store.appendMessage(base.id, "assistant", "こたえ2");

    // いまの続きから分ければ、最新のセッション
    const latest = await store.forkThread(base.id);
    assert.equal(latest.resumePoint, "session-2");

    // **1つめの答えの時点から分ければ、そのときのセッション**
    const older = await store.forkThread(base.id, { fromSeq: first.seq });
    assert.equal(older.resumePoint, "session-1", "その時点のセッションに戻っていない");
    assert.equal(older.forkedFromSeq, first.seq);

    // **分けた後の親のやり取りは混ざらない**（会話の表示もそこまで）
    assert.deepEqual(
      store.getThread(older.id)!.messages.map((m) => m.text),
      ["ひとつめ", "こたえ1"],
      "分けた場所より後のやり取りが Fork に入っている",
    );
    assert.deepEqual(
      store.getThread(latest.id)!.messages.map((m) => m.text),
      ["ひとつめ", "こたえ1", "ふたつめ", "こたえ2"],
    );
  });
});

test("Clear した後でも、Clear より前のやり取りから分けられる", async () => {
  await withStore(async (store, dir) => {
    const project = await store.createProject("p", dir);
    const base = await store.createBaseThread(project.id);
    await store.appendMessage(base.id, "user", "畳む前");
    await store.updateResumePoint(base.id, "session-before");
    await store.appendMessage(base.id, "assistant", "畳む前のこたえ");
    const beforeClear = lastMessage(store, base.id);

    await store.clearThread(base.id);
    // Clear の後は、いまの続き＝新しい会話（resume-point 無し）
    assert.equal(store.getThread(base.id)!.resumePoint, undefined);
    assert.equal((await store.forkThread(base.id)).resumePoint, undefined);

    // **手放したセッションからも分けられる**——これが要望そのもの
    const fork = await store.forkThread(base.id, { fromSeq: beforeClear.seq });
    assert.equal(fork.resumePoint, "session-before", "Clear 前のセッションへ戻れない");
    // 横線（Clear）はその後の出来事なので、Fork の会話には入らない
    assert.equal(store.getThread(fork.id)!.markers.length, 0);
  });
});

test("まだ1度も走っていない時点から分けたら、新しい会話として始まる", async () => {
  await withStore(async (store, dir) => {
    const project = await store.createProject("p", dir);
    const base = await store.createBaseThread(project.id);
    await store.appendMessage(base.id, "user", "まだ走っていない");
    const first = lastMessage(store, base.id);
    const fork = await store.forkThread(base.id, { fromSeq: first.seq });
    assert.equal(fork.resumePoint, undefined, "無いものを在るように扱っている");
  });
});

// **効かせた Skill の集合を会話に刻む**（決定・2026-09-23、§5.7）。
// `instructions` は resume でも Fork でも読み直されない（実測）ので、集合は
// 新しいセッションの最初のターンで決まり、Fork は分けた時点のものを引き継ぐ。
function skillSet(...names: string[]) {
  return {
    active: names.map((name) => ({ module: "skills", name, description: name, uri: `skill://${name}` })),
    othersIn: [],
    problems: [],
  };
}

test("効かせた Skill の集合を会話に刻む。同じものは刻み直さない", async () => {
  const { currentSkillSet } = await import("./store.js");
  await withStore(async (store, dir) => {
    const project = await store.createProject("demo", dir);
    const thread = await store.createBaseThread(project.id);
    assert.equal(currentSkillSet(store.getThread(thread.id)!), undefined, "刻んでいないのに何か効いている");

    await store.fixSessionSkills(thread.id, skillSet("pdf"));
    await store.fixSessionSkills(thread.id, skillSet("pdf"));
    assert.equal(store.getThread(thread.id)!.skillSets!.length, 1, "同じ集合で記録を埋めた");

    // Clear の後の新しいセッションで別の集合を刻む——前のセッションの記録は残る（「あのとき」）
    await store.clearThread(thread.id);
    await store.fixSessionSkills(thread.id, skillSet("pdf", "xlsx"));
    const t = store.getThread(thread.id)!;
    assert.deepEqual(
      t.skillSets!.map((s) => s.set.active.map((a) => a.name)),
      [["pdf"], ["pdf", "xlsx"]],
    );
    assert.deepEqual(
      currentSkillSet(t)!.active.map((a) => a.name),
      ["pdf", "xlsx"],
    );
  });
});

test("Fork は分けた時点で効いていた集合を引き継ぐ——過去のメッセージから分けたら、その時点のもの", async () => {
  const { currentSkillSet } = await import("./store.js");
  await withStore(async (store, dir) => {
    const project = await store.createProject("demo", dir);
    const base = await store.createBaseThread(project.id);
    // 実際のターンの順：刻む → 人の発言 → セッション確定 → 答え
    await store.fixSessionSkills(base.id, skillSet("pdf"));
    await store.appendMessage(base.id, "user", "1つ目のセッション");
    await store.updateResumePoint(base.id, "session-1");
    await store.appendMessage(base.id, "assistant", "1つ目のこたえ");
    const firstSessionMessage = lastMessage(store, base.id).seq;

    await store.clearThread(base.id);
    await store.fixSessionSkills(base.id, skillSet("xlsx"));
    await store.appendMessage(base.id, "user", "2つ目のセッション");

    const now = await store.forkThread(base.id);
    assert.deepEqual(
      currentSkillSet(store.getThread(now.id)!)!.active.map((a) => a.name),
      ["xlsx"],
      "いまから分けた Fork が、いま効いている集合を持っていない",
    );

    const past = await store.forkThread(base.id, { fromSeq: firstSessionMessage });
    assert.equal(store.getThread(past.id)!.resumePoint, "session-1");
    assert.deepEqual(
      currentSkillSet(store.getThread(past.id)!)!.active.map((a) => a.name),
      ["pdf"],
      "過去から分けた Fork が、その時点の集合を持っていない",
    );
  });
});

test("Fork が引き継いだ会話は、スナップショットに1度だけ書き、読み戻しても同じものを指す（2026-10-04、実機で 121MB）", async () => {
  await withStore(async (store, dir, log) => {
    const project = await store.createProject("demo", dir);
    const base = await store.createBaseThread(project.id);
    const big = "x".repeat(100_000);
    for (let i = 0; i < 5; i++) await store.appendMessage(base.id, i % 2 ? "assistant" : "user", `${i}${big}`);
    const forks = [];
    for (let i = 0; i < 10; i++) forks.push(await store.forkThread(base.id));
    // Fork だけが持つ書き換え（表のものと中身が違う）はそのまま残る
    await store.appendMessage(forks[0]!.id, "user", "fork だけの発言");
    await store.save();

    const { stat } = await import("node:fs/promises");
    const size = (await stat(join(dir, "project-thread.v9.snapshot.json"))).size;
    assert.ok(size < 5 * 100_000 * 2, `会話が Fork の数だけ写されている（${size} bytes）`);

    const again = new ProjectThreadStore(dir, log);
    await again.load();
    const b = again.getThread(base.id)!;
    const f = again.getThread(forks[3]!.id)!;
    assert.equal(f.messages.length, 5);
    assert.equal(f.messages[2], b.messages[2], "読み戻したら別々のオブジェクトになった");
    assert.equal(again.getThread(forks[0]!.id)!.messages.at(-1)!.text, "fork だけの発言");
    assert.deepEqual(
      again.getThread(forks[9]!.id)!.messages.map((m) => m.text.slice(0, 1)),
      ["0", "1", "2", "3", "4"],
    );
  });
});

test("前の形（会話をそのまま書いた）スナップショットも読め、同じ中身はまとめる", async () => {
  await withStore(async (store, dir, log) => {
    const project = await store.createProject("demo", dir);
    const base = await store.createBaseThread(project.id);
    await store.appendMessage(base.id, "user", "こんにちは");
    const fork = await store.forkThread(base.id);
    // 前の形で書く（pack を通さない）
    const { writeFile: wf } = await import("node:fs/promises");
    const replacer = (_k: string, v: unknown) => (v instanceof Map ? { __banto_map__: true, entries: [...v.entries()] } : v);
    await wf(join(dir, "project-thread.v9.snapshot.json"), JSON.stringify({ seq: 999999, state: (store as unknown as { projection: { current: unknown } }).projection.current }, replacer));
    const again = new ProjectThreadStore(dir, log);
    await again.load();
    assert.equal(again.getThread(fork.id)!.messages[0], again.getThread(base.id)!.messages[0]);
    assert.equal(again.getThread(fork.id)!.messages[0]!.text, "こんにちは");
  });
});

test("使用量は最新の1件だけ持ち、Fork にも最新だけ引き継ぐ（2026-10-04、実機で 113MB）", async () => {
  await withStore(async (store, dir) => {
    const project = await store.createProject("demo", dir);
    const base = await store.createBaseThread(project.id);
    const s = store as unknown as { recordUsage(id: string, u: unknown, c: number, a?: unknown): Promise<void> };
    for (let i = 0; i < 5; i++) await s.recordUsage(base.id, { n: i }, 0);
    assert.deepEqual(store.getThread(base.id)!.usage.map((u) => u.contextUsage), [{ n: 4 }]);
    const fork = await store.forkThread(base.id);
    assert.deepEqual(store.getThread(fork.id)!.usage.map((u) => u.contextUsage), [{ n: 4 }]);
  });
});

// **起こし直しをまたいで続ける**（2026-10-05、アーキ仕様 §2.5）——ターンの進み具合と、切れたターンの見分け方

/** 同じ置き場を、起動し直したように開き直す（snapshot は書かない——ログだけから畳む） */
async function reopen(dir: string): Promise<ProjectThreadStore> {
  const log = new EventLog(dir);
  await log.init();
  const store = new ProjectThreadStore(dir, log);
  await store.load();
  return store;
}

test("始めて終わっていないターンは、起動し直した store から切れたターンとして見える", async () => {
  await withStore(async (store, dir) => {
    const project = await store.createProject("P", dir);
    const thread = await store.createBaseThread(project.id);
    await store.updateResumePoint(thread.id, "session-1", "uuid-a");
    const turnId = await store.startTurn(thread.id, {
      cause: "human",
      attempt: 0,
      resumePoint: "session-1",
      rewindTo: "uuid-a",
    });
    await store.recordTurnSessionKnown(thread.id, turnId, "session-1");

    const reopened = await reopen(dir);
    const found = reopened.listInterruptedTurns();
    assert.equal(found.length, 1);
    const [t] = found;
    assert.equal(t!.threadId, thread.id);
    assert.equal(t!.turnId, turnId);
    assert.equal(t!.cause, "human");
    assert.equal(t!.attempt, 0);
    assert.equal(t!.sessionId, "session-1");
    assert.equal(t!.resumePoint, "session-1");
    assert.equal(t!.rewindTo, "uuid-a");
    assert.ok(t!.startedSeq > 0);
    assert.ok(t!.startedAt);
  });
});

test("会話の id が分かっても resume-point は変えない（走行中の Fork・Clear の防御のため）", async () => {
  await withStore(async (store, dir) => {
    const project = await store.createProject("P", dir);
    const thread = await store.createBaseThread(project.id);
    await store.updateResumePoint(thread.id, "session-1");
    const turnId = await store.startTurn(thread.id, { cause: "human", attempt: 0, resumePoint: "session-1" });
    // Fork の最初のターンのように、system/init で新しい id が分かった
    await store.recordTurnSessionKnown(thread.id, turnId, "session-2");
    assert.equal(store.getThread(thread.id)?.resumePoint, "session-1");
    assert.equal(store.getThread(thread.id)?.lastTurn?.knownSessionId, "session-2");
    assert.equal(store.listInterruptedTurns()[0]?.sessionId, "session-2");
  });
});

test("新しい会話の最初のターンは、host が先に決めた id で見分けられる（system/init の前に切れても）", async () => {
  await withStore(async (store, dir) => {
    const project = await store.createProject("P", dir);
    const thread = await store.createBaseThread(project.id);
    await store.startTurn(thread.id, { cause: "delivery", attempt: 1, sessionId: "assigned-1" });
    const [t] = store.listInterruptedTurns();
    assert.equal(t?.sessionId, "assigned-1");
    assert.equal(t?.cause, "delivery");
    assert.equal(t?.attempt, 1);
    assert.equal(t?.resumePoint, undefined);
  });
});

test("終わりを書いたターン・resume-point を書いたあとに止まったターンは、切れたことにしない", async () => {
  await withStore(async (store, dir) => {
    const project = await store.createProject("P", dir);
    const ended = await store.createBaseThread(project.id);
    const afterResumePoint = (await store.forkThread(ended.id, { fresh: true })).id;

    const a = await store.startTurn(ended.id, { cause: "human", attempt: 0, sessionId: "s-a" });
    await store.updateResumePoint(ended.id, "s-a");
    await store.endTurn(ended.id, a, "completed");

    // resume-point → 返事 → … → turn.ended の途中で止まった（CLI の側ではターンは終わっている）
    await store.startTurn(afterResumePoint, { cause: "human", attempt: 0, sessionId: "s-b" });
    await store.updateResumePoint(afterResumePoint, "s-b");

    assert.deepEqual((await reopen(dir)).listInterruptedTurns(), []);
  });
});

test("止めた・失敗したターンも、終わりを書いていれば切れたことにしない", async () => {
  await withStore(async (store, dir) => {
    const project = await store.createProject("P", dir);
    const thread = await store.createBaseThread(project.id);
    const turnId = await store.startTurn(thread.id, { cause: "human", attempt: 0, sessionId: "s" });
    await store.endTurn(thread.id, turnId, "failed");
    assert.equal(store.getThread(thread.id)?.lastTurn?.outcome, "failed");
    assert.deepEqual(store.listInterruptedTurns(), []);
  });
});

test("始めたあとに Clear・Thread を閉じた・Project を閉じたものは続けない", async () => {
  await withStore(async (store, dir) => {
    const project = await store.createProject("P", dir);
    const other = await store.createProject("Q", dir);
    const cleared = await store.createBaseThread(project.id);
    const closed = (await store.forkThread(cleared.id, { fresh: true })).id;
    const inClosedProject = await store.createBaseThread(other.id);
    const untouched = (await store.forkThread(cleared.id, { fresh: true })).id;

    for (const id of [cleared.id, closed, inClosedProject.id, untouched]) {
      await store.startTurn(id, { cause: "human", attempt: 0, sessionId: `s-${id}` });
    }
    await store.clearThread(cleared.id);
    await store.closeThread(closed);
    await store.closeProject(other.id);
    // 開き直しても、閉じた時点で走っていたターンは続けない
    await store.reopenThread(closed);

    const found = (await reopen(dir)).listInterruptedTurns();
    assert.deepEqual(
      found.map((t) => t.threadId),
      [untouched],
    );
    assert.equal(store.getThread(cleared.id)?.lastTurn?.abandonedBy, "cleared");
    assert.equal(store.getThread(closed)?.lastTurn?.abandonedBy, "thread_closed");
    assert.equal(store.getThread(inClosedProject.id)?.lastTurn?.abandonedBy, "project_closed");
  });
});

test("見るのは最後のターンだけ。前のターンの id で来た出来事は、今のターンに付けない", async () => {
  await withStore(async (store, dir) => {
    const project = await store.createProject("P", dir);
    const thread = await store.createBaseThread(project.id);
    const first = await store.startTurn(thread.id, { cause: "human", attempt: 0, sessionId: "s-1" });
    await store.endTurn(thread.id, first, "completed");
    const second = await store.startTurn(thread.id, { cause: "human", attempt: 0, resumePoint: "s-1" });
    await store.recordTurnSessionKnown(thread.id, first, "s-old");
    await store.endTurn(thread.id, first, "completed");
    const [t] = store.listInterruptedTurns();
    assert.equal(t?.turnId, second);
    assert.equal(t?.sessionId, undefined, "前のターンの id で来た session id を付けている");
  });
});

test("ターンの進み具合はスナップショットから読み戻しても残る", async () => {
  await withStore(async (store, dir) => {
    const project = await store.createProject("P", dir);
    const thread = await store.createBaseThread(project.id);
    const turnId = await store.startTurn(thread.id, { cause: "human", attempt: 2, sessionId: "s" });
    await store.save();
    const [t] = (await reopen(dir)).listInterruptedTurns();
    assert.equal(t?.turnId, turnId);
    assert.equal(t?.attempt, 2);
  });
});

test("切れたターンが会話に積んだ発言の数（人の発言・届いたもの）を返す。始まりより前・AI の発言は数えない", async () => {
  await withStore(async (store, dir) => {
    const project = await store.createProject("P", dir);
    const empty = await store.createBaseThread(project.id);
    const stacked = await store.createBaseThread(project.id);
    await store.appendMessage(stacked.id, "user", "前のターンの発言");
    await store.appendMessage(stacked.id, "assistant", "前のターンの返事");

    // 発言を積む前に切れた
    await store.startTurn(empty.id, { cause: "human", attempt: 0, sessionId: "s-empty" });
    // 届いたものと人の発言を積んでから切れた
    await store.startTurn(stacked.id, { cause: "human", attempt: 0, sessionId: "s-stacked" });
    await store.appendMessage(stacked.id, "user", "届いたもの", undefined, { from: "m", title: "t", hop: 1, deliveryId: "d" });
    await store.appendMessage(stacked.id, "user", "人の発言");
    // AI の発言は数えない（止めて片づけたターンは返事を書くが、そのときは終わりも書いている。数え方だけを見る）
    await store.appendMessage(stacked.id, "assistant", "途中の返事");

    const found = new Map((await reopen(dir)).listInterruptedTurns().map((t) => [t.threadId, t.stackedMessages]));
    assert.equal(found.get(empty.id), 0);
    assert.equal(found.get(stacked.id), 2);
  });
});

test("走っている最初のターンを Clear したら、終わりの resume-point の更新で Clear を取り消さない（新しい会話・Fork）", async () => {
  await withStore(async (store, dir) => {
    const project = await store.createProject("P", dir);
    const base = await store.createBaseThread(project.id);
    // 新しい会話の最初のターン：resume-point はまだ無く、会話の id は先に決めたものだけ
    await store.startTurn(base.id, { cause: "human", attempt: 0, sessionId: "s-new" });
    await store.clearThread(base.id);
    await store.updateResumePoint(base.id, "s-new");
    assert.equal(store.getThread(base.id)?.resumePoint, undefined, "新しい会話の最初のターンが Clear を取り消した");

    // Fork の最初のターン：resume-point は親から借りたもの、自分の会話の id は system/init で分かる
    await store.updateResumePoint(base.id, "s-parent");
    const fork = await store.forkThread(base.id);
    const turnId = await store.startTurn(fork.id, { cause: "human", attempt: 0, resumePoint: "s-parent" });
    await store.recordTurnSessionKnown(fork.id, turnId, "s-forked");
    await store.clearThread(fork.id);
    await store.updateResumePoint(fork.id, "s-forked");
    assert.equal(store.getThread(fork.id)?.resumePoint, undefined, "Fork の最初のターンが Clear を取り消した");

    // Clear のあとに始まった新しい会話は、当然入る
    await store.startTurn(fork.id, { cause: "human", attempt: 0, sessionId: "s-after" });
    await store.updateResumePoint(fork.id, "s-after");
    assert.equal(store.getThread(fork.id)?.resumePoint, "s-after");
  });
});

test("Fork は親の最後のターンを引き継がない（親の切れたターンが Fork のものに見えない）", async () => {
  await withStore(async (store, dir) => {
    const project = await store.createProject("P", dir);
    const base = await store.createBaseThread(project.id);
    await store.updateResumePoint(base.id, "s-parent");
    await store.startTurn(base.id, { cause: "human", attempt: 0, resumePoint: "s-parent" });
    const fork = await store.forkThread(base.id);
    assert.equal(store.getThread(fork.id)?.lastTurn, undefined);
    assert.deepEqual(
      store.listInterruptedTurns().map((t) => t.threadId),
      [base.id],
    );
  });
});
