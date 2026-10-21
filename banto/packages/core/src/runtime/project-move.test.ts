import { test } from "node:test";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeProjectDirName,
  copyClaudeRecordFiles,
  parseRsyncStats,
  pipeCopy,
  parseRunning,
  pathContains,
  pathsOverlap,
  rsyncShellWord,
  runningInContainerScript,
  sessionIdsOf,
  worktreeRepairScript,
} from "./project-move.js";
import { chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";

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

test("写す流れは溜めない：600MB を流しても banto 本体のメモリに溜まらず、文字列の上限で落ちない（2026-10-14 の実機の不具合）", async () => {
  const before = process.memoryUsage().rss;
  let peak = before;
  const watch = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 50);
  const reader = spawn("sh", ["-c", "head -c 600000000 /dev/zero"], { stdio: ["ignore", "pipe", "pipe"] });
  const writer = spawn("sh", ["-c", "wc -c"], { stdio: ["pipe", "pipe", "pipe"] });
  const [r, w] = await pipeCopy(reader, writer, new PassThrough());
  clearInterval(watch);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "", "読む子の出力は溜めない");
  assert.equal(w.stdout.trim(), "600000000");
  // 流れの分（数十MB）を越えて膨らまない。以前は 600MB 全部が文字列に溜まり、上限で RangeError になった
  assert.ok(peak - before < 200 * 1024 * 1024, `メモリが ${Math.round((peak - before) / 1024 / 1024)}MB 増えた`);
});

