"use client";

// **起こしている Project**（追加・2026-10-16、v4-frontend.md §6.43「スリープ」）。
//
// 起こすのはどれも `modules/prepare` を投げるだけ（起こす専用の口は無い、アーキ §2.2）。眠っている Project に投げてから
// 返るまでの数秒、行と会話の上に「起こしています」を出す——そのための印をここに持つ。記録ではなく、この画面が投げて
// 待っている間だけの印（host には持たない）。眠っているか自体は host の写し（`MockProject.sleep`）。

import { useSyncExternalStore } from "react";

let waking: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function set(next: ReadonlySet<string>): void {
  waking = next;
  for (const l of listeners) l();
}

/** 起こし始めた（返るまで印を出す）。返ったら `doneWaking` */
export function startWaking(projectId: string): void {
  if (waking.has(projectId)) return;
  set(new Set([...waking, projectId]));
}

export function doneWaking(projectId: string): void {
  if (!waking.has(projectId)) return;
  set(new Set([...waking].filter((id) => id !== projectId)));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const EMPTY: ReadonlySet<string> = new Set();

/** その Project をいま起こしているか */
export function useProjectWaking(projectId: string | null): boolean {
  const current = useSyncExternalStore(subscribe, () => waking, () => EMPTY);
  return projectId !== null && current.has(projectId);
}
