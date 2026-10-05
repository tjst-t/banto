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

import { getBackendConfig, hostFetch, readSse } from "./client";
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
    }
  /** その Thread のバックグラウンドの仕事が増えた・減った（その Thread の分を丸ごと） */
  | { type: "background.changed"; threadId: string; projectId?: string; items: RealBackgroundItem[] }
  | { type: "turn.started"; threadId: string; projectId?: string; cause?: "human" | "delivery" }
  | { type: "turn.ended"; threadId: string; projectId?: string }
  | { type: "inbox.changed" }
  /**
   * 判断待ちに答えが付いた（追加・2026-10-05）——どの道で答えても（受信箱・別の画面・host が畳んだ）。ターンの流れが
   * もう無い会話のカードも、これで答え済みになる（`judgment-answers.ts`）
   */
  | { type: "judgment.answered"; threadId: string; judgmentId: string; answer: string }
  /** 「端末を追加」の札が使われた（2026-10-03）。札を出した画面が「端末が入りました」と出す */
  | { type: "auth.device_added"; codeId: string; label: string };

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
