// 店——直列化・外から変わったファイル・無いファイル・古い形・前からある問題の扱い。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BacklogStore } from "./store.js";
import { createItem, updateItem, BACKLOG_FORMAT } from "./model.js";

const NOW = "2026-10-03T00:00:00.000Z";

function setup(rel = "docs/tasks.json") {
  const root = mkdtempSync(join(tmpdir(), "backlog-store-"));
  const store = new BacklogStore({ root, tasksPath: () => rel });
  return { root, store, file: join(root, rel) };
}

test("ファイルが無ければ「無い」と読み、最初の作成でフォルダごと作る", async () => {
  const { store, file } = setup();
  assert.equal((await store.read()).state, "missing");
  const { created, path } = await store.mutate((d) => createItem(d, { kind: "task", title: "First" }, NOW));
  assert.equal(created, true);
  assert.equal(path, "docs/tasks.json");
  const json = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(json.format, BACKLOG_FORMAT);
  assert.deepEqual(json.items.map((i: { id: string }) => i.id), ["first"]);
});

test("同時に来た書き込みは1件ずつ順に——どれも失われない", async () => {
  const { store, file } = setup();
  await Promise.all(
    Array.from({ length: 20 }, (_, n) => store.mutate((d) => createItem(d, { kind: "task", title: `Task ${n}` }, NOW))),
  );
  const json = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(json.items.length, 20);
  assert.equal(new Set(json.items.map((i: { id: string }) => i.id)).size, 20);
  // 一時ファイルが残っていない
  assert.deepEqual(readdirSync(join(file, "..")), ["tasks.json"]);
});

test("毎回読み直す：外（人の手・git pull）で変わったものの上に書く", async () => {
  const { store, file } = setup();
  await store.mutate((d) => createItem(d, { kind: "task", title: "Mine" }, NOW));
  const json = JSON.parse(readFileSync(file, "utf8"));
  json.items.push({ id: "by-hand", kind: "bug", title: "手で足した", status: "ready" });
  writeFileSync(file, JSON.stringify(json));
  await store.mutate((d) => createItem(d, { kind: "task", title: "After" }, NOW));
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(after.items.map((i: { id: string }) => i.id), ["mine", "by-hand", "after"]);
  // 手で省いた欄は既定で埋まり、欄の順で書かれる
  assert.deepEqual(Object.keys(after.items[1]).slice(0, 5), ["id", "kind", "title", "status", "parent"]);
});

test("古い形のファイルは読まず・書かず、変換の手段を言う（中身は1バイトも変えない）", async () => {
  const { store, file } = setup();
  mkdirSync(join(file, ".."), { recursive: true });
  const legacy = JSON.stringify({ tasks: [{ id: "a", title: "A", status: "pending" }] });
  writeFileSync(file, legacy);
  const snap = await store.read();
  assert.equal(snap.state, "refused");
  assert.ok(snap.state === "refused" && snap.legacy);
  await assert.rejects(
    store.mutate((d) => createItem(d, { kind: "task", title: "X" }, NOW)),
    /書き込みません.*convert-tasks-json\.mjs/,
  );
  assert.equal(readFileSync(file, "utf8"), legacy);
});

test("壊れた JSON も読まず・書かない", async () => {
  const { store, file } = setup();
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "{ not json");
  const snap = await store.read();
  assert.ok(snap.state === "refused" && /JSON として読めません/.test(snap.reason));
  await assert.rejects(store.mutate((d) => createItem(d, { kind: "task", title: "X" }, NOW)), /書き込みません/);
});

test("違反する変更は理由つきで断り、ファイルを変えない（輪・やめる理由なし）", async () => {
  const { store, file } = setup();
  await store.mutate((d) => createItem(d, { kind: "task", title: "A", id: "a" }, NOW));
  await store.mutate((d) => createItem(d, { kind: "task", title: "B", id: "b", dependsOn: ["a"] }, NOW));
  const before = readFileSync(file, "utf8");
  await assert.rejects(store.mutate((d) => updateItem(d, "a", { dependsOn: ["b"] }, NOW)), /輪になっています：a → b → a/);
  await assert.rejects(store.mutate((d) => updateItem(d, "a", { status: "dropped" }, NOW)), /理由/);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("手で入った前からある問題は、関係のない変更を止めない（増やす変更だけ断る）", async () => {
  const { store, file } = setup();
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      format: BACKLOG_FORMAT,
      items: [
        { id: "a", kind: "task", title: "A", status: "ready", dependsOn: ["gone"] },
        { id: "b", kind: "task", title: "B", status: "ready" },
      ],
    }),
  );
  const snap = await store.read();
  assert.ok(snap.state === "ok" && snap.problems.length === 1);
  await store.mutate((d) => updateItem(d, "b", { title: "B2" }, NOW));
  await assert.rejects(store.mutate((d) => updateItem(d, "b", { dependsOn: ["gone2"] }, NOW)), /「gone2」がありません/);
});

test("並べ替えも同じ列に並ぶ——足すのと交互に来ても順が壊れない", async () => {
  const { store, file } = setup();
  for (const t of ["a", "b", "c"]) await store.mutate((d) => createItem(d, { kind: "task", title: t }, NOW));
  const { moveItem } = await import("./model.js");
  await Promise.all([
    store.mutate((d) => moveItem(d, "c", "a", "before")),
    store.mutate((d) => createItem(d, { kind: "task", title: "d" }, NOW)),
    store.mutate((d) => moveItem(d, "d", "c", "before")),
  ]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).items.map((i: { id: string }) => i.id), ["d", "c", "a", "b"]);
});
