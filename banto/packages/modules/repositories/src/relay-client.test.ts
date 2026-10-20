// 中継の返事を読む：形が違えば理由つきで投げる（黙って空や半端な一覧にしない）
import { test } from "node:test";
import assert from "node:assert/strict";
import { hostFolderProjects, parseProjectGitOrigin, parseProjectSummaries } from "./relay-client.js";

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

test("clone の記録（URL と選んだアカウント）を読み、origin の設定は形を確かめて読む", () => {
  const [p] = parseProjectSummaries(
    JSON.stringify([{ id: "p1", name: "x", root: "/r", status: "active", runtime: "remote:lab", clonedFrom: { url: "https://github.com/a/b.git", account: "a" } }]),
  );
  assert.deepEqual(p!.clonedFrom, { url: "https://github.com/a/b.git", account: "a" });
  const [q] = parseProjectSummaries(JSON.stringify([{ id: "p1", name: "x", root: "/r", status: "active", clonedFrom: { account: "a" } }]));
  assert.equal(q!.clonedFrom, undefined, "URL の無い記録は読まない");
  assert.deepEqual(parseProjectGitOrigin('{"kind":"not-repo"}'), { kind: "not-repo" });
  assert.deepEqual(parseProjectGitOrigin('{"kind":"repo","urls":["u"],"redirects":[]}'), { kind: "repo", urls: ["u"], redirects: [] });
  assert.throws(() => parseProjectGitOrigin('{"kind":"repo","urls":"u"}'), /形が違います/);
});
