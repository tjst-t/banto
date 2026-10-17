// **組み立て済みの banto を取ってきて、版のフォルダに重ねる**（決定・2026-10-15、アーキ仕様 §2.5「組み立て済みのものを使う」）。
//
// `update.mjs` の段2（組み立てる）が、git の worktree（`versions/<commit>`）を作ったあとに呼ぶ。GitHub Actions
// （`.github/workflows/prebuilt.yml`）がその commit を組み立てて Release `build-<頭12>` に置いたものを取ってきて、
// **worktree の外の作業フォルダに展開し、木を歩いて確かめてから**、決めた場所だけを rename で worktree へ移す。
// 使えないとき（無い・合わない・道具が無い・GitHub 以外）は `{ used: false, reason }` を返し、呼ぶ側がその場で組み立てる。
// やめる印・SIGTERM は呼ぶ側の `checkStop()`（投げる）で受ける。
//
// **このファイルは update.mjs から動的に import される**——無い（古い install.sh が update.mjs だけを写した等）なら、
// update.mjs は理由を書いてその場で組み立てる。

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync } from "node:fs";
import { posix } from "node:path";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";

/** その commit の Release のタグ（workflow と同じ） */
export const tagOf = (commit) => `build-${commit.slice(0, 12)}`;
/** 生成物のファイル名（workflow と同じ） */
export const assetOf = (commit) => `banto-${commit}-linux-x64.tar.zst`;
/** 作業フォルダの名前の頭。`versions/` の中に置く（rename を同じファイルシステムで成り立たせる）。`.` で始まるので版の片づけは飛ばす */
export const WORK_PREFIX = ".prebuilt-";

/** 決めた場所（仕様の「生成物に入れるのは決めた場所だけ」）。`banto/` からの相対 */
const FIXED = ["node_modules", "apps/frontend/.next", "apps/frontend/next-env.d.ts", ".banto-prebuilt.json"];
// `packages/modules/dist` は決めた場所ではない（`modules` は Module を並べるフォルダ）
const DIST = [/^packages\/(?!modules\/)[^/]+\/dist$/, /^packages\/modules\/[^/]+\/dist$/];
/** 決めた場所の根（移す単位）か */
function isRoot(rel) {
  return FIXED.includes(rel) || DIST.some((re) => re.test(rel));
}
/** 決めた場所の根の下（根そのものも含む）か */
function underRoot(rel) {
  const parts = rel.split("/");
  for (let i = 1; i <= parts.length; i++) if (isRoot(parts.slice(0, i).join("/"))) return true;
  return false;
}
/** 根の手前のフォルダ（`apps`・`apps/frontend`・`packages`・`packages/x`・`packages/modules`・`packages/modules/x`）か */
function isAncestorOfRoot(rel) {
  return (
    rel === "apps" ||
    rel === "apps/frontend" ||
    rel === "packages" ||
    rel === "packages/modules" ||
    /^packages\/[^/]+$/.test(rel) ||
    /^packages\/modules\/[^/]+$/.test(rel)
  );
}

/**
 * origin の URL から GitHub の `<owner>/<repo>`。GitHub 以外なら undefined。
 * `git@github.com:o/r(.git)`・`ssh://git@github.com/o/r(.git)`・`https://github.com/o/r(.git)` の3つ
 */
