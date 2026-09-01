"use client";

// Project/Thread の作成・終了・畳むはモック全体で共有する状態なので、
// 単純な pub-sub で「変わったら再描画してよい」ことだけを伝える
// （Context は使わない——真実は projects.ts/threads.ts の配列1箇所に留め、
// ここは「変わった」という通知だけを持つ、規則3の変形）。
import { useSyncExternalStore } from "react";

type Listener = () => void;
const listeners = new Set<Listener>();
let version = 0;

export function notifyMockStoreChange(): void {
  version++;
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): number {
  return version;
}

/** Project/Thread の作成・終了・畳む操作を反映して再描画したいコンポーネントで呼ぶ */
export function useMockStoreVersion(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
