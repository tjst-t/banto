import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeProjectDirName, parseRunning, pathsOverlap, sessionIdsOf } from "./project-move.js";

test("動いているもの：Service の unit・待たないコマンド・Terminal の tmux を読む。Module を包む単位（banto-mod-*）は数えない", () => {
  const items = parseRunning(
    [
      "unit=banto-web.service",
      "unit=banto-shell-abc123.service",
      "unit=banto-mod-shell-p1.service",
      "tmux=main",
      "",
    ].join("\n"),
  );
  assert.deepEqual(items.map((i) => i.kind), ["service", "command", "terminal"]);
  assert.match(items[0]!.label, /Service「web」/);
});

test("重なり：含む・含まれる・同じは重なる。名前の頭が同じだけ（/a/bc と /a/b）は重ならない。/ は全部と重なる", () => {
  assert.ok(pathsOverlap("/a/b", "/a/b"));
  assert.ok(pathsOverlap("/a/b/c", "/a/b"));
  assert.ok(pathsOverlap("/a", "/a/b"));
  assert.ok(!pathsOverlap("/a/bc", "/a/b"));
  assert.ok(pathsOverlap("/", "/x"));
});

test("Claude の会話の記録の置き場の名前：英数字以外を - に。200 字を超えたら扱わない（CLI が縮める）", () => {
  assert.equal(claudeProjectDirName("/home/u/work.dir_1"), "-home-u-work-dir-1");
  assert.equal(claudeProjectDirName(`/${"a".repeat(220)}`), undefined);
});

test("写す会話：全 Thread の resume-point の履歴・いまの resume-point・切れたターンの id。ファイル名にならないものは落とす", () => {
  const ids = sessionIdsOf([
    { resumePoints: [{ sessionId: "s1" }, { sessionId: "s2" }], resumePoint: "s2" },
    { resumePoints: [], resumePoint: "s3", lastTurn: { knownSessionId: "s4", assignedSessionId: "s4" } },
    { resumePoints: [{ sessionId: "../etc" }, { sessionId: ".." }] },
  ]);
  assert.deepEqual(ids.sort(), ["s1", "s2", "s3", "s4"]);
});
