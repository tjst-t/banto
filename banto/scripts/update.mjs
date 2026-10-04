#!/usr/bin/env node
// **banto を更新する本体**（決定・2026-10-04、アーキ仕様 §2.5「画面から banto を更新する」・手順書 `docs/runbooks/release.md` D）。
//
// 画面の「更新」から頼まれると、host が `<dataDir>/update/request.json` を書いて `banto-update.service`（この
// スクリプトを動かす oneshot の unit）を起こす。host の子ではない——起こし直したときに一緒に止まらないため。
// **いつも今動いている版（`current`）のものを動かす**——取ってきた新しいコードのスクリプトは動かさない。
//
// 段：取ってくる（fetch）→ 組み立てる（build）→ 待つ（wait）→ 起こし直す（restart）→ 確かめる（verify）
//
//   node update.mjs                     # request.json があればその頼み、無ければ release の最新を、空くまで待って
//   node update.mjs --now               # 待たずに起こし直す（画面が開けないとき、host で打つ）
//   node update.mjs --commit <sha>      # release から辿れる、その commit にする
//   node update.mjs --first --commit <sha>
//                                       # 初めて入れる（current が無い）。待たない・戻す先が無い・起こすのは install.sh
//   node update.mjs --dry-run           # 取ってきて、何をするかを出すだけ（組み立てない・何も書かない）
//
// 置き場（banto の設定の `releaseDir`、既定 ~/.local/share/banto-release）：
//   repo.git（bare。GitHub の release を refs/remotes/origin/release に取ってくる）・versions/<commit の頭12>
//   （repo.git の worktree、detached）・current → versions/…（動かす版）・previous → versions/…（戻す先）
//
// 書くもの（<dataDir>/update/）：
//   state.json   { id, phase: "fetch"|"build"|"wait"|"restart"|"verify"|"done"|"failed"|"rolled-back"|"cancelled",
//                  mode, from, to, startedAt, updatedAt, waiting?（待っている間の activity の残り）, result?, error?,
//                  failedPhase?, logFile, requestedBy? }
//   <id>.log     この回のログ（子プロセスの出力もそのまま）
// 見るもの（host が置く印。数秒おき）：cancel（待つ・組み立てをやめる。作りかけは消す）・force-now（待たずに起こし直す）
//
// 試験のための差し替え（本番は既定のまま）：
//   --systemctl <コマンド>   BANTO_UPDATE_SYSTEMCTL      既定 systemctl
//   --build <シェルの1行>    BANTO_UPDATE_BUILD          既定 npm ci --include=dev と npm run build（banto/ で）
//   --remote <URL か名前>    BANTO_UPDATE_REMOTE         既定 origin（repo.git の origin＝GitHub）
//   --units "<unit> <unit>"  BANTO_UPDATE_UNITS          既定 "banto-host.service banto-frontend.service"
//   --host-url <URL>         BANTO_UPDATE_HOST_URL       既定 http://127.0.0.1:<設定の port、既定 4737>
//   --ui-url <URL>           BANTO_UPDATE_UI_URL         既定 http://127.0.0.1:<設定の uiPort、既定 4175>/
//   --verify-timeout <秒>    BANTO_UPDATE_VERIFY_TIMEOUT 既定 120
//   --interval <秒>          BANTO_UPDATE_INTERVAL       activity を見る間隔。既定 5
//   --mark-interval <秒>     BANTO_UPDATE_MARK_INTERVAL  印・確かめを見る間隔。既定 2
// 設定は BANTO_CONFIG_PATH か ~/.config/banto/config.json から読む（合言葉・port・dataDir・releaseDir）。

import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";

const RELEASE_REF = "refs/remotes/origin/release";
const FETCH_REFSPEC = `+refs/heads/release:${RELEASE_REF}`;

// ───────────── 入力 ─────────────

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, envName, fallback) => {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1] !== undefined) return args[i + 1];
  return (envName && process.env[envName]) || fallback;
};

const xdgData = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
const configPath =
  process.env.BANTO_CONFIG_PATH ||
  join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "banto", "config.json");
const first = flag("--first");
const dryRun = flag("--dry-run");
let config = {};
if (existsSync(configPath)) config = JSON.parse(readFileSync(configPath, "utf8"));
else if (!first) {
  console.error(`banto の設定がありません：${configPath}（BANTO_CONFIG_PATH で指せます）`);
  process.exit(2);
}

const dataDir = config.dataDir ?? join(xdgData, "banto");
const releaseDir = config.releaseDir ?? join(xdgData, "banto-release");
const repo = join(releaseDir, "repo.git");
const versionsDir = join(releaseDir, "versions");
const currentLink = join(releaseDir, "current");
const previousLink = join(releaseDir, "previous");
const updateDir = join(dataDir, "update");

