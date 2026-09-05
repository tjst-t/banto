import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore, MemoryLimitExceededError, InvalidProjectRootError, NotFoundError } from "./store.js";

async function withStore(fn: (store: ProjectThreadStore, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "banto-pt-test-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const store = new ProjectThreadStore(dir, log);
    await store.load();
    await fn(store, dir);
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

test("fork thread inherits memory at fork time, not after", async () => {
  await withStore(async (store, dir) => {
    const project = await store.createProject("demo", dir);
    const base = await store.createBaseThread(project.id);
    await store.appendMemory(base.id, "decided: use TypeScript");

    const fork = await store.forkThread(base.id);
    assert.equal(fork.memory.length, 1);

    // 分岐後に親へ追記しても、既存のforkには自動で反映されない
    await store.appendMemory(base.id, "decided: use Rust for landlock");
    const forkAfter = store.getThread(fork.id)!;
    assert.equal(forkAfter.memory.length, 1);
    const baseAfter = store.getThread(base.id)!;
    assert.equal(baseAfter.memory.length, 2);
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
    const thread = await store.createBaseThread(project.id);
    await store.appendMemory(thread.id, "wrong decision");
    const entrySeq = store.getThread(thread.id)!.memory[0]!.seq;

    await store.invalidateMemory(thread.id, entrySeq);
    const after = store.getThread(thread.id)!;
    assert.equal(after.memory.length, 1, "entry still present, not deleted");
    assert.equal(after.memory[0]!.invalidated, true);
  });
});

test("memory entries over the char limit are rejected", async () => {
  await withStore(async (store, dir) => {
    const project = await store.createProject("demo", dir);
    const thread = await store.createBaseThread(project.id);
    await assert.rejects(
      () => store.appendMemory(thread.id, "x".repeat(20_001)),
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
