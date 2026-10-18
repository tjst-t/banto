// **受信箱は「あなたの番になったもの」だけ・受信箱の中で読んで答える**（改訂・2026-10-15、ユーザー。アーキ仕様 §2.4
// 「受信箱は『あなたの番になったもの』だけ」・v4-frontend.md §6.41）。
//
// - レビュー待ちを出すか（`reviewDueAfterTurn`）：ターンが終わったとき、その Thread に裏の仕事（返事待ちの札）も、まだ
//   渡していない届いたものも残っていなければ出す。途中で切れた・失敗したターンは残りがあっても出す（人が見ないと進まない）
// - レビュー待ちに添える**そのターンの中身**（`reviewTurnOf`）：読むたびに Thread の記録から組む。Event Store の形は変えない
//   ——頼んだこと・AI の最後の返事・まとめ・結末・tool の数
import type { ThreadState, TurnOutcome } from "../project-thread/types.js";

/** AI の返事の本文は、ここまで添える（超えたら切って `replyTruncated`） */
export const REVIEW_REPLY_MAX_CHARS = 8000;
/** まとめが無いときの「頼んだこと」（人の最後の発言の頭）は、ここまで */
export const REVIEW_REQUEST_MAX_CHARS = 400;

/**
 * ターンの結末。`TurnOutcome` に、**終わりを書く前に止まった**（host が落ちた・起こし直した）`interrupted` を足したもの
 */
export type ReviewTurnOutcome = TurnOutcome | "interrupted";

export interface ReviewTurn {
  /** まとめの `request`。無ければ人の最後の発言の頭 */
  request?: string;
  /** AI の最後の発言の本文（そのターンのもの）。無ければ無い */
  reply?: string;
  replyTruncated?: true;
  /** そのターンのまとめ（`report_turn` の中身そのまま） */
  summary?: Record<string, unknown>;
  /** 走っている間は無い */
  outcome?: ReviewTurnOutcome;
  /** そのターンで AI が呼んだ tool の数（まとめ・決まったことの記録は数えない）。会話の記録が読めなければ無い */
  toolCalls?: number;
}

/** 最後に始めたターンの結末。走っている・1度も走っていなければ無い */
function outcomeOf(thread: Pick<ThreadState, "lastTurn">, running: boolean): ReviewTurnOutcome | undefined {
  const turn = thread.lastTurn;
  if (!turn) return undefined;
  if (turn.outcome) return turn.outcome;
  return running ? undefined : "interrupted";
}

/**
 * **ターンが終わったとき、レビュー待ちを出すか**。残りがあれば出さない——結果が届いて AI がまとめ終えた最後のターンで
 * 出る（「サブエージェントが終わった」を、途中のターンごとに積まない）。最後まで行かなかったターンは残りがあっても出す
 */
export function reviewDueAfterTurn(
  thread: Pick<ThreadState, "lastTurn" | "awaitingReplies" | "deliveries"> | undefined,
): boolean {
  if (!thread) return true;
  // **上限で終わったターンは出さない**（v4-security.md §2 の 9.）——人の番ではない（リセットのあと自動で続ける）。続けるのを
  // やめたときは「続ける」のお知らせが出ている
  if (thread.lastTurn?.rateLimit) return false;
  const outcome = outcomeOf(thread, false);
  if (outcome !== undefined && outcome !== "completed") return true;
  return (thread.awaitingReplies?.length ?? 0) === 0 && (thread.deliveries?.length ?? 0) === 0;
}