const systemctl = option("--systemctl", "BANTO_UPDATE_SYSTEMCTL", "systemctl");
const buildOverride = option("--build", "BANTO_UPDATE_BUILD", undefined);
const remote = option("--remote", "BANTO_UPDATE_REMOTE", "origin");
const units = option("--units", "BANTO_UPDATE_UNITS", "banto-host.service banto-frontend.service").split(/\s+/).filter(Boolean);
const hostUrl = option("--host-url", "BANTO_UPDATE_HOST_URL", `http://127.0.0.1:${config.port ?? 4737}`);
const uiUrl = option("--ui-url", "BANTO_UPDATE_UI_URL", `http://127.0.0.1:${config.uiPort ?? 4175}/`);
const seconds = (name, envName, fallback) => Number(option(name, envName, String(fallback))) * 1000;
const verifyTimeoutMs = seconds("--verify-timeout", "BANTO_UPDATE_VERIFY_TIMEOUT", 120);
const activityIntervalMs = seconds("--interval", "BANTO_UPDATE_INTERVAL", 5);
const markIntervalMs = seconds("--mark-interval", "BANTO_UPDATE_MARK_INTERVAL", 2);

// 子プロセス（npm）は、この node と同じ所から探す（unit の PATH には nvm 等の node が無いことがある）
const childEnv = {
  ...process.env,
  PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
  GIT_TERMINAL_PROMPT: "0",
};

// ───────────── 道具 ─────────────

class Stop extends Error {
  /** @param {"failed"|"cancelled"} phase */
  constructor(phase, message) {
    super(message);
    this.phase = phase;
  }
}
const fail = (message) => {
  throw new Stop("failed", message);
};

function git(gitArgs, opts = {}) {
  const r = spawnSync("git", gitArgs, { encoding: "utf8", env: childEnv, timeout: opts.timeoutMs ?? 600_000, cwd: opts.cwd });
  if (r.error) throw new Error(`git ${gitArgs.join(" ")} を実行できませんでした：${r.error.message}`);
  return r;
}
const gitRepo = (gitArgs, opts) => git(["--git-dir", repo, ...gitArgs], opts);
function gitOk(gitArgs, opts) {
  const r = git(gitArgs, opts);
  if (r.status !== 0) fail(`git ${gitArgs.join(" ")} が失敗しました：${(r.stderr || "").trim() || `終了コード ${r.status}`}`);
  return r.stdout.trim();
}
const gitRepoOk = (gitArgs, opts) => gitOk(["--git-dir", repo, ...gitArgs], opts);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const marker = (name) => existsSync(join(updateDir, name));
const realpathOrNull = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

/** symlink が指す先は `versions/<名前>`（置き場ごと動かしても切れない） */
const linkTarget = (versionDir) => join("versions", basename(versionDir));

