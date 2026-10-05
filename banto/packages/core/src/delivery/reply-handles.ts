// **返信用の札**（決定・2026-09-25、アーキ仕様 §4.2——Slack の `response_url` と同じ形、規則12）。
//
// Module に Thread の id を渡さない。AI が「終わったら届ける」tool（`dev.banto/deliversLater`）を呼んだとき、
// host が**その呼び出し元の Thread に結びついた札**を出し、Module はその札で届ける。札は推測できない印で、
// 期限（24時間）と回数（5回）があり、**札を渡した Module 以外は使えない**——他の Thread・他の Project に届かない。
//
// **返事待ちの札**（tool の結果が `dev.banto/pendingReply`）は期限で切らない——Module が「あとで届ける」と約束した
// ものなので、届くか、Module が止まって host が代わりに「途中で終わりました」を届けるまで生かす。返事待ちは
// Event Store にも残る（`reply.awaiting`、host を起動し直しても分かる）。札そのもの（印）は、起動し直したら
// ふつうは覚え直さない——起動し直せば Module も立て直しで、前の札を使う者はいない。**例外は「起こし直しても続け
// られる」と名乗った Module が続けると答えた札**（追加・2026-10-05、アーキ仕様 §2.5「2. Module の仕事を続ける」）：
// 同じ印で覚え直し、**最後の届け1回だけ**使えるようにする（`restore`）。

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
  /**
   * **人の答えを待っている**（追加・2026-10-04）。Module が「あとで届ける」と言うときに名乗る（`dev.banto/waitingOn`）。
   * 無ければ裏で仕事が進んでいる
   */
  waitingOn?: "human";
}

/**
 * **札の宛先が Module**（追加・2026-10-05、アーキ仕様 §4.2「Module 宛ての返事」）。Module が中継で「終わったら届ける」 tool を
 * 呼んだときに出す。届いたら host がこの Module の受け口の tool（`dev.banto/receivesReplies`）を呼んで渡す
 */
export interface ReplyToModule {
  /** 呼んだ Module の接続名（届け先） */
  connName: string;
  /** 呼んだ Module の宣言上の名前 */
  moduleName: string;
  /** 呼んだ Module に見せる返事の印（札そのものではない） */
  replyId: string;
}

export interface ReplyHandle {
  /** 宛先の Thread。宛先が Module なら空文字（`toModule` を見る） */
  threadId: string;
  /** 宛先が Module のとき（これがあれば Thread には届けない） */
  toModule?: ReplyToModule;
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
  /**
   * **最後の届けにしか使えない**（追加・2026-10-05、起こし直しのあと覚え直した札——`restore`）。使える回数が1回なので、
   * 最後でない届けに使うと札が使い切られたまま片づかずに残る——断る
   */
  finalOnly?: boolean;
}

export class ReplyHandles {
  private readonly handles = new Map<string, ReplyHandle>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(input: {
    threadId: string;
    toModule?: ReplyToModule;
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
  use(id: string, caller: { connName?: string; moduleName: string }, opts: { final?: boolean } = {}): ReplyHandle | { error: string } {
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
    if (h.finalOnly && opts.final === false) {
      return { error: "banto を起こし直したあと覚え直した札は、最後の届け（final）にしか使えません" };
    }
    if (h.usesLeft <= 0) return { error: `返信用の札は ${REPLY_LIMITS.uses} 回まで使えます（使い切りました）` };
    h.usesLeft -= 1;
    return h;
  }

  /**
   * **起き直したあと、返事待ちの札を同じ印で覚え直す**（追加・2026-10-05、アーキ仕様 §2.5「2.」・レビュー 2-1）。
   * 札は Event Store の返事待ち（`reply.awaiting`）に残っている。使った回数は残っていないので、**使えるのは
   * 最後の届け1回だけ**。返事待ちのまま（期限で切らない）。札を渡した Module 以外は使えない確かめはそのまま効く
   */
  restore(id: string, input: Omit<ReplyHandle, "expiresAt" | "usesLeft" | "awaiting" | "finalOnly">): ReplyHandle {
    const h: ReplyHandle = { ...input, expiresAt: this.now() + REPLY_LIMITS.ttlMs, usesLeft: 1, awaiting: true, finalOnly: true };
    this.handles.set(id, h);
    return h;
  }

  get(id: string): ReplyHandle | undefined {
    return this.handles.get(id);
  }

  /**
   * 返事待ちにする（期限で切らない）。人の答えを待っていると名乗ったら、それも覚える
   * （名乗った `title` はカードの題より優先する——その呼び出しで何を待っているかは Module が一番よく知っている）
   */
  markAwaiting(id: string, waitingOn?: { on: "human"; title?: string }): ReplyHandle | undefined {
    const h = this.handles.get(id);
    if (!h) return h;
    h.awaiting = true;
    if (waitingOn) {
      h.work = {
        ...(h.work ?? { toolName: "" }),
        waitingOn: "human",
        ...(waitingOn.title ? { title: waitingOn.title } : {}),
      };
    }
    return h;
  }

  /** 返事が済んだ（最後の届け・代わりの「途中で終わりました」）。 */
  settle(id: string): void {
    this.handles.delete(id);
  }

  /**
   * Module 宛ての札を出す（追加・2026-10-05）。返すのは札（宛先に渡す）と返事の印（呼んだ Module に見せる）
   */
  issueToModule(input: {
    to: { connName: string; moduleName: string };
    projectId?: string;
    connName: string;
    moduleName: string;
  }): { replyTo: string; replyId: string } {
    const replyId = `rid_${randomBytes(12).toString("base64url")}`;
    const { to, ...rest } = input;
    const replyTo = this.issue({ ...rest, threadId: "", toModule: { ...to, replyId }, hop: 0 });
    return { replyTo, replyId };
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
