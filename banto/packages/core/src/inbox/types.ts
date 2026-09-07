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

export type InboxItem = JudgmentItem | ReviewItem;

export interface InboxReadModel {
  items: Map<InboxItemId, InboxItem>;
}
