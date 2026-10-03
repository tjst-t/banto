// 変換スクリプト——読み替えの1件ずつと、書き出したものを Module がそのまま読めること。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { convertLegacy } from "./convert-tasks-json.mjs";
import { parseDocument, validateDocument } from "../dist/model.js";

const SCRIPT = fileURLToPath(new URL("./convert-tasks-json.mjs", import.meta.url));

const LEGACY = {
  $comment: ["いま残っている作業"],
  currentPhase: "2",
  phase1: { closedAt: "2026-09-10" },
  tasks: [
    { id: "a", title: "A", status: "done", phase: "1", why: "理由", completedAt: "2026-09-01", verifiedBy: "E2E", refs: ["x.md"] },
    { id: "b", title: "B", status: "pending", phase: "2", dependencies: ["a"], doneWhen: "測れる", notes: "メモ", note: "追記" },
    { id: "c", title: "C", status: "undecided", phase: "未定", why: "未決のもの", open: ["一つ", "二つ"], decidedAt: "2026-09-05", spec: "§4.4" },
    { id: "d", title: "D", status: "in_progress", dependencies: null, why: "" },
  ],
};

test("読み替え：状態・phase・body の節・completedAt・dependencies・extra", () => {
  const doc = convertLegacy(LEGACY);
  const [a, b, c, d] = doc.items;
  assert.equal(a.status, "done");
  assert.equal(a.closedAt, "2026-09-01");
  assert.equal(a.milestone, "phase-1");
  assert.equal(a.body, "## なぜ\n\n理由\n\n## 確かめ方\n\nE2E");
  assert.equal(b.status, "ready");
  assert.deepEqual(b.dependsOn, ["a"]);
  assert.equal(b.doneWhen, "測れる");
  assert.equal(b.body, "## メモ\n\nメモ\n\n追記");
  assert.equal(c.status, "backlog");
  assert.deepEqual(c.labels, ["未決"]);
  assert.match(c.body, /## 残っていること\n\n- 一つ\n- 二つ/);
  assert.deepEqual(c.refs, ["§4.4"]);
  assert.deepEqual(c.extra, { decidedAt: "2026-09-05" });
  assert.equal(d.status, "in-progress");
  assert.deepEqual(d.dependsOn, []);
  assert.equal(d.milestone, null);
  assert.ok(doc.items.every((i) => i.kind === "task"));
  assert.deepEqual(doc.milestones, [
    { id: "phase-1", title: "Phase 1", status: "closed" },
    { id: "phase-2", title: "Phase 2", status: "open" },
    { id: "milestone-3", title: "Phase 未定", status: "open" },
  ]);
  assert.deepEqual(Object.keys(doc.extra), ["$comment", "currentPhase", "phase1"]);
  // Module がそのまま読め、決まりごとにも反しない
  const parsed = parseDocument(doc);
  assert.ok(parsed.ok);
  assert.deepEqual(validateDocument(parsed.doc), []);
});

test("知らない status は読み替えずに断る", () => {
  assert.throws(() => convertLegacy({ tasks: [{ id: "x", title: "X", status: "someday" }] }), /someday/);
  assert.throws(() => convertLegacy({ format: "banto-backlog/1", tasks: [] }), /変換は要りません/);
});

test("コマンドとして：別の場所に書き出し、入力と同じ場所には書かない", () => {
  const dir = mkdtempSync(join(tmpdir(), "backlog-convert-"));
  const input = join(dir, "tasks.json");
  writeFileSync(input, JSON.stringify(LEGACY));
  const out = join(dir, "out.json");
  execFileSync(process.execPath, [SCRIPT, input, out], { stdio: "pipe" });
  const text = readFileSync(out, "utf8");
  assert.ok(text.endsWith("\n"));
  assert.equal(JSON.parse(text).format, "banto-backlog/1");
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, input, input], { stdio: "pipe" }));
  assert.equal(readFileSync(input, "utf8"), JSON.stringify(LEGACY));
});
