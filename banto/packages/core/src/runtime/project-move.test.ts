import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeProjectDirName,
  copyClaudeRecordFiles,
  parseRsyncStats,
  parseRunning,
  pathContains,
  pathsOverlap,
  rsyncShellWord,
  sessionIdsOf,
} from "./project-move.js";

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

test("含む：同じと、その下は含む。上・名前の頭が同じだけ（/a/bc と /a/b）は含まない。/ は全部を含む", () => {
  assert.ok(pathContains("/a/b", "/a/b"));
  assert.ok(pathContains("/a", "/a/b/c"));
  assert.ok(!pathContains("/a/b/c", "/a/b"));
  assert.ok(!pathContains("/a/b", "/a/bc"));
  assert.ok(pathContains("/", "/x"));
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

test("Claude の会話の記録を写す：無ければ写す・同じなら何もしない・違えば写す先の古いものを .before-<日時> に退かせてから写す", () => {
  const dir = mkdtempSync(join(tmpdir(), "banto-move-records-"));
  try {
    const src = join(dir, "src");
    const dst = join(dir, "dst");
    mkdirSync(join(src, "s1", "subagents"), { recursive: true });
    writeFileSync(join(src, "s1.jsonl"), "移す前\n向こうで話した\n");
    writeFileSync(join(src, "s1", "subagents", "a.jsonl"), "{}\n");
    writeFileSync(join(src, "s2.jsonl"), "同じ\n");
    // 写す先：s1 は移す前の古い記録（同じ根へ戻したときに残っていたもの）、s2 は同じ中身
    mkdirSync(join(dst, "s1"), { recursive: true });
    writeFileSync(join(dst, "s1.jsonl"), "移す前\n");
    writeFileSync(join(dst, "s2.jsonl"), "同じ\n");

    const got = copyClaudeRecordFiles(src, dst, ["s1", "s2", "s3"], "20261013T000000");
    assert.deepEqual(got, { copied: 1, setAside: 2 });
    assert.equal(readFileSync(join(dst, "s1.jsonl"), "utf8"), "移す前\n向こうで話した\n");
    assert.equal(readFileSync(join(dst, "s1.jsonl.before-20261013T000000"), "utf8"), "移す前\n");
    assert.equal(readFileSync(join(dst, "s1", "subagents", "a.jsonl"), "utf8"), "{}\n");
    assert.deepEqual(readdirSync(join(dst, "s1.before-20261013T000000")), []);
    assert.equal(readFileSync(join(dst, "s2.jsonl"), "utf8"), "同じ\n");
    assert.deepEqual(readdirSync(dst).sort(), ["s1", "s1.before-20261013T000000", "s1.jsonl", "s1.jsonl.before-20261013T000000", "s2.jsonl"]);

    // もう一度：全部同じなので何もしない
    assert.deepEqual(copyClaudeRecordFiles(src, dst, ["s1", "s2"], "20261013T000001"), { copied: 0, setAside: 0 });
    assert.equal(readdirSync(dst).length, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rsync の --stats を読む（桁区切りつき）。読めなければ投げる", () => {
  const out = [
    "Number of files: 1,234 (reg: 1,200, dir: 34)",
    "Number of created files: 3",
    "Number of deleted files: 2",
    "Number of regular files transferred: 1,005",
    "Total file size: 9,876,543 bytes",
    "Total transferred file size: 12,345 bytes",
  ].join("\n");
  assert.deepEqual(parseRsyncStats(out), { files: 1005, bytes: 12345, deleted: 2 });
  assert.throws(() => parseRsyncStats("rsync: connection unexpectedly closed"), /読めませんでした/);
});

test("rsync の -e の1語：そのまま渡せるものはそのまま、空白などは引用符でくくる", () => {
  assert.equal(rsyncShellWord("-o"), "-o");
  assert.equal(rsyncShellWord("UserKnownHostsFile=/a/b"), "UserKnownHostsFile=/a/b");
  assert.equal(rsyncShellWord("/a b/c"), "'/a b/c'");
  assert.equal(rsyncShellWord("it's"), '"it\'s"');
  assert.throws(() => rsyncShellWord(`a'b"c`));
});
