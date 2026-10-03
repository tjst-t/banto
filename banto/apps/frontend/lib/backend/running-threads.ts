"use client";

// **いま AI が動いている Thread**（決定・2026-10-03、ユーザー要望。v4-frontend.md §6.33）。
//
// サイドバーの Thread の行で、アイコンを回して見せるためのもの。真実は host（`ThreadTurns`）にあり、
// 画面は出来事の流れ（`app-events.ts`）で写しを持つだけ（規則3）：
//   hello（繋いだ・繋ぎ直した）→ その時点で走っている一覧で**丸ごと置き換える**
//   turn.started → 足す／turn.ended → 外す
// 繋ぎ直すたびに置き換えるので、途切れている間に終わったターンが回り続けることはない。
// ポーリングはしない（app-events.ts と同じ理由）。

import { useSyncExternalStore } from "react";
import { onRealAppEvent, startRealAppEvents } from "./app-events";

let running: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
let wired = false;

function set(next: ReadonlySet<string>): void {
  running = next;
  for (const listener of listeners) listener();
}

/**
 * 聞き始める。**流れを読み始める前に呼ぶ**（`real-projects-bootstrap.tsx`）——後から付けると、
 * 繋いだときの hello（その時点で走っている一覧）を取り逃し、次の知らせまで何も回らない。
 */
export function wireRunningThreads(): void {
  wire();
}

function wire(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;
  onRealAppEvent((event) => {
    if (event.type === "hello") {
      set(new Set((event.running ?? []).map((r) => r.threadId)));
    } else if (event.type === "turn.started") {
      if (running.has(event.threadId)) return;
      set(new Set([...running, event.threadId]));
    } else if (event.type === "turn.ended") {
      if (!running.has(event.threadId)) return;
      const next = new Set(running);
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

/** その Thread で AI が動いているか（host のターンが走っているか）。 */
export function useThreadRunning(threadId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => running.has(threadId),
    () => false,
  );
}