export function githubRepoOf(url) {
  if (typeof url !== "string") return undefined;
  const m =
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url) ??
    /^ssh:\/\/git@github\.com(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url) ??
    /^https:\/\/(?:[^@/\s]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errorText = (err) => err?.cause?.code ?? (err instanceof Error ? err.message : String(err));
const mb = (n) => (n / 1024 / 1024).toFixed(0);

/** 待つ状態（仕様「使う側」4） */
const WAITING = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

class Skip extends Error {}
const skip = (reason) => {
  throw new Skip(reason);
};

/**
 * @param {object} o
 * @param {string} o.commit            組み立てる commit（40文字）
 * @param {string|undefined} o.originUrl repo.git の origin（`--remote` が URL ならそれ）
 * @param {string} o.versionsDir
 * @param {string} o.newDir            worktree（`versions/<頭12>`）
 * @param {string} o.id                この回の id（作業フォルダの名前）
 * @param {(msg: string) => void} o.log
 * @param {(patch: object) => void} o.setPrebuilt  state.json の `prebuilt` を替える
 * @param {(text: string|undefined) => void} o.note state.json の `note`
 * @param {() => void} o.checkStop     やめる印・SIGTERM なら投げる（呼ぶ側の Stop）
 * @param {(extraBytes: number) => void} o.checkSpace 取ってくる分を足した空きの確かめ（足りなければ投げる）
 * @param {string} [o.prebuiltBase]    試験の差し替え：`releases/download` のタグの手前までを丸ごと置き換える URL
 * @param {string} [o.githubApi]       試験の差し替え：runs の口を丸ごと置き換える URL
 * @param {number} o.waitMs            組み立て中を待つ上限
 * @param {number} o.downloadTimeoutMs 取ってくる上限
 * @param {number} [o.headIntervalMs]  有無を見る間隔（既定 30 秒）
 * @param {number} [o.apiIntervalMs]   API に聞く間隔（既定 150 秒）
 * @param {number} [o.registerDelayMs] 回の登録の遅れを待つ間（既定 30 秒）
 * @param {number} [o.markIntervalMs]  やめる印を見る間隔（既定 2 秒）
 * @returns {Promise<{ used: true, run: string } | { used: false, reason: string }>}
 */
export async function usePrebuilt(o) {
  const work = join(o.versionsDir, `${WORK_PREFIX}${o.id}`);
  const markMs = o.markIntervalMs ?? 2000;
  // 呼ぶ側の例外（やめる印・SIGTERM・空きが足りない）には印を付けて、そのまま上へ返す。それ以外の例外（展開した木が読めない
  // EACCES・ELOOP 等）は「使わない」に包み、その場で組み立てる道に落とす（仕様「どれかが違えばその場で組み立てる」）
  const passThrough = (fn) => (...args) => {
    try {
      return fn(...args);
    } catch (err) {
      if (err && typeof err === "object") err[CALLER] = true;
      throw err;
    }
  };
  o = { ...o, checkStop: passThrough(o.checkStop), checkSpace: passThrough(o.checkSpace) };
  /** 待つ間もやめる印を見る（細かく区切って眠る） */
  const nap = async (ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      o.checkStop();
      await sleep(Math.min(markMs, until - Date.now()));
    }
    o.checkStop();
  };
  try {
    // ── 取りに行くかを決める（1） ──
    if (process.arch !== "x64") skip(`この機械は ${process.arch} です（組み立て済みは x64 だけ）`);
    if (typeof zlib.createZstdDecompress !== "function") {
      skip(`この node（${process.version}）は zstd を伸ばせません（zlib.createZstdDecompress が無い）`);
    }
    let downloadBase;
    let runsUrl;
    if (o.prebuiltBase || o.githubApi) {
      if (!o.prebuiltBase || !o.githubApi) skip("試験の差し替えは --prebuilt-base と --github-api を両方渡してください");
      downloadBase = o.prebuiltBase.replace(/\/$/, "");
      runsUrl = o.githubApi;
    } else {
      const repo = githubRepoOf(o.originUrl);
      if (!repo) skip(`取り込み元が GitHub ではありません（${o.originUrl ?? "origin がありません"}）`);
      downloadBase = `https://github.com/${repo}/releases/download`;
      runsUrl = `https://api.github.com/repos/${repo}/actions/workflows/prebuilt.yml/runs`;
    }
    // 前の回が殺されて残した作業フォルダ（lock があるので走っているほかの回のものではない）
    for (const name of readdirSync(o.versionsDir)) {
      if (name.startsWith(WORK_PREFIX)) {
        o.log(`前の回の作業フォルダを消します：${name}`);
        removeAll(join(o.versionsDir, name), o.log);
      }
    }

    const tag = tagOf(o.commit);
    const asset = assetOf(o.commit);
    const assetUrl = `${downloadBase}/${tag}/${asset}`;
    const sumUrl = `${assetUrl}.sha256`;

    // ── 有無を見る（3）・まだ無ければ待つ（4） ──
    o.setPrebuilt({ status: "checking" });
    o.log(`組み立て済みの版を探します：${assetUrl}`);
    let size = await headSize(assetUrl);
    if (size === undefined) {
      const startedWaiting = Date.now();
      const deadline = startedWaiting + o.waitMs;
      let knownRunning = false;
      let askedAgain = false;
      let nextApi = 0;
      for (;;) {
        o.checkStop();
        if (Date.now() >= nextApi) {
          nextApi = Date.now() + (o.apiIntervalMs ?? 150_000);
          const runs = await fetchRuns(runsUrl, o.commit);
          if (runs.error) {
            if (!knownRunning) skip(`GitHub に組み立ての様子を聞けません（${runs.error}）`);
            o.log(`GitHub に聞けません（${runs.error}）。組み立て中と分かっているので、ファイルが出来るのを待ち続けます`);
          } else if (runs.list.some((r) => WAITING.has(r.status))) {
            knownRunning = true;
          } else if (runs.list.some((r) => r.status === "completed" && r.conclusion === "success")) {
            // 成功した回があるのにファイルが無い——消された（直前に出来た場合に備えて、もう一度だけ見る）
            size = await headSize(assetUrl);
            if (size !== undefined) break;
            skip("GitHub の組み立ては済んでいますが、組み立て済みのファイルがありません（消された）");
          } else if (runs.list.length === 0) {
            if (!askedAgain) {
              // push の直後は回の登録が遅れることがある——30 秒後に一度だけ聞き直してから決める
              askedAgain = true;
              o.log("GitHub にこの版の組み立てがまだありません。少し待って聞き直します");
              await nap(o.registerDelayMs ?? 30_000);
              nextApi = 0;
              size = await headSize(assetUrl);
              if (size !== undefined) break;
              continue;
            }
            skip("GitHub でこの版は組み立てられていません");
          } else {
            const last = [...runs.list].sort((a, b) => (b.run_number - a.run_number) || ((b.run_attempt ?? 0) - (a.run_attempt ?? 0)))[0];
            const why =
              last.conclusion === "failure"
                ? "GitHub でのテストか組み立てが落ちています"
                : `GitHub での組み立てが途中で止まりました（${last.conclusion ?? last.status}）`;
            skip(`${why}${last.html_url ? `：${last.html_url}` : ""}`);
          }
        }
        if (Date.now() >= deadline) skip(`GitHub での組み立てを ${Math.round(o.waitMs / 60000)} 分待ちましたが出来ません`);
        const mins = Math.floor((Date.now() - startedWaiting) / 60000);
        o.setPrebuilt({ status: "waiting" });
        o.note(`GitHub で組み立て中です（${mins} 分）`);
        await nap(o.headIntervalMs ?? 30_000);
        size = await headSize(assetUrl);
        if (size !== undefined) break;
      }
      o.note(undefined);
    }

    // ── 空き（2）・取ってくる（5） ──
    o.checkSpace(size);
    mkdirSync(work, { recursive: true, mode: 0o700 });
    const file = join(work, asset);
    o.setPrebuilt({ status: "downloading", bytes: { done: 0, total: size } });
    o.log(`取ってきます（${mb(size)} MB）`);
    await download(assetUrl, file, {
      timeoutMs: o.downloadTimeoutMs,
      checkStop: o.checkStop,
      markMs,
      progress: (done) => {
        o.setPrebuilt({ status: "downloading", bytes: { done, total: size } });
        o.note(`組み立て済みの版を取ってきています（${mb(done)} / ${mb(size)} MB）`);
      },
    });
    o.note(undefined);
    const sumText = await fetchText(sumUrl);
    const want = /^([0-9a-f]{64}) {2}(\S+)\s*$/.exec(sumText.trim());
    if (!want || want[2] !== asset) skip(`.sha256 の書式が違います：${JSON.stringify(sumText.slice(0, 120))}`);
    const got = await sha256Of(file);
    if (got !== want[1]) skip(`sha256 が合いません（取ってきたもの ${got}・Release の ${want[1]}）`);
    o.checkStop();

    // ── 作業フォルダに展開して確かめる（6） ──
    const out = join(work, "x");
    mkdirSync(out);
    o.log("展開します");
    await extract(file, out, { checkStop: o.checkStop, markMs });
    rmSync(file, { force: true });
    o.checkStop();
    const marker = inspectTree(out);
    checkMarker(marker, o.commit);

    // ── 重ねる（7） ──
    const moved = [];
    try {
      for (const rel of rootsIn(out)) {
        const from = join(out, "banto", rel);
        const to = join(o.newDir, "banto", rel);
        if (existsSync(to)) throw new Error(`${rel} が版のフォルダに既にあります`);
        const parent = posix.dirname(rel);
        if (parent !== "." && !existsSync(join(o.newDir, "banto", parent))) throw new Error(`版のフォルダに ${parent} がありません（この commit のソースと合わない）`);
        renameSync(from, to);
        moved.push(to);
      }
    } catch (err) {
      for (const p of moved) rmSync(p, { recursive: true, force: true });
      skip(`版のフォルダに重ねられません：${errorText(err)}`);
    }
    o.setPrebuilt({ status: "used", run: marker.run });
    o.log(`組み立て済みの版を重ねました（${marker.run}）`);
    return { used: true, run: marker.run };
  } catch (err) {
    if (err?.[CALLER]) throw err; // やめる印・SIGTERM・空きが足りない（呼ぶ側の Stop）
    const reason = err instanceof Skip ? err.message : `組み立て済みを使う途中で思わぬ失敗：${errorText(err)}`;
    o.setPrebuilt({ status: "skipped", reason });
    o.note(undefined);
    return { used: false, reason };
  } finally {
    removeAll(work, o.log);
  }
}

