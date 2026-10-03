// tool の口を MCP 越しに確かめる——見える tool・絞り込み・Thread の刻印・無いファイル・古い形・設定。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { THREAD_META_KEY, VISIBILITY_META_KEY } from "@banto/module-contract";
import { createBacklogServer } from "./server.js";

async function connect() {
  const root = mkdtempSync(join(tmpdir(), "backlog-server-"));
  process.env.BANTO_MODULE_DATA_DIR = mkdtempSync(join(tmpdir(), "backlog-data-"));
  const server = createBacklogServer({ projectRoot: root, now: () => "2026-10-03T00:00:00.000Z" });
  const [s, c] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(s), client.connect(c)]);
  const call = async (name: string, args: Record<string, unknown> = {}, meta?: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) })) as {
      content: Array<{ text: string }>;
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };
  return { root, client, call };
}

test("AI に見せるのは6本だけ。消す tool は無い。人の画面の口は admin", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  const vis = (n: string) => (tools.find((t) => t.name === n)!._meta as Record<string, unknown>)[VISIBILITY_META_KEY];
  const agent = tools.filter((t) => (t._meta as Record<string, unknown>)[VISIBILITY_META_KEY] === "agent").map((t) => t.name);
  assert.deepEqual(agent, ["listItems", "getItem", "createItem", "updateItem", "splitStory", "moveItem"]);
  assert.ok(!tools.some((t) => /delete|remove/i.test(t.name)));
  for (const n of ["getBoard", "boardCreateItem", "boardUpdateItem", "boardSplitStory", "boardMoveItem", "getSettings", "setSettings"]) {
    assert.equal(vis(n), "admin", n);
  }
});

test("無いファイル：一覧は空で「まだ tasks.json がありません」と言い、最初の作成で作る", async () => {
  const { root, call } = await connect();
  const empty = await call("listItems");
  assert.match(empty.content[0]!.text, /まだ tasks\.json がありません（docs\/tasks\.json）/);
  assert.deepEqual(empty.structuredContent?.items, []);
  const created = await call("createItem", { kind: "story", title: "Backlog module" });
  assert.match(created.content[0]!.text, /docs\/tasks\.json を作り、足しました：backlog-module/);
  assert.equal(JSON.parse(readFileSync(join(root, "docs/tasks.json"), "utf8")).items.length, 1);
});

test("listItems：actionable は ready かつ依存が全部 done だけ。種類・親でも絞れる", async () => {
  const { call } = await connect();
  await call("createItem", { kind: "story", title: "Story", id: "s" });
  await call("splitStory", { storyId: "s", tasks: [{ title: "One" }, { title: "Two", waitsFor: [0] }] });
  await call("createItem", { kind: "bug", title: "Crash", status: "ready" });
  let r = await call("listItems", { actionable: true });
  assert.deepEqual((r.structuredContent!.items as Array<{ id: string }>).map((i) => i.id), ["one", "crash"]);
  await call("updateItem", { id: "one", status: "done" });
  r = await call("listItems", { actionable: true });
  assert.deepEqual((r.structuredContent!.items as Array<{ id: string }>).map((i) => i.id), ["two", "crash"]);
  r = await call("listItems", { parent: "s", status: ["done", "ready"] });
  assert.deepEqual((r.structuredContent!.items as Array<{ id: string }>).map((i) => i.id), ["one", "two"]);
  r = await call("listItems", { kind: "bug" });
  assert.match(r.content[0]!.text, /crash \[ready・着手できる\] Crash \(bug\)/);
});

test("updateItem：AI のターンの刻印があれば、進めた・閉じたときに Thread を足す。刻印が無ければ足さない", async () => {
  const { call } = await connect();
  await call("createItem", { kind: "task", title: "Work", status: "ready" });
  const stamp = { [THREAD_META_KEY]: { projectId: "p1", threadId: "t1" } };
  await call("updateItem", { id: "work", status: "in-progress" }, stamp);
  // 人の画面から（刻印なし）
  await call("boardUpdateItem", { id: "work", status: "ready" });
  await call("boardUpdateItem", { id: "work", status: "in-progress" });
  const got = await call("getItem", { id: "work" });
  assert.deepEqual((got.structuredContent!.item as { threads: unknown }).threads, [{ projectId: "p1", threadId: "t1" }]);
});

test("断るときは isError と理由（やめる理由なし・輪・知らない項目・型違い）", async () => {
  const { call } = await connect();
  await call("createItem", { kind: "task", title: "A", id: "a" });
  await call("createItem", { kind: "task", title: "B", id: "b", dependsOn: ["a"] });
  for (const [args, re] of [
    [{ id: "a", status: "dropped" }, /理由/],
    [{ id: "a", dependsOn: ["b"] }, /輪/],
    [{ id: "zzz", title: "x" }, /「zzz」がありません/],
    [{ id: "a", priority: "urgent" }, /priority は/],
  ] as const) {
    const r = await call("updateItem", args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.content[0]!.text, re);
  }
  const drop = await call("updateItem", { id: "a", status: "dropped", resolution: "重複" });
  assert.equal(drop.isError, undefined);
  const mv = await call("moveItem", { id: "b", before: "a" });
  assert.match(mv.content[0]!.text, /上から 1 番目/);
  assert.equal((await call("moveItem", { id: "b" })).isError, true);
});

test("古い形のファイル：読む tool も理由と変換の手段を返す。getBoard は画面に出す形で返す", async () => {
  const { root, call } = await connect();
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs/tasks.json"), JSON.stringify({ tasks: [] }));
  const r = await call("listItems");
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /古い tasks\.json の形.*convert-tasks-json\.mjs/);
  const board = await call("getBoard");
  assert.equal(board.structuredContent!.state, "refused");
  assert.equal(board.structuredContent!.legacy, true);
});

test("getBoard：版が同じなら unchanged だけ。設定で場所を変えると別のファイルを読む", async () => {
  const { root, call } = await connect();
  await call("boardCreateItem", { kind: "task", title: "Here" });
  const first = await call("getBoard");
  const again = await call("getBoard", { since: first.structuredContent!.version });
  assert.deepEqual(again.structuredContent, { unchanged: true, version: first.structuredContent!.version });

  assert.equal((await call("setSettings", { path: "../outside.json" })).isError, true);
  assert.equal((await call("setSettings", { path: "/etc/x.json" })).isError, true);
  const saved = await call("setSettings", { path: "planning/backlog.json" });
  assert.deepEqual(saved.structuredContent, { path: "planning/backlog.json" });
  assert.equal((await call("getBoard")).structuredContent!.state, "missing");
  await call("createItem", { kind: "task", title: "There" });
  assert.equal(JSON.parse(readFileSync(join(root, "planning/backlog.json"), "utf8")).items[0].id, "there");
});
