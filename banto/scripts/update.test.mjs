// `scripts/update.mjs` の試験（`node --test scripts/update.test.mjs`）。
//
// GitHub 役はローカルのリポジトリ、組み立ては偽のコマンド、systemctl は偽のスクリプト（restart されたら、そのときの
// `current` を「動いている版」として書く。`show` には unit ごとのファイルの中身を返す）、incus も偽のスクリプト
// （コンテナの一覧はファイルの中身）、host と画面は小さな http サーバ。host は「動いている版」の commit を
// `/api/admin/update` で返し、その版に `banto/BROKEN` があれば答えない（起きない版）。`crash` の印があると、
// 起きない版の host の unit は「落ちて起こし直し中」になる。

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

  // 偽の systemctl：restart・start 等は呼ばれた引数を残す。restart なら今の current を「動いている版」にし、unit の
  // 状態（`show` が返すもの）を「動いている」にする——`crash` の印があって、その版が起きない版なら「落ちて起こし直し中」。
  // `deny-restart` の印があれば polkit に断られたように失敗する。`show` は fake/<unit>.show の中身（無ければ動いている。
  // 自動で起こし直された回数は fake/nrestarts——人の restart では戻らない、本物の systemd と同じ）
  const systemctl = join(fake, "systemctl");
  writeFileSync(
    systemctl,
    `#!/bin/sh
F="${fake}"
if [ "$1" = show ]; then
  for a; do unit=$a; done
  n=$(cat "$F/nrestarts" 2>/dev/null || echo 0)
  if [ -f "$F/$unit.show" ]; then sed "s/NRESTARTS/$n/" "$F/$unit.show"; else printf 'ActiveState=active\\nSubState=running\\nNRestarts=%s\\n' "$n"; fi
  exit 0
fi
echo "$*" >> "$F/systemctl.log"
if [ "$1" = restart ]; then
  if [ -e "$F/deny-restart" ]; then echo "Failed to restart: Interactive authentication required." >&2; exit 1; fi
  running=$(readlink -f "${rel}/current")
  echo "$running" > "$F/running"
  if [ -e "$F/crash" ] && [ -e "$running/banto/BROKEN" ]; then
    if [ "$(cat "$F/crash")" = restarted ]; then
      echo $(( $(cat "$F/nrestarts" 2>/dev/null || echo 0) + 1 )) > "$F/nrestarts"
    else
      printf 'ActiveState=activating\\nSubState=auto-restart\\nNRestarts=NRESTARTS\\n' > "$F/banto-host.service.show"
    fi
  else
    rm -f "$F/banto-host.service.show"
  fi
fi
exit 0
`,
  );
  chmodSync(systemctl, 0o755);

  // 偽の incus：コンテナの一覧は fake/instances.json（無ければ空）。`incus-down` の印があれば届かない
  const incus = join(fake, "incus");
  writeFileSync(
    incus,
    `#!/bin/sh
F="${fake}"
if [ -e "$F/incus-down" ]; then echo "Error: Failed to connect to local daemon" >&2; exit 1; fi
case "$1" in
  project) echo user-1000 ;;
  query) if [ -f "$F/instances.json" ]; then cat "$F/instances.json"; else echo '[]'; fi ;;
  *) echo "知らない引数：$*" >&2; exit 2 ;;
esac
`,
  );
  chmodSync(incus, 0o755);

  // 偽の host と画面
  /** `activityDown` の間、activity の口は答えない（繋いだ途端に切る） */
  const host = { activity: IDLE, activityCalls: 0, activityDown: false };
  const hostServer = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end();
    if (req.url === "/api/admin/activity") {
      host.activityCalls++;
      if (host.activityDown) return req.socket.destroy();
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
    JSON.stringify({ dataDir, releaseDir: rel, port: hostServer.address().port, authToken: TOKEN }),
  );
  const updateDir = join(dataDir, "update");
  const uiUrl = `http://127.0.0.1:${uiServer.address().port}/`;
  const children = [];

  const ctx = {
    dir,
    fake,
    rel,
    repo,
    github,
    uiUrl,
    configPath,
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
      writeFileSync(
        join(updateDir, "request.json"),
        JSON.stringify({ id: `req-${commitSha.slice(0, 7)}`, commit: commitSha, mode, requestedBy: { sessionId: "s1", label: "わたし" } }),
      );
    },
    /** 偽の systemctl の `show <unit>` が返すもの */
    unitShow(unit, text) {
      writeFileSync(join(fake, `${unit}.show`), text);
    },
    /** 偽の incus が返すコンテナの一覧（`source` を mount している装置を1つずつ持つ） */
    instances(sources) {
      writeFileSync(
        join(fake, "instances.json"),
        JSON.stringify(sources.map((source, i) => ({ name: `banto-p${i}`, devices: {}, expanded_devices: { banto: { type: "disk", source, path: source, readonly: "true" } } }))),
      );
    },
    mark(name) {
      writeFileSync(join(updateDir, name), "");
    },
    /** 偽の systemctl・incus への印（deny-restart・crash（中身が restarted なら「落ちて起き直した」）・incus-down） */
    fakeMark(name, content = "") {
      writeFileSync(join(fake, name), content);
    },
    /** update.mjs を走らせる（待たない——試験から印を置けるように）。終わりは `.done` */
    start(args = [], env = {}) {
      const child = spawn(process.execPath, [SCRIPT, ...args], {
        env: {
          ...process.env,
          BANTO_CONFIG_PATH: configPath,
          BANTO_UPDATE_SYSTEMCTL: systemctl,
          BANTO_UPDATE_INCUS: incus,
          BANTO_UPDATE_UI_URL: uiUrl,
          BANTO_UPDATE_BUILD: "echo built > built.txt",
          BANTO_UPDATE_VERIFY_TIMEOUT: "2",
          BANTO_UPDATE_INTERVAL: "0.1",
          BANTO_UPDATE_MARK_INTERVAL: "0.05",
          ...env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      // 壊れて待ち続けても、試験ごと止まらない（試験の上限より先に止めて、終わり方の確かめで落とす）
      const guard = setTimeout(() => child.kill("SIGKILL"), 25_000);
      child.on("exit", () => clearTimeout(guard));
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      const done = new Promise((resolve) => child.on("exit", (code) => resolve({ code, out })));
      return { child, done };
    },
    async waitForPhase(phase, timeoutMs = 10_000) {
      await ctx.waitForState((s) => s.phase === phase, `${phase} になりませんでした`, timeoutMs);
    },
    async waitForState(pred, what, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          if (pred(ctx.state())) return;
        } catch {
          // まだ無い・書いている途中ではない（rename で置くので、読めれば全体）
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`${what}（今：${existsSync(join(updateDir, "state.json")) ? JSON.stringify(ctx.state()) : "state.json 無し"}）`);
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
    const { code, out } = await ctx.start(["--from-request"]).done;
    assert.equal(code, 0, out);
    const s = ctx.state();
    assert.equal(s.phase, "done", JSON.stringify(s));
    assert.equal(s.id, `req-${b.slice(0, 7)}`);
    assert.equal(s.from, ctx.first);
    assert.equal(s.to, b);
    assert.deepEqual(s.requestedBy, { label: "わたし" }, "誰が頼んだかは名前だけ（セッションの id は写さない）");
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

test("新しい版が起きなければ（unit は動いているが答えない）、上限まで待ってから前の版に戻し「前の版に戻しました」で終わる", T, async () => {
  await withRelease(async (ctx) => {
    const b = ctx.commit("起きない版", { broken: true });
    const started = Date.now();
    const { code } = await ctx.start(["--now"]).done;
    assert.equal(code, 1);
    assert.ok(Date.now() - started >= 2000, "unit が動いているのに、上限（2秒）を待たずに諦めた");
    const s = ctx.state();
    assert.equal(s.phase, "rolled-back", JSON.stringify(s));
    assert.equal(s.failedPhase, "verify");
    assert.equal(s.result, "前の版に戻しました");
    assert.match(s.error, /2秒待ちました。host：答えません（503/);
    assert.equal(ctx.current(), v(ctx.first));
    assert.equal(ctx.previous(), null, "戻したのに previous が新しい版の前を指したまま");
    assert.equal(existsSync(join(ctx.rel, v(b), "banto", "built.txt")), true, "起きなかった版はすぐには消さない");
    assert.match(readFileSync(s.logFile, "utf8"), new RegExp(`起きなかった版は .*${b.slice(0, 12)} に残します`));
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
    const run = ctx.start(["--from-request"]);
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
    const run = ctx.start(["--from-request"]);
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

test("走っている更新があれば二重に起きない——走っている方の state.json を書き換えず、頼みも消さない", T, async () => {
  await withRelease(async (ctx) => {
    const b = ctx.commit("二つ目");
    mkdirSync(ctx.updateDir, { recursive: true });
    writeFileSync(join(ctx.updateDir, "lock"), String(process.pid)); // 生きている pid
    const running = JSON.stringify({ id: "走っている回", phase: "build" });
    writeFileSync(join(ctx.updateDir, "state.json"), running);
    ctx.request(b, "now");
    const { code, out } = await ctx.start(["--from-request"]).done;
    assert.equal(code, 3);
    assert.match(out, /ほかの更新が走っています/);
    assert.equal(readFileSync(join(ctx.updateDir, "state.json"), "utf8"), running);
    assert.equal(existsSync(join(ctx.updateDir, "request.json")), true, "頼みを消した（host が「受け取られていない」と言えなくなる）");
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

// ───────────── 頼み（request.json）の受け取り方 ─────────────

test("--from-request で頼みが無ければ、何もせずに断って理由を state に書く（release の最新を入れない）", T, async () => {
  await withRelease(async (ctx) => {
    ctx.commit("二つ目");
    const { code, out } = await ctx.start(["--from-request"]).done;
    assert.equal(code, 1, out);
    const s = ctx.state();
    assert.equal(s.phase, "failed");
    assert.match(s.error, /頼み.*がありません。画面から頼まれずに banto-update\.service が起きた/);
    assert.equal(ctx.current(), v(ctx.first));
    assert.deepEqual(ctx.versions(), [ctx.first.slice(0, 12)]);
    assert.deepEqual(ctx.systemctlCalls(), []);
  });
});

test("--from-request が無ければ request.json を使わず、消しもしない（手で打った更新は release の最新）", T, async () => {
  await withRelease(async (ctx) => {
    const b = ctx.commit("二つ目");
    const c = ctx.commit("三つ目");
    ctx.request(b, "now");
    const { code, out } = await ctx.start().done;
    assert.equal(code, 0, out);
    assert.equal(ctx.state().to, c);
    assert.equal(ctx.state().requestedBy, undefined);
    assert.equal(ctx.current(), v(c));
    assert.equal(existsSync(join(ctx.updateDir, "request.json")), true);
  });
});

test("設定が読めなくても、黙って終わらない——既定のデータ置き場の state.json に理由を書く", T, async () => {
  await withRelease(async (ctx) => {
    const bad = join(ctx.dir, "bad.json");
    writeFileSync(bad, "{ 壊れた");
    const xdg = join(ctx.dir, "xdg");
    const { code, out } = await ctx.start(["--from-request"], { BANTO_CONFIG_PATH: bad, XDG_DATA_HOME: xdg }).done;
    assert.equal(code, 1, out);
    const s = JSON.parse(readFileSync(join(xdg, "banto", "update", "state.json"), "utf8"));
    assert.equal(s.phase, "failed");
    assert.match(s.error, /banto の設定を読めません/);
    assert.deepEqual(ctx.systemctlCalls(), []);
  });
});

// ───────────── 今の版の突き合わせ ─────────────

test("current と動いている版が食い違っていたら（前の回が途中で止まった）、何も作らずに止まり、直し方を書く", T, async () => {
  await withRelease(async (ctx) => {
    const b = ctx.commit("二つ目");
    assert.equal((await ctx.start(["--now"]).done).code, 0);
    // 動いているのは b のまま、current だけが前の版に戻っている
    rmSync(join(ctx.rel, "current"));
    execFileSync("ln", ["-s", v(ctx.first), join(ctx.rel, "current")]);
    ctx.commit("三つ目");
    const { code } = await ctx.start(["--now"]).done;
    assert.equal(code, 1);
    const s = ctx.state();
    assert.equal(s.failedPhase, "fetch");
    assert.match(s.error, new RegExp(`current（${ctx.first}）と動いている版（${b}）が食い違っています`));
    assert.match(s.error, new RegExp(`ln -sfn ${v(b).replace("/", "\\/")} `));
    assert.deepEqual(ctx.versions(), [ctx.first.slice(0, 12), b.slice(0, 12)].sort());
    assert.equal(ctx.systemctlCalls().length, 1, "食い違ったまま起こし直した");
  });
});

// ───────────── 待つ ─────────────

test("待つ段で host が答えなくても、unit が動いている・起動中なら進まない（「host が答えません」を書いて待ち続ける）", T, async () => {
  for (const shown of ["active/running", "activating/start"]) {
    await withRelease(async (ctx) => {
      const b = ctx.commit("二つ目");
      const [active, sub] = shown.split("/");
      ctx.unitShow("banto-host.service", `ActiveState=${active}\nSubState=${sub}\nNRestarts=NRESTARTS\n`);
      ctx.host.activityDown = true;
      ctx.request(b, "wait");
      const run = ctx.start(["--from-request"]);
      await ctx.waitForState(
        (s) => (s.note ?? "").includes(`banto-host.service は ${shown} なので、答えるまで待ちます`),
        "答えないことが書かれません",
      );
      assert.match(ctx.state().note, /^host が答えません（/);
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(ctx.state().phase, "wait");
      assert.deepEqual(ctx.systemctlCalls(), [], "答えないのを「空いた」とみなして起こし直した");
      ctx.host.activityDown = false;
      const { code, out } = await run.done;
      assert.equal(code, 0, out);
      assert.equal(ctx.state().phase, "done");
      assert.equal(ctx.state().note, undefined, "答えるようになったのに、答えませんが残っている");
      assert.equal(ctx.current(), v(b));
    });
  }
});

test("待つ段で host が答えず、unit も止まっている（inactive・failed）なら、待つものは無いので進む", T, async () => {
  for (const active of ["inactive", "failed"]) {
    await withRelease(async (ctx) => {
      const b = ctx.commit("二つ目");
      ctx.host.activityDown = true;
      ctx.unitShow("banto-host.service", `ActiveState=${active}\nSubState=dead\nNRestarts=0\n`);
      ctx.request(b, "wait");
      const { code, out } = await ctx.start(["--from-request"]).done;
      assert.equal(code, 0, out);
      assert.equal(ctx.state().phase, "done", active);
      assert.equal(ctx.current(), v(b));
    });
  }
});

// ───────────── 起こし直す・確かめる ─────────────

test("起こし直した unit が落ちた（起こし直し中・落ちて起き直した）なら、上限を待たずにすぐ前の版に戻す", T, async () => {
  for (const [crash, shown] of [
    ["", "activating/auto-restart・起こし直された回数 0"],
    ["restarted", "active/running・起こし直された回数 1"],
  ]) {
    await withRelease(async (ctx) => {
      const b = ctx.commit("落ち続ける版", { broken: true });
      ctx.fakeMark("crash", crash);
      const started = Date.now();
      const { code } = await ctx.start(["--now"], { BANTO_UPDATE_VERIFY_TIMEOUT: "60" }).done;
      assert.equal(code, 1);
      assert.ok(Date.now() - started < 15_000, `落ちているのに上限まで待った（${Date.now() - started}ms）`);
      const s = ctx.state();
      assert.equal(s.phase, "rolled-back", JSON.stringify(s));
      assert.equal(s.error, `banto-host.service が落ちました（${shown}）`);
      assert.equal(ctx.current(), v(ctx.first));
      assert.ok(existsSync(join(ctx.rel, v(b))));
    });
  }
});

test("前に落ちたことのある unit（起こし直された回数 3）でも、この restart のあとで落ちていなければ戻さない", T, async () => {
  await withRelease(async (ctx) => {
    const b = ctx.commit("二つ目");
    ctx.fakeMark("nrestarts", "3");
    const { code, out } = await ctx.start(["--now"]).done;
    assert.equal(code, 0, out);
    assert.equal(ctx.state().phase, "done", JSON.stringify(ctx.state()));
    assert.equal(ctx.current(), v(b));
  });
});

test("起こし直しそのものが断られたら（polkit 等）、戻す処理はせず current だけ前に戻し、failedPhase は restart", T, async () => {
  await withRelease(async (ctx) => {
    const b = ctx.commit("二つ目");
    ctx.fakeMark("deny-restart");
    const { code } = await ctx.start(["--now"]).done;
    assert.equal(code, 1);
    const s = ctx.state();
    assert.equal(s.phase, "failed", JSON.stringify(s));
    assert.equal(s.failedPhase, "restart");
    assert.match(s.error, /^起こし直せませんでした（今の版のまま動いています）：.*Interactive authentication required/);
    assert.equal(ctx.current(), v(ctx.first));
    assert.equal(ctx.previous(), null);
    assert.deepEqual(ctx.systemctlCalls(), ["restart banto-host.service banto-frontend.service"], "断られたのに、戻すためにもう一度 restart した");
    assert.ok(existsSync(join(ctx.rel, v(b), "banto", "built.txt")), "組み立てた版は残す");
  });
});

test("画面の口は banto-update.service の定義から読む。分からなければ組み立てる前に断る", T, async () => {
  await withRelease(async (ctx) => {
    const b = ctx.commit("二つ目");
    const r1 = await ctx.start(["--now"], { BANTO_UPDATE_UI_URL: "" }).done;
    assert.equal(r1.code, 1);
    assert.match(ctx.state().error, /画面の口が分かりません/);
    assert.deepEqual(ctx.versions(), [ctx.first.slice(0, 12)]);
    ctx.unitShow("banto-update.service", `Environment=HOME=/home/u BANTO_UPDATE_UI_URL=${ctx.uiUrl}\n`);
    const r2 = await ctx.start(["--now"], { BANTO_UPDATE_UI_URL: "" }).done;
    assert.equal(r2.code, 0, r2.out);
    assert.equal(ctx.current(), v(b));
  });
});

// ───────────── 片づけ ─────────────

test("古い版は、コンテナがまだ mount していれば残す。Incus に届かなければ何も消さない", T, async () => {
  await withRelease(async (ctx) => {
    const firstName = ctx.first.slice(0, 12);
    ctx.instances([join(ctx.rel, v(ctx.first), "banto")]);
    const b = ctx.commit("二つ目");
    assert.equal((await ctx.start(["--now"]).done).code, 0);
    const c = ctx.commit("三つ目");
    assert.equal((await ctx.start(["--now"]).done).code, 0);
    assert.deepEqual(ctx.versions(), [firstName, b.slice(0, 12), c.slice(0, 12)].sort(), "mount されている版を消した");
    assert.match(readFileSync(ctx.state().logFile, "utf8"), /残します：.*（コンテナ banto-p0 がまだ mount しています/);

    // コンテナが付け直した（もう mount していない）——次の回に消える
    ctx.instances([]);
    const d = ctx.commit("四つ目");
    assert.equal((await ctx.start(["--now"]).done).code, 0);
    assert.deepEqual(ctx.versions(), [c.slice(0, 12), d.slice(0, 12)].sort());

    ctx.fakeMark("incus-down");
    const e = ctx.commit("五つ目");
    assert.equal((await ctx.start(["--now"]).done).code, 0);
    assert.equal(ctx.state().phase, "done");
    assert.deepEqual(ctx.versions(), [c.slice(0, 12), d.slice(0, 12), e.slice(0, 12)].sort(), "Incus に聞けないのに消した");
    assert.match(readFileSync(ctx.state().logFile, "utf8"), /Incus に聞けないので、古い版.*は消しません/);
  });
});

test("残っている版（起こし直せなかった・戻した）を頼み直すと、Incus に聞いてから消して作り直す。聞けない・使われているなら断る", T, async () => {
  await withRelease(async (ctx) => {
    const b = ctx.commit("二つ目");
    ctx.fakeMark("deny-restart");
    assert.equal((await ctx.start(["--now"]).done).code, 1);
    assert.ok(existsSync(join(ctx.rel, v(b))));
    rmSync(join(ctx.fake, "deny-restart"));

    ctx.fakeMark("incus-down");
    assert.equal((await ctx.start(["--now"]).done).code, 1);
    assert.match(ctx.state().error, /が残っています.*Incus に聞けないので.*worktree remove --force/);
    rmSync(join(ctx.fake, "incus-down"));

    ctx.instances([join(ctx.rel, v(b), "banto")]);
    assert.equal((await ctx.start(["--now"]).done).code, 1);
    assert.match(ctx.state().error, /コンテナ（banto-p0）がまだ使っています/);

    ctx.instances([]);
    const { code, out } = await ctx.start(["--now"]).done;
    assert.equal(code, 0, out);
    assert.equal(ctx.current(), v(b));
  });
});

// ───────────── 組み立てる前 ─────────────

test("手で消された版の worktree の登録が残っていても、組み立てられる（worktree add の前に prune）", T, async () => {
  await withRelease(async (ctx) => {
    const b = ctx.commit("二つ目");
    git(ctx.dir, "--git-dir", ctx.repo, "fetch", "-q", "origin", "+refs/heads/release:refs/remotes/origin/release");
    git(ctx.dir, "--git-dir", ctx.repo, "worktree", "add", "-q", "--detach", join(ctx.rel, v(b)), b);
    rmSync(join(ctx.rel, v(b)), { recursive: true });
    const { code, out } = await ctx.start(["--now"]).done;
    assert.equal(code, 0, out);
    assert.equal(ctx.current(), v(b));
  });
});

test("空きが今の版の大きさより少なければ、組み立てる前に理由つきで断る", T, async () => {
  await withRelease(async (ctx) => {
    ctx.commit("二つ目");
    const { code } = await ctx.start(["--now"], { BANTO_UPDATE_NEED_BYTES: String(2 ** 62) }).done;
    assert.equal(code, 1);
    const s = ctx.state();
    assert.equal(s.failedPhase, "build");
    assert.match(s.error, /空きが足りません/);
    assert.deepEqual(ctx.versions(), [ctx.first.slice(0, 12)]);
    assert.equal(ctx.worktrees(), 1);
  });
});

// ───────────── 取ってくる ─────────────

const HANGING_REMOTE = { BANTO_UPDATE_REMOTE: "ext::sh -c sleep% 30", GIT_ALLOW_PROTOCOL: "ext" };

test("取ってくるのが返らなければ、上限で止めて失敗にする", T, async () => {
  await withRelease(async (ctx) => {
    const started = Date.now();
    const { code } = await ctx.start(["--now"], { ...HANGING_REMOTE, BANTO_UPDATE_FETCH_TIMEOUT: "1" }).done;
    assert.equal(code, 1);
    assert.ok(Date.now() - started < 10_000, "上限を過ぎても待った");
    assert.equal(ctx.state().failedPhase, "fetch");
    assert.match(ctx.state().error, /1秒で終わりませんでした/);
  });
});

test("取ってくる途中でも cancel でやめられる", T, async () => {
  await withRelease(async (ctx) => {
    const run = ctx.start(["--now"], HANGING_REMOTE);
    await ctx.waitForState(() => /fetch/.test(readFileSync(ctx.state().logFile, "utf8")), "fetch を始めません");
    const started = Date.now();
    ctx.mark("cancel");
    const { code } = await run.done;
    assert.equal(code, 0);
    assert.ok(Date.now() - started < 10_000);
    assert.equal(ctx.state().phase, "cancelled");
  });
});
