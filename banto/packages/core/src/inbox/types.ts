// docs/specs/v4-architecture.md §2.4「受信箱——人のところに来るもの」の型。
// 判断待ち・レビュー待ちを1つの入れ物にまとめ、判断待ちを先に表示する。

export type InboxItemId = string;

export type JudgmentSource = "elicitation" | "text" | "factory" | "alarm";

/** Elicitation由来の判断待ちの3状態（§2.4.1決定）。 */
export type JudgmentLiveness = "live" | "answered" | "timed_out";

export interface JudgmentItem {
  kind: "judgment";
  id: InboxItemId;
  threadId: string;
  source: JudgmentSource;
  message: string;
  /** Elicitationのform/urlモードの引数をそのまま使う（§2.4「自前で作らない」）。 */
  mode?: "form" | "url";
  requestedSchema?: unknown;
  url?: string;
  toolCallId?: string;
  /** 承認する tool の引数（決定・2026-09-06）——何を承認するのかを人に見せるため。 */
  toolInput?: unknown;
  /** どのサーバが聞いているか（§2.4.1 の MUST）。 */
  serverName?: string;
  liveness: JudgmentLiveness;
  answer?: unknown;
  createdAt: string;
}

export interface ReviewItem {
  kind: "review";
  id: InboxItemId;
  threadId: string;
  summary: string;
  acknowledged: boolean;
  createdAt: string;
}

/**
 * **お知らせ**——人に伝えたいが、許可/拒否を求めるものではないもの
 * （決定・2026-09-07、`module-connect-failure-surface`）。
 *
 * 最初の用途は「Module を繋げなかった」。判断待ち（judgment）は
 * **止まっているものを人が動かす**ためのもの、レビュー待ち（review）は
 * Factory の成果物を見るためのもので、どちらもここには当てはまらない
 * ——語の意味を曲げて相乗りさせない（規則11）。
 *
 * **Project 単位**（Thread ではない）。Module は Project に繋がるものなので、
 * どの会話で気づいたかは本質ではない。
 */
export interface NoticeItem {
  kind: "notice";
  id: InboxItemId;
  /** どの Project の話か。**無い＝banto 全体**（instance に1本の Module 等）。 */
  projectId?: string;
  /** 同じことを何度も積まないための鍵（例：`module-connect:filesystem`）。 */
  dedupeKey: string;
  title: string;
  detail: string;
  acknowledged: boolean;
  createdAt: string;
}

export type InboxItem = JudgmentItem | ReviewItem | NoticeItem;

export interface InboxReadModel {
  items: Map<InboxItemId, InboxItem>;
}
