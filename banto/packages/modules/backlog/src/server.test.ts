// tool の口を MCP 越しに確かめる——見える tool・絞り込み・Thread の刻印・無いブランチ・古い形・設定・送れなかったこと・申告。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MODULE_META_KEY, THREAD_META_KEY, VISIBILITY_META_KEY } from "@banto/module-contract";
import { createBacklogServer } from "./server.js";
import { RelayingRemote } from "./remote.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/** ブランチの中の一覧（git から直接） */
function onBranch(root: string, branch = "backlog"): { items: Array<{ id: string }> } {
  return JSON.parse(git(root, "show", `${branch}:tasks.json`)) as { items: Array<{ id: string }> };
}

async function connect(opts: { origin?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "backlog-server-"));
  git(root, "init", "-q");
  git(root, "commit", "-q", "--allow-empty", "-m", "code");
  if (opts.origin) git(root, "remote", "add", "origin", opts.origin);
  process.env.BANTO_MODULE_DATA_DIR = mkdtempSync(join(tmpdir(), "backlog-data-"));
  const server = createBacklogServer({ projectRoot: root, now: () => "2026-10-03T00:00:00.000Z", remote: new RelayingRemote(root, undefined) });
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

test("無いブランチ：一覧は空で「まだ一覧のブランチ backlog がありません」と言い、最初の作成で作る。コミットは操作の要約", async () => {
  const { root, call } = await connect();
  const empty = await call("listItems");
  assert.match(empty.content[0]!.text, /まだ一覧のブランチ backlog がありません。createItem で最初の項目を足すと作ります/);
  assert.deepEqual(empty.structuredContent?.items, []);
  const created = await call("createItem", { kind: "story", title: "Backlog module" });
  assert.match(created.content[0]!.text, /一覧のブランチ backlog を作り、足しました：#1 backlog-module \[backlog\] Backlog module/);
  assert.equal(onBranch(root).items.length, 1);
  await call("updateItem", { id: "backlog-module", status: "in-progress", title: "Backlog" });
  await call("splitStory", { storyId: "backlog-module", tasks: [{ title: "One" }, { title: "Two" }] });
  assert.deepEqual(git(root, "log", "--format=%s", "backlog").split("\n"), [
    "backlog: splitStory #1 backlog-module（2 件）",
    "backlog: updateItem #1 backlog-module（title・status → in-progress）",
    "backlog: createItem #1 backlog-module",
  ]);
  // 作業ツリーは空のまま（docs/tasks.json は作らない）
  assert.equal(git(root, "status", "--porcelain"), "");
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
  assert.match(r.content[0]!.text, /#4 crash \[ready・着手できる\] Crash \(bug\)/);
});

test("番号で指す：getItem・updateItem・moveItem・splitStory・parent・dependsOn・listItems の parent は 42 でも \"#42\" でも受ける。番号は書けない", async () => {
  const { root, call } = await connect();
  await call("createItem", { kind: "story", title: "Story" }); // #1
  await call("createItem", { kind: "task", title: "A" }); // #2
  const b = await call("createItem", { kind: "task", title: "B", parent: 1, dependsOn: ["#2"] }); // #3
  assert.match(b.content[0]!.text, /足しました：#3 b \[backlog\] B 親:story 待ち:a/);
  assert.equal((b.structuredContent!.item as { number: number }).number, 3);
  const got = await call("getItem", { id: "#3" });
  assert.match(got.content[0]!.text, /^#3 b \[backlog\] B/);
  assert.equal((await call("getItem", { id: 3 })).content[0]!.text, got.content[0]!.text);
  const story = await call("getItem", { id: 1 });
  assert.match(story.content[0]!.text, /タスク：#3 b \[backlog\]/);
  const up = await call("updateItem", { id: 3, status: "ready", dependsOn: [] });
  assert.match(up.content[0]!.text, /変えました：#3 b \[ready・着手できる\]/);
  const split = await call("splitStory", { storyId: "#1", tasks: [{ title: "C", dependsOn: [2] }] });
  assert.match(split.content[0]!.text, /「#1 story」を 1 件のタスクに分けました：\n#4 c \[ready\] C/);
  const mv = await call("moveItem", { id: 4, before: "#3" });
  assert.match(mv.content[0]!.text, /「#4 c」を「#3 b」の前へ動かしました/);
  const kids = await call("listItems", { parent: 1, status: ["ready"] });
  assert.deepEqual((kids.structuredContent!.items as Array<{ id: string; number: number }>).map((i) => `${i.number}:${i.id}`), ["4:c", "3:b"]);
  // ブランチには id で書く（番号で指しても、親・依存は id）
  const onDisk = JSON.parse(git(root, "show", "backlog:tasks.json")) as { items: Array<{ id: string; number: number; parent: string | null; dependsOn: string[] }> };
  assert.deepEqual(onDisk.items.find((i) => i.id === "c"), { ...onDisk.items.find((i) => i.id === "c")!, number: 4, parent: "story", dependsOn: ["a"] });
  assert.equal(git(root, "log", "-1", "--format=%s", "backlog"), "backlog: moveItem #4 c（#3 b の前）");
  for (const [tool, args, re] of [
    ["getItem", { id: 99 }, /項目「#99」がありません/],
    ["getItem", { id: "#99" }, /項目「#99」がありません/],
    ["updateItem", { id: 2, number: 50 }, /number は作るときに振られるもので、書けません/],
    ["createItem", { kind: "task", title: "X", number: 50 }, /number は作るときに振られるもので、書けません/],
    ["boardUpdateItem", { id: 2, number: 50 }, /number は作るときに振られるもので、書けません/],
    ["updateItem", { id: 2, dependsOn: [99] }, /項目「#99」がありません/],
    ["updateItem", { id: 1.5, title: "x" }, /id は項目の id か番号です/],
  ] as const) {
    const r = await call(tool, args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.content[0]!.text, re);
  }
  assert.equal((JSON.parse(git(root, "show", "backlog:tasks.json")) as { items: Array<{ number: number }> }).items.find((i) => i.number === 50), undefined);
});

test("updateItem：AI のターンの刻印があれば、進めたときに Thread を足す。閉じただけ・刻印が無いときは足さない", async () => {
  const { call } = await connect();
  await call("createItem", { kind: "task", title: "Work", status: "ready" });
  const stamp = { [THREAD_META_KEY]: { projectId: "p1", threadId: "t1" } };
  await call("updateItem", { id: "work", status: "in-progress" }, stamp);
  // 別の Thread が片づけで閉じる→開き直す：足さない
  const other = { [THREAD_META_KEY]: { projectId: "p1", threadId: "t2" } };
  await call("updateItem", { id: "work", status: "done" }, other);
  await call("updateItem", { id: "work", status: "ready" }, other);
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

test("古い形の中身：読む tool も理由と変換の手段を返す。getBoard は画面に出す形で返す", async () => {
  const { root, call } = await connect();
  const blob = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], { input: JSON.stringify({ tasks: [] }), encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["-C", root, "mktree"], { input: `100644 blob ${blob}\ttasks.json\n`, encoding: "utf8" }).trim();
  git(root, "update-ref", "refs/heads/backlog", git(root, "commit-tree", tree, "-m", "old"));
  const r = await call("listItems");
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /ブランチ backlog の tasks\.json を読めません：古い tasks\.json の形.*git show backlog:tasks\.json.*convert-tasks-json\.mjs/);
  const board = await call("getBoard");
  assert.equal(board.structuredContent!.state, "refused");
  assert.equal(board.structuredContent!.legacy, true);
  assert.match(String(board.structuredContent!.convertCommand), /^git show backlog:tasks\.json > old-tasks\.json && node \S+convert-tasks-json\.mjs old-tasks\.json <書き出す先>$/);
});

test("getBoard：版が同じなら unchanged だけ。設定でブランチを変えると別の一覧を読み書きする", async () => {
  const { root, call } = await connect();
  await call("boardCreateItem", { kind: "task", title: "Here" });
  const first = await call("getBoard");
  assert.equal(first.structuredContent!.branch, "backlog");
  const again = await call("getBoard", { since: first.structuredContent!.version });
  assert.deepEqual(again.structuredContent, { unchanged: true, version: first.structuredContent!.version });

  for (const bad of ["-f", "a:b", "+main", "a..b", "x.lock", "a b", ""]) {
    assert.equal((await call("setSettings", { branch: bad })).isError, true, bad);
  }
  assert.deepEqual((await call("getSettings")).structuredContent, { branch: "backlog" });
  const saved = await call("setSettings", { branch: "refs/heads/planning" });
  assert.deepEqual(saved.structuredContent, { branch: "planning" });
  assert.equal((await call("getBoard")).structuredContent!.state, "missing");
  await call("createItem", { kind: "task", title: "There" });
  assert.equal(onBranch(root, "planning").items[0]!.id, "there");
  assert.deepEqual(onBranch(root, "backlog").items.map((i) => i.id), ["here"]);
});

test("送れなかったら、書いた tool はそう言い（書き込みは済み）、listItems はまだ送っていない件数と理由を毎回添える", async () => {
  const { root, call } = await connect({ origin: join(tmpdir(), `backlog-no-origin-${Date.now()}`) });
  const created = await call("createItem", { kind: "task", title: "Offline" });
  assert.equal(created.isError, undefined);
  assert.match(created.content[0]!.text, /足しました：#1 offline.*\n（書き込みは済みましたが、origin に送れませんでした：/s);
  assert.match(String(created.structuredContent!.pushError), /.+/);
  assert.equal(onBranch(root).items[0]!.id, "offline");
  const listed = await call("listItems");
  assert.match(listed.content[0]!.text, /origin に送っていない変更が 1 件あります（送れなかった理由：/);
  const sync = listed.structuredContent!.sync as { origin: boolean; ahead: number; pushError?: string };
  assert.deepEqual({ origin: sync.origin, ahead: sync.ahead }, { origin: true, ahead: 1 });
  assert.match(sync.pushError ?? "", /.+/);
  const board = await call("getBoard", { fetch: true });
  assert.equal((board.structuredContent!.sync as { ahead: number }).ahead, 1);
  assert.match(String((board.structuredContent!.sync as { fetchError?: string }).fetchError), /.+/);
});

test("ブランチが無く作業ツリーに docs/tasks.json があれば、移すコマンドを案内する。Project の根が git でなければ書かない", async () => {
  const { root, call } = await connect();
  execFileSync("mkdir", ["-p", join(root, "docs")]);
  writeFileSync(join(root, "docs/tasks.json"), JSON.stringify({ format: "banto-backlog/1", items: [] }));
  const listed = await call("listItems");
  assert.match(listed.content[0]!.text, /作業ツリーに docs\/tasks\.json があります——ブランチへ移すには：node \S+move-to-branch\.mjs --repo \S+ --file docs\/tasks\.json --branch backlog --push（自動では移しません）/);
  const board = await call("getBoard");
  assert.equal((board.structuredContent!.leftover as { path: string }).path, "docs/tasks.json");

  const plain = mkdtempSync(join(tmpdir(), "backlog-server-plain-"));
  const server = createBacklogServer({ projectRoot: plain });
  const [s, c] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(s), client.connect(c)]);
  const r = (await client.callTool({ name: "createItem", arguments: { kind: "task", title: "X" } })) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /git のリポジトリではありません/);
});

test("申告：Repositories に頼む（無くても動く）・git を走らせる（exec）・Project ごと", async () => {
  const { client } = await connect();
  const { resources } = await client.listResources();
  const meta = (resources.find((r) => r.uri === "backlog://module")!._meta as Record<string, unknown>)[MODULE_META_KEY];
  assert.deepEqual(meta, {
    satisfies: ["backlog"],
    dependsOn: [{ role: "repositories", required: false }],
    isolation: "subprocess",
    scope: "project",
    confinement: { kind: "landlock", root: "project", profile: "exec" },
  });
});
