import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore } from "../project-thread/store.js";
import { NEW_CHAT_NAME } from "./chat-project.js";
import { ChatTitler, cleanModelTitle, titleFromFirstSentence, CHAT_TITLE_MAX_CHARS } from "./chat-title.js";

async function withStore(fn: (store: ProjectThreadStore, log: EventLog, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "banto-chat-title-test-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const store = new ProjectThreadStore(dir, log);
    await store.load();
    await fn(store, log, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function renamedEvents(log: EventLog, projectId: string): Promise<Array<{ id: string; name: string }>> {
  const out: Array<{ id: string; name: string }> = [];
  for await (const e of log.readFrom(0)) {
    const payload = e.payload as { id: string; name: string };
    if (e.type === "project.renamed" && payload.id === projectId) out.push(payload);
  }
  return out;
}

async function chat(store: ProjectThreadStore, dir: string) {
  const project = await store.createProject(NEW_CHAT_NAME, dir, { kind: "chat" });
  const thread = await store.createBaseThread(project.id);
  return { project, thread };
}

test("最初のターンのあと、小さいモデルの題で project.renamed が1回積まれ、projects.changed が流れる。次のターンでは付けない", async () => {
  await withStore(async (store, log, dir) => {
    const { project, thread } = await chat(store, dir);
    const asked: Array<{ projectId: string; prompt: string }> = [];
    const titler = new ChatTitler({
      projectThread: store,
      ask: async ({ projectId, prompt }) => {
        asked.push({ projectId, prompt });
        return "「家計簿アプリの相談」。";
      },
    });
    let changed = 0;
    store.onProjectsChanged(() => changed++);
    await titler.turnStarted(thread.id, "家計簿のアプリを作りたい。まず何から考えればいい？");
    assert.deepEqual(asked, [{ projectId: project.id, prompt: "家計簿のアプリを作りたい。まず何から考えればいい？" }]);
    assert.equal(store.getProject(project.id)?.name, "家計簿アプリの相談");
    assert.equal(changed, 1);
    await titler.turnStarted(thread.id, "二回目の書き込み");
    assert.equal(asked.length, 1);
    assert.deepEqual(await renamedEvents(log, project.id), [{ id: project.id, name: "家計簿アプリの相談" }]);
  });
});

test("待っている間に次のターンが始まっても、小さいモデルは1回しか呼ばない", async () => {
  await withStore(async (store, log, dir) => {
    const { project, thread } = await chat(store, dir);
    let calls = 0;
    let answer!: (title: string) => void;
    const titler = new ChatTitler({
      projectThread: store,
      ask: () => {
        calls++;
        return new Promise<string>((resolve) => (answer = resolve));
      },
    });
    const first = titler.turnStarted(thread.id, "一回目");
    await titler.turnStarted(thread.id, "二回目");
    answer("題");
    await first;
    assert.equal(calls, 1);
    assert.equal((await renamedEvents(log, project.id)).length, 1);
  });
});

test("人が先に名前を変えていれば、小さいモデルを呼ばず積まない", async () => {
  await withStore(async (store, log, dir) => {
    const { project, thread } = await chat(store, dir);
    await store.renameProject(project.id, "人が付けた名前");
    let calls = 0;
    const titler = new ChatTitler({ projectThread: store, ask: async () => (calls++, "AI の題") });
    await titler.turnStarted(thread.id, "相談したい");
    assert.equal(calls, 0);
    assert.equal(store.getProject(project.id)?.name, "人が付けた名前");
    assert.deepEqual(await renamedEvents(log, project.id), [{ id: project.id, name: "人が付けた名前" }]);
  });
});

test("小さいモデルを待っている間に人が名前を変えたら、積まない", async () => {
  await withStore(async (store, log, dir) => {
    const { project, thread } = await chat(store, dir);
    const titler = new ChatTitler({
      projectThread: store,
      ask: async () => {
        await store.renameProject(project.id, "人が付けた名前");
        return "AI の題";
      },
    });
    await titler.turnStarted(thread.id, "相談したい");
    assert.equal(store.getProject(project.id)?.name, "人が付けた名前");
    assert.equal((await renamedEvents(log, project.id)).length, 1);
  });
});

test("小さいモデルが失敗したら、書き込みの最初の文を縮めた題にする", async () => {
  await withStore(async (store, log, dir) => {
    const { project, thread } = await chat(store, dir);
    const titler = new ChatTitler({
      projectThread: store,
      ask: async () => {
        throw new Error("Not logged in");
      },
    });
    await titler.turnStarted(thread.id, "\n  週末に行く旅行の計画を立てたい。予算は5万円くらい。\n");
    assert.deepEqual(await renamedEvents(log, project.id), [{ id: project.id, name: "週末に行く旅行の計画を立てたい" }]);
  });
});

test("小さいモデルの答えが題の形にならなければ（引用符だけ等）、最初の文の題にする", async () => {
  await withStore(async (store, _log, dir) => {
    const { project, thread } = await chat(store, dir);
    const titler = new ChatTitler({ projectThread: store, ask: async () => "「」" });
    await titler.turnStarted(thread.id, "Plan a trip. Budget is small.");
    assert.equal(store.getProject(project.id)?.name, "Plan a trip");
  });
});

test("普通の Project・閉じたチャットには題を付けない", async () => {
  await withStore(async (store, log, dir) => {
    const normal = await store.createProject(NEW_CHAT_NAME, dir);
    const normalThread = await store.createBaseThread(normal.id);
    const { project: closed, thread: closedThread } = await chat(store, dir);
    await store.closeProject(closed.id);
    let calls = 0;
    const titler = new ChatTitler({ projectThread: store, ask: async () => (calls++, "題") });
    await titler.turnStarted(normalThread.id, "相談");
    await titler.turnStarted(closedThread.id, "相談");
    assert.equal(calls, 0);
    assert.equal((await renamedEvents(log, normal.id)).length + (await renamedEvents(log, closed.id)).length, 0);
  });
});

test("最初の文の題：文の終わりで切り、長ければ縮める。空白だけなら無い", () => {
  assert.equal(titleFromFirstSentence("家計簿を作りたい！どう？"), "家計簿を作りたい");
  assert.equal(titleFromFirstSentence("Use v1.2 for this. Then more"), "Use v1.2 for this");
  assert.equal(titleFromFirstSentence("   \n  "), undefined);
  const long = "あ".repeat(50);
  const clipped = titleFromFirstSentence(long)!;
  assert.equal([...clipped].length, CHAT_TITLE_MAX_CHARS);
  assert.ok(clipped.endsWith("…"));
});

test("小さいモデルの答えを整える：前置き・囲み・末尾の句点を落とす", () => {
  assert.equal(cleanModelTitle("Title: \"Trip planning\"."), "Trip planning");
  assert.equal(cleanModelTitle("『旅行の計画』"), "旅行の計画");
  assert.equal(cleanModelTitle("  "), undefined);
});
