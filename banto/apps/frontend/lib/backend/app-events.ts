"use client";

// **host から画面への出来事の流れ**（決定・2026-09-25、`docs/specs/v4-frontend.md` §6.8「host が始めたターンにも繋ぐ」）。
//
// 届いたもの（待たない仕事の完了など）で host が自分でターンを始めるようになったので、開いている画面が
// 「知らないうちに始まった」ターンに気づく道が要る。**ポーリングはしない**（受信箱で踏んだ——再描画が
// assistant-ui のランタイムを壊した）。流れてくるのは「何が起きたか」だけで、中身は既存の口で取りに行く：
//   turn.started / turn.ended / hello（繋ぎ直した）→ 開いている会話に最新を出す（`latest-state.ts`）
//   inbox.changed → 受信箱を取り直す
//
// 独自のヘッダを送るので EventSource は使わない（ターンの SSE と同じく fetch で読む）。途切れたら数秒おいて
// 繋ぎ直す——**繋がっていない間も人は止めない**（開き直せば記録から見える）。黙って止まった接続も見切る
// （`readSse`）——携帯で別アプリから戻ったとき、知らせが止まったままにならない。

import { getBackendConfig, hostFetch, readSse, type RealThreadClosedBy } from "./client";
import { refreshRealInbox } from "./real-inbox";
import { noteJudgmentAnswered } from "./judgment-answers";

/** バックグラウンドで動いているもの1件（host の `BackgroundItem`、§6.33） */
export interface RealBackgroundItem {
  module: string;
  since: string;
  toolName?: string;
  toolCallId?: string;
  resourceUri?: string;
  title?: string;
  description?: string;
  /** 人の答えを待っている（公開の承認など、2026-10-04）。無ければ裏で仕事が進んでいる */
  waitingOn?: "human";
  /**
   * 起こし直しのあと Module が続けると答えた時刻（ISO。追加・2026-10-05、アーキ仕様 §2.5「2.」）。「起こし直しのあと
   * 続けています」と出す——長く届かなければ人が気づける
   */
  keptAt?: string;
  /** Module との接続が切れたあと続けている（追加・2026-10-17、Backlog #362）。無ければ起こし直しのあと */
  keptAfter?: "disconnect";
}

export type RealAppEvent =
  /**
   * `running`：繋いだ時点で走っている Thread。`background`：その時点のバックグラウンドの仕事（返事待ちの札がある Thread だけ）。
   * どちらも追加・2026-10-03（v4-frontend.md §6.33）。古い host は付けない
   */
  | {
      type: "hello";
      running?: Array<{ threadId: string; projectId?: string }>;
      background?: Array<{ threadId: string; projectId?: string; items: RealBackgroundItem[] }>;
      /** 上限が戻るのを待っている Thread（追加・2026-10-18、v4-frontend.md §6.46）。古い host は付けない */
      rateLimitWaits?: Array<{ threadId: string; projectId?: string; continueAt: string }>;
      /** 混んでいる Project とこの機械（追加・2026-10-09、§6.36）。古い host は付けない */
      resources?: RealResourcesBusy;
      /** 別の実行場所へ移している Project（追加・2026-10-12、Backlog #270）。古い host は付けない */
      moving?: RealRuntimeMoveView[];
      /** 別のサーバへコードを送っている途中のもの（追加・2026-10-12、Backlog #269）。古い host は付けない */
      codeTransfers?: RealCodeTransfer[];
      /** 3 分を超えて繋がらない別のサーバ（追加・2026-10-17、Backlog #383）。古い host は付けない */
      unreachable?: RealRuntimeUnreachable[];
    }
  /**
   * 別のサーバへコードを送っている（追加・2026-10-12、Backlog #269）。送り始め・進むたび・終わったとき（`transfer` 無し）。
   * その実行場所の分を丸ごと
   */
  | {
      type: "code.transfer";
      runtime: string;
      projectIds: string[];
      transfer?: { sentBytes: number; totalBytes: number; startedAt: string; failed?: string };
    }
  /**
   * 別の実行場所へ移す状況が変わった（追加・2026-10-12、Backlog #270）。`move` があれば移している途中（丸ごと置き換える）、
   * 無ければ終わった——`failed` があれば移せなかった（受信箱の知らせと同じ文）
   */
  | {
      type: "runtime_move.changed";
      projectId: string;
      move?: RealRuntimeMoveView;
      failed?: { title: string; reason: string; from: RealRuntimeMoveSide };
      /** 移し終えた（追加・2026-10-14、Backlog #293）。古い host は付けない */
      done?: { from: RealRuntimeMoveSide; to: RealRuntimeMoveSide };
    }
  /** 3 分を超えて繋がらない別のサーバが変わった（全体を置き換える。Backlog #383） */
  | { type: "runtimes.unreachable"; unreachable: RealRuntimeUnreachable[] }
  /** 混んでいる Project とこの機械が変わった（全体を置き換える） */
  | { type: "resources.busy"; busy: RealResourcesBusy }
  /** その Thread のバックグラウンドの仕事が増えた・減った（その Thread の分を丸ごと） */
  | { type: "background.changed"; threadId: string; projectId?: string; items: RealBackgroundItem[] }
  /** 上限が戻るのを待っている Thread が変わった（追加・2026-10-18、§6.46）。`continueAt` が無ければ待っていない */
  | { type: "rate_limit_wait.changed"; threadId: string; projectId?: string; continueAt?: string }
  | { type: "turn.started"; threadId: string; projectId?: string; cause?: "human" | "delivery" }
  | { type: "turn.ended"; threadId: string; projectId?: string }
  | { type: "inbox.changed" }
  /**
   * 判断待ちに答えが付いた（追加・2026-10-05）——どの道で答えても（受信箱・別の画面・host が畳んだ）。ターンの流れが
   * もう無い会話のカードも、これで答え済みになる（`judgment-answers.ts`）
   */
  | { type: "judgment.answered"; threadId: string; judgmentId: string; answer: string }
  /** 「端末を追加」の札が使われた（2026-10-03）。札を出した画面が「端末が入りました」と出す */
  | { type: "auth.device_added"; codeId: string; label: string }
  /**
   * Thread が閉じた（追加・2026-10-08、アーキ仕様 §2.2「AI が自分の Fork を閉じる」）。AI が閉じた（`close_fork`）ときも、
   * 人が画面で閉じたときも。サイドバーの開いている一覧から外し、開いている画面は飛ばさず帯を出す
   */
  | { type: "thread.closed"; threadId: string; projectId?: string; by: RealThreadClosedBy; reason?: string }
  /**
   * その Project の自動化の台帳が変わった（追加・2026-10-15、v4-frontend.md §6.42）。中身は流れてこない——写しを持っている
   * 画面が取り直す（`automations.ts`）
   */
  | { type: "automations.changed"; projectId: string }
  /**
   * Project の一覧が変わった（追加・2026-10-16、アーキ仕様 §2.2「Project のグループとスリープ」）。作る・名前・並び・閉じる・
   * 開き直す・グループ。中身は流れてこない——`project-groups.ts` が一覧とグループを取り直す
   */
  | { type: "projects.changed" };