test("containers：動いているものはコンテナの中のユーザーで数える。止まっていれば数えない（起こさない）・Incus が答えなければ失敗", () => {
  const dir = mkdtempSync(join(tmpdir(), "banto-running-ct-"));
  try {
    const log = join(dir, "log");
    // 偽の incus：list はコンテナの様子（$STATE）、exec は中で流す台本を受けて、Service が1つ動いているように答える
    writeFileSync(
      join(dir, "incus"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase "$1" in\n  list) [ "$STATE" = fail ] && exit 1; [ -n "$STATE" ] && echo "$STATE"; exit 0 ;;\n  config) echo "$INSIDE"; exit 0 ;;\n  exec) echo unit=banto-web.service; echo unit=banto-mod-shell-x.service; echo tmux=main ;;\nesac\n`,
    );
    chmodSync(join(dir, "incus"), 0o755);
    const run = (state: string, inside = "1001:1002") =>
      spawnSync("sh", ["-c", runningInContainerScript("banto-p1")], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, STATE: state, INSIDE: inside } });
    const up = run("RUNNING");
    assert.equal(up.status, 0, up.stderr);
    assert.deepEqual(parseRunning(up.stdout).map((r) => r.kind), ["service", "terminal"]);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    assert.match(calls[0]!, /^list \^banto-p1\$ -c s -f csv$/);
    // 中のユーザーで（VM の SSH ユーザーではない）。番号はコンテナの札から（中のユーザーの systemd のバスは台本が id -u から組む）
    assert.match(calls[1]!, /^config get banto-p1 user\.banto\.inside$/);
    assert.match(calls[2]!, /^exec banto-p1 --user 1001 --group 1002 .*-- \/bin\/sh -c /);
    // 札の無い（まだ付け替えていない）コンテナは前の番号 1000
    writeFileSync(log, "");
    assert.equal(run("RUNNING", "").status, 0);
    assert.match(readFileSync(log, "utf8").trim().split("\n")[2]!, /^exec banto-p1 --user 1000 --group 1000 /);
    for (const bad of ["a;b:1", "1:", ":2", "1:2:3"]) assert.notEqual(run("RUNNING", bad).status, 0, `形の違う札（${bad}）で流した`);
    writeFileSync(log, "");
    for (const st of ["STOPPED", ""]) {
      const r = run(st);
      assert.equal(r.status, 0);
      assert.equal(r.stdout, "", `止まっている（${st || "無い"}）のに数えた`);
    }
    assert.ok(!readFileSync(log, "utf8").includes("exec"), "止まっているコンテナの中で流した");
    assert.notEqual(run("fail").status, 0, "Incus が答えないのに「何も動いていない」にした");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** git の作業ツリー（根の中に worktree を1つ、根の外に1つ）を作り、根を tar で写す（移す先へ写したのと同じ形） */
function copiedRepoWithWorktrees(base: string, outside: boolean): { old: string; copy: string; out: string } {
  const old = join(base, "old");
  const copy = join(base, "copy");
  const out = join(base, "outside");
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, "a.txt"), "あ\n");
  git(old, "init", "-q");
  git(old, "add", ".");
  git(old, "commit", "-qm", "1");
  git(old, "worktree", "add", "-q", ".worktrees/w1", "-b", "w1");
  if (outside) git(old, "worktree", "add", "-q", out, "-b", "o");
  mkdirSync(copy);
  const tar = spawnSync("sh", ["-c", `tar -C '${old}' -cf - . | tar -C '${copy}' -xf -`], { encoding: "utf8" });
  assert.equal(tar.status, 0, tar.stderr);
  return { old, copy, out };
}

/** worktree の印（`.git/worktrees/<名前>/gitdir` と worktree の `.git` ファイル） */
function marks(root: string, name: string, worktree: string): { gitdir: string; dotGit: string } {
  return { gitdir: readFileSync(join(root, ".git", "worktrees", name, "gitdir"), "utf8"), dotGit: readFileSync(join(worktree, ".git"), "utf8") };
}

test("git worktree repair（#467）：同じ機械で元の根が見えていても、元の worktree の印は変えず、写した先の印だけを直す", () => {
  const base = mkdtempSync(join(tmpdir(), "banto-wt-repair-"));
  try {
    const { old, copy } = copiedRepoWithWorktrees(base, false);
    const before = marks(old, "w1", join(old, ".worktrees", "w1"));
    // 写したままでは、写した先の印は元の根を指している（直す前提の確かめ）
    assert.deepEqual(marks(copy, "w1", join(copy, ".worktrees", "w1")), before);

    const r = spawnSync("sh", ["-c", worktreeRepairScript(old, copy)], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr + r.stdout, /^$/, "repair が何かを直した（先に書き換えていない）");
    assert.deepEqual(marks(old, "w1", join(old, ".worktrees", "w1")), before, "元の worktree の印を書き換えた");
    assert.deepEqual(marks(copy, "w1", join(copy, ".worktrees", "w1")), {
      gitdir: `${copy}/.worktrees/w1/.git\n`,
      dotGit: `gitdir: ${copy}/.git/worktrees/w1\n`,
    });
    // 写した先の git が、写した先の worktree を自分のものとして扱う
    const list = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: copy, encoding: "utf8" });
    assert.match(list.stdout, new RegExp(`^worktree ${copy}/.worktrees/w1$`, "m"));
    const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: join(copy, ".worktrees", "w1"), encoding: "utf8" });
    assert.equal(branch.stdout.trim(), "w1");
    assert.equal(spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: join(copy, ".worktrees", "w1"), encoding: "utf8" }).stdout.trim(), join(copy, ".git"));
    // 2回流しても同じ
    assert.equal(spawnSync("sh", ["-c", worktreeRepairScript(old, copy)], { encoding: "utf8" }).status, 0);
    assert.deepEqual(marks(old, "w1", join(old, ".worktrees", "w1")), before);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("git worktree repair（#467）：根の外の worktree が見えていれば repair を流さず、元の Project のその印も変えない。根の中は直す", () => {
  const base = mkdtempSync(join(tmpdir(), "banto-wt-repair-"));
  try {
    const { old, copy, out } = copiedRepoWithWorktrees(base, true);
    const before = { inside: marks(old, "w1", join(old, ".worktrees", "w1")), outside: marks(old, "outside", out) };
    const r = spawnSync("sh", ["-c", worktreeRepairScript(old, copy)], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /根の外の worktree が見えているので git worktree repair は流しません/);
    assert.deepEqual({ inside: marks(old, "w1", join(old, ".worktrees", "w1")), outside: marks(old, "outside", out) }, before, "元の印を書き換えた");
    assert.deepEqual(marks(copy, "w1", join(copy, ".worktrees", "w1")), {
      gitdir: `${copy}/.worktrees/w1/.git\n`,
      dotGit: `gitdir: ${copy}/.git/worktrees/w1\n`,
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
