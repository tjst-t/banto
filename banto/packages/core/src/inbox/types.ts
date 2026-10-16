// docs/specs/v4-architecture.md §2.4「受信箱——人のところに来るもの」の型。
// 判断待ち・レビュー待ちを1つの入れ物にまとめ、判断待ちを先に表示する。

export type InboxItemId = string;

/** `relay`＝Module 間中継の初回承認（host 自身が発生源、docs/specs/v4-frontend.md
 *  「Module 間中継の承認」）。**発生源が誰かであって、答え方の種類ではない。** */
export type JudgmentSource = "elicitation" | "text" | "factory" | "alarm" | "relay" | "message" | "automation" | "memory";

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
  /**
   * **この判断待ちが属する、AI の tool 呼び出しの id**（Runner の tool_use の id。追加・2026-10-05）。中継の承認・Module の
   * 質問は tool 呼び出しの**中で**起きるので `toolCallId`（承認する呼び出しそのもの）は無い——代わりにこれで外側の
   * 呼び出しに結びつける。起き直したあとの続きの文が「どの呼び出しが人を待ったまま無効になったか」を書くのに使う
   * （`delivery/turn-continuation.ts`）。決まらなければ無い
   */
  withinToolCallId?: string;
  /** 承認する tool の引数（決定・2026-09-06）——何を承認するのかを人に見せるため。 */
  toolInput?: unknown;
  /** どのサーバが聞いているか（§2.4.1 の MUST）。 */
  serverName?: string;
  /**
   * **答えの選択肢**（追加・2026-10-01）。無ければ「許可する／拒否する」。Project をまたぐメッセージの承認は
   * 「許可し、以後この Project からは聞かない」を足す（アーキ仕様 §4.2）
   */
  choices?: string[];
  liveness: JudgmentLiveness;
  answer?: unknown;
  createdAt: string;
}

export interface ReviewItem {
  kind: "review";
  id: InboxItemId;
  threadId: string;
  summary: string;
  /** 自動化の回のターンの終わり（追加・2026-10-15、アーキ仕様 §4.3「受信箱」）。無ければふつうのターンの終わり */
  automation?: ReviewAutomation;
  acknowledged: boolean;
  createdAt: string;
}

/**
 * **人が見ないといけない回**（アーキ仕様 §4.3「受信箱」）。`decisions`＝まとめに決めることがある、`waiting`＝判断待ちで
 * 止まった、`failed`＝失敗した・止めた・途中で切れた。自動化の「受信箱に出すか」に依らず出し、後の回で置き換えない
 */
export type ReviewAttention = "decisions" | "waiting" | "failed";

/** 自動化の回のレビュー待ちが、どの回のどのターンのものか */
export interface ReviewAutomation {
  id: string;
  runId: string;
  attention?: ReviewAttention;
  /**
   * そのターンの始まりの seq と結末。後の回が同じ Thread で走っても（毎回まっさらでも発言は記録に残る）、置き換えずに
   * 残したカードがそのターンの中身を出せるように。結末はそのターンのもの（あとで変わらない）
   */
  startedSeq: number;
  outcome?: "completed" | "stopped" | "failed" | "interrupted";
  /** この Thread の、まだ見ていない回の数え始め（最初の未確認の回が動いた時刻。置き換えたカードから引き継ぐ） */
  since: string;
  /** レビュー待ちを出した出来事の seq（fold が付ける）。そのターンの発言はこれより前 */
  raisedSeq: number;
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
  /**
   * **どの会話で起きたか**（追加・2026-10-15、アーキ仕様 §2.4）。受信箱のカードから、その会話へ移る口に使う。
   * 分かるときだけ（届いたが起こさなかった宛先・Fork を立てなかった親・続けるターン・Module の呼び出し元の会話）。
   * **重ならない鍵には入れない**——同じことは会話が違っても1件
   */
  threadId?: string;
  /** 同じことを何度も積まないための鍵（例：`module-connect:filesystem`）。 */
  dedupeKey: string;
  title: string;
  detail: string;
  /**
   * **人が「続ける」を押せる**（追加・2026-10-05、アーキ仕様 §2.5「上限」）。起こし直しのたびに切れるので自動で
   * 続けるのをやめたターン。押すと host がそのターンの続きを起こす（`POST /api/inbox/:id/resume`）
   */
  resume?: { threadId: string; turnId: string };
  acknowledged: boolean;
  createdAt: string;
}

export type InboxItem = JudgmentItem | ReviewItem | NoticeItem;

export interface InboxReadModel {
  items: Map<InboxItemId, InboxItem>;
}