/** 一時名で作って rename（読む側・systemd が、無い瞬間を見ない） */
function swapLink(link, target) {
  const tmp = `${link}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  renameSync(tmp, link);
}

function writeAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

// ───────────── 進み具合とログ ─────────────

let state;
let logFile;
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  if (logFile && !dryRun) appendFileSync(logFile, `${line}\n`);
}
function setState(patch) {
  state = { ...state, ...patch, updatedAt: new Date().toISOString() };
  for (const k of Object.keys(state)) if (state[k] === undefined) delete state[k];
  if (!dryRun) writeAtomic(join(updateDir, "state.json"), JSON.stringify(state, null, 2));
}

// ───────────── 二重起動を断る ─────────────

const lockPath = join(updateDir, "lock");
function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      process.on("exit", () => rmSync(lockPath, { force: true }));
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const pid = Number(readFileSync(lockPath, "utf8"));
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (e) {
        alive = e.code === "EPERM";
      }
      if (alive) {
        console.error(`ほかの更新が走っています（pid ${pid}、${lockPath}）。終わってからにしてください`);
        process.exit(3);
      }
      // 落ちた回の残り
      rmSync(lockPath, { force: true });
    }
  }
  console.error(`${lockPath} を取れませんでした`);
  process.exit(3);
}

// ───────────── 版のフォルダ ─────────────

/** 作りかけ・古い版を消す。今の版と前の版は消さない */
function removeVersion(dir) {
  const real = realpathOrNull(dir) ?? dir;
  if (real === realpathOrNull(currentLink) || real === realpathOrNull(previousLink)) {
    throw new Error(`${dir} は今の版か前の版なので消しません`);
  }
  const r = gitRepo(["worktree", "remove", "--force", "--force", dir]);
  if (r.status !== 0 || existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  gitRepo(["worktree", "prune"]);
}

let terminated = false;
let runningChild;
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    terminated = true;
    if (runningChild) killTree(runningChild);
  });
}
function killTree(child) {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // もう居ない
  }
}

/** 組み立ての1コマンド。出力はそのままログへ。やめる印・止められたら子を止めて cancelled */
async function runStep(file, stepArgs, cwd) {
  log(`$ ${[file, ...stepArgs].join(" ")}（${cwd}）`);
  const fd = openSync(logFile, "a");
  try {
    const child = spawn(file, stepArgs, { cwd, env: childEnv, stdio: ["ignore", fd, fd], detached: true });
    runningChild = child;
    const exited = new Promise((resolve) => {
      child.on("error", (err) => resolve({ code: -1, error: err }));
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });
    let cancelled = false;
    for (;;) {
      const done = await Promise.race([exited, sleep(markIntervalMs).then(() => undefined)]);
      if (done) {
        if (cancelled) throw new Stop("cancelled", terminated ? "止められました（SIGTERM）" : "やめました（組み立ての途中）");
        if (done.error) fail(`${file} を起こせませんでした：${done.error.message}`);
        if (done.code !== 0) fail(`${[file, ...stepArgs].join(" ")} が失敗しました（${done.signal ?? `終了コード ${done.code}`}）。ログ：${logFile}`);
        return;
      }
      if (!cancelled && (terminated || marker("cancel"))) {
        cancelled = true;
        log("やめる印があるので、組み立てを止めます");
        killTree(child);
      }
    }
  } finally {
    runningChild = undefined;
    closeSync(fd);
  }
}

// ───────────── host に聞く ─────────────

const authHeaders = { authorization: `Bearer ${config.authToken}` };

/** `undefined` は host が答えない（止まっている——待つものは無い） */
async function fetchActivity() {
  let res;
  try {
    res = await fetch(`${hostUrl}/api/admin/activity`, { headers: authHeaders, signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    log(`host が答えません（${err.cause?.code ?? err.message}）——待つものはありません`);
    return undefined;
  }
  if (!res.ok) fail(`${hostUrl}/api/admin/activity が ${res.status} を返しました`);
  const { now: _now, ...activity } = await res.json();
  return activity;
}

/** 新しい版の host が答え、その版が `commit` で、画面の口が答えるまで待つ */
async function verify(commit) {
  const deadline = Date.now() + verifyTimeoutMs;
  let hostDetail = "まだ聞いていません";
  let uiDetail = "まだ聞いていません";
  let hostOk = false;
  let uiOk = false;
  while (Date.now() < deadline) {
    if (!hostOk) {
      try {
        const res = await fetch(`${hostUrl}/api/admin/update`, { headers: authHeaders, signal: AbortSignal.timeout(5_000) });
        if (!res.ok) hostDetail = `${res.status} を返しました`;
        else {
          const body = await res.json();
          const got = body?.current?.commit ?? null;
          hostOk = got === commit;
          hostDetail = hostOk ? "答えました" : `動いている版が ${got ?? "不明"} です（${(body?.reasons ?? []).join("／")}）`;
        }
      } catch (err) {
        hostDetail = `答えません（${err.cause?.code ?? err.message}）`;
      }
    }
    if (!uiOk) {
      try {
        const res = await fetch(uiUrl, { signal: AbortSignal.timeout(5_000), redirect: "manual" });
        uiOk = res.status < 500;
        uiDetail = uiOk ? "答えました" : `${res.status} を返しました`;
      } catch (err) {
        uiDetail = `答えません（${err.cause?.code ?? err.message}）`;
      }
    }
    if (hostOk && uiOk) return { ok: true };
    await sleep(markIntervalMs);
  }
  return { ok: false, detail: `${verifyTimeoutMs / 1000}秒待ちました。host：${hostDetail}／画面（${uiUrl}）：${uiDetail}` };
}

function restartUnits() {
  log(`$ ${systemctl} restart ${units.join(" ")}`);
  const r = spawnSync(systemctl, ["restart", ...units], { encoding: "utf8", env: childEnv, timeout: 180_000 });
  if (r.error) return `${systemctl} を実行できませんでした：${r.error.message}`;
  if (r.status !== 0) return `${systemctl} restart が失敗しました：${(r.stderr || "").trim() || `終了コード ${r.status}`}`;
  return undefined;
}

// ───────────── 本体 ─────────────

mkdirSync(updateDir, { recursive: true, mode: 0o700 });
if (!dryRun) acquireLock();

// 画面からの頼み（host が書いたもの）。コマンドで指定されたときは使わない
let request;
const requestPath = join(updateDir, "request.json");
const cliTarget = flag("--commit") || flag("--now") || first;
if (!cliTarget && existsSync(requestPath)) {
  request = JSON.parse(readFileSync(requestPath, "utf8"));
  if (!dryRun) rmSync(requestPath, { force: true });
}

const id = String(request?.id ?? `cli-${new Date().toISOString().replace(/[:.]/g, "-")}`).replace(/[^A-Za-z0-9._-]/g, "_");
const mode = first || flag("--now") ? "now" : (request?.mode ?? "wait");
const commitArg = request?.commit ?? option("--commit", undefined, undefined);
logFile = join(updateDir, `${id}.log`);
state = {
  id,
  phase: "fetch",
  mode,
  from: null,
  to: null,
  startedAt: new Date().toISOString(),
  logFile,
  ...(request?.requestedBy ? { requestedBy: request.requestedBy } : {}),
};
setState({});

let building; // 作りかけの版のフォルダ（失敗・やめたら消す）
let fromDir = null;

/** 終了コードを返す（done・cancelled は 0、それ以外は 1） */
async function run() {
  // ── 1. 取ってくる ──
  log(`更新を始めます（${id}・${mode === "now" ? "すぐ" : "空くまで待つ"}${first ? "・初めて入れる" : ""}）`);
  if (!existsSync(repo)) fail(`${repo} がありません（置き場を整えるのは setup-update.sh か install.sh）`);
  let from = null;
  if (existsSync(currentLink)) {
    if (first) fail(`${currentLink} があります。--first は初めて入れるときだけです`);
    fromDir = realpathSync(currentLink);
    from = gitOk(["-C", fromDir, "rev-parse", "HEAD"]);
  } else if (!first) {
    fail(`${currentLink} がありません。初めて入れるときは --first`);
  }
  setState({ from });
  log(`今の版：${from ?? "（無し）"}。${remote} から release を取ってきます`);
  gitRepoOk(["fetch", "--no-tags", remote, FETCH_REFSPEC]);
  const release = gitRepoOk(["rev-parse", "--verify", `${RELEASE_REF}^{commit}`]);
  let to = release;
  if (commitArg) {
    const r = gitRepo(["rev-parse", "--verify", "-q", `${commitArg}^{commit}`]);
    if (r.status !== 0) fail(`${commitArg} が見つかりません`);
    to = r.stdout.trim();
  }
  if (gitRepo(["merge-base", "--is-ancestor", to, release]).status !== 0) fail(`${to} は release（${release}）から辿れません`);
  if (from && from === to) {
    setState({ to, phase: "done", result: "もうこの版で動いています" });
    log("もうこの版で動いています");
    return 0;
  }
  if (from && gitRepo(["merge-base", "--is-ancestor", from, to]).status !== 0) {
    fail(`今の版（${from}）が ${to} の祖先ではありません（早送りで済みません）。更新しません`);
  }
  setState({ to });
  const newDir = join(versionsDir, to.slice(0, 12));

  if (dryRun) {
    const commits = from ? gitRepoOk(["log", "--format=%h %s", `${from}..${to}`, "--"]) : "（初めて入れる）";
    console.log(`\n今の版：${from ?? "（無し）"}\n新しい版：${to}\n入るコミット：\n${commits}\n`);
    console.log(`組み立てる：${newDir}（${buildOverride ?? "npm ci --include=dev && npm run build"}）`);
    if (!first) {
      console.log(mode === "wait" ? "待つ：動いているものが無くなるまで" : "待たない");
      console.log(`起こし直す：${systemctl} restart ${units.join(" ")}（current → ${newDir}・previous → ${fromDir}）`);
      console.log(`確かめる：${verifyTimeoutMs / 1000}秒以内に ${hostUrl}/api/admin/update と ${uiUrl}`);
    } else console.log(`current → ${newDir}（起こすのは install.sh）`);
    console.log("\n--dry-run なので、ここで終わります");
    return 0;
  }

  // ── 2. 組み立てる ──
  setState({ phase: "build" });
  mkdirSync(versionsDir, { recursive: true });
  if (existsSync(newDir)) {
    log(`${newDir} が残っています（前の回の作りかけ）。消してから作り直します`);
    removeVersion(newDir);
  }
  building = newDir;
  gitRepoOk(["worktree", "add", "--detach", newDir, to]);
  const bantoDir = join(newDir, "banto");
  if (buildOverride) await runStep("sh", ["-c", buildOverride], bantoDir);
  else {
    await runStep("npm", ["ci", "--include=dev"], bantoDir);
    await runStep("npm", ["run", "build"], bantoDir);
  }
  log("組み立てました");

  // ── 3. 待つ ──
  if (mode === "wait" && !first) {
    setState({ phase: "wait" });
    log("動いているものが無くなるまで待ちます");
    let nextActivity = 0;
    let last = "";
    for (;;) {
      if (terminated) throw new Stop("cancelled", "止められました（SIGTERM）");
      if (marker("cancel")) throw new Stop("cancelled", "待つのをやめました");
      if (marker("force-now")) {
        log("すぐ起こし直す印があるので、待たずに進みます");
        break;
      }
      if (Date.now() >= nextActivity) {
        const activity = await fetchActivity();
        if (!activity || activity.idle) break;
        const text = JSON.stringify(activity);
        if (text !== last) {
          log(`待っています：ターン ${activity.turns.length}・返事待ちの仕事 ${activity.awaitingReplies.length}・Module の呼び出し ${activity.moduleCalls.length}`);
          setState({ waiting: activity });
          last = text;
        }
        nextActivity = Date.now() + activityIntervalMs;
      }
      await sleep(markIntervalMs);
    }
    if (last) log("動いているものがなくなりました");
  }

  // ── 4. 起こし直す ──
  setState({ phase: "restart", waiting: undefined });
  const oldPrevious = existsSync(previousLink) ? readlinkSync(previousLink) : null;
  if (fromDir) swapLink(previousLink, linkTarget(fromDir));
  swapLink(currentLink, linkTarget(newDir));
  building = undefined;
  if (first) {
    setState({ phase: "done", result: `${to.slice(0, 12)} を入れました（起こすのは install.sh）` });
    log("入れました（初めて入れるときは起こし直しません）");
    return 0;
  }
  const restartError = restartUnits();

  // ── 5. 確かめる ──
  setState({ phase: "verify" });
  const checked = restartError ? { ok: false, detail: restartError } : await verify(to);
  if (checked.ok) {
    log("新しい版が起きました。古い版を片づけます");
    const keep = new Set([realpathOrNull(currentLink), realpathOrNull(previousLink)]);
    for (const name of readdirSync(versionsDir)) {
      const dir = join(versionsDir, name);
      if (keep.has(realpathOrNull(dir))) continue;
      log(`消します：${dir}`);
      removeVersion(dir);
    }
    setState({ phase: "done", result: `${to.slice(0, 12)} に更新しました` });
    log("更新しました");
    return 0;
  }
  {
    log(`新しい版が起きません：${checked.detail}。前の版に戻します`);
    swapLink(currentLink, linkTarget(fromDir));
    if (oldPrevious) swapLink(previousLink, oldPrevious);
    else rmSync(previousLink, { force: true });
    const againError = restartUnits();
    const back = againError ? { ok: false, detail: againError } : await verify(from);
    if (back.ok) {
      removeVersion(newDir);
      setState({
        phase: "rolled-back",
        failedPhase: restartError ? "restart" : "verify",
        error: checked.detail,
        result: "前の版に戻しました",
      });
      log("前の版に戻しました");
    } else {
      setState({
        phase: "failed",
        failedPhase: "verify",
        error: `新しい版が起きず（${checked.detail}）、前の版に戻しても起きません（${back.detail}）`,
      });
      log(`前の版に戻しても起きません：${back.detail}`);
    }
    return 1;
  }
}

let exitCode;
try {
  exitCode = await run();
} catch (err) {
  const stop = err instanceof Stop ? err : undefined;
  const message = err instanceof Error ? err.message : String(err);
  const failedPhase = state.phase;
  if (building) {
    log(`作りかけの ${building} を消します`);
    try {
      removeVersion(building);
    } catch (e) {
      log(`消せませんでした：${e instanceof Error ? e.message : e}`);
    }
  }
  if (stop?.phase === "cancelled") {
    setState({ phase: "cancelled", result: `${message}（今の版のまま）`, waiting: undefined });
    log(message);
    exitCode = 0;
  } else {
    setState({ phase: "failed", failedPhase, error: message, waiting: undefined });
    log(`失敗しました（${failedPhase}）：${message}`);
    if (!stop) console.error(err);
    exitCode = 1;
  }
} finally {
  // 次の回に持ち越さない
  rmSync(join(updateDir, "cancel"), { force: true });
  rmSync(join(updateDir, "force-now"), { force: true });
}
process.exit(exitCode);
