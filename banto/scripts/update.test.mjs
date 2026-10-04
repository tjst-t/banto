// `scripts/update.mjs` の試験（`node --test scripts/update.test.mjs`）。
//
// GitHub 役はローカルのリポジトリ、組み立ては偽のコマンド、systemctl は偽のスクリプト（restart されたら、そのときの
// `current` を「動いている版」として書く）、host と画面は小さな http サーバ。host は「動いている版」の commit を
// `/api/admin/update` で返し、その版に `banto/BROKEN` があれば答えない（起きない版）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "update.mjs");
const TOKEN = "tok";

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" }).trim();

const IDLE = { idle: true, onlyWaitingOnHuman: false, turns: [], awaitingReplies: [], moduleCalls: [] };
const BUSY = {
  idle: false,
  onlyWaitingOnHuman: false,
  turns: [{ threadId: "t1", threadTitle: "作業中", startedAt: "2026-10-04T00:00:00Z", hop: 0, queued: 0, waitingOnHuman: false }],
  awaitingReplies: [],
  moduleCalls: [],
};

async function withRelease(fn) {
  const dir = mkdtempSync(join(tmpdir(), "banto-update-test-"));
  const github = join(dir, "github");
  const rel = join(dir, "release");
  const dataDir = join(dir, "data");
  const fake = join(dir, "fake");
  mkdirSync(join(github, "banto"), { recursive: true });
  mkdirSync(fake);
  git(dir, "init", "-q", "-b", "release", github);
  writeFileSync(join(github, "banto", "README"), "v1\n");
  git(github, "add", ".");
  git(github, "commit", "-q", "-m", "最初の版");
  const first = git(github, "rev-parse", "HEAD");
  let n = 0;
  /** release を1つ進める。`broken` なら、その版は起きない */
  const commit = (subject, { broken = false } = {}) => {
    writeFileSync(join(github, "banto", "README"), `v${++n + 1}\n`);
    if (broken) writeFileSync(join(github, "banto", "BROKEN"), "");
    else rmSync(join(github, "banto", "BROKEN"), { force: true });
    git(github, "add", "-A");
    git(github, "commit", "-q", "-m", subject);
    return git(github, "rev-parse", "HEAD");
  };

  // 置き場の形（setup-update.sh が作るもの）
  const repo = join(rel, "repo.git");
  git(dir, "init", "-q", "--bare", repo);
  git(repo, "remote", "add", "origin", github);
  git(repo, "fetch", "-q", "origin", "+refs/heads/release:refs/remotes/origin/release");
  const firstDir = join(rel, "versions", first.slice(0, 12));
  git(repo, "worktree", "add", "-q", "--detach", firstDir, first);
  execFileSync("ln", ["-s", join("versions", first.slice(0, 12)), join(rel, "current")]);
  writeFileSync(join(fake, "running"), realpathSync(firstDir));

  // 偽の systemctl：呼ばれた引数を残し、restart なら今の current を「動いている版」にする
  const systemctl = join(fake, "systemctl");
  writeFileSync(
    systemctl,
    `#!/bin/sh\necho "$*" >> "${fake}/systemctl.log"\n[ "$1" = restart ] && readlink -f "${rel}/current" > "${fake}/running"\nexit 0\n`,
  );
  chmodSync(systemctl, 0o755);

  // 偽の host と画面
  const host = { activity: IDLE, activityCalls: 0 };
  const hostServer = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end();
    if (req.url === "/api/admin/activity") {
      host.activityCalls++;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ...host.activity, now: new Date().toISOString() }));
    }
    if (req.url === "/api/admin/update") {
      const running = readFileSync(join(fake, "running"), "utf8").trim();
      if (existsSync(join(running, "banto", "BROKEN"))) return res.writeHead(503).end();
      const commit = git(running, "rev-parse", "HEAD");
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ current: { commit } }));
    }
    res.writeHead(404).end();
  });
  const uiServer = createServer((_req, res) => res.writeHead(200).end("ok"));
  await new Promise((r) => hostServer.listen(0, "127.0.0.1", r));
  await new Promise((r) => uiServer.listen(0, "127.0.0.1", r));

  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ dataDir, releaseDir: rel, port: hostServer.address().port, uiPort: uiServer.address().port, authToken: TOKEN }),
  );
  const updateDir = join(dataDir, "update");
  const children = [];

  const ctx = {
    dir,
    rel,
    github,
    updateDir,
    first,
    commit,
    host,
    systemctlCalls: () => (existsSync(join(fake, "systemctl.log")) ? readFileSync(join(fake, "systemctl.log"), "utf8").trim().split("\n") : []),
    current: () => readlinkSync(join(rel, "current")),
    previous: () => (existsSync(join(rel, "previous")) ? readlinkSync(join(rel, "previous")) : null),
    versions: () => readdirSync(join(rel, "versions")).sort(),
    worktrees: () => git(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length - 1,
    state: () => JSON.parse(readFileSync(join(updateDir, "state.json"), "utf8")),
    request(commitSha, mode) {
      mkdirSync(updateDir, { recursive: true });
      writeFileSync(join(updateDir, "request.json"), JSON.stringify({ id: `req-${commitSha.slice(0, 7)}`, commit: commitSha, mode, requestedBy: { sessionId: "s1" } }));
    },
    mark(name) {
      writeFileSync(join(updateDir, name), "");
    },
    /** update.mjs を走らせる（待たない——試験から印を置けるように）。終わりは `.done` */
    start(args = [], env = {}) {
      const child = spawn(process.execPath, [SCRIPT, ...args], {
        env: {
          ...process.env,
          BANTO_CONFIG_PATH: configPath,
          BANTO_UPDATE_SYSTEMCTL: systemctl,
          BANTO_UPDATE_BUILD: "echo built > built.txt",
          BANTO_UPDATE_VERIFY_TIMEOUT: "2",
          BANTO_UPDATE_INTERVAL: "0.1",
          BANTO_UPDATE_MARK_INTERVAL: "0.05",
          ...env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      const done = new Promise((resolve) => child.on("exit", (code) => resolve({ code, out })));
      return { child, done };
    },
    async waitForPhase(phase, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          if (ctx.state().phase === phase) return;
        } catch {
          // まだ無い・書いている途中ではない（rename で置くので、読めれば全体）
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`${phase} になりませんでした（今：${JSON.stringify(ctx.state())}）`);
    },
  };
  try {
    await fn(ctx);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    hostServer.close();
    uiServer.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const v = (sha) => join("versions", sha.slice(0, 12));
/** 待つ所が壊れていたら、止まらずに落ちる */
const T = { timeout: 30_000 };

test("成功：組み立てて current を替え、起こし直して確かめる。次の更新で、previous より古い版を片づける", T, async () => {
  await withRelease(async (ctx) => {
    const b = ctx.commit("二つ目");
    ctx.request(b, "wait");
    const { code, out } = await ctx.start().done;
    assert.equal(code, 0, out);
    const s = ctx.state();
    assert.equal(s.phase, "done", JSON.stringify(s));
    assert.equal(s.id, `req-${b.slice(0, 7)}`);
    assert.equal(s.from, ctx.first);
    assert.equal(s.to, b);
    assert.deepEqual(s.requestedBy, { sessionId: "s1" });
    assert.equal(existsSync(join(ctx.updateDir, "request.json")), false, "頼みを受け取ったら消す");
    assert.equal(ctx.current(), v(b));
    assert.equal(ctx.previous(), v(ctx.first));
    assert.equal(readFileSync(join(ctx.rel, "current", "banto", "built.txt"), "utf8"), "built\n", "組み立ては新しい版の banto/ で");
    assert.deepEqual(ctx.systemctlCalls(), ["restart banto-host.service banto-frontend.service"]);
    assert.ok(ctx.host.activityCalls >= 1, "待つ形なのに host に聞いていない");
    assert.match(readFileSync(s.logFile, "utf8"), /built|更新しました/);

    const c = ctx.commit("三つ目");
    assert.equal((await ctx.start(["--now"]).done).code, 0);
    assert.equal(ctx.current(), v(c));
    assert.equal(ctx.previous(), v(b));
    assert.deepEqual(ctx.versions(), [b.slice(0, 12), c.slice(0, 12)].sort(), "previous より古い版が残っている");
    assert.equal(ctx.worktrees(), 2, "消した版の worktree が repo.git に残っている");
  });
});

test("組み立てが落ちたら、作りかけを消して今の版のまま（起こし直さない）", T, async () => {
  await withRelease(async (ctx) => {
    const b = ctx.commit("二つ目");
    const { code } = await ctx.start(["--now"], { BANTO_UPDATE_BUILD: "echo こわれた >&2; exit 7" }).done;
    assert.equal(code, 1);
    const s = ctx.state();
    assert.equal(s.phase, "failed");
    assert.equal(s.failedPhase, "build");
    assert.match(s.error, /終了コード 7/);
    assert.match(readFileSync(s.logFile, "utf8"), /こわれた/, "子の出力がログに無い");
    assert.equal(ctx.current(), v(ctx.first));
    assert.equal(existsSync(join(ctx.rel, v(b))), false, "作りかけが残っている");
    assert.equal(ctx.worktrees(), 1);
    assert.deepEqual(ctx.systemctlCalls(), []);
  });
});

test("新しい版が起きなければ、前の版に戻して起こし直し「前の版に戻しました」で終わる", T, async () => {
  await withRelease(async (ctx) => {
    const b = ctx.commit("起きない版", { broken: true });
    const { code } = await ctx.start(["--now"]).done;
    assert.equal(code, 1);
    const s = ctx.state();
    assert.equal(s.phase, "rolled-back", JSON.stringify(s));
    assert.equal(s.failedPhase, "verify");
    assert.equal(s.result, "前の版に戻しました");
    assert.match(s.error, /host：503/);
    assert.equal(ctx.current(), v(ctx.first));
    assert.equal(ctx.previous(), null, "戻したのに previous が新しい版の前を指したまま");
    assert.equal(existsSync(join(ctx.rel, v(b))), false);
    assert.deepEqual(ctx.systemctlCalls(), [
      "restart banto-host.service banto-frontend.service",
      "restart banto-host.service banto-frontend.service",
    ]);
  });
});

test("待っている間は残っているものを state に書き、cancel でやめる（作った版は消し、起こし直さない）", T, async () => {
  await withRelease(async (ctx) => {
    const b = ctx.commit("二つ目");
    ctx.host.activity = BUSY;
    ctx.request(b, "wait");
    const run = ctx.start();
    await ctx.waitForPhase("wait");
    // 残っているものが書かれるまで
    const deadline = Date.now() + 5000;
    while (!ctx.state().waiting && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.equal(ctx.state().waiting.turns[0].threadTitle, "作業中");
    ctx.mark("cancel");
    const { code, out } = await run.done;
    assert.equal(code, 0, out);
    const s = ctx.state();
    assert.equal(s.phase, "cancelled");
    assert.equal(s.waiting, undefined);
    assert.equal(ctx.current(), v(ctx.first));
    assert.equal(existsSync(join(ctx.rel, v(b))), false);
    assert.deepEqual(ctx.systemctlCalls(), []);
    assert.equal(existsSync(join(ctx.updateDir, "cancel")), false, "印を次の回に持ち越す");
  });
});

test("cancel は組み立ての途中でも効く（子を止めて作りかけを消す）", T, async () => {
  await withRelease(async (ctx) => {
    const b = ctx.commit("二つ目");
    const run = ctx.start(["--now"], { BANTO_UPDATE_BUILD: "sleep 30" });
    await ctx.waitForPhase("build");
    const started = Date.now();
    ctx.mark("cancel");
    const { code } = await run.done;
    assert.equal(code, 0);
    assert.ok(Date.now() - started < 10_000, "組み立てが終わるまで待った");
    assert.equal(ctx.state().phase, "cancelled");
    assert.equal(existsSync(join(ctx.rel, v(b))), false);
    assert.equal(ctx.current(), v(ctx.first));
  });
});

test("force-now で待たずに起こし直す", T, async () => {
  await withRelease(async (ctx) => {
    const b = ctx.commit("二つ目");
    ctx.host.activity = BUSY;
    ctx.request(b, "wait");
    const run = ctx.start();
    await ctx.waitForPhase("wait");
    ctx.mark("force-now");
    const { code, out } = await run.done;
    assert.equal(code, 0, out);
    assert.equal(ctx.state().phase, "done");
    assert.equal(ctx.current(), v(b));
    assert.equal(ctx.systemctlCalls().length, 1);
    assert.equal(existsSync(join(ctx.updateDir, "force-now")), false);
  });
});

test("早送りで済まない release・release から辿れない commit は断る（何も作らない）", T, async () => {
  await withRelease(async (ctx) => {
    const b = ctx.commit("二つ目");
    // release を、今の版を含まない歴史に書き換える
    git(ctx.github, "checkout", "-q", "--orphan", "other");
    git(ctx.github, "commit", "-q", "-m", "書き換えた歴史");
    git(ctx.github, "branch", "-q", "-f", "release", "other");
    git(ctx.github, "checkout", "-q", "release");
    const r1 = await ctx.start(["--now"]).done;
    assert.equal(r1.code, 1);
    assert.equal(ctx.state().failedPhase, "fetch");
    assert.match(ctx.state().error, /早送り/);
    // b は前に取ってきた（repo.git にある）が、いまの release からは辿れない
    git(ctx.dir, "--git-dir", join(ctx.rel, "repo.git"), "fetch", "-q", ctx.github, `${b}:refs/keep/b`);
    const r2 = await ctx.start(["--now", "--commit", b]).done;
    assert.equal(r2.code, 1);
    assert.match(ctx.state().error, /release.*から辿れません/);
    assert.deepEqual(ctx.versions(), [ctx.first.slice(0, 12)]);
    assert.deepEqual(ctx.systemctlCalls(), []);
  });
});

test("走っている更新があれば二重に起きない", T, async () => {
  await withRelease(async (ctx) => {
    ctx.commit("二つ目");
    mkdirSync(ctx.updateDir, { recursive: true });
    writeFileSync(join(ctx.updateDir, "lock"), String(process.pid)); // 生きている pid
    const { code, out } = await ctx.start(["--now"]).done;
    assert.equal(code, 3);
    assert.match(out, /ほかの更新が走っています/);
    assert.equal(existsSync(join(ctx.updateDir, "state.json")), false);
  });
});

test("--first：current が無いところに入れる。待たない・起こさない・戻す先なし", T, async () => {
  await withRelease(async (ctx) => {
    rmSync(join(ctx.rel, "current"));
    const b = ctx.commit("二つ目");
    const { code, out } = await ctx.start(["--first", "--commit", b]).done;
    assert.equal(code, 0, out);
    assert.equal(ctx.state().phase, "done");
    assert.equal(ctx.current(), v(b));
    assert.equal(ctx.previous(), null);
    assert.deepEqual(ctx.systemctlCalls(), []);
    assert.equal(ctx.host.activityCalls, 0);
  });
});

test("--dry-run は何も作らず、何も書かない", T, async () => {
  await withRelease(async (ctx) => {
    const b = ctx.commit("二つ目");
    const { code, out } = await ctx.start(["--dry-run"]).done;
    assert.equal(code, 0, out);
    assert.match(out, new RegExp(b));
    assert.match(out, /二つ目/);
    assert.equal(existsSync(join(ctx.updateDir, "state.json")), false);
    assert.deepEqual(ctx.versions(), [ctx.first.slice(0, 12)]);
    assert.deepEqual(ctx.systemctlCalls(), []);
  });
});
