// 番号の振り直し——作った順（古い一覧の並び→createdAt）・番号のある項目は変えない・2回目は何もしない・作業ツリーに触らない・送る。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./assign-numbers.mjs", import.meta.url));

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim();
}

const task = (id, over = {}) => ({ id, kind: "task", title: id, status: "ready", createdAt: null, ...over });

function repo() {
  const root = mkdtempSync(join(tmpdir(), "backlog-number-"));
  const bare = mkdtempSync(join(tmpdir(), "backlog-number-origin-"));
  git(bare, "init", "-q", "--bare");
  git(root, "init", "-q");
  mkdirSync(join(root, "docs"));
  // Backlog の形に移す前の古い一覧（id が重なっていた行は、移すときに付け直された）
  const legacy = { tasks: [{ id: "old-a", title: "A" }, { id: "dup", title: "最初の dup" }, { id: "dup", title: "後の dup" }, { id: "old-b", title: "B" }] };
  writeFileSync(join(root, "docs/tasks.json"), JSON.stringify(legacy));
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "legacy");
  const doc = {
    format: "banto-backlog/1",
    milestones: [],
    items: [
      task("later", { createdAt: "2026-10-04T02:00:00.000Z" }),
      task("old-b", { title: "B" }),
      task("dup-2", { title: "後の dup" }),
      task("numbered", { number: 3, createdAt: "2026-10-04T03:00:00.000Z" }),
      task("dup", { title: "最初の dup" }),
      task("earlier", { createdAt: "2026-10-04T01:00:00.000Z" }),
      task("old-a", { title: "A" }),
    ],
  };
  const blob = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], { input: `${JSON.stringify(doc, null, 2)}\n`, encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["-C", root, "mktree"], { input: `100644 blob ${blob}\ttasks.json\n`, encoding: "utf8" }).trim();
  const commit = execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit-tree", tree, "-m", "by hand"], { encoding: "utf8" }).trim();
  git(root, "update-ref", "refs/heads/backlog", commit);
  git(root, "remote", "add", "origin", bare);
  return { root, bare };
}

const onBranch = (root) => JSON.parse(git(root, "show", "backlog:tasks.json"));

test("作った順に振る：createdAt の無いものが先で古い一覧の並び（重なった id は題で合わせる）、次に createdAt 順。並び・番号のある項目は変えない", () => {
  const { root, bare } = repo();
  const before = { status: git(root, "status", "--porcelain"), index: readFileSync(join(root, ".git/index")), head: git(root, "rev-parse", "HEAD") };
  const out = execFileSync("node", [SCRIPT, "--repo", root, "--legacy", "HEAD:docs/tasks.json", "--push"], { encoding: "utf8" });
  assert.match(out, /backlog ブランチの 6 件に #4〜#9 を振りました/);
  assert.match(out, /origin へ送りました/);
  const items = onBranch(root).items;
  assert.deepEqual(items.map((i) => i.id), ["later", "old-b", "dup-2", "numbered", "dup", "earlier", "old-a"], "並びが変わった");
  const byId = Object.fromEntries(items.map((i) => [i.id, i.number]));
  assert.deepEqual(byId, { "old-a": 4, dup: 5, "dup-2": 6, "old-b": 7, earlier: 8, later: 9, numbered: 3 });
  assert.equal(git(root, "rev-list", "--count", "backlog"), "2");
  assert.equal(git(root, "log", "-1", "--format=%an|%s", "backlog"), "banto|backlog: 番号の無い 6 件に #4〜#9 を振る（作った順）");
  assert.equal(git(bare, "rev-parse", "backlog"), git(root, "rev-parse", "backlog"));
  assert.equal(git(root, "status", "--porcelain"), before.status);
  assert.deepEqual(readFileSync(join(root, ".git/index")), before.index);
  assert.equal(git(root, "rev-parse", "HEAD"), before.head);

  // 2回目：何も変えない（コミットも積まない）
  const head = git(root, "rev-parse", "backlog");
  const again = execFileSync("node", [SCRIPT, "--repo", root, "--legacy", "HEAD:docs/tasks.json"], { encoding: "utf8" });
  assert.match(again, /もう全部番号があります/);
  assert.equal(git(root, "rev-parse", "backlog"), head);
});

test("古い一覧なしなら、createdAt の無いものは今の並び。ブランチが無い・古い一覧が違う形なら断る", () => {
  const { root } = repo();
  execFileSync("node", [SCRIPT, "--repo", root], { encoding: "utf8" });
  const byId = Object.fromEntries(onBranch(root).items.map((i) => [i.id, i.number]));
  assert.deepEqual(byId, { "old-b": 4, "dup-2": 5, dup: 6, "old-a": 7, earlier: 8, later: 9, numbered: 3 });
  assert.throws(() => execFileSync("node", [SCRIPT, "--repo", root, "--branch", "nope"], { stdio: "pipe" }), /nope ブランチがありません/);
  assert.throws(() => execFileSync("node", [SCRIPT, "--repo", root, "--legacy", "backlog:tasks.json"], { stdio: "pipe" }), /古い tasks\.json の形/);
});
