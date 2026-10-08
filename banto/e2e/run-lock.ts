// **同じ機械の E2E は一度に1回**（追加・2026-10-08、ユーザー）。
//
// 回ごとに port・置き場は分かれている（`config.ts`）ので、2つの回が同時に走ってもデータは混ざらない。それでも
// **incusd と CPU は機械に1つ**——別の作業ツリーの E2E（Factory が3件同時に流すと起きる）と重なると、コンテナの
// 起動が遅れ、待ちの上限に当たって落ちる。落ちた試験を見ても、原因が隣の回だとは分からない。
//
// そこで Playwright の主プロセスが**最初に**（webServer を起こす前に）機械全体のロックを取る。取れなければ**断らずに
// 待つ**（待っていることを一定間隔で言う）。
//
//   - 置き場は HOME に依らない固定の場所（`/tmp`）。人の Shell と Factory・サブエージェントは HOME が違う
//   - 中身は持ち主の pid・その起動時刻・作業ツリー・始めた時刻。**持ち主が死んでいれば奪ってよい**（SIGKILL で落ちた回が
//     残したもの）。pid の使い回しに引っかからないよう、/proc の起動時刻まで比べる
//   - worker と webServer の子は config を読み直すので、env の印（`BANTO_E2E_LOCK_HELD`）があれば取らない（二重に
//     取ろうとして自分を待つと、終わらない）
//   - 回の終わり（成功・失敗・Ctrl-C）で外す——主プロセスの `exit` で消す。SIGKILL なら残るが、次の回が pid で見抜く
//   - `BANTO_E2E_NO_LOCK=1` で取らない（切り分け用）
//
// Node に flock は無いので、**中身を書き終えた一時ファイルを link(2) で置く**——link は置き場に既にあれば失敗し、
// 置けたときには中身が揃っている（O_EXCL で作ってから書くと、読んだ側が空のファイルを見る隙がある）。
import { linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { isAlive, sleepSync } from "./containers.ts";

const LOCK_PATH = "/tmp/banto-e2e.lock";
const HELD_ENV = "BANTO_E2E_LOCK_HELD";
/** 待つ上限。フル E2E 1回（約1時間）の3倍——これを超えて待つなら、前の回が止まっているのを疑う */
const MAX_WAIT_MS = 3 * 60 * 60 * 1000;
const REPORT_EVERY_MS = 30_000;
const POLL_MS = 2_000;

interface Owner {
  pid: number;
  /** /proc/<pid>/stat の起動時刻（clock tick）。pid の使い回しを見抜く */
  startTime: string | null;
  worktree: string;
  startedAt: string;
  host: string;
}

function procStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // 2つ目のコマンド名は括弧つきで空白を含みうるので、閉じ括弧の後ろから数える（22番目が starttime）
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

function readOwner(): Owner | null | "unreadable" {
  let text: string;
  try {
    text = readFileSync(LOCK_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return "unreadable";
  }
  try {
    return JSON.parse(text) as Owner;
  } catch {
    return "unreadable";
  }
}

function ownerAlive(owner: Owner): boolean {
  if (!isAlive(owner.pid)) return false;
  // 読めない（他人のプロセス等）なら生きている扱い——奪いすぎるより待ちすぎるほうが安全
  const now = procStartTime(owner.pid);
  return owner.startTime === null || now === null || now === owner.startTime;
}

function describe(owner: Owner): string {
  return `pid ${owner.pid}・作業ツリー ${owner.worktree}・始めた時刻 ${owner.startedAt}`;
}

/** 持ち主の死んだロックを外す。外す前に横へ退けて、退けたものが見た持ち主のままかを確かめる（別の回が奪い直した後のを消さない） */
function removeStale(stale: Owner): void {
  const aside = `${LOCK_PATH}.stale-${process.pid}-${Date.now()}`;
  try {
    renameSync(LOCK_PATH, aside);
  } catch {
    return; // 別の回が先に外した
  }
  const moved = (() => {
    try {
      return JSON.parse(readFileSync(aside, "utf8")) as Owner;
    } catch {
      return null;
    }
  })();
  if (moved && (moved.pid !== stale.pid || moved.startedAt !== stale.startedAt)) {
    // 退けたのは、読んでから退けるまでの間に別の回が置いた生きたロック——戻す（もう誰かが置いていれば、そちらが持ち主）
    try {
      linkSync(aside, LOCK_PATH);
    } catch {
      // 置けなかった：その間にさらに別の回が取った。どちらか一方だけが走る形は崩れない
    }
  }
  try {
    unlinkSync(aside);
  } catch {
    // もう無い
  }
}

/**
 * 機械全体のロックを取るまで待つ。Playwright の主プロセスで1回だけ取り、子は印を見て何もしない。
 * 上限を超えたら理由つきで投げる（黙って並走しない）
 */
export function acquireMachineLock(worktree: string): void {
  if (process.env.BANTO_E2E_NO_LOCK === "1") {
    if (!process.env[HELD_ENV]) console.warn("[e2e] BANTO_E2E_NO_LOCK=1——機械全体のロックを取らずに走る（別の E2E と重なりうる）");
    process.env[HELD_ENV] = "off";
    return;
  }
  if (process.env[HELD_ENV]) return; // 主プロセスが取っている（worker・webServer の子）

  const me: Owner = {
    pid: process.pid,
    startTime: procStartTime(process.pid),
    worktree,
    startedAt: new Date().toISOString(),
    host: hostname(),
  };
  const tmp = `${LOCK_PATH}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(me), { mode: 0o666 });
  const started = Date.now();
  let lastReport = 0;
  try {
    for (;;) {
      try {
        linkSync(tmp, LOCK_PATH);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new Error(`[e2e] 機械全体のロック（${LOCK_PATH}）を置けません：${(err as Error).message}`);
        }
      }
      const owner = readOwner();
      if (owner === null) continue; // 読む間に外れた——すぐ取り直す
      if (owner !== "unreadable" && !ownerAlive(owner)) {
        console.log(`[e2e] 前の E2E（${describe(owner)}）は居ないので、残ったロックを外す`);
        removeStale(owner);
        continue;
      }
      const waited = Date.now() - started;
      if (waited > MAX_WAIT_MS) {
        throw new Error(
          `[e2e] 別の E2E が ${Math.round(waited / 60000)} 分たっても終わらないので止めます` +
            `（${owner === "unreadable" ? `${LOCK_PATH} が読めない` : describe(owner)}）。` +
            `止まっているなら、その回を止めるか ${LOCK_PATH} を消してください`,
        );
      }
      if (Date.now() - lastReport >= REPORT_EVERY_MS) {
        lastReport = Date.now();
        console.log(
          `[e2e] 別の E2E（${owner === "unreadable" ? `${LOCK_PATH} が読めない` : describe(owner)}）が終わるのを待っています` +
            `（${Math.round(waited / 1000)} 秒）`,
        );
      }
      sleepSync(POLL_MS);
    }
  } finally {
    unlinkSync(tmp);
  }
  if (Date.now() - started > POLL_MS) console.log(`[e2e] 機械全体のロックを取った（${Math.round((Date.now() - started) / 1000)} 秒待った）`);
  process.env[HELD_ENV] = String(process.pid);
  // 回の終わりで外す。Playwright は Ctrl-C でも自分で終わる（exit が走る）。SIGKILL は次の回が pid で見抜く
  process.on("exit", () => {
    const owner = readOwner();
    if (owner && owner !== "unreadable" && owner.pid === process.pid) {
      try {
        unlinkSync(LOCK_PATH);
      } catch {
        // もう無い
      }
    }
  });
}