/** 長い文を頭から切る（切ったかも返す） */
function head(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

/**
 * **レビュー待ちに添えるターンの中身**を Thread の記録から組む。AI の返事は**そのターンのもの**だけ（最後に始めたターンより
 * 後ろの発言）——返事を書く前に切れたターンで、前のターンの返事を出さない
 */
export function reviewTurnOf(
  thread: Pick<ThreadState, "lastTurn" | "messages">,
  opts: {
    running: boolean;
    toolCalls?: number;
    /**
     * **最後のターンではない、前のターン**の中身を組む（追加・2026-10-15、アーキ仕様 §4.3「受信箱」——後の回で置き換え
     * なかった自動化の回のカード）。`startedSeq` より後ろ・`beforeSeq` より前の発言から組み、結末は渡したもの
     */
    earlier?: { startedSeq: number; beforeSeq: number; outcome?: ReviewTurnOutcome };
  },
): ReviewTurn {
  const earlier = opts.earlier;
  const startedSeq = earlier ? earlier.startedSeq : thread.lastTurn?.startedSeq;
  const messages = earlier ? thread.messages.filter((m) => m.seq < earlier.beforeSeq) : thread.messages;
  const reply = [...messages]
    .reverse()
    .find((m) => m.role === "assistant" && (startedSeq === undefined || m.seq > startedSeq));
  const summary = reply?.turnSummary?.summary;
  const summaryRequest = typeof summary?.request === "string" && summary.request.trim() !== "" ? summary.request : undefined;
  const human = [...messages].reverse().find((m) => m.role === "user" && !m.origin && m.text.trim() !== "");
  const request = summaryRequest ?? (human ? head(human.text.trim(), REVIEW_REQUEST_MAX_CHARS).text : undefined);
  const body = reply && reply.text.trim() !== "" ? head(reply.text, REVIEW_REPLY_MAX_CHARS) : undefined;
  const outcome = earlier ? earlier.outcome : outcomeOf(thread, opts.running);
  return {
    ...(request !== undefined ? { request } : {}),
    ...(body ? { reply: body.text, ...(body.truncated ? { replyTruncated: true as const } : {}) } : {}),
    ...(summary ? { summary } : {}),
    ...(outcome ? { outcome } : {}),
    ...(opts.toolCalls !== undefined ? { toolCalls: opts.toolCalls } : {}),
  };
}

/** 会話の鎖（SDK の `getSessionMessages`）の1件。数えるのに要る分だけ */
export interface ChainMessage {
  type: string;
  message: unknown;
}

/** 作業に数えない tool（`http/turn-summary.ts` の `NON_WORK_TOOLS` を渡す） */
export function countLastTurnToolCalls(chain: readonly ChainMessage[], nonWork: ReadonlySet<string>): number {
  const blocksOf = (m: ChainMessage): Array<{ type?: string; name?: string; text?: string }> => {
    const content = (m.message as { content?: unknown } | undefined)?.content;
    return Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : [];
  };
  // 人の側の発言（tool の結果でも、Stop hook の差し戻しでもない user）まで遡る——そこからが最後のターン
  const isHuman = (m: ChainMessage): boolean => {
    if (m.type !== "user") return false;
    const blocks = blocksOf(m);
    if (blocks.some((b) => b.type === "tool_result")) return false;
    const text = blocks.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
    return !text.trimStart().startsWith("Stop hook feedback");
  };
  let count = 0;
  for (let i = chain.length - 1; i >= 0; i--) {
    const m = chain[i]!;
    if (isHuman(m)) break;
    if (m.type !== "assistant") continue;
    for (const b of blocksOf(m)) {
      if (b.type === "tool_use" && typeof b.name === "string" && !nonWork.has(b.name)) count++;
    }
  }
  return count;
}

/**
 * **tool の数を、会話の記録（CLI の会話の鎖）から数える**。数えるのは、最後に始めたターンが resume-point を書いた
 * （CLI の側で最後まで行った）ときだけ——書いていなければ鎖の末尾は前のターンのもの。同じ resume-point なら数え直さない
 * （受信箱は出来事のたびに読み直される）
 */
export class ReviewToolCounter {
  private readonly cache = new Map<string, { key: string; count: number | undefined }>();

  constructor(
    private readonly read: (sessionId: string, dir: string | undefined) => Promise<readonly ChainMessage[]>,
    private readonly nonWork: ReadonlySet<string>,
  ) {}

  async count(
    thread: Pick<ThreadState, "id" | "lastTurn" | "resumePoint">,
    dir: string | undefined,
  ): Promise<number | undefined> {
    const turn = thread.lastTurn;
    if (!turn?.resumePointUpdated || !thread.resumePoint) return undefined;
    const key = `${turn.turnId}\u0000${thread.resumePoint}`;
    const cached = this.cache.get(thread.id);
    if (cached?.key === key) return cached.count;
    let count: number | undefined;
    try {
      const chain = await this.read(thread.resumePoint, dir);
      count = chain.length > 0 ? countLastTurnToolCalls(chain, this.nonWork) : undefined;
    } catch (err) {
      // 数えられなくても受信箱は出す（数を添えないだけ）——黙らずにログに残す（規則2）
      console.warn(`[host] ${thread.id} の会話の記録を読めず、tool の数を数えられませんでした:`, err);
      count = undefined;
    }
    this.cache.set(thread.id, { key, count });
    return count;
  }
}
