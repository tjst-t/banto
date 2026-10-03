// git を読む口：**フォルダの設定（`.git/config`）から banto 本体の権限でコードが走らない**こと・走らせてよい
// サブコマンドの一覧・時間切れ・bare・`.git` という名前のただのフォルダ。**本物の git で、使い捨ての置き場に作る**。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_COMMANDS, GIT_ENV, GIT_TIMEOUTS, readFolder } from "./git.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: "ignore" });
}

function scratch(): { dir: string; done(): void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "banto-repositories-git-")));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 悪意のある設定を持つリポジトリ。コマンドを指せる設定を、どれも「走ったら印を残す」スクリプトに向ける */
function trappedRepo(dir: string) {
  const marks = join(dir, "marks");
  mkdirSync(marks);
  const script = (name: string) => {
    const path = join(dir, `trap-${name}.sh`);
    writeFileSync(path, `#!/bin/sh\ntouch ${join(marks, name)}\nexit 1\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "first");
  git(repo, "remote", "add", "origin", "git@github.com:evil/repo.git");
  const hooks = join(dir, "hooks");
  mkdirSync(hooks);
  for (const h of ["pre-commit", "commit-msg", "post-checkout", "reference-transaction"]) {
    writeFileSync(join(hooks, h), `#!/bin/sh\ntouch ${join(marks, "hook-" + h)}\n`);
    chmodSync(join(hooks, h), 0o755);
  }
  const config: Array<[string, string]> = [
    ["core.fsmonitor", script("fsmonitor")],
    ["core.hooksPath", hooks],
    ["core.sshCommand", script("ssh")],
    ["core.pager", script("pager")],
    ["core.editor", script("editor")],
    ["credential.helper", `!${script("credential")}`],
    ["diff.external", script("diff")],
    ["gpg.program", script("gpg")],
  ];
  for (const [k, v] of config) git(repo, "config", k, v);
  // 印を残すのは、ここから後に走ったものだけ（作るときの commit で hooksPath はまだ無い）
  for (const m of readdirSync(marks)) rmSync(join(marks, m));
  return { repo, marks: () => readdirSync(marks).sort() };
}

/** 潰しを外した環境（外から渡された GIT_* を落としただけ）——罠が本当に効く罠かを確かめるための対照 */
const PLAIN_ENV = Object.fromEntries(Object.entries(GIT_ENV).filter(([k]) => !k.startsWith("GIT_CONFIG_") && k !== "GIT_PAGER"));

/**
 * 設定から何かを起こすコマンド。読む口では使わないものも、潰しが効いているかを見るために走らせる。
 * `core.pager` は端末に出すときだけ走る（banto は端末を持たない）ので、ここでは起こせない——潰しは置いてある
 */
const TRIGGERS: Array<{ mark: string; args: string[]; input?: string; edit?: boolean }> = [
  { mark: "fsmonitor", args: ["status", "--porcelain"] },
  { mark: "hook-pre-commit", args: ["commit", "-q", "--allow-empty", "-m", "x"] },
  { mark: "editor", args: ["commit", "--allow-empty"] },
  { mark: "credential", args: ["credential", "fill"], input: "protocol=https\nhost=example.com\n\n" },
  { mark: "ssh", args: ["ls-remote", "ssh://git@example.invalid/x.git"] },
  { mark: "diff", args: ["diff"], edit: true },
];

test("走らせてよいサブコマンドは一覧のものだけ（増やすときはこの試験も直す）", () => {
  assert.deepEqual([...GIT_COMMANDS], [
    "rev-parse",
    "worktree list",
    "remote get-url",
    "symbolic-ref",
    "rev-list",
    "config --get init.defaultBranch",
    "init",
    "clone",
    "for-each-ref",
    "config --name-only --get-regexp",
    "status",
    "worktree prune",
  ]);
});

test("フォルダの設定がコマンドを指していても、読む口からは何も走らない——潰しはどのコマンドにも効く", async () => {
  const s = scratch();
  try {
    const t = trappedRepo(s.dir);
    const facts = await readFolder(t.repo);
    assert.equal(facts.kind, "repo");
    assert.deepEqual(t.marks(), [], "読むだけでフォルダの設定のコマンドが走った");

    for (const trigger of TRIGGERS) {
      if (trigger.edit) writeFileSync(join(t.repo, "a.txt"), `changed ${trigger.mark}\n`);
      const run = (env: NodeJS.ProcessEnv) =>
        spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...trigger.args], {
          cwd: t.repo,
          env,
          input: trigger.input ?? "",
          timeout: 10_000,
        });
      run(GIT_ENV);
      assert.deepEqual(t.marks(), [], `潰した環境で git ${trigger.args.join(" ")} が ${trigger.mark} を走らせた`);
      // 対照：潰さなければ、この罠は本当に走る（罠が効かない試験になっていないか）
      run(PLAIN_ENV);
      assert.ok(t.marks().includes(trigger.mark), `対照で ${trigger.mark} が走らない——罠の作りが違う（${t.marks().join(",")}）`);
      for (const m of t.marks()) rmSync(join(s.dir, "marks", m));
      if (trigger.edit) git(t.repo, "checkout", "-q", "--", "a.txt");
    }
  } finally {
    s.done();
  }
});

test("コミット数が時間切れでも行は読める——数えられなかった理由だけを添える", async () => {
  const s = scratch();
  const saved = { count: GIT_TIMEOUTS.count, path: GIT_ENV.PATH };
  try {
    const repo = join(s.dir, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    git(repo, "commit", "-q", "--allow-empty", "-m", "first");
    // rev-list だけ答えない git（時間を短くするだけでは、速い機械で間に合ってしまう——決まって切れる形にする）
    const bin = join(s.dir, "bin");
    mkdirSync(bin);
    const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    writeFileSync(join(bin, "git"), `#!/bin/sh
for a in "$@"; do [ "$a" = rev-list ] && exec sleep 30; done
exec ${real} "$@"
`);
    chmodSync(join(bin, "git"), 0o755);
    GIT_ENV.PATH = `${bin}:${saved.path ?? ""}`;
    GIT_TIMEOUTS.count = 300;
    const facts = await readFolder(repo);
    assert.equal(facts.kind, "repo");
    if (facts.kind !== "repo") return;
    assert.equal(facts.commits, undefined);
    assert.equal(facts.commitsProblem, "git rev-list が 300 msで答えませんでした");
    assert.equal(facts.branch, "main");
  } finally {
    GIT_TIMEOUTS.count = saved.count;
    GIT_ENV.PATH = saved.path;
    s.done();
  }
});

test("どこにいるかは git に聞く——bare は bare、その中は「中」、`.git` という名前のただのフォルダは git でない", async () => {
  const s = scratch();
  try {
    const bare = join(s.dir, "srv.git");
    execFileSync("git", ["init", "-q", "--bare", bare]);
    assert.deepEqual(await readFolder(bare), { kind: "bare" });
    assert.deepEqual(await readFolder(join(bare, "refs")), { kind: "inside", top: bare });

    const plain = join(s.dir, "plain", ".git");
    mkdirSync(plain, { recursive: true });
    assert.deepEqual(await readFolder(plain), { kind: "not-git" }, "名前が .git なだけのフォルダをリポジトリの中と言った");

    const repo = join(s.dir, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    assert.deepEqual(await readFolder(join(repo, ".git", "objects")), { kind: "inside", top: repo });
    assert.ok(existsSync(join(repo, ".git")));
  } finally {
    s.done();
  }
});
