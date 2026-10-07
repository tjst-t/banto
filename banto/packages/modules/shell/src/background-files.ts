// **待たずに流したコマンドの置き場**（決定・2026-10-07、docs/specs/v4-modules.md §2.3「待たない形」）。
//
// 1つのコマンドに1つのフォルダ（`<Shell の置き場>/commands/<commandId>/`）。書き手は決まっている：
//   - `job.json`：Shell（流したとき・止めると頼んだとき）
//   - `started.json`・`exit.json`・`output.log`：起動役（`background-wrapper.ts`）
// Shell と起動役は別のプロセスで、起こし直しをまたぐ——どちらもここだけを見て状態を決める（規則3）。
// 起動役も読むので、このファイルは node の標準だけで書く。

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Shell が流したときに書く記録。**札そのものは書かない**（指紋だけ） */
export interface JobRecord {
  id: string;
  command: string;
  /** 絶対パス */
  cwd: string;
  /** ISO 8601 */
  startedAt: string;
  /** 秒。無ければ上限なし */
  timeoutSec?: number;
  /** 書き出した `secretFiles`（絶対パス）。コマンドが終わったら起動役が消す（消せずに終わったら Shell が消す） */
  secretFiles?: string[];
  /** 返信用の札の指紋（`replyToFingerprint`）。起き直した host の問いと照らす */
  replyToFingerprint: string;
  /** 流した Thread（host が刻んだ印）。止める口・一覧はこれで持ち主を見る */
  requestedBy?: { projectId: string; threadId: string };
  /** 中継で流した Module（host が刻んだ印） */
  requestedByModule?: { name: string; conn: string };
  /** systemd の単位の名前（`banto-shell-<id>`） */
  unit: string;
  /** `cancelCommand` で止めると頼んだ時刻。これが無いのに止められたものは「外から止められた」 */
  cancelRequestedAt?: string;
}

/** 起動役が起きてすぐ書く。pid の使い回しは開始時刻で見分ける */
export interface StartedRecord {
  pid: number;
  startTicks?: number;
  at: string;
}

/** 起動役が終わるときに書く。**終了コードは systemd の単位の状態に頼らない**（`--collect` の単位は終わると消える） */
export interface ExitRecord {
  at: string;
  code: number | null;
  signal: string | null;
  /** 起動役が SIGTERM・SIGINT・SIGHUP を受けた（`cancelCommand`・人の `systemctl stop`・コンテナの停止） */
  stopRequested: boolean;
  timedOut: boolean;
  /** 出力の総量（バイト）。保存は `OUTPUT_SAVE_BYTES` まで */
  outputBytes: number;
  capped: boolean;
  /** 出力の末尾（`tailLines` で整えたもの）。保存を越えたあとも本当の終わり */
  tail: string;
  /** 起こせなかった・環境を読めなかった等 */
  error?: string;
}

export const JOB_FILE = "job.json";
export const STARTED_FILE = "started.json";
export const EXIT_FILE = "exit.json";
export const OUTPUT_FILE = "output.log";

/** 1本のコマンドの出力を保存する上限（待つ形の `saveBytes` と同じ 64 MiB）。越えた分は書かない——出力の量では止めない */
export const OUTPUT_SAVE_BYTES = 64 * 1024 * 1024;

/**
 * **届ける末尾の大きさ**。行数はユーザーの決定（50 行）。1行が極端に長い（圧縮した JS・進捗の `\r` の連なり）と
 * 1通が膨らむので、1行と全体にも上限を置く——届けた本文は会話に積まれ、AI の文脈にそのまま入る
 */
export const TAIL_LIMITS = { lines: 50, lineChars: 1_000, totalChars: 16_000 } as const;

export const jobPath = (dir: string, id: string, file: string) => join(dir, id, file);

/** 一時ファイルに書いてから置き換える——読み手（別のプロセス）が書きかけを読まない */
export function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

/** 無ければ undefined。**読めないものは投げる**（壊れた記録を「無い」にしない——規則2） */
export function readJsonIfExists<T>(path: string): T | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  return JSON.parse(text) as T;
}

/**
 * 出力の終わりから、届ける末尾を作る。`fromMiddle` は「text が途中から始まっている」（ファイルの終わりだけを
 * 読んだ・手元に後ろだけを持っている）——最初の行は頭が欠けているので「…」を付ける（捨てると、極端に長い1行が
 * 丸ごと消える）
 */
export function tailLines(text: string, fromMiddle = false, limits: { lines: number; lineChars: number; totalChars: number } = TAIL_LIMITS): string {
  // 端末の進捗表示（`\r` で同じ行を書き直す）は、最後に見えている姿だけ残す
  let lines = text.split("\n").map((l) => {
    const cr = l.replace(/\r+$/, "").lastIndexOf("\r");
    return cr === -1 ? l.replace(/\r+$/, "") : l.slice(cr + 1);
  });
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (fromMiddle && lines.length > 0) lines[0] = `…${lines[0]}`;
  const picked = lines.slice(-limits.lines).map((l) =>
    l.length > limits.lineChars ? `${l.slice(0, limits.lineChars)}…（この行の残り ${l.length - limits.lineChars} 文字を省きました）` : l,
  );
  // 全体の上限は**新しい行から**数える——終わり（エラーのまとめ・終了の表示）を残す
  const kept: string[] = [];
  let total = 0;
  for (let i = picked.length - 1; i >= 0; i--) {
    total += picked[i]!.length + 1;
    if (total > limits.totalChars && kept.length > 0) break;
    kept.unshift(picked[i]!);
  }
  return kept.join("\n");
}

/** プロセスの開始時刻（起動からの clock tick）。読めなければ undefined（もう居ない・/proc が無い） */
export function startTicksOf(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // 2つめの欄（comm）は括弧の中に空白を含みうる——最後の ')' の後ろから数える
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(rest[19]);
    return Number.isFinite(ticks) ? ticks : undefined;
  } catch {
    return undefined;
  }
}

/** 起動役がまだ居るか。pid が使い回されていたら（開始時刻が違えば）居ない */
export function wrapperAlive(started: StartedRecord): boolean {
  if (!Number.isInteger(started.pid) || started.pid <= 1) return false;
  try {
    process.kill(started.pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  const now = startTicksOf(started.pid);
  // ゾンビ（親が刈る前）も居ない扱い
  if (now !== undefined && isZombie(started.pid)) return false;
  return now === undefined || started.startTicks === undefined || now === started.startTicks;
}

function isZombie(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch {
    return false;
  }
}
