"use client";

// **繋がらない別のサーバとその Project**（追加・2026-10-17、ユーザー要望。Backlog #383）。サイドバーの頭文字の「!」に使う。
//
// 真実は host（`modules/remote-outage.ts`——受信箱の「繋げません」と同じ判定）にあり、画面は出来事の流れで写しを持つだけ（規則3）：
//   hello（繋いだ・繋ぎ直した）→ 丸ごと置き換える／runtimes.unreachable（変わったときだけ）→ 丸ごと置き換える
// ポーリングはしない（`resources-busy.ts` と同じ形）。

import { useSyncExternalStore } from "react";
import { onRealAppEvent, startRealAppEvents, type RealRuntimeUnreachable } from "./app-events";

let unreachable: RealRuntimeUnreachable[] = [];
const listeners = new Set<() => void>();
let wired = false;

function set(next: RealRuntimeUnreachable[] | undefined): void {
  unreachable = next ?? [];
  for (const listener of listeners) listener();
}

/** 聞き始める。**流れを読み始める前に呼ぶ**（hello を取り逃さないため、`real-projects-bootstrap.tsx`） */
export function wireUnreachableRuntimes(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;
  onRealAppEvent((event) => {
    if (event.type === "hello") set(event.unreachable);
    else if (event.type === "runtimes.unreachable") set(event.unreachable);
  });
  startRealAppEvents();
}

function subscribe(listener: () => void): () => void {
  wireUnreachableRuntimes();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** その Project の実行場所に繋がらなければ、その実行場所（繋がっていれば undefined） */
export function useProjectUnreachable(projectId: string): RealRuntimeUnreachable | undefined {
  return useSyncExternalStore(
    subscribe,
    () => unreachable.find((u) => u.projectIds.includes(projectId)),
    () => undefined,
  );
}