const CALLER = Symbol("呼ぶ側の例外");

/**
 * 作業フォルダを消す。tar は書き込めない・読めないフォルダ（mode 000 等）も作れるので、消す前に自分の権限を足す。
 * 消せなくても投げない（元の例外を隠さない）——ログに書き、次の回の初めにまた試す
 */
function removeAll(dir, log) {
  try {
    rmSync(dir, { recursive: true, force: true });
    return;
  } catch {
    // 権限を足してからもう一度
  }
  const grant = (p) => {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    if (!st.isDirectory()) return;
    try {
      chmodSync(p, 0o700);
    } catch {
      // 持ち主でない等——消すのは下で試す
    }
    let names = [];
    try {
      names = readdirSync(p);
    } catch {
      return;
    }
    for (const name of names) grant(join(p, name));
  };
  grant(dir);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    log(`作業フォルダ ${dir} を消せませんでした（次の回の初めにまた試します）：${errorText(err)}`);
  }
}

/** HEAD でファイルの大きさ。無ければ undefined。届かない・5xx は「無い」と同じに扱う（待つ／その場で組み立てる） */
async function headSize(url) {
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return undefined;
    const n = Number(res.headers.get("content-length"));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** その commit の回の一覧（鍵なし。回数制限・403・429 は error） */
async function fetchRuns(runsUrl, commit) {
  const url = `${runsUrl}${runsUrl.includes("?") ? "&" : "?"}head_sha=${commit}&per_page=20`;
  try {
    const res = await fetch(url, { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30_000) });
    if (res.status === 403 || res.status === 429) return { error: `回数制限（${res.status}、残り ${res.headers.get("x-ratelimit-remaining") ?? "?"}）` };
    if (res.status === 404) return { list: [] }; // workflow がまだ無いリポジトリ
    if (!res.ok) return { error: `${res.status} を返しました` };
    const body = await res.json();
    return { list: Array.isArray(body?.workflow_runs) ? body.workflow_runs : [] };
  } catch (err) {
    return { error: errorText(err) };
  }
}

