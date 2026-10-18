"use client";

// **上限が戻るのを待っている Thread**（追加・2026-10-18、v4-frontend.md §6.46）。
//
// Claude の使用量の上限で止まったターンを、host がリセットのあと自動で続ける——その待ち。会話の入力欄の上の帯と、
// サイドバーの Thread の行の下の1行に出す。真実は host（Event Store の `turn.ended` の `continueAt`）。画面は出来事の流れで
// 写しを持つだけ（規則3、`background-work.ts` と同じ形）：
//   hello → その時点の一覧で**丸ごと置き換える**／rate_limit_wait.changed → その Thread の分を置き換える／
//   thread.closed → 外す（閉じた Fork の待ちは host でも消える）

import { useSyncExternalStore } from "react";
import { onRealAppEvent, startRealAppEvents } from "./app-events";

let byThread: ReadonlyMap<string, string> = new Map();
const listeners = new Set<() => void>();
let wired = false;

function set(next: ReadonlyMap<string, string>): void {
  byThread = next;
  for (const listener of listeners) listener();
}

/** 聞き始める。**流れを読み始める前に呼ぶ**（`real-projects-bootstrap.tsx`）——hello を取り逃さないため */
export function wireRateLimitWaits(): void {
  wire();
}

function wire(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;
  onRealAppEvent((event) => {
    if (event.type === "hello") {
      set(new Map((event.rateLimitWaits ?? []).map((w) => [w.threadId, w.continueAt] as const)));
    } else if (event.type === "rate_limit_wait.changed") {
      const next = new Map(byThread);
      if (event.continueAt === undefined) next.delete(event.threadId);
      else next.set(event.threadId, event.continueAt);
      set(next);
    } else if (event.type === "thread.closed" && byThread.has(event.threadId)) {
      const next = new Map(byThread);
      next.delete(event.threadId);
      set(next);
    }
  });
  startRealAppEvents();
}

function subscribe(listener: () => void): () => void {
  wire();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** その Thread が自動で続ける時刻（ISO）。待っていなければ undefined */
export function useRateLimitWait(threadId: string): string | undefined {
  return useSyncExternalStore(
    subscribe,
    () => byThread.get(threadId),
    () => undefined,
  );
}

/** 時刻を「HH:MM」で（24時間） */
export function clockOf(iso: string): string {
  return new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** 残りの時間を「n時間m分」で（1分に満たなければ「1分」——切り上げる。「0分」と出して止まって見せない） */
export function remainingOf(iso: string, now: number): string {
  const minutes = Math.max(1, Math.ceil((Date.parse(iso) - now) / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}時間${m}分` : `${m}分`;
}
