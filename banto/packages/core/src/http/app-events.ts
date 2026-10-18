// **host から画面への出来事の流れ**（決定・2026-09-25、`docs/specs/v4-frontend.md` §6.8「host が始めたターンにも繋ぐ」）。
//
// 届いたもので host が自分でターンを始めるようになったので、開いている画面が「知らないうちに始まった」ターンに
// 気づく道が要る。**ポーリングはしない**（受信箱で踏んだ——再描画が assistant-ui のランタイムを壊した）。
// 流すのは「何が起きたか」の知らせだけで、中身は画面が既存の口で取りに行く（繋ぎ直す・記録を読む・受信箱）。

import type { AwaitingReply, ThreadClosedBy } from "../project-thread/types.js";
import type { RuntimeMoveChange } from "../runtime/project-move.js";

/**
 * **バックグラウンドで動いているもの1件**（追加・2026-10-03、v4-frontend.md §6.33）。返事待ちの札（`AwaitingReply`）から
 * 人に見せてよい分だけを写す——**札そのもの（`replyTo`）は画面に出さない**（届けるための推測できない印なので）
 */
export interface BackgroundItem {
  /** 約束した Module（宣言の名前。画面を開くときの Module の名前と同じ） */
  module: string;
  /** 頼んだ時刻（ISO） */
  since: string;
  toolName?: string;
  toolCallId?: string;
  resourceUri?: string;
  title?: string;
  description?: string;
  /** 人の答えを待っている（追加・2026-10-04）。無ければ裏で仕事が進んでいる */
  waitingOn?: "human";
  /**
   * **起こし直しのあと続けている**（追加・2026-10-05、アーキ仕様 §2.5「2.」）——Module が続けると答えた時刻（ISO）。
   * 画面は「起こし直しのあと続けています」と出す
   */
  keptAt?: string;
  /** Module との接続が切れたあと続けている（追加・2026-10-17、Backlog #362）。画面は「接続が切れたあと続けています」と出す */
  keptAfter?: "disconnect";
}

export function backgroundItemsOf(awaiting: readonly AwaitingReply[] | undefined): BackgroundItem[] {
  return (awaiting ?? []).map((r) => ({ module: r.moduleName, since: r.since, ...(r.work ?? {}), ...(r.keptAt ? { keptAt: r.keptAt } : {}), ...(r.keptAfter ? { keptAfter: r.keptAfter } : {}) }));
}