/** 移す元・移す先（host の `RuntimeMoveView` の from・to） */
export interface RealRuntimeMoveSide {
  runtime: string;
  root: string;
  /** 「この機械のコンテナ」「別のサーバ「名前」」 */
  label: string;
}

/** 移している Project（host の `RuntimeMoveView` と同じ形）。進み具合は host が起き直したあとは無い */
export interface RealRuntimeMoveView {
  projectId: string;
  from: RealRuntimeMoveSide;
  to: RealRuntimeMoveSide;
  phase?: "preparing" | "stopping" | "copying" | "verifying" | "finishing";
  copiedBytes?: number;
  totalBytes?: number;
}

/** 別のサーバへコードを送っている途中の1件（大きさは縮める前のバイト数） */
export interface RealCodeTransfer {
  /** 別のサーバの名前 */
  runtime: string;
  /** その実行場所で動く Project */
  projectIds: string[];
  sentBytes: number;
  totalBytes: number;
  startedAt: string;
  /** 送れなかった理由（止まった・接続が切れた）。次に送り始めるまで残る */
  failed?: string;
}

/** 3 分を超えて繋がらない別のサーバ1つ（host の `RuntimeUnreachableView` と同じ形） */
export interface RealRuntimeUnreachable {
  /** 別のサーバの名前 */
  runtime: string;
  /** いちばん新しい失敗の理由 */
  reason: string;
  /** 最初に失敗した時刻（ISO） */
  since: string;
  /** その実行場所で動く Project */
  projectIds: string[];
}

/** 混んでいる Project とこの機械（host の `ResourcesBusy` と同じ形） */
export interface RealResourcesBusy {
  projects: Array<{ projectId: string; reason?: string }>;
  host?: { reason?: string };
}

const listeners = new Set<(event: RealAppEvent) => void>();
let started = false;

export function onRealAppEvent(listener: (event: RealAppEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 流れを読み始める（何度呼んでも1本だけ）。 */
export function startRealAppEvents(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  void loop();
}

async function loop(): Promise<void> {
  for (;;) {
    try {
      await readOnce();
    } catch (err) {
      // 途切れた——数秒おいて繋ぎ直す（黙って諦めない。記録は host に残っている）
      console.warn("[banto] host からの知らせが途切れました。繋ぎ直します:", err);
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

async function readOnce(): Promise<void> {
  const config = getBackendConfig();
  if (!config) return; // まだ繋ぎ先が決まっていない——次の周回で見る
  const res = await hostFetch("/api/events");
  if (!res.ok || !res.body) throw new Error(`知らせの流れに繋げませんでした（${res.status}）`);
  await readSse(res, (data) => dispatch(data as RealAppEvent));
}

function dispatch(event: RealAppEvent): void {
  if (event.type === "inbox.changed") void refreshRealInbox();
  if (event.type === "judgment.answered") noteJudgmentAnswered(event.judgmentId, event.answer);
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      console.warn("[banto] host からの知らせの聞き手が例外を投げました:", err);
    }
  }
}
