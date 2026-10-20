// 別のサーバの Project の git とブランチの中身をやり取りする台本（Backlog #466）。**台本は本物の sh と git で流す**——向こうの
// 箱の中で流すのと同じ argv を、この機械で流す（箱に届く道は remote-ssh.test.ts が見る）。見るのは：origin の設定を読む
// （リポジトリの段だけ・送り先を変える設定の名前）・そのブランチだけの bundle・無いブランチ・取り込むのは追跡の ref だけ・
// 追跡の ref を合わせる・フックを走らせない・ブランチ名とコミットの名前の形・大きすぎるもの・この機械の Project は断る。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdirSync, utimesSync } from "node:fs";
import { RemoteProjectGit, UNBUNDLE_SCRIPT, parseOriginConfig, type ProjectRun, type RunInProject } from "./remote-git.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * 箱の中で流す代わり：argv をこの機械でそのまま流す（標準入出力はバイトのまま、上限つき）。**こちらでは時間で切らない**——
 * 向こうの git が自分の上限で止まることを見るため。`env` で PATH・TMPDIR を差し替えられる
 */
const runWith =
  (env: Record<string, string> = {}): RunInProject =>
  (_projectId, argv, opts) =>
  new Promise<ProjectRun>((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/", ...env } });
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      size += c.length;
      if (size > opts.maxStdoutBytes) {
        overflow = true;
        child.kill("SIGKILL");
      } else chunks.push(c);
    });
    child.stderr.on("data", (c: Buffer) => (stderr += String(c)));
    child.on("close", (code) => resolve({ code: code ?? 255, stdout: Buffer.concat(chunks), stderr, ...(overflow ? { overflow: true as const } : {}) }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.stdin ?? Buffer.alloc(0));
  });
const localRun = runWith();

