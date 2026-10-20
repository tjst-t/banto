"use client";

// **新しい Project の始め方の仕事**（追加・2026-10-20、`docs/specs/v4-frontend.md` §6.49）。別のサーバに「clone」「新しい
// リポジトリ」で作った Project の、会話の上の帯に使う。
//
// 真実は host（Project の記録の `start`）にあり、画面は出来事の流れで写しを持つだけ（規則3）：
//   hello（繋いだ・繋ぎ直した）→ 終わっていないものを丸ごと置き換える
//   project.start.changed → その Project の分を置き換える（終わったら外す）
// ポーリングはしない（app-events.ts と同じ理由）。

import { useSyncExternalStore } from "react";
import { onRealAppEvent, startRealAppEvents } from "./app-events";
import type { RealProjectStart } from "./client";

let starts: ReadonlyMap<string, RealProjectStart> = new Map();
const listeners = new Set<() => void>();
let wired = false;

function notify(): void {
  for (const listener of listeners) listener();
}

function put(projectId: string, start: RealProjectStart): void {
  const next = new Map(starts);
  if (start.status === "done") next.delete(projectId);
  else next.set(projectId, start);
  starts = next;
  notify();
}

/** 聞き始める。**流れを読み始める前に呼ぶ**（hello を取り逃さないため、`real-projects-bootstrap.tsx`） */
export function wireProjectStarts(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;
  onRealAppEvent((event) => {
    if (event.type === "hello") {
      starts = new Map((event.projectStarts ?? []).filter((s) => s.start.status !== "done").map((s) => [s.projectId, s.start] as const));
      notify();
    } else if (event.type === "project.start.changed") {
      put(event.projectId, event.start);
    }
  });
  startRealAppEvents();
}

/**
 * **作った直後の記録を先に入れる**——作った応答（記録つき）は、知らせの流れより先に届くことがある。帯を空白にしない
 */
export function noteProjectStart(projectId: string, start: RealProjectStart | undefined): void {
  if (start) put(projectId, start);
}

function subscribe(listener: () => void): () => void {
  wireProjectStarts();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** その Project の始め方の仕事（終わっていないもの）。無ければ undefined */
export function useProjectStart(projectId: string): RealProjectStart | undefined {
  return useSyncExternalStore(
    subscribe,
    () => starts.get(projectId),
    () => undefined,
  );
}
