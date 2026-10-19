// `scripts/update.mjs` の試験（`node --test scripts/update.test.mjs`）。
//
// GitHub 役はローカルのリポジトリ、組み立ては偽のコマンド、systemctl は偽のスクリプト（restart されたら、そのときの
// `current` を「動いている版」として書く。`show` には unit ごとのファイルの中身を返す）、incus も偽のスクリプト
// （コンテナの一覧はファイルの中身）、host と画面は小さな http サーバ。host は「動いている版」の commit を
// `/api/admin/update` で返し、その版に `banto/BROKEN` があれば答えない（起きない版）。`crash` の印があると、
// 起きない版の host の unit は「落ちて起こし直し中」になる。`record-history` の印があると、restart のたびに host と同じく
// 動いた版の記録（history.json）に起きた版を書く（起きない版でも——本物の host は待ち受けの前に書く）。

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

const IDLE = {
  idle: true,
  onlyWaitingOnHuman: false,
  restartable: true,
  blocking: [],
  continuesAfterRestart: [],
  turns: [],
  awaitingReplies: [],
  moduleReplies: [],
  moduleCalls: [],
};
const TURN = { threadId: "t1", threadTitle: "作業中", startedAt: "2026-10-04T00:00:00Z", hop: 0, queued: 0, waitingOnHuman: false };
const REPLY = { threadId: "t2", threadTitle: "調べもの", module: "subagent", since: "2026-10-04T00:00:00Z" };
const CALL = { threadId: "t1", threadTitle: "作業中", connName: "shell-p1", origin: "turn" };
/** ターンが tool を呼んでいる——呼び出しは切れると結果が分からないので待つ（ターンは起き直したあと続く） */
const BUSY = {
  ...IDLE,
  idle: false,
  restartable: false,
  blocking: [{ kind: "call", waitingOnHuman: false, ...CALL }],
  continuesAfterRestart: [{ kind: "turn", ...TURN }],
  turns: [TURN],
  moduleCalls: [CALL],
};
/** ターンが文を書いている・続けられる Module の仕事が走っている——どれも起き直したあと続くので待たない */
const CONTINUES = {
  ...IDLE,
  idle: false,
  continuesAfterRestart: [
    { kind: "turn", ...TURN },
    { kind: "reply", ...REPLY },
  ],
  turns: [TURN],
  awaitingReplies: [REPLY],
};
/** `restartable` を持たない古い host の答え（2026-10-05 より前） */
const OLD_IDLE = { idle: true, onlyWaitingOnHuman: false, turns: [], awaitingReplies: [], moduleCalls: [] };
const OLD_BUSY = { ...OLD_IDLE, idle: false, turns: [TURN] };

