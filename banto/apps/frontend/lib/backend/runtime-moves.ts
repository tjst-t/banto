"use client";

// **別の実行場所へ移している Project**（追加・2026-10-12、ユーザー要望。Backlog #270 runtime-move-visible）。
// 会話の面の帯・入力欄を止める理由・サイドバーの印に使う。
//
// 真実は host（記録の move と、移す本体の進み具合）にあり、画面は出来事の流れで写しを持つだけ（規則3）：
//   hello（繋いだ・繋ぎ直した）→ 移している一覧を丸ごと置き換える
//   runtime_move.changed → その Project の分を置き換える（終わったら外す。移せなければ「移せなかった」を残す）
// 「移せなかった」は人が閉じるか、次に移し始めるまで残す（host は持たない——受信箱の知らせが正本）。
// ポーリングはしない（app-events.ts と同じ理由）。

import { useSyncExternalStore } from "react";
import { onRealAppEvent, startRealAppEvents, type RealRuntimeMoveSide, type RealRuntimeMoveView } from "./app-events";

export interface RuntimeMoveFailure {
  title: string;
  reason: string;
  from: RealRuntimeMoveSide;
}

let moving: ReadonlyMap<string, RealRuntimeMoveView> = new Map();
let failed: ReadonlyMap<string, RuntimeMoveFailure> = new Map();
const listeners = new Set<() => void>();
let wired = false;

function notify(): void {
  for (const listener of listeners) listener();
}

/** 聞き始める。**流れを読み始める前に呼ぶ**（hello を取り逃さないため、`real-projects-bootstrap.tsx`） */
export function wireRuntimeMoves(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;
  onRealAppEvent((event) => {
    if (event.type === "hello") {
      moving = new Map((event.moving ?? []).map((m) => [m.projectId, m] as const));
      if (moving.size > 0) failed = new Map([...failed].filter(([id]) => !moving.has(id)));
      notify();
    } else if (event.type === "runtime_move.changed") {
      const nextMoving = new Map(moving);
      const nextFailed = new Map(failed);
      if (event.move) {
        nextMoving.set(event.projectId, event.move);
        nextFailed.delete(event.projectId);
      } else {
        nextMoving.delete(event.projectId);
        if (event.failed) nextFailed.set(event.projectId, event.failed);
      }
      moving = nextMoving;
      failed = nextFailed;
      notify();
    }
  });
  startRealAppEvents();
}

/** 「移せなかった」の帯を閉じる */
export function dismissRuntimeMoveFailure(projectId: string): void {
  if (!failed.has(projectId)) return;
  const next = new Map(failed);
  next.delete(projectId);
  failed = next;
  notify();
}

function subscribe(listener: () => void): () => void {
  wireRuntimeMoves();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** その Project を移していれば、その様子。移していなければ undefined */
export function useRuntimeMove(projectId: string): RealRuntimeMoveView | undefined {
  return useSyncExternalStore(
    subscribe,
    () => moving.get(projectId),
    () => undefined,
  );
}

/**
 * その Project を移しているか。進み具合が変わるたびには描き直させない（会話の面ごと1秒ごとに描き直さないため）——
 * 進み具合を出すのは帯（`useRuntimeMove`）だけ
 */
export function useProjectMoving(projectId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => moving.has(projectId),
    () => false,
  );
}

/** その Project を移せなかったとき（人が閉じるまで） */
export function useRuntimeMoveFailure(projectId: string): RuntimeMoveFailure | undefined {
  return useSyncExternalStore(
    subscribe,
    () => failed.get(projectId),
    () => undefined,
  );
}

/** 写す大きさ（移す画面と会話の面の帯で同じ書き方） */
export function formatMoveBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
