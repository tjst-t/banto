"use client";

// **混んでいる Project とこの機械**（決定・2026-10-09、ユーザー。v4-frontend.md §6.36）。サイドバーの印に使う。
//
// 真実は host（`resources.ts` が 10 秒ごとに測る）にあり、画面は出来事の流れで写しを持つだけ（規則3）：
//   hello（繋いだ・繋ぎ直した）→ 丸ごと置き換える／resources.busy（変わったときだけ）→ 丸ごと置き換える
// ポーリングはしない（app-events.ts と同じ理由）。

import { useSyncExternalStore } from "react";
import { onRealAppEvent, startRealAppEvents, type RealResourcesBusy } from "./app-events";

let busy: RealResourcesBusy = { projects: [] };
const listeners = new Set<() => void>();
let wired = false;

function set(next: RealResourcesBusy | undefined): void {
  busy = next ?? { projects: [] };
  for (const listener of listeners) listener();
}

/** 聞き始める。**流れを読み始める前に呼ぶ**（hello を取り逃さないため、`real-projects-bootstrap.tsx`） */
export function wireResourcesBusy(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;
  onRealAppEvent((event) => {
    if (event.type === "hello") set(event.resources);
    else if (event.type === "resources.busy") set(event.busy);
  });
  startRealAppEvents();
}

function subscribe(listener: () => void): () => void {
  wireResourcesBusy();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** その Project が混んでいれば理由（理由が無ければ空文字）、混んでいなければ undefined */
export function useProjectBusy(projectId: string): string | undefined {
  return useSyncExternalStore(
    subscribe,
    () => {
      const p = busy.projects.find((x) => x.projectId === projectId);
      return p ? (p.reason ?? "") : undefined;
    },
    () => undefined,
  );
}

/** この機械が混んでいれば理由（理由が無ければ空文字）、混んでいなければ undefined */
export function useHostBusy(): string | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (busy.host ? (busy.host.reason ?? "") : undefined),
    () => undefined,
  );
}
