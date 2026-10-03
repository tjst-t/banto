"use client";

// **バックグラウンドで動いているもの**（決定・2026-10-03、ユーザー。v4-frontend.md §6.33）。
//
// AI が「終わったら届ける」tool（`runSubagent` の runInBackground など）で頼み、Module が「あとで届ける」と約束して、
// まだ届いていないもの。サイドバーの Thread の行の名前の下と、いま開いていない Project の行に出す。
// 真実は host の返事待ちの札（Event Store）。画面は出来事の流れで写しを持つだけ（規則3、`running-threads.ts` と同じ形）：
//   hello → その時点の一覧で**丸ごと置き換える**／background.changed → その Thread の分を置き換える

import { useSyncExternalStore } from "react";
import { onRealAppEvent, startRealAppEvents, type RealBackgroundItem } from "./app-events";

export type BackgroundItem = RealBackgroundItem;

interface ThreadBackground {
  projectId?: string;
  items: readonly BackgroundItem[];
}

let byThread: ReadonlyMap<string, ThreadBackground> = new Map();
const listeners = new Set<() => void>();
let wired = false;
const EMPTY: readonly BackgroundItem[] = [];

function set(next: ReadonlyMap<string, ThreadBackground>): void {
  byThread = next;
  for (const listener of listeners) listener();
}

/** 聞き始める。**流れを読み始める前に呼ぶ**（`real-projects-bootstrap.tsx`）——hello を取り逃さないため */
export function wireBackgroundWork(): void {
  wire();
}

function wire(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;
  onRealAppEvent((event) => {
    if (event.type === "hello") {
      set(
        new Map(
          (event.background ?? [])
            .filter((b) => b.items.length > 0)
            .map((b) => [b.threadId, { projectId: b.projectId, items: b.items }] as const),
        ),
      );
    } else if (event.type === "background.changed") {
      const next = new Map(byThread);
      if (event.items.length === 0) next.delete(event.threadId);
      else next.set(event.threadId, { projectId: event.projectId, items: event.items });
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

/** その Thread のバックグラウンドの仕事 */
export function useThreadBackground(threadId: string): readonly BackgroundItem[] {
  return useSyncExternalStore(
    subscribe,
    () => byThread.get(threadId)?.items ?? EMPTY,
    () => EMPTY,
  );
}

/** 写し全体（Project の行で、その Project の Thread の分を集めるため） */
export function useBackgroundByThread(): ReadonlyMap<string, ThreadBackground> {
  return useSyncExternalStore(
    subscribe,
    () => byThread,
    () => byThread,
  );
}
