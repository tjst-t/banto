// **返信用の札**（決定・2026-09-25、アーキ仕様 §4.2——Slack の `response_url` と同じ形、規則12）。
//
// Module に Thread の id を渡さない。AI が「終わったら届ける」tool（`dev.banto/deliversLater`）を呼んだとき、
// host が**その呼び出し元の Thread に結びついた札**を出し、Module はその札で届ける。札は推測できない印で、
// 期限（24時間）と回数（5回）があり、**札を渡した Module 以外は使えない**——他の Thread・他の Project に届かない。
//
// **返事待ちの札**（tool の結果が `dev.banto/pendingReply`）は期限で切らない——Module が「あとで届ける」と約束した
// ものなので、届くか、Module が止まって host が代わりに「途中で終わりました」を届けるまで生かす。返事待ちは
// Event Store にも残る（`reply.awaiting`、host を起動し直しても分かる）。札そのもの（印）は覚え直さない
// ——起動し直せば Module も立て直しで、前の札を使う者はいない。

import { randomBytes } from "node:crypto";

export const REPLY_LIMITS = {
  ttlMs: 24 * 60 * 60 * 1000,
  uses: 5,
} as const;

/**
 * **バックグラウンドの仕事を人に見せるための手がかり**（追加・2026-10-03、v4-frontend.md §6.33）。札を出すときに host が
 * 呼び出しから作る——Module には聞かない。サイドバーが「どの Thread で何が動いているか」を出し、押せば会話の
 * カードと同じ画面（`resourceUri`、`toolCallId` の呼び出し）を開く
 */
export interface BackgroundWork {
  /** 呼んだ tool の名前（Module の中の名前） */
  toolName: string;
  /** Runner の tool_use の id（会話の記録の toolCallId と同じ）。Runner が渡さなければ無い */
  toolCallId?: string;
  /** tool の画面（`_meta.ui.resourceUri`）。無ければ開く画面は無い */
  resourceUri?: string;
  /** カード（`dev.banto/card`）の題と説明を、その呼び出しの引数で埋めたもの */
  title?: string;
  description?: string;
}

export interface ReplyHandle {
  threadId: string;
  projectId?: string;
  /** 札を渡した Module の接続名（Project ごとの Module は `<名前>-<projectId>`） */
  connName: string;
  /** 札を渡した Module の宣言上の名前 */
  moduleName: string;
  /** 札を出したターンのホップ数（人が送ったターン＝0） */
  hop: number;
  expiresAt: number;
  usesLeft: number;
  awaiting: boolean;
  work?: BackgroundWork;
}

export class ReplyHandles {
  private readonly handles = new Map<string, ReplyHandle>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(input: {
    threadId: string;
    projectId?: string;
    connName: string;
    moduleName: string;
    hop: number;
    work?: BackgroundWork;
  }): string {
    this.forgetExpired();
    const id = `reply_${randomBytes(24).toString("base64url")}`;
    this.handles.set(id, {
      ...input,
      expiresAt: this.now() + REPLY_LIMITS.ttlMs,
      usesLeft: REPLY_LIMITS.uses,
      awaiting: false,
    });
    return id;
  }

  /**
   * 使ってよいかを確かめて1回分使う。**だめなら理由を返す**（黙って落とさない——呼んだ Module に言う）
   */
  use(id: string, caller: { connName?: string; moduleName: string }): ReplyHandle | { error: string } {
    const h = this.handles.get(id);
    if (!h) return { error: "返信用の札が見つかりません（期限切れか、banto を起動し直した）" };
    if (!h.awaiting && h.expiresAt < this.now()) {
      this.handles.delete(id);
      return { error: "返信用の札の期限が切れています" };
    }
    // **札を渡した相手と同じ Module か**——合言葉を持つ別の Module が札を拾っても使えない
    if (caller.moduleName !== h.moduleName || (caller.connName !== undefined && caller.connName !== h.connName)) {
      return { error: "この返信用の札は、あなたに渡したものではありません" };
    }
    if (h.usesLeft <= 0) return { error: `返信用の札は ${REPLY_LIMITS.uses} 回まで使えます（使い切りました）` };
    h.usesLeft -= 1;
    return h;
  }

  get(id: string): ReplyHandle | undefined {
    return this.handles.get(id);
  }

  /** 返事待ちにする（期限で切らない）。 */
  markAwaiting(id: string): ReplyHandle | undefined {
    const h = this.handles.get(id);
    if (h) h.awaiting = true;
    return h;
  }

  /** 返事が済んだ（最後の届け・代わりの「途中で終わりました」）。 */
  settle(id: string): void {
    this.handles.delete(id);
  }

  /** その接続に渡した返事待ちの札（Module が止まったとき、代わりに届ける先） */
  awaitingFor(connName: string): Array<[string, ReplyHandle]> {
    return [...this.handles.entries()].filter(([, h]) => h.awaiting && h.connName === connName);
  }

  private forgetExpired(): void {
    const now = this.now();
    for (const [id, h] of this.handles) if (!h.awaiting && h.expiresAt < now) this.handles.delete(id);
  }
}
