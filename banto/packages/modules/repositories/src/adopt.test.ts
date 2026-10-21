// 今あるフォルダをリポジトリにする（Backlog #502）。**本物の git で、使い捨ての home の中に作る**（repositories.test.ts と同じ）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIRST_COMMIT_MESSAGE, FolderAdopter } from "./adopt.js";
import { GIT_ENV } from "./git.js";
import { LedgerStore } from "./ledger.js";

/** 名前・メールは使い捨ての HOME の .gitconfig に置く——Module は人の git の設定の段を読んで最初のコミットを作る */
function world(identity = true) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "banto-adopt-")));
  // Module の git は読む口の環境（GIT_ENV）で走る——試験はそこの HOME を替える（clone.test.ts と同じ）
  const saved = { HOME: GIT_ENV.HOME, XDG: GIT_ENV.XDG_CONFIG_HOME };
  GIT_ENV.HOME = home;
  GIT_ENV.XDG_CONFIG_HOME = join(home, ".config");
  writeFileSync(join(home, ".gitconfig"), identity ? "[user]\n\tname = t\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n" : "[user]\n\tuseConfigOnly = true\n");
  const store = new LedgerStore(join(home, ".banto-data"));
  return {
    home,
    store,
    adopter: new FolderAdopter(store, home),
    folder(name: string, files: Record<string, string> = {}) {
      const dir = join(home, name);
      mkdirSync(dir, { recursive: true });
      for (const [f, body] of Object.entries(files)) {
        mkdirSync(join(dir, f, ".."), { recursive: true });
        writeFileSync(join(dir, f), body);
      }
      return dir;
    },
    git(cwd: string, ...args: string[]) {
      return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") } });
    },
    done() {
      GIT_ENV.HOME = saved.HOME;
      GIT_ENV.XDG_CONFIG_HOME = saved.XDG;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("git でないフォルダ：調べると init、リポジトリにすると git init・最初のコミット（.gitignore に従う）・台帳に入る", async () => {
  const w = world();
  try {
    const dir = w.folder("banto/chats/2026-10-21-abcd", { "index.html": "<p>hi</p>", "src/app.js": "1", ".gitignore": "secret.txt\n", "secret.txt": "x" });
    const ins = await w.adopter.inspect(dir);
    assert.equal(ins.state, "init");
    assert.equal(ins.displayPath, "~/banto/chats/2026-10-21-abcd");

    const r = await w.adopter.adopt(dir);
    assert.deepEqual({ initialized: r.initialized, committed: r.committed, alreadyListed: r.alreadyListed, branch: r.branch, path: r.path }, {
      initialized: true,
      committed: true,
      alreadyListed: false,
      branch: "main",
      path: dir,
    });
    assert.equal(w.git(dir, "log", "--format=%s|%an").trim(), `${FIRST_COMMIT_MESSAGE}|t`);
    assert.deepEqual(w.git(dir, "ls-files").trim().split("\n").sort(), [".gitignore", "index.html", "src/app.js"]);
    assert.deepEqual((await w.store.entries()).map((e) => e.path), [dir]);
    assert.equal((await w.adopter.inspect(dir)).state, "known");

    // もう一度押しても何もしない（コミットを足さない・台帳の行を増やさない）
    const again = await w.adopter.adopt(dir);
    assert.equal(again.alreadyListed, true);
    assert.equal(again.initialized, false);
    assert.equal(w.git(dir, "rev-list", "--count", "HEAD").trim(), "1");
    assert.equal((await w.store.entries()).length, 1);
  } finally {
    w.done();
  }
});

test("空のフォルダは git init と台帳だけ（コミットは作らない）", async () => {
  const w = world();
  try {
    const dir = w.folder("empty");
    const r = await w.adopter.adopt(dir);
    assert.equal(r.initialized, true);
    assert.equal(r.committed, false);
    assert.deepEqual((await w.store.entries()).map((e) => e.path), [dir]);
  } finally {
    w.done();
  }
});

test("もう git のリポジトリの一番上なら、コミットせずに台帳に足すだけ（origin が GitHub なら、そう言う）", async () => {
  const w = world();
  try {
    const dir = w.folder("work/app", { "a.txt": "1" });
    w.git(dir, "init", "-q");
    w.git(dir, "remote", "add", "origin", "git@github.com:someone/app.git");
    writeFileSync(join(dir, "b.txt"), "途中");
    const ins = await w.adopter.inspect(dir);
    assert.equal(ins.state, "import");
    assert.deepEqual(ins.github, { owner: "someone", name: "app" });
    const r = await w.adopter.adopt(dir);
    assert.equal(r.initialized, false);
    assert.equal(r.committed, false);
    assert.equal(r.alreadyListed, false);
    assert.throws(() => w.git(dir, "rev-parse", "--verify", "-q", "HEAD"), "人の作業の途中をコミットした");
    assert.deepEqual((await w.store.entries()).map((e) => [e.path, e.github]), [[dir, { owner: "someone", name: "app" }]]);
  } finally {
    w.done();
  }
});

test("リポジトリの中のフォルダ・無いフォルダは断る（理由つき）", async () => {
  const w = world();
  try {
    const top = w.folder("work/mono", { "pkg/a.txt": "1" });
    w.git(top, "init", "-q");
    const inner = join(top, "pkg");
    const ins = await w.adopter.inspect(inner);
    assert.equal(ins.state, undefined);
    assert.match(ins.refusal ?? "", /リポジトリの中のフォルダです/);
    await assert.rejects(w.adopter.adopt(inner), /リポジトリにできません/);
    assert.equal(existsSync(join(inner, ".git")), false);
    assert.match((await w.adopter.inspect(join(w.home, "nowhere"))).refusal ?? "", /ありません/);
    assert.deepEqual(await w.store.entries(), []);
  } finally {
    w.done();
  }
});

test("名前・メールが無くて最初のコミットを作れなければ、git の理由のまま断り、作りかけの .git を消す（台帳にも入れない）", async () => {
  const w = world(false);
  try {
    const dir = w.folder("chat", { "a.txt": "1" });
    await assert.rejects(w.adopter.adopt(dir), /最初のコミットを作れませんでした/);
    assert.equal(existsSync(join(dir, ".git")), false, "作りかけの .git が残った");
    assert.equal(existsSync(join(dir, "a.txt")), true, "中のファイルに触った");
    assert.deepEqual(await w.store.entries(), []);
  } finally {
    w.done();
  }
});