export type AppEvent =
  // cause：人が送ったターンか、届いたもので host が始めたターンか（画面の帯の言い方が変わる）
  | { type: "turn.started"; threadId: string; projectId?: string; cause: "human" | "delivery" }
  | { type: "turn.ended"; threadId: string; projectId?: string }
  | { type: "inbox.changed" }
  // 判断待ちに答えが付いた（追加・2026-10-05）。**ターンの流れが無くても**会話のカードを答え済みにする——ターンが先に
  // 終わってから host が畳んだもの・受信箱で答えたもの。answer は会話のカードに出す一言（`judgmentAnswerText`）
  | { type: "judgment.answered"; threadId: string; judgmentId: string; answer: string }
  // 「端末を追加」の札が使われた（決定・2026-10-03）。札を出した画面が「端末が入りました」と出す
  | { type: "auth.device_added"; codeId: string; label: string }
  // その Thread のバックグラウンドの仕事が増えた・減った。**その Thread の分を丸ごと**送る（画面は置き換える）
  | { type: "background.changed"; threadId: string; projectId?: string; items: BackgroundItem[] }
  // 上限が戻るのを待っている Thread が変わった（追加・2026-10-18、v4-frontend.md §6.46）。`continueAt` があれば待っている（その時刻に
  // 自動で続ける）、無ければ待っていない。会話の待ちの帯とサイドバーの1行に使う
  | { type: "rate_limit_wait.changed"; threadId: string; projectId?: string; continueAt?: string }
  // Thread が閉じた（追加・2026-10-08、アーキ仕様 §2.2「AI が自分の Fork を閉じる」）。AI が閉じた（`close_fork`）ときも、
  // 人が画面で閉じたときも。開いている画面は飛ばさず帯を出し、サイドバーは開いている一覧から外す
  | { type: "thread.closed"; threadId: string; projectId?: string; by: ThreadClosedBy; reason?: string }
  // その Project の自動化の台帳が変わった（追加・2026-10-15、v4-frontend.md §6.42）。作った・直した・止めた・消した・
  // 回を書いた。中身は流さない——開いている画面が `GET /api/projects/:id/automations` で取り直す
  | { type: "automations.changed"; projectId: string }
  // Project の一覧が変わった（追加・2026-10-16、アーキ仕様 §2.2「Project のグループとスリープ」）。作る・名前・並び・閉じる・
  // 開き直す・グループ。中身は流さない——画面が `GET /api/projects`・`GET /api/project-groups` で取り直す
  | { type: "projects.changed" }
  // 混んでいる Project とこの機械（追加・2026-10-09、v4-frontend.md §6.36）。**変わったときだけ**、全体を送る（画面は置き換える）
  | { type: "resources.busy"; busy: ResourcesBusy }
  // 3 分を超えて繋がらない別のサーバとその Project（追加・2026-10-17、Backlog #383）。**変わったときだけ**、全体を送る
  // （画面は置き換える）。サイドバーの頭文字の「!」
  | { type: "runtimes.unreachable"; unreachable: RuntimeUnreachableView[] }
  // Project を別の実行場所へ移す状況（追加・2026-10-12、Backlog #270）。移している途中は `move` を丸ごと（写している間は
  // 1秒に1回まで）、終われば `move` 無し、移せなければ `failed`。会話の面の帯・入力欄・サイドバーの印に使う
  | ({ type: "runtime_move.changed" } & RuntimeMoveChange)
  // 別のサーバへ banto のコードを送っている（追加・2026-10-12、Backlog #269）。送り始め・進むたび（間引いて）・送れなかった
  // とき（`transfer.failed`）・使えるようになったとき（`transfer` 無し）。**その実行場所の分を丸ごと**送る（画面は置き換える）
  | { type: "code.transfer"; runtime: string; projectIds: string[]; transfer?: CodeTransferView };

/** 別のサーバへコードを送っている途中の1件（大きさは縮める前のバイト数） */
export interface CodeTransferView {
  sentBytes: number;
  totalBytes: number;
  startedAt: string;
  /** 送れなかった理由（次に送り始めるまで残る） */
  failed?: string;
}

/** 3 分を超えて繋がらない別のサーバ1つ（判定は受信箱のお知らせと同じ——`modules/remote-outage.ts`） */
export interface RuntimeUnreachableView {
  /** 別のサーバの名前 */
  runtime: string;
  /** いちばん新しい失敗の理由 */
  reason: string;
  /** 最初に失敗した時刻（ISO） */
  since: string;
  /** その実行場所で動く Project */
  projectIds: string[];
}

/** 混んでいる Project とこの機械（サイドバーの印） */
export interface ResourcesBusy {
  projects: Array<{ projectId: string; reason?: string }>;
  host?: { reason?: string };
}

export class AppEventBus {
  private readonly listeners = new Set<(event: AppEvent) => void>();

  publish(event: AppEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.warn("[host] 画面への知らせの聞き手が例外を投げました:", err);
      }
    }
  }

  subscribe(listener: (event: AppEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/**
 * **Project の一覧が変わったら `projects.changed` を流す**（追加・2026-10-16、アーキ仕様 §2.2「Project のグループとスリープ」）。
 * 繋ぐのは起動のとき1回（`cli.ts`）。試験も同じ繋ぎ方を通す
 */
export function announceProjectsChanged(
  store: { onProjectsChanged(listener: () => void): () => void },
  bus: AppEventBus,
): () => void {
  return store.onProjectsChanged(() => bus.publish({ type: "projects.changed" }));
}