async function fetchText(url) {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
    if (!res.ok) skip(`${url} が ${res.status} を返しました`);
    return await res.text();
  } catch (err) {
    if (err instanceof Skip) throw err;
    skip(`${url} を取れません：${errorText(err)}`);
  }
}

async function download(url, file, { timeoutMs, checkStop, markMs, progress }) {
  const ctrl = new AbortController();
  const deadline = Date.now() + timeoutMs;
  let stopErr;
  let timedOut = false;
  const timer = setInterval(() => {
    try {
      checkStop();
    } catch (err) {
      stopErr = err;
      ctrl.abort();
    }
    if (Date.now() >= deadline) {
      timedOut = true;
      ctrl.abort();
    }
  }, markMs);
  let done = 0;
  let lastReport = 0;
  try {
    const res = await fetch(url, { redirect: "follow", signal: ctrl.signal });
    if (!res.ok || !res.body) skip(`${url} が ${res.status} を返しました`);
    const body = Readable.fromWeb(res.body);
    body.on("data", (chunk) => {
      done += chunk.length;
      if (Date.now() - lastReport > 2000) {
        lastReport = Date.now();
        progress(done);
      }
    });
    await pipeline(body, createWriteStream(file, { mode: 0o600 }));
    progress(done);
  } catch (err) {
    if (stopErr) throw stopErr;
    if (timedOut) skip(`取ってくるのが ${Math.round(timeoutMs / 1000)} 秒で終わりませんでした（${mb(done)} MB）`);
    if (err instanceof Skip) throw err;
    skip(`取ってこられませんでした：${errorText(err)}`);
  } finally {
    clearInterval(timer);
  }
}

