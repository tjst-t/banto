"use client";

// **承認をすべて自動で許可する**（決定・2026-10-05、ユーザー。v4-frontend.md §6.4）の、画面がもう知っている値。
//
// 設定の節（スイッチ）と入力欄の印が同じ値を見る——設定で切り替えたら、開いている会話の印もすぐ変わるように。
// 真実は host の Configuration。ここは「最後に host から聞いた値」を Project ごとに覚えるだけ（規則3）
import { useEffect, useSyncExternalStore } from "react";
import { fetchRealAutoApproveAll, setRealAutoApproveAll } from "@/lib/backend/client";

const known = new Map<string, boolean>();
const listeners = new Set<() => void>();

function note(projectId: string, enabled: boolean): void {
  if (known.get(projectId) === enabled) return;
  known.set(projectId, enabled);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** host から読み直す。読めなければ投げる（呼ぶ側が言う） */
export async function refreshAutoApproveAll(projectId: string): Promise<boolean> {
  const enabled = await fetchRealAutoApproveAll(projectId);
  note(projectId, enabled);
  return enabled;
}

/** 保存する。host が答えた値を覚える */
export async function saveAutoApproveAll(projectId: string, enabled: boolean): Promise<boolean> {
  const saved = await setRealAutoApproveAll(projectId, enabled);
  note(projectId, saved);
  return saved;
}

/** その Project の値（まだ聞いていなければ undefined）。`load` なら、開いたときに host に聞く */
export function useAutoApproveAll(projectId: string | undefined, load: boolean): boolean | undefined {
  useEffect(() => {
    if (!projectId || !load) return;
    refreshAutoApproveAll(projectId).catch((err: unknown) =>
      console.warn("[banto] 承認をすべて自動で許可する の設定を読めませんでした:", err),
    );
  }, [projectId, load]);
  return useSyncExternalStore(
    subscribe,
    () => (projectId ? known.get(projectId) : undefined),
    () => undefined,
  );
}
