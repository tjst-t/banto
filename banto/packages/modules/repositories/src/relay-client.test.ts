// 中継の返事を読む：形が違えば理由つきで投げる（黙って空や半端な一覧にしない）
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProjectSummaries } from "./relay-client.js";

test("Project の一覧は id・name・root・status を確かめて読み、形が違えば何が違うかを言って投げる", () => {
  const ok = [{ id: "p1", name: "家計簿", root: "/home/u/kakeibo", status: "active", extra: "落とす" }];
  assert.deepEqual(parseProjectSummaries(JSON.stringify(ok)), [{ id: "p1", name: "家計簿", root: "/home/u/kakeibo", status: "active" }]);
  assert.deepEqual(parseProjectSummaries("[]"), []);
  assert.throws(() => parseProjectSummaries("<html>"), /JSON ではありません/);
  assert.throws(() => parseProjectSummaries(JSON.stringify({ projects: [] })), /配列ではありません/);
  assert.throws(
    () => parseProjectSummaries(JSON.stringify([ok[0], { id: "p2", name: "x", root: "/x", status: "archived" }])),
    /2 件目の形が違います/,
  );
  assert.throws(() => parseProjectSummaries(JSON.stringify([{ id: "p1", name: "x", status: "active" }])), /1 件目/);
});
