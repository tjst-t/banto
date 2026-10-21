// **host から画面への出来事の流れ**（決定・2026-09-25、`docs/specs/v4-frontend.md` §6.8「host が始めたターンにも繋ぐ」）。
//
// 届いたもので host が自分でターンを始めるようになったので、開いている画面が「知らないうちに始まった」ターンに
// 気づく道が要る。**ポーリングはしない**（受信箱で踏んだ——再描画が assistant-ui のランタイムを壊した）。
// 流すのは「何が起きたか」の知らせだけで、中身は画面が既存の口で取りに行く（繋ぎ直す・記録を読む・受信箱）。

import type { AwaitingReply, MissionState, ProjectStart, ThreadClosedBy } from "../project-thread/types.js";
import type { RuntimeMoveChange } from "../runtime/project-move.js";
import type { IdleCompactionView } from "../delivery/idle-compaction.js";
import type { BackgroundSummaryOf } from "../delivery/background-summaries.js";
import type { BackgroundView } from "@banto/module-contract";

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
  /**
   * **結果で名乗った画面**（追加・2026-10-21、アーキ仕様 §4.2「結果で名乗る画面」、Backlog #489）。定義に画面（`resourceUri`）を
   * 持たない tool だけ。画面はその Module の入口を `canvasView`＝`select` で開く
   */
  view?: BackgroundView;
  /**
   * **人が頼んだ要約**（追加・2026-10-21、アーキ仕様 §4.2「札の手がかりを Module があとから足す」の 3.、Backlog #489）。host の
   * メモリの表から重ねる（Event Store には無い）。`summaryAt` は作った時刻（ISO）
   */
  summary?: string;
  summaryAt?: string;
}

/**
 * 返事待ちの札から、画面に見せる1件ずつを作る。**要約の表を重ねるのはここ1か所**（アーキ仕様 §4.2 の 3.）——呼び元は必ず
 * 表を渡す。AI に見せる文を作る呼び元（`describeBackgroundItems`・`closeForkDroppedNote`）は `WITHOUT_SUMMARIES` を渡す
 * （要約は人が頼んだもので、AI には渡さない——§4.1「4.」）
 */
export function backgroundItemsOf(awaiting: readonly AwaitingReply[] | undefined, summaries: BackgroundSummaryOf): BackgroundItem[] {
  return (awaiting ?? []).map((r) => {
    const s = summaries(r.replyTo);
    return {
      module: r.moduleName,
      since: r.since,
      ...(r.work ?? {}),
      ...(r.keptAt ? { keptAt: r.keptAt } : {}),
      ...(r.keptAfter ? { keptAfter: r.keptAfter } : {}),
      ...(s ? { summary: s.summary, summaryAt: s.summaryAt } : {}),
    };
  });
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
  // その Thread の任務が変わった（追加・2026-10-20、v4-frontend.md §6.47）。**今の任務を丸ごと**送る（画面は置き換える）。
  // 会話の札と面・サイドバーの1行・受信箱の「枠を延ばす」に使う
  | { type: "mission.changed"; threadId: string; projectId?: string; mission: MissionState }
  // 空いた会話の冷める前の要約の様子が変わった（追加・2026-10-20、アーキ仕様 §3.1）。`at` があれば予定がある（`noticeAt` から会話に
  // 「まもなく要約します」の帯）、`compacting` は要約している。`warms`・`warmTokens` は温め直しの回数と読み出しの量（文脈のメーター）
  | ({ type: "idle_compaction.changed"; threadId: string; projectId?: string } & IdleCompactionView)
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
  | { type: "code.transfer"; runtime: string; projectIds: string[]; transfer?: CodeTransferView }
  // 新しい Project の始め方の仕事（別のサーバの clone・新しいリポジトリ。追加・2026-10-20、v4-frontend.md §6.49）。記録が
  // 変わるたびに丸ごと。会話の上の帯に使う
  | { type: "project.start.changed"; projectId: string; start: ProjectStart };

/** 別のサーバへコードを送っている途中の1件（大きさは縮める前のバイト数） */
export interface CodeTransferView {
  sentBytes: number;
  totalBytes: number;
  startedAt: string;
  /** 送れなかった理由（次に送り始めるまで残る） */
  failed?: string;
  /** コンテナの土台のイメージを作っている段（containers の最初の1回。あればバイト数ではなくこれを見せる） */
  baseImage?: string;
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
