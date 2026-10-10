// 中継の返事を読む：形が違えば理由つきで投げる（黙って空や半端な一覧にしない）
import { test } from "node:test";
import assert from "node:assert/strict";
import { hostFolderProjects, parseProjectSummaries } from "./relay-client.js";

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

test("別のサーバの Project は、この機械のフォルダと突き合わせる一覧から外す（根は向こうのパス）", () => {
  const listed = parseProjectSummaries(
    JSON.stringify([
      { id: "p1", name: "家計簿", root: "/home/u/kakeibo", status: "active", runtime: "host-container" },
      { id: "p2", name: "古い記録", root: "/home/u/old", status: "closed" },
      { id: "p3", name: "lab", root: "/home/u/kakeibo", status: "active", runtime: "remote:lab" },
    ]),
  );
  assert.equal(listed[2]!.runtime, "remote:lab");
  assert.deepEqual(hostFolderProjects(listed).map((p) => p.id), ["p1", "p2"]);
});
