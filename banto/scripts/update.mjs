#!/usr/bin/env node
// **banto を更新する本体**（決定・2026-10-04、アーキ仕様 §2.5「画面から banto を更新する」・手順書 `docs/runbooks/release.md` D）。
//
// 画面の「更新」から頼まれると、host が `<dataDir>/update/request.json` を書いて `banto-update.service`（この
// スクリプトを `--from-request` で動かす oneshot の unit）を起こす。host の子ではない——起こし直したときに一緒に止まらないため。
// **いつも今動いている版（`current`）のものを動かす**——取ってきた新しいコードのスクリプトは動かさない。
//
// 段：取ってくる（fetch）→ 組み立てる（build）→ 待つ（wait）→ 起こし直す（restart）→ 確かめる（verify）
//
//   node update.mjs --from-request      # 画面からの頼み（request.json）だけを行う。無ければ断る（unit はこれで動かす）
//   node update.mjs                     # release の最新を、空くまで待って（request.json があっても使わない）
//   node update.mjs --now               # 待たずに起こし直す（画面が開けないとき、host で打つ）
//   node update.mjs --commit <sha>      # release から辿れる、その commit にする
//   node update.mjs --first --commit <sha>
//                                       # 初めて入れる（current が無い）。待たない・戻す先が無い・起こすのは install.sh
//   node update.mjs --dry-run           # 取ってきて、何をするかを出すだけ（組み立てない・何も書かない）
//   --wait-timeout <分>                 # 待つ段の上限（既定は無し）。越えたら「やめる」と同じに片づけて cancelled
//
// **`--from-request` の無いときは request.json を使わない**——unit が頼み無しで起きた（人が systemctl start した等）
// ときに、人が一覧を見ていない release の最新を入れないため。逆に unit は頼みが無ければ何もしない。
//
// 置き場（banto の設定の `releaseDir`、既定 ~/.local/share/banto-release）：
//   repo.git（bare。GitHub の release を refs/remotes/origin/release に取ってくる）・versions/<commit の頭12>
//   （repo.git の worktree、detached）・current → versions/…（動かす版）・previous → versions/…（戻す先）
//
// 書くもの（<dataDir>/update/）：
//   state.json   { id, phase: "fetch"|"build"|"wait"|"restart"|"verify"|"done"|"failed"|"rolled-back"|"cancelled",
//                  mode, from, to, startedAt, updatedAt,
//                  waiting?（待っている間の残り：{ blocking（activity の待つもの）, continuing（起き直したあと続くものの数）}）,
//                  note?（いま止まっている理由。例「host が答えません」）, result?, error?, failedPhase?, logFile,
//                  requestedBy?（{ label } だけ。セッションの id は写さない） }
//   <id>.log     この回のログ（子プロセスの出力もそのまま）
// 見るもの（host が置く印。数秒おき）：cancel（取ってくる・組み立てる・待つのをやめる。作りかけは消す）・
//   force-now（待たずに起こし直す）
//
// **同じものの写しがある所**（片方を変えたら、もう片方も）：
//   - unit 名（banto-update.service・banto-host.service・banto-frontend.service）：ここ・`setup-update.sh` の
//     UPDATE_UNIT／UNITS・`packages/core/src/self-update/self-update.ts` の UPDATE_UNIT・install.sh（作成中。Fork
//     「新しいホストへのインストール」）
//   - release の refspec：ここの FETCH_REFSPEC・`setup-update.sh` の FETCH_REFSPEC・`self-update.ts` の FETCH_REFSPEC・
//     install.sh（作成中）。release 以外を取るように変えるなら、全部を
//   - 画面の口：`setup-update.sh` が banto-frontend.service から読んで、`banto-update.service` に
//     BANTO_UPDATE_UI_URL として書く。ここはそれを読むだけ
//   - `GET /api/admin/update` の `current.commit`：確かめ（verify）と「今の版」の突き合わせに使う。**前の版の
//     updater が新しい版の host に聞く口なので、形を変えない**（アーキ仕様 §2.5）
//
// 試験のための差し替え（本番は既定のまま）：
//   --systemctl <コマンド>   BANTO_UPDATE_SYSTEMCTL      既定 systemctl
//   --incus <コマンド>       BANTO_UPDATE_INCUS          既定 incus（古い版がコンテナに mount されていないか見る）
//   --build <シェルの1行>    BANTO_UPDATE_BUILD          既定 npm ci --include=dev と npm run build（banto/ で）
//   --remote <URL か名前>    BANTO_UPDATE_REMOTE         既定 origin（repo.git の origin＝GitHub）
//   --units "<unit> <unit>"  BANTO_UPDATE_UNITS          既定 "banto-host.service banto-frontend.service"（最初が host）
//   --host-url <URL>         BANTO_UPDATE_HOST_URL       既定 http://127.0.0.1:<設定の port、既定 4737>
//   --ui-url <URL>           BANTO_UPDATE_UI_URL         既定 banto-update.service の Environment の BANTO_UPDATE_UI_URL
//   --verify-timeout <秒>    BANTO_UPDATE_VERIFY_TIMEOUT 既定 600（下の VERIFY_TIMEOUT_S）
//   --fetch-timeout <秒>     BANTO_UPDATE_FETCH_TIMEOUT  既定 600
//   --need-bytes <バイト>    BANTO_UPDATE_NEED_BYTES     組み立てに要る空き。既定は今の版の大きさ（du）
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
  statfsSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";