async function sha256Of(file) {
  const h = createHash("sha256");
  await pipeline(createReadStream(file), h);
  return h.digest("hex");
}

/** zstd を node で伸ばして tar -x に流す（外の zstd コマンドは使わない）。`-P` は付けない（先頭の `/` は既定で外れる） */
async function extract(file, out, { checkStop, markMs }) {
  const tar = spawn("tar", ["-x", "--no-same-owner", "--no-same-permissions", "-f", "-", "-C", out], { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  tar.stderr.on("data", (d) => {
    stderr += d;
  });
  const exited = new Promise((resolve) => {
    tar.on("error", (err) => resolve({ error: err }));
    tar.on("exit", (code) => resolve({ code }));
  });
  let stopErr;
  const timer = setInterval(() => {
    try {
      checkStop();
    } catch (err) {
      stopErr = err;
      tar.kill("SIGTERM");
    }
  }, markMs);
  try {
    await pipeline(createReadStream(file), zlib.createZstdDecompress(), tar.stdin).catch((err) => {
      if (!stopErr) throw err;
    });
    const r = await exited;
    if (stopErr) throw stopErr;
    if (r.error) skip(`tar を起こせません：${r.error.message}`);
    if (r.code !== 0) skip(`展開に失敗しました（tar の終了コード ${r.code}）：${stderr.trim().slice(0, 400)}`);
  } catch (err) {
    if (stopErr) throw stopErr;
    if (err instanceof Skip) throw err;
    // tar が先に落ちると、流し込む側が EPIPE で先に投げる——tar の終わりと理由を（少しだけ）待って文言に入れる
    tar.kill("SIGTERM");
    const r = await Promise.race([exited, sleep(5000).then(() => undefined)]);
    const why = stderr.trim().slice(0, 400);
    skip(`展開に失敗しました：${errorText(err)}${r?.code !== undefined ? `（tar の終了コード ${r.code}）` : ""}${why ? `：${why}` : ""}`);
  } finally {
    clearInterval(timer);
  }
}

/**
 * 展開した木を歩いて確かめる（6）。通れば印のファイルの中身を返す。
 * 種類は通常のファイル・フォルダ・symlink だけ／パスはすべて決めた場所の下／symlink は相対で、字面で解いた先が `banto/` の中／
 * hard link は木の中で数えた名前の数がリンク数に届く
 */
export function inspectTree(out) {
  const top = readdirSync(out);
  if (top.length !== 1 || top[0] !== "banto") skip(`中身の一番上が banto/ だけではありません（${top.join("・")}）`);
  /** @type {Map<string, { nlink: number, seen: number, rel: string }>} */
  const inodes = new Map();
  const walk = (rel) => {
    const abs = join(out, "banto", rel);
    const st = lstatSync(abs);
    if (rel !== "" && !underRoot(rel) && !(st.isDirectory() && isAncestorOfRoot(rel))) skip(`決めた場所の外のものがあります：banto/${rel}`);
    if (isRoot(rel)) {
      // 移す単位（根）は本物でなければ断る——node_modules・.next・dist が git の管理する場所を指す形は要らない
      const wantDir = !rel.endsWith(".json") && !rel.endsWith(".d.ts");
      if (wantDir ? !st.isDirectory() : !st.isFile()) skip(`決めた場所の根が${wantDir ? "フォルダ" : "ファイル"}ではありません：banto/${rel}`);
    }
    if (st.isSymbolicLink()) {
      const target = readlinkSync(abs);
      if (posix.isAbsolute(target)) skip(`絶対パスを指すリンクがあります：banto/${rel} → ${target}`);
      const resolved = posix.normalize(posix.join(posix.dirname(rel), target));
      if (resolved === ".." || resolved.startsWith("../")) skip(`banto/ の外を指すリンクがあります：banto/${rel} → ${target}`);
      return;
    }
    if (st.isDirectory()) {
      if (rel !== "" && !underRoot(rel) && !isAncestorOfRoot(rel)) skip(`決めた場所の外のフォルダがあります：banto/${rel}`);
      for (const name of readdirSync(abs)) walk(rel === "" ? name : `${rel}/${name}`);
      return;
    }
    if (!st.isFile()) skip(`ファイル・フォルダ・リンク以外のもの（デバイス等）があります：banto/${rel}`);
    if (!underRoot(rel)) skip(`決めた場所の外のファイルがあります：banto/${rel}`);
    if (st.nlink > 1) {
      const key = `${st.dev}:${st.ino}`;
      const e = inodes.get(key) ?? { nlink: st.nlink, seen: 0, rel };
      e.seen += 1;
      inodes.set(key, e);
    }
  };
  walk("");
  for (const e of inodes.values()) {
    if (e.seen < e.nlink) skip(`木の外に名前を持つ hard link があります：banto/${e.rel}`);
  }
  let marker;
  try {
    marker = JSON.parse(readFileSync(join(out, "banto", ".banto-prebuilt.json"), "utf8"));
  } catch (err) {
    skip(`印のファイル（.banto-prebuilt.json）を読めません：${errorText(err)}`);
  }
  return marker;
}

/** 印の中身を確かめる（6） */
export function checkMarker(marker, commit, { nodeVersion = process.versions.node } = {}) {
  if (marker?.commit !== commit) skip(`印の commit（${marker?.commit}）が組み立てる commit（${commit}）と違います`);
  if (marker.platform !== "linux-x64") skip(`印の platform が linux-x64 ではありません（${marker.platform}）`);
  if (typeof marker.run !== "string" || !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/actions\/runs\/\d+$/.test(marker.run)) {
    skip(`印の run の形が違います（${JSON.stringify(marker.run)}）`);
  }
  const major = (v) => String(v ?? "").split(".")[0];
  if (major(marker.node) !== major(nodeVersion)) skip(`組み立てた Node.js（${marker.node}）とこの機械の Node.js（${nodeVersion}）の major が違います`);
  // CPU（AVX2）は見ない（改訂・2026-10-17）——AVX2 に頼っていたのは opencode だけで、依存から外した（使うときに core が
  // 動かす機械の CPU で選んで取ってくる、アーキ仕様 §4.1「エージェントの本体を取ってくる」）
}

/** 移す単位（決めた場所の根）のうち、展開した木にあるもの */
function rootsIn(out) {
  const roots = [];
  const base = join(out, "banto");
  for (const rel of FIXED) if (existsSync(join(base, rel))) roots.push(rel);
  for (const group of ["packages", "packages/modules"]) {
    const dir = join(base, group);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (group === "packages" && name === "modules") continue;
      const rel = `${group}/${name}/dist`;
      if (DIST.some((re) => re.test(rel)) && existsSync(join(base, rel))) roots.push(rel);
    }
  }
  return roots;
}

/**
 * `--dry-run` 用：その commit の組み立て済みがあるかを HEAD で1回だけ見る（API までは聞かない）。返すのは人に見せる1行
 */
export async function previewPrebuilt({ commit, originUrl, prebuiltBase }) {
  if (process.arch !== "x64") return `使いません（この機械は ${process.arch}）`;
  if (typeof zlib.createZstdDecompress !== "function") return `使いません（この node ${process.version} は zstd を伸ばせない）`;
  let base = prebuiltBase?.replace(/\/$/, "");
  if (!base) {
    const repo = githubRepoOf(originUrl);
    if (!repo) return `使いません（取り込み元が GitHub ではありません：${originUrl ?? "origin がありません"}）`;
    base = `https://github.com/${repo}/releases/download`;
  }
  const url = `${base}/${tagOf(commit)}/${assetOf(commit)}`;
  const size = await headSize(url);
  return size !== undefined
    ? `あります（${mb(size)} MB、${url}）——取ってきて重ねます`
    : `まだありません（${url}）——GitHub で組み立て中なら待ち、無ければその場で組み立てます`;
}
