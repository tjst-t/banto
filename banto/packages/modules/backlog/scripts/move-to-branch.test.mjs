// 作業ツリーの tasks.json をブランチへ移すスクリプト——orphan・作業ツリーに触らない・あれば上書きしない・古い形は断る・送る。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./move-to-branch.mjs", import.meta.url));

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim();
}

function repo() {
  const root = mkdtempSync(join(tmpdir(), "backlog-move-"));
  const bare = mkdtempSync(join(tmpdir(), "backlog-move-origin-"));
  git(bare, "init", "-q", "--bare");
  git(root, "init", "-q");
  mkdirSync(join(root, "docs"));
  const text = `${JSON.stringify({ format: "banto-backlog/1", milestones: [], items: [{ id: "a", kind: "task", title: "A", status: "ready" }] }, null, 2)}\n`;
  writeFileSync(join(root, "docs/tasks.json"), text);
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "code");
  git(root, "remote", "add", "origin", bare);
  return { root, bare, text };
}

test("コマンド1つで、中身を変えずに orphan のブランチへ移して送る。作業ツリーと index には触らず、元のファイルは残す", () => {
  const { root, bare, text } = repo();
  writeFileSync(join(root, "docs/tasks.json"), text); // 作業ツリーはそのまま
  const before = { status: git(root, "status", "--porcelain"), index: readFileSync(join(root, ".git/index")), head: git(root, "rev-parse", "HEAD") };
  const out = execFileSync("node", [SCRIPT, "--repo", root, "--push"], { encoding: "utf8" });
  assert.match(out, /docs\/tasks\.json の 1 件を backlog ブランチに移しました/);
  assert.match(out, /origin へ送りました/);
  assert.equal(git(root, "show", "backlog:tasks.json") + "\n", text);
  assert.equal(git(root, "rev-list", "--parents", "-n", "1", "backlog").split(" ").length, 1, "親がある");
  assert.equal(git(root, "ls-tree", "--name-only", "backlog"), "tasks.json");
  assert.equal(git(root, "log", "-1", "--format=%an", "backlog"), "banto");
  assert.equal(git(bare, "rev-parse", "backlog"), git(root, "rev-parse", "backlog"));
  assert.equal(git(root, "status", "--porcelain"), before.status);
  assert.deepEqual(readFileSync(join(root, ".git/index")), before.index);
  assert.equal(git(root, "rev-parse", "HEAD"), before.head);
  assert.equal(readFileSync(join(root, "docs/tasks.json"), "utf8"), text);

  // もうあれば上書きしない
  assert.throws(() => execFileSync("node", [SCRIPT, "--repo", root], { encoding: "utf8", stdio: "pipe" }), /backlog ブランチはもうあります/);
});

test("古い形・別のブランチ名・送れないとき", () => {
  const { root } = repo();
  writeFileSync(join(root, "old.json"), JSON.stringify({ tasks: [] }));
  assert.throws(() => execFileSync("node", [SCRIPT, "--repo", root, "--file", "old.json"], { stdio: "pipe" }), /古い形——先に convert-tasks-json\.mjs/);
  assert.throws(() => execFileSync("node", [SCRIPT, "--repo", root, "--branch", "-x"], { stdio: "pipe" }), /ブランチ名/);
  git(root, "remote", "set-url", "origin", join(tmpdir(), `backlog-move-gone-${Date.now()}`));
  const out = execFileSync("node", [SCRIPT, "--repo", root, "--branch", "plan", "--push"], { encoding: "utf8" });
  assert.match(out, /plan ブランチに移しました/);
  assert.match(out, /origin へ送れませんでした——あとで git push origin plan で送れます/);
});