const RELEASE_REF = "refs/remotes/origin/release";
/** 写し：`setup-update.sh` の FETCH_REFSPEC・core `self-update.ts` の FETCH_REFSPEC・install.sh（作成中） */
const FETCH_REFSPEC = `+refs/heads/release:${RELEASE_REF}`;
/** 写し：`setup-update.sh` の UPDATE_UNIT・core `self-update.ts` の UPDATE_UNIT・install.sh（作成中） */
const UPDATE_UNIT = "banto-update.service";
/**
 * 起こし直したあと、新しい版が答えるまで待つ上限（秒）。**計測していない**——組み立て済みなので普段は数秒〜数十秒のはずだが、
 * 起動時の記録の読み直しやコンテナの付け直しで延びうるので長めに取る。落ちたこと（unit が failed・起こし直し中）は
 * 上限を待たずにその場で見るので、長くしても「落ちているのに待ち続ける」ことにはならない
 */
const VERIFY_TIMEOUT_S = 600;
/** git fetch の上限（秒）。これも計測していない（普段は数秒）。GitHub が返らないまま止まり続けないための線 */
const FETCH_TIMEOUT_S = 600;

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
const fromRequest = flag("--from-request");

// 設定が読めなくても、ここでは止まらない——そのことを state.json に書くため（画面から頼んだのに黙って何も起きない、を作らない）。
// 書く場所（dataDir）が設定に依るので、読めなければ既定の場所に書く（分かる範囲で）
let config = {};
let configError;
if (existsSync(configPath)) {
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    configError = `banto の設定を読めません：${configPath}：${err instanceof Error ? err.message : err}`;
  }
} else if (!first) {
  configError = `banto の設定がありません：${configPath}（BANTO_CONFIG_PATH で指せます）`;
}

const dataDir = config.dataDir ?? join(xdgData, "banto");
const releaseDir = config.releaseDir ?? join(xdgData, "banto-release");
const repo = join(releaseDir, "repo.git");
const versionsDir = join(releaseDir, "versions");
const currentLink = join(releaseDir, "current");
const previousLink = join(releaseDir, "previous");
const updateDir = join(dataDir, "update");

const systemctl = option("--systemctl", "BANTO_UPDATE_SYSTEMCTL", "systemctl");
const incus = option("--incus", "BANTO_UPDATE_INCUS", "incus");
const buildOverride = option("--build", "BANTO_UPDATE_BUILD", undefined);
const remote = option("--remote", "BANTO_UPDATE_REMOTE", "origin");
const units = option("--units", "BANTO_UPDATE_UNITS", "banto-host.service banto-frontend.service").split(/\s+/).filter(Boolean);
const hostUnit = units[0];
const hostUrl = option("--host-url", "BANTO_UPDATE_HOST_URL", `http://127.0.0.1:${config.port ?? 4737}`);
const seconds = (name, envName, fallback) => Number(option(name, envName, String(fallback))) * 1000;
const verifyTimeoutMs = seconds("--verify-timeout", "BANTO_UPDATE_VERIFY_TIMEOUT", VERIFY_TIMEOUT_S);
const fetchTimeoutMs = seconds("--fetch-timeout", "BANTO_UPDATE_FETCH_TIMEOUT", FETCH_TIMEOUT_S);
const needBytesOverride = option("--need-bytes", "BANTO_UPDATE_NEED_BYTES", undefined);
const activityIntervalMs = seconds("--interval", "BANTO_UPDATE_INTERVAL", 5);
const markIntervalMs = seconds("--mark-interval", "BANTO_UPDATE_MARK_INTERVAL", 2);
/** 待つ段の上限（分）。既定は無し——人が画面でやめる・すぐに切り替える。install.sh のように人が見ていない呼び手が付ける */
const waitTimeoutMin = option("--wait-timeout", "BANTO_UPDATE_WAIT_TIMEOUT", undefined);
const waitTimeoutMs = waitTimeoutMin === undefined ? undefined : Number(waitTimeoutMin) * 60_000;
if (waitTimeoutMs !== undefined && !(waitTimeoutMs > 0)) {
  console.error(`--wait-timeout は正の分で指してください：${waitTimeoutMin}`);
  process.exit(2);
}

// 子プロセス（npm）は、この node と同じ所から探す（unit の PATH には nvm 等の node が無いことがある）
const childEnv = {
  ...process.env,
  PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
  GIT_TERMINAL_PROMPT: "0",
};

// ───────────── 道具 ─────────────

