// docs/specs/v4-architecture.md §2.3「ターンごとに変わるものは system prompt に
// 入れず、そのターンに添える」（決定・2026-09-05）の実装。
//
// system prompt はメッセージ列より前にあるので、1バイト変われば走行中の枝の
// キャッシュが全部崩れる（§3）。Fork Thread が親から引き継げるキャッシュも
// 同じ理由で失う。メッセージ列は追記なので、ここに置けば前方一致は壊れない。
// 手法自体は SDK も採っている（`excludeDynamicSections` は cwd・git status を
// 剥がして最初の user メッセージとして入れ直す）。

import type { PendingMemoryChange, ThreadState } from "../project-thread/types.js";

/** このタグの意味は骨格（system-prompt.ts）が説明している——人が書いた文章と
 *  混ざらないよう、必ずこの名前で囲う。 */
const TAG = "banto-turn-context";

export interface TurnContextInput {
  thread: Pick<ThreadState, "kind" | "parentThreadId">;
  /** 確定後にProjectで増えた／取り消された分（まだ届けていないものだけ）。 */
  pendingMemory: readonly PendingMemoryChange[];
  /** このThreadで人に聞いていて、まだ返事が無いもの。 */
  openJudgments: readonly { message: string }[];
  /** ターンの開始時刻。呼び出し側が渡す——ここでnew Date()しない（試験可能性）。 */
  startedAt: Date;
}

/**
 * ターンに添えるブロックを組み立てる。**必ず何かしら返る**——時刻と
 * いまいる Thread は毎回入る。
 */
export function buildTurnContext(input: TurnContextInput): string {
  const lines: string[] = [];

  // 「今日は〜」と断定しない。長いターンなら終わるころには過去になっている
  // ——断定形で書けば嘘になる（規則8の精神）。
  lines.push(`このターンの開始時刻：${formatLocalIso(input.startedAt)}`);

  lines.push(
    input.thread.kind === "fork"
      ? "いまいる Thread：Fork Thread（Base Thread から分岐したもの。同じ文脈から出た別の試み）"
      : "いまいる Thread：Base Thread（この Project の主の会話）",
  );

  const appended = input.pendingMemory.filter((m) => m.kind === "appended");
  if (appended.length > 0) {
    lines.push("", "この Thread が始まってから、別の枝で決まったこと（Memory に入っている）：");
    for (const m of appended) lines.push(`- ${m.text}`);
  }

  const invalidated = input.pendingMemory.filter((m) => m.kind === "invalidated");
  if (invalidated.length > 0) {
    lines.push("", "取り消された決定（もう従わない）：");
    for (const m of invalidated) lines.push(`- ${m.text}`);
  }

  if (input.openJudgments.length > 0) {
    lines.push("", "いま人に聞いていて、まだ返事が無いもの：");
    for (const j of input.openJudgments) lines.push(`- ${j.message}`);
  }

  return `<${TAG}>\n${lines.join("\n")}\n</${TAG}>`;
}

/** ローカルのタイムゾーンつきISO8601（`2026-09-05T18:03:12+09:00`）。
 *  `toISOString()`はUTCに変換してしまい、人の生活時間と食い違う。 */
function formatLocalIso(date: Date): string {
  const pad = (n: number, width = 2) => String(Math.floor(Math.abs(n))).padStart(width, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(offsetMinutes / 60)}:${pad(offsetMinutes % 60)}`
  );
}