function world(): { dir: string; repo: string; pg: RemoteProjectGit; roots: Map<string, string>; done(): void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "banto-remote-git-")));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "commit", "-q", "--allow-empty", "-m", "main");
  const roots = new Map([["p1", repo]]);
  const pg = new RemoteProjectGit({ remoteRootOf: (id) => roots.get(id), run: localRun });
  return { dir, repo, pg, roots, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 作業ツリーに触らずに、そのブランチに1コミット積む（Backlog と同じ形） */
function commitOn(repo: string, branch: string, text: string): string {
  const blob = execFileSync("git", ["-C", repo, "hash-object", "-w", "--stdin"], { input: text, encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["-C", repo, "mktree"], { input: `100644 blob ${blob}\ttasks.json\n`, encoding: "utf8" }).trim();
  let parent: string | undefined;
  try {
    parent = git(repo, "rev-parse", "-q", "--verify", `refs/heads/${branch}`);
  } catch {
    parent = undefined;
  }
  const commit = git(repo, "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "backlog");
  git(repo, "update-ref", `refs/heads/${branch}`, commit);
  return commit;
}

test("origin の設定はリポジトリの段だけを読み、URL と送り先を変える設定の名前に分ける。git でなければ not-repo", async () => {
  const w = world();
  try {
    assert.deepEqual(await w.pg.origin("p1"), { kind: "repo", urls: [], redirects: [] });
    git(w.repo, "remote", "add", "origin", "https://github.com/a/b.git");
    git(w.repo, "config", "remote.origin.pushurl", "https://github.com/a/c.git");
    git(w.repo, "config", "url.https://evil.example.com/.insteadOf", "https://github.com/");
    git(w.repo, "config", "url.ssh://x/.pushInsteadOf", "https://github.com/");
    // リポジトリの外の設定（ユーザーの段）は見ない——向こうのユーザーの ~/.gitconfig の insteadOf で断らない
    const origin = await w.pg.origin("p1");
    assert.deepEqual(origin, {
      kind: "repo",
      urls: ["https://github.com/a/b.git"],
      redirects: ["remote.origin.pushurl", "url.https://evil.example.com/.insteadof", "url.ssh://x/.pushinsteadof"],
    });
    // 根がリポジトリの下のフォルダでも同じリポジトリ
    mkdirSync(join(w.repo, "docs"));
    w.roots.set("p2", join(w.repo, "docs"));
    assert.equal((await w.pg.origin("p2")).kind, "repo");
    const plain = join(w.dir, "plain");
    mkdirSync(plain);
    w.roots.set("p3", plain);
    assert.deepEqual(await w.pg.origin("p3"), { kind: "not-repo" });
    // 根が無い——「git でない」と言わずに投げる（規則2）
    w.roots.set("p4", join(w.dir, "missing"));
    await assert.rejects(() => w.pg.origin("p4"), /origin を読めませんでした/);
  } finally {
    w.done();
  }
});

test("そのブランチだけの bundle を作り、取り込むのは追跡の ref だけ。追跡の ref を合わせる。フックは走らない", async () => {
  const w = world();
  try {
    const marks = join(w.dir, "marks");
    mkdirSync(marks);
    const hooks = join(w.dir, "hooks");
    mkdirSync(hooks);
    for (const h of ["reference-transaction", "post-checkout"]) {
      writeFileSync(join(hooks, h), `#!/bin/sh\ntouch ${join(marks, h)}\n`);
      chmodSync(join(hooks, h), 0o755);
    }
    const head = commitOn(w.repo, "backlog", '{"items":[]}\n');
    // ここから先、w.repo に触るのは台本だけ
    git(w.repo, "config", "core.hooksPath", hooks);
    const bundle = await w.pg.bundle("p1", "backlog");
    assert.ok(bundle && bundle.toString("latin1").startsWith("# v2 git bundle"));
    // bundle に入るのはそのブランチだけ
    const file = join(w.dir, "b.bundle");
    writeFileSync(file, bundle!);
    assert.deepEqual(git(w.dir, "bundle", "list-heads", file).split("\n"), [`${head} refs/heads/backlog`]);
    assert.equal(await w.pg.bundle("p1", "nothing-here"), undefined);

    // 別の手元のコミットを取り込む——追跡の ref だけ進み、手元のブランチはそのまま
    const other = join(w.dir, "other");
    git(w.dir, "clone", "-q", w.repo, other);
    git(other, "fetch", "-q", "origin", "backlog:backlog");
    const ahead = commitOn(other, "backlog", '{"items":[1]}\n');
    const theirs = execFileSync("git", ["-C", other, "bundle", "create", "-q", "-", "refs/heads/backlog"]);
    await w.pg.unbundle("p1", "backlog", theirs);
    assert.equal(git(w.repo, "rev-parse", "refs/remotes/origin/backlog"), ahead);
    assert.equal(git(w.repo, "rev-parse", "refs/heads/backlog"), head);
    // 追跡の ref を、もうあるコミットに合わせる（送り終えたあと）。無いコミットは断る
    await w.pg.track("p1", "backlog", head);
    assert.equal(git(w.repo, "rev-parse", "refs/remotes/origin/backlog"), head);
    await assert.rejects(() => w.pg.track("p1", "backlog", "0".repeat(40)), /origin\/backlog を進められませんでした/);
    await assert.rejects(() => w.pg.track("p1", "backlog", "HEAD"), /コミットの名前の形が違います/);
    // 一時ファイルは残らない・フックは走らない
    assert.deepEqual([existsSync(join(marks, "reference-transaction")), existsSync(join(marks, "post-checkout"))], [false, false]);
    // 壊れた bundle は取り込まない
    await assert.rejects(() => w.pg.unbundle("p1", "backlog", Buffer.from("not a bundle")), /取り込めませんでした/);
  } finally {
    w.done();
  }
});

test("ブランチ名・大きさ・どの Project かを確かめる", async () => {
  const w = world();
  try {
    for (const bad of ["-f", "+a:b", "a..b", "refs/*"]) {
      await assert.rejects(() => w.pg.bundle("p1", bad), /ブランチ名として受け付けられない/, bad);
      await assert.rejects(() => w.pg.unbundle("p1", bad, Buffer.alloc(1)), /ブランチ名として受け付けられない/, bad);
    }
    // この機械の Project（別のサーバでない）は断る
    await assert.rejects(() => w.pg.origin("host-project"), /別のサーバで動いていません/);
    // 上限を越えた bundle は読むのをやめて断る
    const big = new RemoteProjectGit({
      remoteRootOf: () => w.repo,
      run: (id, argv, opts) => localRun(id, ["/bin/sh", "-c", 'head -c 7000000 /dev/zero'], opts),
    });
    await assert.rejects(() => big.bundle("p1", "backlog"), /大きすぎて、別のサーバとの間で運べません/);
    await assert.rejects(() => w.pg.unbundle("p1", "backlog", Buffer.alloc(6 * 1024 * 1024 + 1)), /大きすぎます/);
  } finally {
    w.done();
  }
});

test("origin の設定の出力（--null）を読む", () => {
  assert.deepEqual(parseOriginConfig("not-repo\n"), { kind: "not-repo" });
  assert.deepEqual(parseOriginConfig(""), { kind: "repo", urls: [], redirects: [] });
  assert.deepEqual(parseOriginConfig("remote.origin.url\na\0remote.origin.url\nb\0url.x.insteadof\ny\0url.x.insteadof\nz\0"), {
    kind: "repo",
    urls: ["a", "b"],
    redirects: ["url.x.insteadof"],
  });
});

test("向こうの git は自分の上限で止まる（core が線を切っても走り切らない）。取り込む一時ファイルは止められても残さず、前の回の残りも消す（レビュー L3）", async () => {
  const w = world();
  try {
    commitOn(w.repo, "backlog", "{}\n");
    // bundle を作る git が答えないまま居座る向こう
    const bin = join(w.dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!/bin/sh\nfor a; do [ "$a" = bundle ] && exec sleep 30; done\nexec ${execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim()} "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    const hung = new RemoteProjectGit({ remoteRootOf: () => w.repo, run: runWith({ PATH: `${bin}:${process.env.PATH}` }), timeoutMs: 2000 });
    const started = Date.now();
    await assert.rejects(() => hung.bundle("p1", "backlog"), /bundle にできませんでした/);
    assert.ok(Date.now() - started < 6000, `向こうの git が上限で止まらない（${Date.now() - started}ms）`);

    // 前の回の残り（1時間前）は消し、今の回の一時ファイルも残さない
    const tmp = join(w.dir, "tmp");
    mkdirSync(tmp);
    const stale = join(tmp, "banto-unbundle.OLD123");
    writeFileSync(stale, "x");
    utimesSync(stale, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
    const fresh = join(tmp, "banto-unbundle.NOW456");
    writeFileSync(fresh, "y");
    const pg = new RemoteProjectGit({ remoteRootOf: () => w.repo, run: runWith({ TMPDIR: tmp }) });
    const bundle = execFileSync("git", ["-C", w.repo, "bundle", "create", "-q", "-", "refs/heads/backlog"]);
    await pg.unbundle("p1", "backlog", bundle);
    assert.deepEqual(readdirSync(tmp), ["banto-unbundle.NOW456"], "前の回の残りを消していない・今の回のものが残った・走っているかもしれない新しいものを消した");

    // 受けている途中で止められた（線が切れた）——一時ファイルを消してから終わる
    const child = spawn("env", ["BANTO_GIT_LIMIT=10", "/bin/sh", "-c", UNBUNDLE_SCRIPT, "banto-git", w.repo, "backlog"], {
      stdio: ["pipe", "ignore", "ignore"],
      env: { PATH: process.env.PATH ?? "", TMPDIR: tmp },
    });
    child.stdin.write(bundle.subarray(0, 10));
    const until = Date.now() + 5000;
    while (readdirSync(tmp).length < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    assert.equal(readdirSync(tmp).length, 2, "一時ファイルができていない");
    const closed = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
    child.kill("SIGTERM");
    child.stdin.end();
    assert.notEqual(await closed, 0);
    assert.deepEqual(readdirSync(tmp), ["banto-unbundle.NOW456"], "止められたあとに一時ファイルが残った");
  } finally {
    w.done();
  }
});