class Stop extends Error {
  /** @param {"failed"|"cancelled"} phase・`note` は終わったあとも state.json に残す説明 */
  constructor(phase, message, { note } = {}) {
    super(message);
    this.phase = phase;
    this.note = note;
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
const errorText = (err) => err?.cause?.code ?? (err instanceof Error ? err.message : String(err));

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
  if (!logFile || dryRun) return;
  try {
    appendFileSync(logFile, `${line}\n`);
  } catch (err) {
    console.error(`ログ（${logFile}）に書けませんでした：${errorText(err)}`);
  }
}
/** 書けなくても止まらない（ディスクが一杯でも、起こし直し・戻す処理は最後まで行う）。書けなかったことは journal に出す */
function setState(patch) {
  state = { ...state, ...patch, updatedAt: new Date().toISOString() };
  for (const k of Object.keys(state)) if (state[k] === undefined) delete state[k];
  if (dryRun) return;
  try {
    writeAtomic(join(updateDir, "state.json"), JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(`state.json に書けませんでした（${state.phase}）：${errorText(err)}`);
  }
}

// ───────────── 二重起動を断る ─────────────

const lockPath = join(updateDir, "lock");
let lockHeld = false;
const FINISHED = new Set(["done", "failed", "rolled-back", "cancelled"]);
/**
 * 走っている回が終わりの状態（done 等）を書いてから lock を外すまでの間に打たれた回は、断らずにこの間だけ待つ。
 * 終わりの状態は片づけを済ませてから書く（下の finish）ので、書いた回に残っているのは lock を外して終わることだけ
 */
const LOCK_HANDOVER_MS = 5_000;
function holderFinished() {
  try {
    return FINISHED.has(JSON.parse(readFileSync(join(updateDir, "state.json"), "utf8")).phase);
  } catch {
    return false;
  }
}
/** 断ったときは state.json も request.json も触らずに終わる——走っている方の進み具合を壊さない */
async function acquireLock() {
  const handoverUntil = Date.now() + LOCK_HANDOVER_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      lockHeld = true;
      process.on("exit", releaseLock);
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    let pid;
    try {
      pid = Number(readFileSync(lockPath, "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") continue; // 読む前に外れた
      throw err;
    }
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (e) {
      alive = e.code === "EPERM";
    }
    if (!alive) {
      // 落ちた回の残り
      rmSync(lockPath, { force: true });
      continue;
    }
    if (Date.now() < handoverUntil && holderFinished()) {
      await sleep(50);
      continue;
    }
    console.error(`ほかの更新が走っています（pid ${pid}、${lockPath}）。終わってからにしてください`);
    process.exit(3);
  }
}
function releaseLock() {
  if (!lockHeld) return;
  rmSync(lockPath, { force: true });
  lockHeld = false;
}

/**
 * **終わりの状態**（done・failed・rolled-back・cancelled）は、ここに預けて最後に書く——片づけ（古い版・作りかけを消す・
 * 印を消す）を済ませてから書いて、すぐ lock を外す。state.json を読む側（画面・install.sh）は、終わりの状態を見たら
 * 次を頼んでよい（先に書くと、片づけの間に打ち直した回が「ほかの更新が走っています」で断られていた）
 */
let finalState;
const finish = (patch) => {
  finalState = patch;
};

// ───────────── systemd ─────────────

/** `systemctl show` の値。読めなければ `{ error }` */
function unitProps(unit, props) {
  const r = spawnSync(systemctl, ["show", "-p", props.join(","), unit], { encoding: "utf8", env: childEnv, timeout: 30_000 });
  if (r.error) return { error: `${systemctl} を実行できませんでした：${r.error.message}` };
  if (r.status !== 0) return { error: `${systemctl} show ${unit} が失敗しました：${(r.stderr || "").trim() || `終了コード ${r.status}`}` };
  const out = {};
  for (const line of r.stdout.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/** restart の直前に読んだ、unit ごとの「自動で起こし直された回数」（`NRestarts`）。読めなかった unit は入れない */
const restartsBefore = new Map();

/**
 * **落ちたか**——起こし直したあとに、その unit が落ちて止まっている（`failed`・`inactive`）か、落ちて起こし直されて
 * いる（`auto-restart`・`NRestarts` が restart の直前より増えた）なら、その説明。起動中・動いているなら undefined。
 * `NRestarts` は人の restart では 0 に戻らない（2026-10-04、Ubuntu 24.04 の systemd 255 で確かめた——2 のまま）
 * ので、直前の値と比べる。`auto-restart` は RestartSec の間しか見えないので、それだけには頼らない
 */
function unitDown(unit) {
  const p = unitProps(unit, ["ActiveState", "SubState", "NRestarts"]);
  if (p.error) return { unknown: p.error };
  const before = restartsBefore.get(unit);
  const restarted = before !== undefined && Number(p.NRestarts) > before;
  if (p.ActiveState === "failed" || p.ActiveState === "inactive" || p.SubState === "auto-restart" || restarted) {
    const count = before !== undefined ? `・起こし直された回数 ${Number(p.NRestarts) - before}` : "";
    return { down: `${unit} が落ちました（${p.ActiveState}/${p.SubState}${count}）` };
  }
  return {};
}

function restartUnits() {
  restartsBefore.clear();
  for (const unit of units) {
    const n = Number(unitProps(unit, ["NRestarts"]).NRestarts);
    if (Number.isFinite(n)) restartsBefore.set(unit, n);
  }
  log(`$ ${systemctl} restart ${units.join(" ")}`);
  const r = spawnSync(systemctl, ["restart", ...units], { encoding: "utf8", env: childEnv, timeout: 180_000 });
  if (r.error) return `${systemctl} を実行できませんでした：${r.error.message}`;
  if (r.status !== 0) return `${systemctl} restart が失敗しました：${(r.stderr || "").trim() || `終了コード ${r.status}`}`;
  return undefined;
}

/**
 * 画面の口。`setup-update.sh` が banto-frontend.service から読んで `banto-update.service` に書いたものが正本
 * （unit で動くときは環境変数で、手で打ったときは unit の定義から読む）
 */
function resolveUiUrl() {
  const given = option("--ui-url", "BANTO_UPDATE_UI_URL", undefined);
  if (given) return given;
  const p = unitProps(UPDATE_UNIT, ["Environment"]);
  const found = p.error ? undefined : /(?:^|\s)BANTO_UPDATE_UI_URL=(\S+)/.exec(p.Environment ?? "")?.[1];
  if (found) return found;
  return { error: `画面の口が分かりません（${UPDATE_UNIT} に BANTO_UPDATE_UI_URL がありません${p.error ? `：${p.error}` : ""}）。setup-update.sh を打ち直すか、--ui-url で指してください` };
}

// ───────────── 版のフォルダ ─────────────

/**
 * **どこかのコンテナがまだ mount している版**（名前の集まり）。host と同じユーザー・同じ `incus` の CLI で聞く
 * （`packages/container` の runIncus・ProjectContainers と同じ口。`incus query` は区画を自分で付けないので、
 * `incus project get-current` で引いて付ける）。Project のコンテナは、止まっていても装置を持ったまま——次に起きる
 * ときに付け直されるまでは、その版を指している。聞けなければ `{ error }`（呼ぶ側は消さない）
 */
function versionsInUse() {
  const run = (incusArgs) => spawnSync(incus, incusArgs, { encoding: "utf8", env: childEnv, timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
  const cur = run(["project", "get-current"]);
  if (cur.error || cur.status !== 0) return { error: `incus project get-current：${cur.error?.message ?? ((cur.stderr || "").trim() || `終了コード ${cur.status}`)}` };
  const project = encodeURIComponent(cur.stdout.trim());
  const q = run(["query", `/1.0/instances?recursion=1&project=${project}`]);
  if (q.error || q.status !== 0) return { error: `incus query /1.0/instances：${q.error?.message ?? ((q.stderr || "").trim() || `終了コード ${q.status}`)}` };
  let instances;
  try {
    instances = JSON.parse(q.stdout);
  } catch (err) {
    return { error: `incus query /1.0/instances の答えを読めません：${errorText(err)}` };
  }
  const roots = [versionsDir, realpathOrNull(versionsDir)].filter(Boolean);
  /** @type {Map<string, string[]>} 版の名前 → 使っているコンテナ */
  const used = new Map();
  for (const inst of instances) {
    const devices = { ...(inst.devices ?? {}), ...(inst.expanded_devices ?? {}) };
    for (const dev of Object.values(devices)) {
      if (dev?.type !== "disk" || typeof dev.source !== "string" || !isAbsolute(dev.source)) continue;
      for (const source of [dev.source, realpathOrNull(dev.source)].filter(Boolean)) {
        for (const root of roots) {
          const rel = relative(root, source);
          if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
          const name = rel.split(sep)[0];
          used.set(name, [...new Set([...(used.get(name) ?? []), inst.name])]);
        }
      }
    }
  }
  return { used };
}

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

/** 組み立てる前に、今の版の大きさ（du）以上の空きがあるか。無ければ組み立てる前に断る */
function checkDiskSpace(fromDir) {
  let need;
  if (needBytesOverride !== undefined) need = Number(needBytesOverride);
  else if (fromDir) {
    // node_modules の中に読めないものがあると du は 1 で終わるが、合計は出す——合計が読めれば使う
    const r = spawnSync("du", ["-sk", fromDir], { encoding: "utf8", env: childEnv, timeout: 300_000 });
    const kib = Number(/^(\d+)\s/.exec(r.stdout ?? "")?.[1]);
    if (!Number.isFinite(kib)) fail(`今の版の大きさを測れませんでした（du -sk ${fromDir}：${r.error?.message ?? ((r.stderr || "").trim() || `終了コード ${r.status}`)}）`);
    need = kib * 1024;
  } else {
    log("今の版が無いので、空きは確かめません（初めて入れる）");
    return;
  }
  const fs = statfsSync(versionsDir);
  const free = Number(fs.bavail) * Number(fs.bsize);
  const gib = (n) => `${(n / 1024 ** 3).toFixed(1)}GiB`;
  log(`空き：${gib(free)}（要る分の目安＝今の版の大きさ ${gib(need)}）`);
  if (free < need) fail(`${versionsDir} の空きが足りません（空き ${gib(free)}・要る分の目安 ${gib(need)}＝今の版の大きさ）。空けてから頼み直してください`);
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

/**
 * 子プロセスを1つ走らせる（取ってくる・組み立てる）。出力はそのままログへ。やめる印・止められたら子を止めて cancelled、
 * `timeoutMs` を過ぎたら子を止めて失敗
 */
async function runStep(file, stepArgs, cwd, { timeoutMs } = {}) {
  log(`$ ${[file, ...stepArgs].join(" ")}（${cwd}）`);
  const fd = dryRun ? undefined : openSync(logFile, "a");
  try {
    const out = fd ?? "inherit";
    const child = spawn(file, stepArgs, { cwd, env: childEnv, stdio: ["ignore", out, out], detached: true });
    runningChild = child;
    const exited = new Promise((resolve) => {
      child.on("error", (err) => resolve({ code: -1, error: err }));
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });
    const deadline = timeoutMs ? Date.now() + timeoutMs : Infinity;
    let stopping; // "cancelled" | "timeout"
    for (;;) {
      const done = await Promise.race([exited, sleep(markIntervalMs).then(() => undefined)]);
      if (done) {
        if (stopping === "cancelled") throw new Stop("cancelled", terminated ? "止められました（SIGTERM）" : "やめました（取ってくる・組み立てる途中）");
        if (stopping === "timeout") fail(`${[file, ...stepArgs].join(" ")} が ${timeoutMs / 1000}秒で終わりませんでした`);
        if (done.error) fail(`${file} を起こせませんでした：${done.error.message}`);
        if (done.code !== 0) fail(`${[file, ...stepArgs].join(" ")} が失敗しました（${done.signal ?? `終了コード ${done.code}`}）。ログ：${logFile}`);
        return;
      }
      if (!stopping && (terminated || marker("cancel"))) {
        stopping = "cancelled";
        log("やめる印があるので、子を止めます");
        killTree(child);
      } else if (!stopping && Date.now() >= deadline) {
        stopping = "timeout";
        log(`${timeoutMs / 1000}秒を過ぎたので、子を止めます`);
        killTree(child);
      }
    }
  } finally {
    runningChild = undefined;
    if (fd !== undefined) closeSync(fd);
  }
}

// ───────────── host に聞く ─────────────

const authHeaders = { authorization: `Bearer ${config.authToken}` };

/**
 * `{ activity }` か、host が答えない（繋がらない・時間切れ・5xx）なら `{ unreachable }`。
 * **答えないことを「空いた」とみなさない**——一時的に落ちている・重いだけかもしれない（呼ぶ側が unit の状態を見る）
 */
async function fetchActivity() {
  let res;
  try {
    res = await fetch(`${hostUrl}/api/admin/activity`, { headers: authHeaders, signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    return { unreachable: errorText(err) };
  }
  if (res.status >= 500) return { unreachable: `${res.status} を返しました` };
  if (!res.ok) fail(`${hostUrl}/api/admin/activity が ${res.status} を返しました`);
  const { now: _now, ...activity } = await res.json();
  return { activity };
}

/**
 * **待つ段の残り**（決定・2026-10-05、アーキ仕様 §2.5「画面から banto を更新する」の待つ段）。host の activity が
 * `restartable` を持てば、待つのは `blocking`（切れると結果が分からなくなるもの）だけ——ターン・続けられる Module の仕事は
 * 起き直したあと続く。持たない古い host なら今どおり全部（ターン・返事待ちの仕事・Module の呼び出し）を待つ。
 * 返すのは進んでよいか（`ready`）と state.json の `waiting`：`{ blocking, continuing（起き直したあと続くものの数）}`
 */
function waitingOf(activity) {
  if (typeof activity.restartable === "boolean") {
    return { ready: activity.restartable, waiting: { blocking: activity.blocking, continuing: activity.continuesAfterRestart.length } };
  }
  return {
    ready: activity.idle,
    waiting: {
      blocking: [
        ...activity.turns.map((t) => ({ kind: "turn", ...t })),
        ...activity.awaitingReplies.map((r) => ({ kind: "reply", ...r })),
        ...activity.moduleCalls.map((c) => ({ kind: "call", waitingOnHuman: false, ...c })),
      ],
      continuing: 0,
    },
  };
}

/**
 * 動いている host が答える版（`GET /api/admin/update` の `current`）。答えなければ（繋がらない・時間切れ・5xx）
 * `{ unreachable }`、断られたら（4xx——合言葉が違う等）`{ refused }`
 */
async function runningVersion() {
  try {
    const res = await fetch(`${hostUrl}/api/admin/update`, { headers: authHeaders, signal: AbortSignal.timeout(10_000) });
    if (res.status >= 500) return { unreachable: `${res.status} を返しました` };
    if (!res.ok) return { refused: `${hostUrl}/api/admin/update が ${res.status} を返しました` };
    const body = await res.json();
    return { commit: body?.current?.commit ?? null, reasons: body?.reasons ?? [] };
  } catch (err) {
    return { unreachable: errorText(err) };
  }
}

/**
 * 新しい版の host が答え、その版が `commit` で、画面の口が答えるまで待つ。unit が落ちた（failed・起こし直し中）なら
 * 上限を待たずにその場で諦める。起動中なら上限（`verifyTimeoutMs`）まで待つ
 */
async function verify(commit, uiUrl) {
  const deadline = Date.now() + verifyTimeoutMs;
  let hostDetail = "まだ聞いていません";
  let uiDetail = "まだ聞いていません";
  let hostOk = false;
  let uiOk = false;
  const unknownLogged = new Set();
  for (;;) {
    for (const unit of units) {
      const d = unitDown(unit);
      if (d.down) return { ok: false, detail: d.down };
      if (d.unknown && !unknownLogged.has(unit)) {
        log(`${unit} の状態を読めません（${d.unknown}）。答えるかどうかだけで確かめます`);
        unknownLogged.add(unit);
      }
    }
    if (!hostOk) {
      const r = await runningVersion();
      if (r.unreachable) hostDetail = `答えません（${r.unreachable}）`;
      else if (r.refused) hostDetail = r.refused;
      else {
        hostOk = r.commit === commit;
        hostDetail = hostOk ? "答えました" : `動いている版が ${r.commit ?? "不明"} です（${r.reasons.join("／")}）`;
      }
    }
    if (!uiOk) {
      try {
        const res = await fetch(uiUrl, { signal: AbortSignal.timeout(5_000), redirect: "manual" });
        uiOk = res.status < 500;
        uiDetail = uiOk ? "答えました" : `${res.status} を返しました`;
      } catch (err) {
        uiDetail = `答えません（${errorText(err)}）`;
      }
    }
    if (hostOk && uiOk) return { ok: true };
    if (Date.now() >= deadline) break;
    await sleep(markIntervalMs);
  }
  return { ok: false, detail: `${verifyTimeoutMs / 1000}秒待ちました。host：${hostDetail}／画面（${uiUrl}）：${uiDetail}` };
}

// ───────────── 本体 ─────────────

try {
  mkdirSync(updateDir, { recursive: true, mode: 0o700 });
} catch (err) {
  console.error(`更新の置き場（${updateDir}）を作れません：${errorText(err)}${configError ? `（${configError}）` : ""}`);
  process.exit(2);
}
if (!dryRun) await acquireLock();

// 画面からの頼み（host が書いたもの）。使うのは --from-request のときだけ
let request;
let setupError = configError;
const requestPath = join(updateDir, "request.json");
const cliTarget = flag("--commit") || flag("--now") || first;
if (fromRequest) {
  if (cliTarget) setupError ??= "--from-request は --commit・--now・--first と一緒に使えません";
  else if (!existsSync(requestPath)) {
    setupError ??=
      `頼み（${requestPath}）がありません。画面から頼まれずに ${UPDATE_UNIT} が起きたので、何もしません` +
      "（人が一覧を見ていない release の最新を入れないため）";
  } else {
    try {
      request = JSON.parse(readFileSync(requestPath, "utf8"));
      if (typeof request?.commit !== "string" || !/^[0-9a-f]{40}$/.test(request.commit)) throw new Error("commit（40文字の id）がありません");
      if (request.mode !== "wait" && request.mode !== "now") throw new Error('mode が "wait" でも "now" でもありません');
    } catch (err) {
      setupError ??= `頼み（${requestPath}）を読めません：${errorText(err)}`;
    }
    if (!dryRun) rmSync(requestPath, { force: true });
  }
} else if (existsSync(requestPath)) {
  console.log(`${requestPath} がありますが、--from-request で動いていないので使いません（画面からの頼みは ${UPDATE_UNIT} が受け取ります）`);
}

const startedAt = new Date().toISOString();
const id = String(request?.id ?? `${fromRequest ? "unit" : "cli"}-${startedAt.replace(/[:.]/g, "-")}`).replace(/[^A-Za-z0-9._-]/g, "_");
const mode = first || flag("--now") ? "now" : (request?.mode ?? "wait");
const commitArg = request?.commit ?? option("--commit", undefined, undefined);
// 誰が頼んだかは、人に見せる名前だけ写す（セッションの id は state.json に残さない）
const requestedByLabel = typeof request?.requestedBy?.label === "string" ? request.requestedBy.label : undefined;
logFile = join(updateDir, `${id}.log`);
state = {
  id,
  phase: "fetch",
  mode,
  from: null,
  to: null,
  startedAt,
  logFile,
  ...(requestedByLabel ? { requestedBy: { label: requestedByLabel } } : {}),
};
setState({});

let building; // 作りかけの版のフォルダ（失敗・やめたら消す）
let fromDir = null;

/** 終了コードを返す（done・cancelled は 0、それ以外は 1） */
async function run() {
  if (setupError) fail(setupError);

  // ── 1. 取ってくる ──
  log(`更新を始めます（${id}・${mode === "now" ? "すぐ" : "空くまで待つ"}${first ? "・初めて入れる" : ""}）`);
  if (!existsSync(repo)) fail(`${repo} がありません（置き場を整えるのは setup-update.sh か install.sh）`);
  let from = null;
  if (existsSync(currentLink)) {
    if (first) fail(`${currentLink} があります。--first は初めて入れるときだけです`);
    fromDir = realpathSync(currentLink);
    from = gitOk(["-C", fromDir, "rev-parse", "HEAD"]);
    // current のリンクと、動いている版を突き合わせる——前の回が起こし直しの途中で止まっていると、食い違ったまま
    // previous・current を替えて、動いていない版を「今の版」として戻す先にしてしまう
    const running = await runningVersion();
    if (running.refused) fail(running.refused);
    if (running.unreachable) log(`host が答えないので（${running.unreachable}）、今の版は ${currentLink} から：${from}`);
    else if (running.commit !== from) {
      const runningDir = running.commit ? join(versionsDir, running.commit.slice(0, 12)) : null;
      fail(
        `current（${from}）と動いている版（${running.commit ?? `不明：${running.reasons.join("／")}`}）が食い違っています。` +
          "前の更新が途中で止まったのかもしれません。直し方：" +
          (runningDir && existsSync(runningDir)
            ? `動いている版に合わせるなら ln -sfn ${linkTarget(runningDir)} ${currentLink}.new && mv -T ${currentLink}.new ${currentLink}、`
            : "") +
          `current の版で動かすなら systemctl restart ${units.join(" ")}。そのあとで頼み直してください`,
      );
    }
  } else if (!first) {
    fail(`${currentLink} がありません。初めて入れるときは --first`);
  }
  setState({ from });
  // 起こし直したあとの確かめに要る。組み立てる前に分からなければ断る（組み立ててから気づかない）
  let uiUrl = null;
  if (!first) {
    const ui = resolveUiUrl();
    if (typeof ui === "string") uiUrl = ui;
    else if (!dryRun) fail(ui.error);
  }
  log(`今の版：${from ?? "（無し）"}。${remote} から release を取ってきます`);
  await runStep("git", ["--git-dir", repo, "fetch", "--no-tags", remote, FETCH_REFSPEC], releaseDir, { timeoutMs: fetchTimeoutMs });
  const release = gitRepoOk(["rev-parse", "--verify", `${RELEASE_REF}^{commit}`]);
  let to = release;
  if (commitArg) {
    const r = gitRepo(["rev-parse", "--verify", "-q", `${commitArg}^{commit}`]);
    if (r.status !== 0) fail(`${commitArg} が見つかりません`);
    to = r.stdout.trim();
  }
  if (gitRepo(["merge-base", "--is-ancestor", to, release]).status !== 0) fail(`${to} は release（${release}）から辿れません`);
  if (from && from === to) {
    finish({ to, phase: "done", result: "もうこの版で動いています" });
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
      console.log(`確かめる：${verifyTimeoutMs / 1000}秒以内に ${hostUrl}/api/admin/update と ${uiUrl ?? "（画面の口が分かりません）"}`);
    } else console.log(`current → ${newDir}（起こすのは install.sh）`);
    console.log("\n--dry-run なので、ここで終わります");
    return 0;
  }

  // ── 2. 組み立てる ──
  setState({ phase: "build" });
  mkdirSync(versionsDir, { recursive: true });
  // 手で消された版の登録が残っていると、同じ場所への worktree add が断られる
  gitRepoOk(["worktree", "prune"]);
  if (existsSync(newDir)) {
    const inUse = versionsInUse();
    const users = inUse.used?.get(basename(newDir));
    if (inUse.error) {
      fail(
        `${newDir} が残っています（前の回の作りかけか、戻した版）。Incus に聞けないので、消して作り直してよいか分かりません` +
          `（${inUse.error}）。Incus に届くようにしてから頼み直すか、どのコンテナもこの版を mount していないと確かめてから ` +
          `git --git-dir ${repo} worktree remove --force ${newDir} で消してください`,
      );
    }
    if (users) fail(`${newDir} が残っていて、コンテナ（${users.join("・")}）がまだ使っています。Project を開き直してから頼み直してください`);
    log(`${newDir} が残っています（前の回の作りかけか、戻した版）。消してから作り直します`);
    removeVersion(newDir);
  }
  checkDiskSpace(fromDir);
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
    log(`途中で切れるもの（実行中の呼び出し・続けられない仕事）が無くなるまで待ちます${waitTimeoutMs ? `（上限 ${waitTimeoutMin} 分）` : ""}`);
    const waitDeadline = waitTimeoutMs ? Date.now() + waitTimeoutMs : Infinity;
    let nextActivity = 0;
    let last = "";
    let lastNote;
    const note = (text) => {
      if (text === lastNote) return;
      if (text) log(text);
      setState({ note: text });
      lastNote = text;
    };
    for (;;) {
      if (terminated) throw new Stop("cancelled", "止められました（SIGTERM）");
      if (marker("cancel")) throw new Stop("cancelled", "待つのをやめました");
      if (Date.now() >= waitDeadline) {
        const text = `待つ上限（${waitTimeoutMin} 分）を超えたのでやめました`;
        throw new Stop("cancelled", text, { note: text });
      }
      if (marker("force-now")) {
        log("すぐ起こし直す印があるので、待たずに進みます");
        break;
      }
      if (Date.now() >= nextActivity) {
        const r = await fetchActivity();
        if (r.unreachable) {
          const u = unitProps(hostUnit, ["ActiveState", "SubState"]);
          if (!u.error && (u.ActiveState === "inactive" || u.ActiveState === "failed")) {
            log(`host が答えず（${r.unreachable}）、${hostUnit} は ${u.ActiveState} です——止まっているので、待つものはありません`);
            break;
          }
          note(
            `host が答えません（${r.unreachable}）。` +
              (u.error ? `${hostUnit} の状態も読めない（${u.error}）ので` : `${hostUnit} は ${u.ActiveState}/${u.SubState} なので`) +
              "、答えるまで待ちます",
          );
        } else {
          note(undefined);
          const { ready, waiting } = waitingOf(r.activity);
          if (ready) {
            log(`途中で切れるものはありません${waiting.continuing > 0 ? `（起き直したあと続くもの ${waiting.continuing} 件）` : ""}`);
            break;
          }
          const text = JSON.stringify(waiting);
          if (text !== last) {
            log(`待っています：途中で切れるもの ${waiting.blocking.length} 件（起き直したあと続くもの ${waiting.continuing} 件）`);
            setState({ waiting });
            last = text;
          }
        }
        nextActivity = Date.now() + activityIntervalMs;
      }
      await sleep(markIntervalMs);
    }
  }

  // ── 4. 起こし直す ──
  setState({ phase: "restart", waiting: undefined, note: undefined });
  const oldPrevious = existsSync(previousLink) ? readlinkSync(previousLink) : null;
  const restoreLinks = () => {
    swapLink(currentLink, linkTarget(fromDir));
    if (oldPrevious) swapLink(previousLink, oldPrevious);
    else rmSync(previousLink, { force: true });
  };
  if (fromDir) swapLink(previousLink, linkTarget(fromDir));
  swapLink(currentLink, linkTarget(newDir));
  building = undefined;
  if (first) {
    finish({ phase: "done", result: `${to.slice(0, 12)} を入れました（起こすのは install.sh）` });
    log("入れました（初めて入れるときは起こし直しません）");
    return 0;
  }
  const restartError = restartUnits();
  if (restartError) {
    // 断られた（polkit 等）——何も起こし直していないので、戻す処理（もう一度 restart）はしない。current だけは
    // 動いている版に揃える（次に誰かが起こし直したとき、確かめていない版で起きないように）
    restoreLinks();
    const running = await runningVersion();
    const still =
      running.unreachable || running.refused || running.commit === from
        ? "今の版のまま動いています"
        : `ただし host が答えた版は ${running.commit ?? "不明"} です——確かめてください`;
    finish({ phase: "failed", failedPhase: "restart", error: `起こし直せませんでした（${still}）：${restartError}` });
    log(`起こし直せませんでした：${restartError}。current を ${linkTarget(fromDir)} に戻しました。組み立てた版は ${newDir} に残します（次の回が片づけます）`);
    return 1;
  }

  // ── 5. 確かめる ──
  setState({ phase: "verify" });
  const checked = await verify(to, uiUrl);
  if (checked.ok) {
    log("新しい版が起きました。古い版を片づけます");
    setState({ note: "古い版を片づけています" });
    cleanUpOldVersions();
    finish({ phase: "done", result: `${to.slice(0, 12)} に更新しました`, note: undefined });
    log("更新しました");
    return 0;
  }
  log(`新しい版が起きません：${checked.detail}。前の版に戻します`);
  restoreLinks();
  const againError = restartUnits();
  const back = againError ? { ok: false, detail: againError } : await verify(from, uiUrl);
  // 起きなかった版はすぐには消さない（何が起きたかを見られるように）。次の回が作りかけとして片づける
  log(`起きなかった版は ${newDir} に残します（次の回が片づけます）`);
  if (back.ok) {
    finish({ phase: "rolled-back", failedPhase: "verify", error: checked.detail, result: "前の版に戻しました" });
    log("前の版に戻しました");
  } else {
    finish({
      phase: "failed",
      failedPhase: "verify",
      error: `新しい版が起きず（${checked.detail}）、前の版に戻しても起きません（${back.detail}）`,
    });
    log(`前の版に戻しても起きません：${back.detail}`);
  }
  return 1;
}

/** previous より古い版を消す。コンテナがまだ mount している版は残す（次の回にまた見る）。Incus に聞けなければ何も消さない */
function cleanUpOldVersions() {
  const keep = new Set([realpathOrNull(currentLink), realpathOrNull(previousLink)]);
  const old = readdirSync(versionsDir).filter((name) => !keep.has(realpathOrNull(join(versionsDir, name))));
  if (old.length === 0) return;
  const inUse = versionsInUse();
  if (inUse.error) {
    log(`Incus に聞けないので、古い版（${old.join("・")}）は消しません。次の回にまた見ます：${inUse.error}`);
    return;
  }
  for (const name of old) {
    const dir = join(versionsDir, name);
    const users = inUse.used.get(name);
    if (users) {
      log(`残します：${dir}（コンテナ ${users.join("・")} がまだ mount しています。次の回にまた見ます）`);
      continue;
    }
    log(`消します：${dir}`);
    try {
      removeVersion(dir);
    } catch (err) {
      log(`消せませんでした：${errorText(err)}`);
    }
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
      log(`消せませんでした：${errorText(e)}`);
    }
  }
  if (stop?.phase === "cancelled") {
    finish({ phase: "cancelled", result: `${message}（今の版のまま）`, waiting: undefined, note: stop.note });
    log(message);
    exitCode = 0;
  } else {
    // 始める前に断った（頼みが無い・設定が読めない）ときは、どの段でもない
    finish({ phase: "failed", failedPhase: setupError ? undefined : failedPhase, error: message, waiting: undefined, note: undefined });
    log(`失敗しました（${setupError ? "始める前" : failedPhase}）：${message}`);
    if (!stop) console.error(err);
    exitCode = 1;
  }
} finally {
  // 次の回に持ち越さない（--dry-run は走っている回の印を消さない）
  if (!dryRun) {
    rmSync(join(updateDir, "cancel"), { force: true });
    rmSync(join(updateDir, "force-now"), { force: true });
  }
}
// 片づけを済ませたので、終わりの状態を書いて、すぐ lock を外す
if (finalState) setState(finalState);
releaseLock();
process.exit(exitCode);
