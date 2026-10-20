"use client";

// **空いた会話の冷める前の要約**（追加・2026-10-20、アーキ仕様 §3.1、v4-frontend.md §6.52）。
//
// 4時間空いた会話を、host がキャッシュの温かいうちに要約する。その予定（`at`）・帯を出す時刻（`noticeAt`）・要約している・
// 温め直しの回数を、会話の帯と文脈のメーターに出す。真実は host（中継のメモリ——起こし直すと消える）。画面は出来事の流れで
// 写しを持つだけ（規則3、`rate-limit-waits.ts` と同じ形）：
//   hello → その時点の一覧で**丸ごと置き換える**（温め直しの回数だけは残す——hello は予定のある会話しか載せない）／
//   idle_compaction.changed → その Thread の分を置き換える／thread.closed → 外す
// 会話の記録を開いたとき（メーターを開いたとき）に取った値でも埋める（`seedIdleCompaction`）。

import { useSyncExternalStore } from "react";
import { onRealAppEvent, startRealAppEvents } from "./app-events";
import type { RealIdleCompaction } from "./client";

let byThread: ReadonlyMap<string, RealIdleCompaction> = new Map();
const listeners = new Set<() => void>();
let wired = false;

function set(next: ReadonlyMap<string, RealIdleCompaction>): void {
  byThread = next;
  for (const listener of listeners) listener();
}

function strip(v: RealIdleCompaction): RealIdleCompaction {
  return {
    ...(v.at !== undefined ? { at: v.at } : {}),
    ...(v.noticeAt !== undefined ? { noticeAt: v.noticeAt } : {}),
    compacting: v.compacting,
    warms: v.warms,
    warmTokens: v.warmTokens,
  };
}

/** 聞き始める。**流れを読み始める前に呼ぶ**（`real-projects-bootstrap.tsx`）——hello を取り逃さないため */
export function wireIdleCompactions(): void {
  wire();
}

function wire(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;
  onRealAppEvent((event) => {
    if (event.type === "hello") {
      const next = new Map<string, RealIdleCompaction>();
      // 予定の無い会話の温め直しの回数は hello に載らない——予定と要約しているだけを外し、回数は残す
      for (const [id, v] of byThread) next.set(id, { compacting: false, warms: v.warms, warmTokens: v.warmTokens });
      for (const v of event.idleCompactions ?? []) next.set(v.threadId, strip(v));
      set(next);
    } else if (event.type === "idle_compaction.changed") {
      const next = new Map(byThread);
      next.set(event.threadId, strip(event));
      set(next);
    } else if (event.type === "thread.closed" && byThread.has(event.threadId)) {
      const next = new Map(byThread);
      next.delete(event.threadId);
      set(next);
    }
  });
  startRealAppEvents();
}

/** 会話の記録（`GET /api/threads/:id`）で取った値で埋める */
export function seedIdleCompaction(threadId: string, view: RealIdleCompaction | undefined): void {
  if (!view) return;
  const next = new Map(byThread);
  next.set(threadId, strip(view));
  set(next);
}

function subscribe(listener: () => void): () => void {
  wire();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** その Thread の冷める前の要約の様子（知らなければ undefined） */
export function useIdleCompaction(threadId: string): RealIdleCompaction | undefined {
  return useSyncExternalStore(
    subscribe,
    () => byThread.get(threadId),
    () => undefined,
  );
}