async function withRelease(fn) {
  const dir = mkdtempSync(join(tmpdir(), "banto-update-test-"));
  const github = join(dir, "github");
  const rel = join(dir, "release");
  const dataDir = join(dir, "data");
  const fake = join(dir, "fake");
  const updateDir = join(dataDir, "update");
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
  n=$(grep -c '^restart' "$F/systemctl.log")
  if [ -f "${updateDir}/history.json" ]; then cp "${updateDir}/history.json" "$F/history-at-restart-$n"; fi
  if [ -e "$F/record-history" ]; then "${process.execPath}" "$F/record.mjs" "${updateDir}/history.json" "$(git -C "$running" rev-parse HEAD)"; fi
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
  // host が起動の途中で書くのと同じ：起きた版を先頭に（もうあれば lastStartedAt を替える）。記録が無ければ previous を種に
  writeFileSync(
    join(fake, "record.mjs"),
    `import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
const [path, commit] = process.argv.slice(2);
let versions = [];
if (existsSync(path)) versions = JSON.parse(readFileSync(path, "utf8")).versions;
else if (existsSync(${JSON.stringify(join(rel, "previous"))})) {
  const prev = execFileSync("git", ["-C", ${JSON.stringify(join(rel, "previous"))}, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (prev !== commit) versions = [{ commit: prev, firstStartedAt: null, lastStartedAt: null }];
}
const at = new Date().toISOString();
const old = versions.find((v) => v.commit === commit);
versions = [{ commit, firstStartedAt: old ? old.firstStartedAt : at, lastStartedAt: at }, ...versions.filter((v) => v.commit !== commit)];
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path + ".tmp", JSON.stringify({ versions }));
renameSync(path + ".tmp", path);
`,
  );

  // 偽の incus：コンテナの一覧は fake/instances.json（無ければ空）。`incus-down` の印があれば届かない
  const incus = join(fake, "incus");
  writeFileSync(
    incus,
    `#!/bin/sh
F="${fake}"
if [ -e "$F/incus-down" ]; then echo "Error: Failed to connect to local daemon" >&2; exit 1; fi
if [ -e "$F/incus-slow" ] && [ "$1" = query ]; then sleep 2; fi
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
  const host = { activity: IDLE, activityCalls: 0, activityDown: false, activityStatus: undefined, uiStatus: 200 };
  const hostServer = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end();
    if (req.url === "/api/admin/activity") {
      host.activityCalls++;
      if (host.activityDown) return req.socket.destroy();
      if (host.activityStatus) return res.writeHead(host.activityStatus).end();
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
  const uiServer = createServer((_req, res) => res.writeHead(host.uiStatus).end("ok"));
  await new Promise((r) => hostServer.listen(0, "127.0.0.1", r));
  await new Promise((r) => uiServer.listen(0, "127.0.0.1", r));

  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ dataDir, releaseDir: rel, port: hostServer.address().port, authToken: TOKEN }),
  );
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
    request(commitSha, mode, extra = {}) {
      mkdirSync(updateDir, { recursive: true });
      writeFileSync(
        join(updateDir, "request.json"),
        JSON.stringify({ id: `req-${commitSha.slice(0, 7)}`, commit: commitSha, mode, requestedBy: { sessionId: "s1", label: "わたし" }, ...extra }),
      );
    },
    /** 動いた版の記録の commit（新しい順） */
    history: () => JSON.parse(readFileSync(join(updateDir, "history.json"), "utf8")).versions.map((x) => x.commit),
    /** 動いた版の記録を置く（並べた順が新しい順） */
    writeHistory(commits) {
      mkdirSync(updateDir, { recursive: true });
      const at = (i) => new Date(Date.UTC(2026, 9, 19, 12, 0, 0) - i * 60_000).toISOString();
      writeFileSync(
        join(updateDir, "history.json"),
        JSON.stringify({ versions: commits.map((c, i) => ({ commit: c, firstStartedAt: at(i), lastStartedAt: at(i) })) }),
      );
    },
    /** 組み立てた回数（BUILD_WITH_MARKS で組み立てたとき） */
    builds: () => (existsSync(join(fake, "builds")) ? readFileSync(join(fake, "builds"), "utf8").trim().split("\n").length : 0),
    /** 組み立てた印（banto/node_modules・packages/core/dist・apps/frontend/.next）を作り、回数を数える組み立て */
    buildWithMarks: { BANTO_UPDATE_BUILD: `mkdir -p node_modules packages/core/dist apps/frontend/.next && echo built > built.txt && echo x >> '${join(fake, "builds")}'` },
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
    /** 偽の systemctl・incus への印（deny-restart・crash（中身が restarted なら「落ちて起き直した」）・incus-down・incus-slow） */
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
    // 書くのは待つもの（切れると結果が分からないもの）と、起き直したあと続くものの数
    assert.deepEqual(ctx.state().waiting, { blocking: [{ kind: "call", waitingOnHuman: false, ...CALL }], continuing: 1 });
    assert.equal(ctx.state().phase, "wait");
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

test("ターンと続けられる仕事が動いていても、途中で切れるもの（実行中の呼び出し）が無ければ待たずに起こし直す", T, async () => {
  await withRelease(async (ctx) => {
    const b = ctx.commit("二つ目");
    ctx.host.activity = CONTINUES;
    ctx.request(b, "wait");
    const { code, out } = await ctx.start(["--from-request"]).done;
    assert.equal(code, 0, out);
    const s = ctx.state();
    assert.equal(s.phase, "done", JSON.stringify(s));
    assert.equal(ctx.current(), v(b));
    assert.deepEqual(ctx.systemctlCalls(), ["restart banto-host.service banto-frontend.service"]);
    assert.ok(ctx.host.activityCalls >= 1, "host に聞いていない");
    assert.match(readFileSync(s.logFile, "utf8"), /途中で切れるものはありません（起き直したあと続くもの 2 件）/);
  });
});

test("実行中の呼び出しを待ち、終われば（ターンがまだ走っていても）起こし直す", T, async () => {
  await withRelease(async (ctx) => {
    const b = ctx.commit("二つ目");
    ctx.host.activity = BUSY;
    ctx.request(b, "wait");
    const run = ctx.start(["--from-request"]);
    await ctx.waitForPhase("wait");
    const deadline = Date.now() + 5000;
    while (!ctx.state().waiting && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.equal(ctx.state().waiting.blocking.length, 1);
    assert.deepEqual(ctx.systemctlCalls(), [], "呼び出しが実行中なのに起こし直した");
    // 呼び出しが終わった（ターンは文を書いている）
    ctx.host.activity = { ...BUSY, restartable: true, blocking: [], moduleCalls: [] };
    const { code, out } = await run.done;
    assert.equal(code, 0, out);
    assert.equal(ctx.state().phase, "done");
    assert.equal(ctx.state().waiting, undefined);
    assert.deepEqual(ctx.systemctlCalls(), ["restart banto-host.service banto-frontend.service"]);
  });
});

test("restartable を持たない古い host には、今どおり全部空く（idle）まで待つ。残りはターンも待つものとして書く", T, async () => {
  await withRelease(async (ctx) => {
    const b = ctx.commit("二つ目");
    ctx.host.activity = OLD_BUSY;
    ctx.request(b, "wait");
    const run = ctx.start(["--from-request"]);
    await ctx.waitForPhase("wait");
    const deadline = Date.now() + 5000;
    while (!ctx.state().waiting && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(ctx.state().waiting, { blocking: [{ kind: "turn", ...TURN }], continuing: 0 });
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(ctx.systemctlCalls(), [], "古い host でターンが走っているのに起こし直した");
    ctx.host.activity = OLD_IDLE;
    const { code, out } = await run.done;
    assert.equal(code, 0, out);
    assert.equal(ctx.state().phase, "done");
    assert.deepEqual(ctx.systemctlCalls(), ["restart banto-host.service banto-frontend.service"]);
  });
});

test("--wait-timeout：待つ段が上限を越えたら、やめるのと同じに片づけて cancelled（note に理由）", T, async () => {
  await withRelease(async (ctx) => {
    const b = ctx.commit("二つ目");
    ctx.host.activity = BUSY;
    const started = Date.now();
    const { code, out } = await ctx.start(["--wait-timeout", "0.02"]).done;
    assert.equal(code, 0, out);
    assert.ok(Date.now() - started >= 1200, "上限（1.2秒）より前にやめた");
    const s = ctx.state();
    assert.equal(s.phase, "cancelled", JSON.stringify(s));
    assert.equal(s.note, "待つ上限（0.02 分）を超えたのでやめました");
    assert.equal(s.waiting, undefined);
    assert.equal(ctx.current(), v(ctx.first));
    assert.equal(existsSync(join(ctx.rel, v(b))), false, "作った版を消していない");
    assert.deepEqual(ctx.systemctlCalls(), []);
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
    const started = Date.now();
    const { code, out } = await ctx.start(["--from-request"]).done;
    assert.equal(code, 3);
    assert.ok(Date.now() - started < 3000, "走っている回（終わりの状態でない）なのに、外れるのを待った");
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

test("終わりの状態（done）は古い版を片づけてから書く——片づけの間は note に出し、done を見てすぐ打ち直しても断られない", T, async () => {
  await withRelease(async (ctx) => {
    const firstName = ctx.first.slice(0, 12);
    ctx.commit("二つ目");
    assert.equal((await ctx.start(["--now"]).done).code, 0);
    const c = ctx.commit("三つ目");
    ctx.fakeMark("incus-slow"); // 片づけ（Incus に聞く）に2秒かかる
    const run = ctx.start(["--now"]);
    await ctx.waitForState((s) => s.note === "古い版を片づけています", "片づけていることが書かれません");
    assert.equal(ctx.state().phase, "verify", "片づけの前に終わりの状態を書いた");
    await ctx.waitForPhase("done");
    assert.ok(!ctx.versions().includes(firstName), "done を書いたのに、まだ片づけ終わっていない");
    assert.equal(ctx.state().note, undefined);
    rmSync(join(ctx.fake, "incus-slow"));
    const d = ctx.commit("四つ目");
    const again = ctx.start(["--now"]); // done を見てすぐ打つ
    const r = await again.done;
    assert.equal(r.code, 0, `done を見てから打ったのに断られた：${r.out}`);
    assert.equal((await run.done).code, 0);
    assert.equal(ctx.current(), v(d));
    assert.ok(ctx.versions().includes(c.slice(0, 12)));
  });
});

test("lock を持つ回が終わりの状態を書いたあと（lock を外す前）に打たれた回は、断らずに外れるのを待つ。終わっていない回なら断る", T, async () => {
  await withRelease(async (ctx) => {
    const b = ctx.commit("二つ目");
    mkdirSync(ctx.updateDir, { recursive: true });
    const lock = join(ctx.updateDir, "lock");
    // 1秒後に lock を外して終わる「前の回」
    const holder = spawn("sh", ["-c", `sleep 1; rm -f '${lock}'`], { stdio: "ignore" });
    writeFileSync(lock, String(holder.pid));
    writeFileSync(join(ctx.updateDir, "state.json"), JSON.stringify({ id: "前の回", phase: "done" }));
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

// ───────────── 組み立て済みを使う（scripts/prebuilt.mjs、アーキ仕様 §2.5「組み立て済みのものを使う」） ─────────────
//
// GitHub 役は小さな http サーバ：`/dl/build-<頭12>/<ファイル>` に組み立て済みと .sha256 を置き、`/runs` が回の一覧を返す。
// 組み立て済みは試験の中で作る（banto/node_modules と印のファイル。workspace のリンク `node_modules/@banto/core` も入れる）。
// その場で組み立てに落ちたかは、偽の組み立て（built.txt）で見分ける

import { zstdCompressSync } from "node:zlib";
import { createHash } from "node:crypto";
import { symlinkSync } from "node:fs";

/** 組み立て済みの tar.zst を作る。`tweak(dir)` で中身を壊せる。返すのは中身のバイト列 */
function makePrebuilt(dir, commitSha, { marker = {}, tweak } = {}) {
  const src = mkdtempSync(join(dir, "pb-src-"));
  mkdirSync(join(src, "banto", "node_modules", "foo"), { recursive: true });
  mkdirSync(join(src, "banto", "node_modules", "@banto"), { recursive: true });
  writeFileSync(join(src, "banto", "node_modules", "foo", "index.js"), "module.exports = 1;\n");
  symlinkSync("../../packages/core", join(src, "banto", "node_modules", "@banto", "core"));
  writeFileSync(
    join(src, "banto", ".banto-prebuilt.json"),
    JSON.stringify({
      commit: commitSha,
      platform: "linux-x64",
      node: process.versions.node,
      builtAt: "2026-10-16T00:00:00Z",
      run: "https://github.com/o/r/actions/runs/1",
      ...marker,
    }),
  );
  tweak?.(join(src, "banto"));
  // 読めないフォルダ（mode 000）は tar -c が中を読めないので、権限を戻して中身を取り、tar の中でだけ 000 にする
  // （GNU tar の --mode は全体に効くので、そのフォルダだけを別の tar にしてつなぐ）
  const locked = join(src, "banto", "node_modules", "locked");
  if (existsSync(locked)) {
    chmodSync(locked, 0o755);
    const t1 = execFileSync("tar", ["-C", src, "--exclude=banto/node_modules/locked", "-cf", "-", "banto"], { maxBuffer: 1 << 26 });
    const t2 = execFileSync("tar", ["-C", src, "--mode=a-rwx", "--no-recursion", "-cf", "-", "banto/node_modules/locked"], { maxBuffer: 1 << 26 });
    const t3 = execFileSync("tar", ["-C", src, "-cf", "-", "banto/node_modules/locked/x"], { maxBuffer: 1 << 26 });
    rmSync(src, { recursive: true, force: true });
    const strip = (t) => t.subarray(0, endOfArchive(t));
    return zstdCompressSync(Buffer.concat([strip(t1), strip(t2), strip(t3), Buffer.alloc(1024)]));
  }
  const tar = execFileSync("tar", ["-C", src, "-cf", "-", "banto"], { maxBuffer: 1 << 26 });
  rmSync(src, { recursive: true, force: true });
  return zstdCompressSync(tar);
}

/** tar の中身の終わり（最初の 0 だけのヘッダの位置） */
function endOfArchive(t) {
  for (let off = 0; off + 512 <= t.length; ) {
    const header = t.subarray(off, off + 512);
    if (header.every((x) => x === 0)) return off;
    const size = parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim() || "0", 8);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return t.length;
}

/** GitHub 役。`gh.assets` に置いたものを配り、`gh.runs` を回の一覧として返す。`gh.slow` なら少しずつ返す */
async function withGithub(fn) {
  const gh = { assets: new Map(), runs: [], heads: 0, apiCalls: 0, slow: false, apiStatus: 0 };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/runs") {
      gh.apiCalls++;
      if (gh.apiStatus) return res.writeHead(gh.apiStatus, { "x-ratelimit-remaining": "0" }).end();
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ workflow_runs: gh.runs }));
    }
    const body = gh.assets.get(url.pathname);
    if (req.method === "HEAD") gh.heads++;
    if (!body) return res.writeHead(404).end();
    res.writeHead(200, { "content-length": body.length });
    if (req.method === "HEAD") return res.end();
    if (!gh.slow) return res.end(body);
    let i = 0;
    const timer = setInterval(() => {
      if (res.destroyed) return clearInterval(timer);
      res.write(body.subarray(i, i + 64));
      i += 64;
      if (i >= body.length) {
        clearInterval(timer);
        res.end();
      }
    }, 100);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  gh.env = { BANTO_UPDATE_PREBUILT_BASE: `${base}/dl`, BANTO_UPDATE_GITHUB_API: `${base}/runs`, BANTO_UPDATE_PREBUILT_POLL_MS: "200" };
  /** その commit の組み立て済みを置く（`sum` で .sha256 の中身を差し替えられる） */
  gh.publish = (commitSha, bytes, { sum, sumLine } = {}) => {
    const name = `banto-${commitSha}-linux-x64.tar.zst`;
    const dir = `/dl/build-${commitSha.slice(0, 12)}`;
    gh.assets.set(`${dir}/${name}`, bytes);
    const hex = sum ?? createHash("sha256").update(bytes).digest("hex");
    gh.assets.set(`${dir}/${name}.sha256`, Buffer.from(sumLine?.(hex, name) ?? `${hex}  ${name}\n`));
  };
  try {
    await fn(gh);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

/** 版のフォルダに作業フォルダが残っていない */
const noWorkDirs = (ctx) => readdirSync(join(ctx.rel, "versions")).filter((n) => n.startsWith(".prebuilt-"));

test("組み立て済み：あれば取ってきて重ね、その場では組み立てない（workspace のリンクも通す・作業フォルダを残さない）", T, async () => {
  await withRelease(async (ctx) => {
    await withGithub(async (gh) => {
      const b = ctx.commit("二つ目");
      gh.publish(b, makePrebuilt(ctx.dir, b));
      const { code, out } = await ctx.start(["--now"], { ...gh.env, BANTO_UPDATE_BUILD: "echo 組み立ててはいけない >&2; exit 9" }).done;
      assert.equal(code, 0, out);
      const s = ctx.state();
      assert.equal(s.phase, "done", JSON.stringify(s));
      assert.equal(s.prebuilt?.status, "used");
      assert.equal(s.prebuilt?.run, "https://github.com/o/r/actions/runs/1");
      assert.equal(ctx.current(), v(b));
      const banto = join(ctx.rel, "current", "banto");
      assert.equal(readFileSync(join(banto, "node_modules", "foo", "index.js"), "utf8"), "module.exports = 1;\n");
      assert.equal(readlinkSync(join(banto, "node_modules", "@banto", "core")), "../../packages/core");
      assert.equal(readFileSync(join(banto, "README"), "utf8"), "v2\n", "git が管理するファイルが変わった");
      assert.equal(git(join(ctx.rel, "current"), "status", "--porcelain", "--untracked-files=no"), "", "管理しているファイルが書き換わった");
      assert.deepEqual(noWorkDirs(ctx), []);
      assert.match(readFileSync(s.logFile, "utf8"), /組み立て済みの版を重ねました/);
    });
  });
});

for (const [name, setup, reason] of [
  ["sha256 が合わない", (gh, b, dir) => gh.publish(b, makePrebuilt(dir, b), { sum: "0".repeat(64) }), /sha256 が合いません/],
  [
    "banto/ の外を指すリンクがある",
    (gh, b, dir) => gh.publish(b, makePrebuilt(dir, b, { tweak: (d) => symlinkSync("../../../../etc", join(d, "node_modules", "evil")) })),
    /banto\/ の外を指すリンク/,
  ],
  [
    "絶対パスを指すリンクがある",
    (gh, b, dir) => gh.publish(b, makePrebuilt(dir, b, { tweak: (d) => symlinkSync("/etc/passwd", join(d, "node_modules", "evil")) })),
    /絶対パスを指すリンク/,
  ],
  [
    "決めた場所の外のファイルがある",
    (gh, b, dir) => gh.publish(b, makePrebuilt(dir, b, { tweak: (d) => writeFileSync(join(d, "README"), "すり替え\n") })),
    /決めた場所の外/,
  ],
  ["印の commit が違う", (gh, b, dir) => gh.publish(b, makePrebuilt(dir, b, { marker: { commit: "f".repeat(40) } })), /印の commit/],
  ["印の platform が違う", (gh, b, dir) => gh.publish(b, makePrebuilt(dir, b, { marker: { platform: "linux-arm64" } })), /platform/],
  [
    "FIFO（ファイル・フォルダ・リンク以外）がある",
    (gh, b, dir) => gh.publish(b, makePrebuilt(dir, b, { tweak: (d) => execFileSync("mkfifo", [join(d, "node_modules", "pipe")]) })),
    /デバイス等/,
  ],
  [
    "packages/modules/dist（決めた場所ではない）がある",
    (gh, b, dir) =>
      gh.publish(b, makePrebuilt(dir, b, { tweak: (d) => (mkdirSync(join(d, "packages", "modules", "dist"), { recursive: true }), writeFileSync(join(d, "packages", "modules", "dist", "x.js"), "")) })),
    /決めた場所の外/,
  ],
  [
    "移す単位の根（.next）が symlink",
    (gh, b, dir) =>
      gh.publish(b, makePrebuilt(dir, b, { tweak: (d) => (mkdirSync(join(d, "apps", "frontend"), { recursive: true }), symlinkSync("../../node_modules", join(d, "apps", "frontend", ".next"))) })),
    /根がフォルダではありません/,
  ],
  [
    "読めないフォルダ（mode 000）がある——思わぬ失敗も、その場で組み立てる道に落とす",
    (gh, b, dir) => gh.publish(b, makePrebuilt(dir, b, { tweak: (d) => (mkdirSync(join(d, "node_modules", "locked", "x"), { recursive: true }), chmodSync(join(d, "node_modules", "locked"), 0o000)) })),
    /思わぬ失敗|EACCES/,
  ],
  [
    "版のフォルダに無い場所（packages/nope）に dist がある——先に移したものを巻き戻す",
    (gh, b, dir) =>
      gh.publish(b, makePrebuilt(dir, b, { tweak: (d) => (mkdirSync(join(d, "packages", "nope", "dist"), { recursive: true }), writeFileSync(join(d, "packages", "nope", "dist", "x.js"), "")) })),
    /packages\/nope がありません/,
  ],
  ["印の node の major が違う", (gh, b, dir) => gh.publish(b, makePrebuilt(dir, b, { marker: { node: "1.0.0" } })), /major が違います/],
  ["印の run の形が違う", (gh, b, dir) => gh.publish(b, makePrebuilt(dir, b, { marker: { run: "https://evil.example/x" } })), /run の形/],
  [".sha256 のファイル名が違う", (gh, b, dir) => gh.publish(b, makePrebuilt(dir, b), { sumLine: (hex) => `${hex}  other.tar.zst\n` }), /\.sha256 の書式/],
  [".sha256 の書式が違う", (gh, b, dir) => gh.publish(b, makePrebuilt(dir, b), { sumLine: (hex) => `sha256:${hex}\n` }), /\.sha256 の書式/],
]) {
  test(`組み立て済み：${name}なら使わず、その場で組み立てる（重ねかけたものも作業フォルダも残さない）`, T, async () => {
    await withRelease(async (ctx) => {
      await withGithub(async (gh) => {
        const b = ctx.commit("二つ目");
        setup(gh, b, ctx.dir);
        const { code, out } = await ctx.start(["--now"], gh.env).done;
        assert.equal(code, 0, out);
        const s = ctx.state();
        assert.equal(s.phase, "done", JSON.stringify(s));
        assert.equal(s.prebuilt?.status, "skipped");
        assert.match(s.prebuilt?.reason ?? "", reason);
        const banto = join(ctx.rel, "current", "banto");
        assert.equal(readFileSync(join(banto, "built.txt"), "utf8"), "built\n", "その場で組み立てていない");
        assert.equal(existsSync(join(banto, "node_modules")), false, "使わない組み立て済みが重なっている");
        assert.equal(readFileSync(join(banto, "README"), "utf8"), "v2\n");
        assert.deepEqual(noWorkDirs(ctx), []);
      });
    });
  });
}

test("組み立て済み：GitHub で組み立て中なら待ち、出来上がったら使う（待つ間は state に waiting）", T, async () => {
  await withRelease(async (ctx) => {
    await withGithub(async (gh) => {
      const b = ctx.commit("二つ目");
      gh.runs = [{ run_number: 1, run_attempt: 1, status: "in_progress", conclusion: null }];
      const run = ctx.start(["--now"], gh.env);
      await ctx.waitForState((s) => s.prebuilt?.status === "waiting", "組み立て中を待ちません");
      assert.match(ctx.state().note ?? "", /GitHub で組み立て中です/);
      gh.publish(b, makePrebuilt(ctx.dir, b));
      const { code, out } = await run.done;
      assert.equal(code, 0, out);
      assert.equal(ctx.state().prebuilt?.status, "used");
      assert.equal(existsSync(join(ctx.rel, "current", "banto", "built.txt")), false);
    });
  });
});

test("組み立て済み：回の一覧で、待っている回が cancelled になっても走っている回があれば待つ（concurrency）", T, async () => {
  await withRelease(async (ctx) => {
    await withGithub(async (gh) => {
      const b = ctx.commit("二つ目");
      gh.runs = [
        { run_number: 3, run_attempt: 1, status: "completed", conclusion: "cancelled" },
        { run_number: 2, run_attempt: 1, status: "in_progress", conclusion: null },
      ];
      const run = ctx.start(["--now"], gh.env);
      await ctx.waitForState((s) => s.prebuilt?.status === "waiting", "走っている回を待ちません");
      gh.publish(b, makePrebuilt(ctx.dir, b));
      assert.equal((await run.done).code, 0);
      assert.equal(ctx.state().prebuilt?.status, "used");
    });
  });
});

for (const [name, runs, reason] of [
  ["GitHub でテストが落ちた", [{ run_number: 1, status: "completed", conclusion: "failure", html_url: "https://github.com/o/r/actions/runs/9" }], /テストか組み立てが落ちています/],
  ["GitHub の回が止められた", [{ run_number: 1, status: "completed", conclusion: "cancelled" }], /途中で止まりました/],
  ["成功した回があるのにファイルが無い（消された）", [{ run_number: 1, status: "completed", conclusion: "success" }], /消された/],
  ["GitHub で組み立てられていない（聞き直しても回が無い）", [], /組み立てられていません/],
]) {
  test(`組み立て済み：${name}なら、待たずにその場で組み立てる`, T, async () => {
    await withRelease(async (ctx) => {
      await withGithub(async (gh) => {
        ctx.commit("二つ目");
        gh.runs = runs;
        const { code, out } = await ctx.start(["--now"], gh.env).done;
        assert.equal(code, 0, out);
        const s = ctx.state();
        assert.equal(s.prebuilt?.status, "skipped");
        assert.match(s.prebuilt?.reason ?? "", reason);
        assert.equal(readFileSync(join(ctx.rel, "current", "banto", "built.txt"), "utf8"), "built\n");
      });
    });
  });
}

test("組み立て済み：待つ上限を越えたら、その場で組み立てる", T, async () => {
  await withRelease(async (ctx) => {
    await withGithub(async (gh) => {
      ctx.commit("二つ目");
      gh.runs = [{ run_number: 1, status: "queued", conclusion: null }];
      const { code } = await ctx.start(["--now"], { ...gh.env, BANTO_UPDATE_PREBUILT_WAIT: "1" }).done;
      assert.equal(code, 0);
      assert.match(ctx.state().prebuilt?.reason ?? "", /待ちましたが出来ません/);
      assert.equal(existsSync(join(ctx.rel, "current", "banto", "built.txt")), true);
    });
  });
});

test("組み立て済み：組み立て中を待つ間に cancel でやめられる（版も作業フォルダも残さない）", T, async () => {
  await withRelease(async (ctx) => {
    await withGithub(async (gh) => {
      const b = ctx.commit("二つ目");
      gh.runs = [{ run_number: 1, status: "in_progress", conclusion: null }];
      const run = ctx.start(["--now"], gh.env);
      await ctx.waitForState((s) => s.prebuilt?.status === "waiting", "待ちません");
      ctx.mark("cancel");
      const { code } = await run.done;
      assert.equal(code, 0);
      assert.equal(ctx.state().phase, "cancelled");
      assert.equal(ctx.current(), v(ctx.first));
      assert.equal(existsSync(join(ctx.rel, v(b))), false, "作りかけが残っている");
      assert.deepEqual(noWorkDirs(ctx), []);
      assert.deepEqual(ctx.systemctlCalls(), []);
    });
  });
});

test("組み立て済み：取ってくる途中でも cancel でやめられる（作業フォルダを残さない）", T, async () => {
  await withRelease(async (ctx) => {
    await withGithub(async (gh) => {
      const b = ctx.commit("二つ目");
      // 少しずつ返すので、取ってくるのに数秒かかる大きさにする（中身は使わない）
      gh.publish(b, Buffer.concat([makePrebuilt(ctx.dir, b), Buffer.alloc(64 * 200)]));
      gh.slow = true;
      const run = ctx.start(["--now"], gh.env);
      await ctx.waitForState((s) => s.prebuilt?.status === "downloading", "取ってきません");
      ctx.mark("cancel");
      const { code } = await run.done;
      assert.equal(code, 0);
      assert.equal(ctx.state().phase, "cancelled");
      assert.equal(existsSync(join(ctx.rel, v(b))), false);
      assert.deepEqual(noWorkDirs(ctx), []);
    });
  });
});

test("組み立て済み：前の回が殺されて残した作業フォルダは、次の回の初めに消す。古い版の片づけは触らない", T, async () => {
  await withRelease(async (ctx) => {
    await withGithub(async (gh) => {
      mkdirSync(join(ctx.rel, "versions", ".prebuilt-old", "x"), { recursive: true });
      const b = ctx.commit("二つ目");
      gh.publish(b, makePrebuilt(ctx.dir, b));
      assert.equal((await ctx.start(["--now"], gh.env).done).code, 0);
      assert.deepEqual(noWorkDirs(ctx), []);
      assert.match(readFileSync(ctx.state().logFile, "utf8"), /前の回の作業フォルダを消します：\.prebuilt-old/);
    });
  });
});

test("組み立て済み：--no-prebuilt なら取りに行かない", T, async () => {
  await withRelease(async (ctx) => {
    await withGithub(async (gh) => {
      const b = ctx.commit("二つ目");
      gh.publish(b, makePrebuilt(ctx.dir, b));
      assert.equal((await ctx.start(["--now", "--no-prebuilt"], gh.env).done).code, 0);
      assert.equal(ctx.state().prebuilt?.status, "skipped");
      assert.equal(gh.heads, 0, "取りに行った");
      assert.equal(existsSync(join(ctx.rel, "current", "banto", "built.txt")), true);
    });
  });
});

test("組み立て済み：取り込み元が GitHub でなければ取りに行かない（今までの試験の形）", T, async () => {
  await withRelease(async (ctx) => {
    ctx.commit("二つ目");
    assert.equal((await ctx.start(["--now"]).done).code, 0);
    assert.match(ctx.state().prebuilt?.reason ?? "", /GitHub ではありません/);
  });
});

test("組み立て済み：巻き戻し——重ねる途中で落ちたら、先に移した node_modules も版のフォルダに残さない", T, async () => {
  await withRelease(async (ctx) => {
    await withGithub(async (gh) => {
      const b = ctx.commit("二つ目");
      gh.publish(
        b,
        makePrebuilt(ctx.dir, b, {
          tweak: (d) => (mkdirSync(join(d, "packages", "nope", "dist"), { recursive: true }), writeFileSync(join(d, "packages", "nope", "dist", "x.js"), "")),
        }),
      );
      assert.equal((await ctx.start(["--now"], { ...gh.env, BANTO_UPDATE_BUILD: "ls node_modules > ls.txt 2>&1; echo built > built.txt" }).done).code, 0);
      const banto = join(ctx.rel, "current", "banto");
      assert.match(readFileSync(join(banto, "ls.txt"), "utf8"), /No such file/, "巻き戻していない（組み立ての前に node_modules があった）");
      assert.equal(existsSync(join(banto, "packages")), false);
    });
  });
});

test("組み立て済み：API が回数制限（403）で、まだ組み立て中と分かっていなければ待たずにその場で組み立てる", T, async () => {
  await withRelease(async (ctx) => {
    await withGithub(async (gh) => {
      ctx.commit("二つ目");
      gh.apiStatus = 403;
      assert.equal((await ctx.start(["--now"], gh.env).done).code, 0);
      assert.match(ctx.state().prebuilt?.reason ?? "", /回数制限（403/);
      assert.equal(existsSync(join(ctx.rel, "current", "banto", "built.txt")), true);
    });
  });
});

test("組み立て済み：組み立て中と分かったあと API が回数制限になっても、ファイルが出来るまで待って使う", T, async () => {
  await withRelease(async (ctx) => {
    await withGithub(async (gh) => {
      const b = ctx.commit("二つ目");
      gh.runs = [{ run_number: 1, status: "in_progress", conclusion: null }];
      const run = ctx.start(["--now"], gh.env);
      await ctx.waitForState((s) => s.prebuilt?.status === "waiting", "待ちません");
      gh.apiStatus = 403;
      const calls = gh.apiCalls;
      await ctx.waitForState(() => gh.apiCalls > calls, "API に聞き直しません", 5_000);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(ctx.state().phase, "build", "回数制限で待つのをやめた");
      gh.publish(b, makePrebuilt(ctx.dir, b));
      assert.equal((await run.done).code, 0);
      assert.equal(ctx.state().prebuilt?.status, "used");
    });
  });
});

test("組み立て済み：取ってくるのが上限で終わらなければ、その場で組み立てる（作業フォルダを残さない）", T, async () => {
  await withRelease(async (ctx) => {
    await withGithub(async (gh) => {
      const b = ctx.commit("二つ目");
      gh.publish(b, Buffer.concat([makePrebuilt(ctx.dir, b), Buffer.alloc(64 * 200)]));
      gh.slow = true;
      assert.equal((await ctx.start(["--now"], { ...gh.env, BANTO_UPDATE_PREBUILT_TIMEOUT: "1" }).done).code, 0);
      assert.match(ctx.state().prebuilt?.reason ?? "", /秒で終わりませんでした/);
      assert.equal(existsSync(join(ctx.rel, "current", "banto", "built.txt")), true);
      assert.deepEqual(noWorkDirs(ctx), []);
    });
  });
});

test("組み立て済み：prebuilt.mjs が無ければその場で組み立て、壊れていれば止める（黙って組み立てに落とさない）", T, async () => {
  await withRelease(async (ctx) => {
    await withGithub(async (gh) => {
      const copy = join(ctx.dir, "scripts-copy");
      mkdirSync(copy);
      writeFileSync(join(copy, "update.mjs"), readFileSync(SCRIPT));
      const runCopy = (env) =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, [join(copy, "update.mjs"), "--now"], {
            env: {
              ...process.env,
              BANTO_CONFIG_PATH: ctx.configPath,
              BANTO_UPDATE_SYSTEMCTL: join(ctx.fake, "systemctl"),
              BANTO_UPDATE_INCUS: join(ctx.fake, "incus"),
              BANTO_UPDATE_UI_URL: ctx.uiUrl,
              BANTO_UPDATE_BUILD: "echo built > built.txt",
              BANTO_UPDATE_VERIFY_TIMEOUT: "2",
              BANTO_UPDATE_INTERVAL: "0.1",
              BANTO_UPDATE_MARK_INTERVAL: "0.05",
              ...env,
            },
            stdio: "ignore",
          });
          child.on("exit", (code) => resolve(code));
        });
      ctx.commit("二つ目");
      assert.equal(await runCopy(gh.env), 0);
      assert.match(ctx.state().prebuilt?.reason ?? "", /prebuilt\.mjs）がありません/);
      writeFileSync(join(copy, "prebuilt.mjs"), "export const = ;\n");
      ctx.commit("三つ目");
      assert.equal(await runCopy(gh.env), 1);
      assert.equal(ctx.state().phase, "failed");
      assert.match(ctx.state().error ?? "", /prebuilt\.mjs）が壊れています/);
    });
  });
});

test("組み立て済み：印の確かめ（node の major）と origin の読み方（scripts/prebuilt.mjs を直に）", async () => {
  const m = await import(join(dirname(SCRIPT), "prebuilt.mjs"));
  const commit = "a".repeat(40);
  const mk = { commit, platform: "linux-x64", node: "24.1.0", run: "https://github.com/o/r/actions/runs/5" };
  assert.doesNotThrow(() => m.checkMarker(mk, commit, { nodeVersion: "24.21.0" }));
  assert.throws(() => m.checkMarker(mk, commit, { nodeVersion: "22.1.0" }), /major が違います/);
  // 前の印（AVX2 の印つき）でも、CPU は見ない——AVX2 に頼っていた opencode は依存から外した
  assert.doesNotThrow(() => m.checkMarker({ ...mk, cpu: { avx2: true } }, commit, { nodeVersion: "24.21.0" }));
  for (const [url, want] of [
    ["git@github.com:o/r.git", "o/r"],
    ["git@github.com:o/r", "o/r"],
    ["ssh://git@github.com/o/r.git", "o/r"],
    ["ssh://git@github.com:22/o/r", "o/r"],
    ["https://github.com/o/r.git", "o/r"],
    ["https://github.com/o/r/", "o/r"],
    ["https://gitlab.com/o/r.git", undefined],
    ["git@gitlab.com:o/r.git", undefined],
    ["/srv/git/banto", undefined],
    [undefined, undefined],
  ]) {
    assert.equal(m.githubRepoOf(url), want, String(url));
  }
});

// ───────────── 前の版に戻す（kind rollback・--rollback）─────────────

/** a（最初の版）→ b → c と、組み立てた印つきで上げる（restart のたびに host と同じく記録を書く） */
async function upToC(ctx) {
  ctx.fakeMark("record-history");
  const b = ctx.commit("二つ目");
  assert.equal((await ctx.start(["--now"], ctx.buildWithMarks).done).code, 0);
  const c = ctx.commit("三つ目");
  assert.equal((await ctx.start(["--now"], ctx.buildWithMarks).done).code, 0);
  assert.deepEqual(ctx.history(), [c, b, ctx.first]);
  assert.equal(ctx.builds(), 2);
  return { b, c };
}

test("戻す：記録にある機械の版はそのまま使う——組み立てない・取ってこない（GitHub に届かなくても）・空きを見ない・早送りでなくてよい", T, async () => {
  await withRelease(async (ctx) => {
    const { b, c } = await upToC(ctx);
    const offline = { ...ctx.buildWithMarks, BANTO_UPDATE_REMOTE: join(ctx.dir, "無い"), BANTO_UPDATE_NEED_BYTES: String(2 ** 62) };

    const dry = await ctx.start(["--dry-run", "--rollback", b], offline).done;
    assert.equal(dry.code, 0, dry.out);
    assert.match(dry.out, new RegExp(`戻す先：${b}`));
    assert.match(dry.out, /抜けるコミット：\n\S+ 三つ目/);
    assert.match(dry.out, /そのまま使う：/);

    ctx.request(b, "now", { kind: "rollback" });
    const { code, out } = await ctx.start(["--from-request"], offline).done;
    assert.equal(code, 0, out);
    const s = ctx.state();
    assert.equal(s.phase, "done", JSON.stringify(s));
    assert.equal(s.kind, "rollback");
    assert.equal(s.from, c);
    assert.equal(s.to, b);
    assert.equal(s.result, `版 ${b.slice(0, 12)} に戻しました`);
    assert.equal(ctx.current(), v(b));
    assert.equal(ctx.previous(), v(c));
    assert.equal(ctx.builds(), 2, "そのまま使える版を組み立て直した");
    const logText = readFileSync(s.logFile, "utf8");
    assert.doesNotMatch(logText, /release を取ってきます/, "機械にある版なのに取ってきた");
    assert.doesNotMatch(logText, /空き：/, "そのまま使うのに空きを見た");
    assert.match(logText, /そのまま使います/);
    assert.deepEqual(ctx.history().slice(0, 2), [b, c]);
  });
});

test("戻す：記録に無い版・記録が無い／読めない・kind が未知・--rollback と一緒に使えない引数は断る（何もしない）", T, async () => {
  await withRelease(async (ctx) => {
    const b = ctx.commit("二つ目");
    git(ctx.dir, "--git-dir", ctx.repo, "fetch", "-q", "origin", "+refs/heads/release:refs/remotes/origin/release");
    const refused = async (args, pattern, failedPhase) => {
      const { code } = await ctx.start(args).done;
      assert.equal(code, 1);
      const s = ctx.state();
      assert.equal(s.phase, "failed", JSON.stringify(s));
      assert.equal(s.failedPhase, failedPhase);
      assert.match(s.error, pattern);
    };
    ctx.request(b, "now", { kind: "rollback" });
    await refused(["--from-request"], /動いた版の記録.*が無いので、戻せる版が分かりません/, "fetch");
    writeFileSync(join(ctx.updateDir, "history.json"), "{こわれた");
    ctx.request(b, "now", { kind: "rollback" });
    await refused(["--from-request"], /動いた版の記録.*を読めないので、戻せる版が分かりません/, "fetch");
    ctx.writeHistory([ctx.first]);
    ctx.request(b, "now", { kind: "rollback" });
    await refused(["--from-request"], /この機械で動いた版の記録にありません/, "fetch");
    await refused(["--rollback", b.slice(0, 12)], /この機械で動いた版の記録にありません/, "fetch");

    ctx.request(b, "now", { kind: "rolback" });
    await refused(["--from-request"], /kind（"rolback"）を知りません/, undefined);
    assert.equal(existsSync(join(ctx.updateDir, "request.json")), false, "読めない頼みは受け取って消す");
    await refused(["--rollback", ctx.first, "--commit", b], /--rollback は --from-request・--commit・--first と一緒に使えません/, undefined);
    ctx.request(b, "now", { kind: "rollback" });
    await refused(["--from-request", "--rollback", ctx.first], /--rollback は --from-request・--commit・--first と一緒に使えません/, undefined);
    await refused(["--rollback"], /--rollback には戻す版の commit/, undefined);

    assert.equal(ctx.current(), v(ctx.first));
    assert.deepEqual(ctx.versions(), [ctx.first.slice(0, 12)]);
    assert.deepEqual(ctx.systemctlCalls(), []);
  });
});

test("戻す：機械に無い版は取ってきてその場で組み立てる——早送りでも release から辿れなくてもよい。repo.git に無ければ断る", T, async () => {
  await withRelease(async (ctx) => {
    const { b, c } = await upToC(ctx);
    // b はまだ previous として機械にある——消して「機械に無い」に。release も b を含まない形に書き換える
    rmSync(join(ctx.rel, "previous"));
    git(ctx.dir, "--git-dir", ctx.repo, "worktree", "remove", "--force", join(ctx.rel, v(b)));
    git(ctx.github, "reset", "-q", "--hard", ctx.first);
    const d = ctx.commit("書き換えた release");
    ctx.request(b, "now", { kind: "rollback" });
    const { code, out } = await ctx.start(["--from-request"], ctx.buildWithMarks).done;
    assert.equal(code, 0, out);
    const s = ctx.state();
    assert.equal(s.phase, "done", JSON.stringify(s));
    assert.equal(ctx.current(), v(b));
    assert.equal(ctx.previous(), v(c));
    assert.equal(ctx.builds(), 3, "機械に無い版を組み立てていない");
    assert.match(readFileSync(s.logFile, "utf8"), /そのままは使えません（この機械にありません）[\s\S]*release を取ってきます/);
    assert.equal(git(ctx.dir, "--git-dir", ctx.repo, "rev-parse", "refs/remotes/origin/release"), d);

    // 記録にあっても repo.git にも機械にも無い（GitHub の release から消えた）版は断る
    const gone = "0123456789abcdef0123456789abcdef01234567";
    ctx.writeHistory([b, gone]);
    ctx.request(gone, "now", { kind: "rollback" });
    assert.equal((await ctx.start(["--from-request"]).done).code, 1);
    assert.match(ctx.state().error, /GitHub の release から消えたので取ってこられません/);
    assert.equal(ctx.current(), v(b));
  });
});

test("戻す：機械に無い版は組み立て済みがあればそれを重ねる。機械にある版は組み立て済みを取りに行かない", T, async () => {
  await withRelease(async (ctx) => {
    await withGithub(async (gh) => {
      const { b, c } = await upToC(ctx);
      rmSync(join(ctx.rel, "previous"));
      git(ctx.dir, "--git-dir", ctx.repo, "worktree", "remove", "--force", join(ctx.rel, v(b)));
      gh.publish(b, makePrebuilt(ctx.dir, b));
      const noBuild = { ...gh.env, BANTO_UPDATE_BUILD: "echo 組み立ててはいけない >&2; exit 9" };

      const dry = await ctx.start(["--dry-run", "--rollback", b], noBuild).done;
      assert.equal(dry.code, 0, dry.out);
      assert.match(dry.out, /組み立て済み：あります/);
      assert.match(dry.out, /組み立てる：.*そのままは使えない：この機械にありません/);

      ctx.request(b, "now", { kind: "rollback" });
      const { code, out } = await ctx.start(["--from-request"], noBuild).done;
      assert.equal(code, 0, out);
      const s = ctx.state();
      assert.equal(s.phase, "done", JSON.stringify(s));
      assert.equal(s.kind, "rollback");
      assert.equal(s.prebuilt?.status, "used");
      assert.equal(ctx.current(), v(b));
      assert.equal(ctx.previous(), v(c));
      assert.equal(ctx.builds(), 2, "組み立て済みがあるのに、その場で組み立てた");
      assert.deepEqual(noWorkDirs(ctx), []);

      // c は機械にある一度動いた版——組み立て済みを取りに行かず（state に prebuilt が無い）、そのまま使う
      const dry2 = await ctx.start(["--dry-run", "--rollback", c], noBuild).done;
      assert.equal(dry2.code, 0, dry2.out);
      assert.match(dry2.out, /そのまま使う：/);
      assert.doesNotMatch(dry2.out, /組み立て済み：/);
      ctx.request(c, "now", { kind: "rollback" });
      assert.equal((await ctx.start(["--from-request"], noBuild).done).code, 0);
      const s2 = ctx.state();
      assert.equal(s2.phase, "done", JSON.stringify(s2));
      assert.equal(s2.prebuilt, undefined, "そのまま使う版なのに組み立て済みを取りに行った");
      assert.equal(ctx.current(), v(c));
      assert.doesNotMatch(readFileSync(s2.logFile, "utf8"), /組み立て済みの版を探します/);
    });
  });
});

test("戻す：そのまま使う版は、待つ間の cancel・待つ段の失敗でも消さない", T, async () => {
  await withRelease(async (ctx) => {
    const { b, c } = await upToC(ctx);
    ctx.host.activity = BUSY;
    ctx.request(b, "wait", { kind: "rollback" });
    const run = ctx.start(["--from-request"]);
    await ctx.waitForPhase("wait");
    ctx.mark("cancel");
    assert.equal((await run.done).code, 0);
    assert.equal(ctx.state().phase, "cancelled");
    assert.equal(ctx.current(), v(c));
    assert.ok(existsSync(join(ctx.rel, v(b), "banto", "apps", "frontend", ".next")), "cancel で一度動いた版を消した");

    ctx.host.activityStatus = 400;
    ctx.request(b, "wait", { kind: "rollback" });
    assert.equal((await ctx.start(["--from-request"]).done).code, 1);
    assert.equal(ctx.state().failedPhase, "wait");
    assert.ok(existsSync(join(ctx.rel, v(b), "banto", "apps", "frontend", ".next")), "失敗で一度動いた版を消した");
    assert.equal(ctx.builds(), 2);
  });
});

test("組み立てた印が欠けた記録済みの版は、作りかけとして消して作り直す", T, async () => {
  await withRelease(async (ctx) => {
    const { b } = await upToC(ctx);
    ctx.commit("四つ目");
    assert.equal((await ctx.start(["--now"], ctx.buildWithMarks).done).code, 0); // b は previous でなくなる（記録の新しい2つとして残る）
    rmSync(join(ctx.rel, v(b), "banto", "packages", "core", "dist"), { recursive: true });
    ctx.request(b, "now", { kind: "rollback" });
    const { code, out } = await ctx.start(["--from-request"], ctx.buildWithMarks).done;
    assert.equal(code, 0, out);
    assert.equal(ctx.current(), v(b));
    assert.equal(ctx.builds(), 4, "印が欠けているのに作り直さなかった");
    assert.match(readFileSync(ctx.state().logFile, "utf8"), /組み立てた印（banto\/packages\/core\/dist）が欠けています/);
    assert.ok(existsSync(join(ctx.rel, v(b), "banto", "packages", "core", "dist")));
  });
});

test("更新（早送り）でも、コンテナが使っている一度動いた版は作り直さずに使う（作りかけ・起きなかった版は今どおり断る）", T, async () => {
  await withRelease(async (ctx) => {
    const { b, c } = await upToC(ctx);
    ctx.request(b, "now", { kind: "rollback" });
    assert.equal((await ctx.start(["--from-request"]).done).code, 0);
    assert.equal(ctx.current(), v(b));
    // 戻したあとも c のフォルダ（previous）をコンテナが使っている——#367 のあとに止まった形
    ctx.instances([join(ctx.rel, v(c), "banto")]);
    const { code, out } = await ctx.start(["--now"]).done;
    assert.equal(code, 0, out);
    assert.equal(ctx.state().kind, "update");
    assert.equal(ctx.state().result, `${c.slice(0, 12)} に更新しました`);
    assert.equal(ctx.current(), v(c));
    assert.equal(ctx.builds(), 2, "一度動いた版を組み立て直した");
  });
});

test("片づけ：今の版（current の実体）と記録の新しい2つと previous を残す", T, async () => {
  await withRelease(async (ctx) => {
    const { b, c } = await upToC(ctx);
    const d = ctx.commit("四つ目");
    assert.equal((await ctx.start(["--now"]).done).code, 0);
    const e = ctx.commit("五つ目");
    assert.equal((await ctx.start(["--now"]).done).code, 0);
    const name = (x) => x.slice(0, 12);
    assert.deepEqual(ctx.history(), [e, d, c, b, ctx.first]);
    assert.deepEqual(ctx.versions(), [c, d, e].map(name).sort(), "3つ残っていない");

    // host が新しい版を記録に書くより先に片づけが走った——今の版は current から数える（記録の先頭の e は2つのうちに入る）
    rmSync(join(ctx.fake, "record-history"));
    const f = ctx.commit("六つ目");
    assert.equal((await ctx.start(["--now"]).done).code, 0);
    assert.deepEqual(ctx.versions(), [d, e, f].map(name).sort());

    // previous（f）が記録に無くても残す
    ctx.writeHistory([e, d]);
    const g = ctx.commit("七つ目");
    assert.equal((await ctx.start(["--now"]).done).code, 0);
    assert.equal(ctx.previous(), v(f));
    assert.deepEqual(ctx.versions(), [d, e, f, g].map(name).sort());

    // 記録が読めなければ何も消さない
    writeFileSync(join(ctx.updateDir, "history.json"), "{こわれた");
    const h = ctx.commit("八つ目");
    assert.equal((await ctx.start(["--now"]).done).code, 0);
    assert.deepEqual(ctx.versions(), [d, e, f, g, h].map(name).sort());
    assert.match(readFileSync(ctx.state().logFile, "utf8"), /動いた版の記録.*を読めないので、古い版は消しません/);
  });
});

test("起きなかった版は記録から抜く——戻す前の版に起こし直して確かめたあとで。戻しても起きなかった（failed/verify）回でも", T, async () => {
  await withRelease(async (ctx) => {
    ctx.fakeMark("record-history");
    const b = ctx.commit("起きない版", { broken: true });
    assert.equal((await ctx.start(["--now"]).done).code, 1);
    assert.equal(ctx.state().phase, "rolled-back");
    assert.deepEqual(ctx.history(), [ctx.first], "起きなかった版が記録に残っている");
    // 戻す前の版へ restart した時点では、まだ抜いていない（host が書いた b が載ったまま）
    const atSecondRestart = JSON.parse(readFileSync(join(ctx.fake, "history-at-restart-2"), "utf8")).versions.map((x) => x.commit);
    assert.deepEqual(atSecondRestart, [b, ctx.first]);
    assert.match(readFileSync(ctx.state().logFile, "utf8"), new RegExp(`起きなかった版 ${b} を動いた版の記録から抜きました`));

    // 画面の口が答えない——新しい版も、戻した版も確かめられない
    const c = ctx.commit("三つ目");
    ctx.host.uiStatus = 500;
    assert.equal((await ctx.start(["--now"]).done).code, 1);
    const s = ctx.state();
    assert.equal(s.phase, "failed", JSON.stringify(s));
    assert.equal(s.failedPhase, "verify");
    assert.ok(!ctx.history().includes(c), "戻しても起きなかった回で、起きなかった版が記録に残っている");
    assert.equal(ctx.history()[0], ctx.first);
  });
});
