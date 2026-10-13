// **Project ごとに最後に開いた Thread を覚える**（追加・2026-10-13、ユーザー要望。v4-frontend.md §6.40）。
//
// ほかの Project からサイドバー（・畳んだレール）の Project の名前を押して移ったとき、その Project で最後に
// 開いていた Thread（Base か Fork）を開く。以前はいつも Base Thread だった。
//
// 置き場は localStorage（この端末・このブラウザだけ）——どこを見ていたかは端末ごとの話で、host の記録には
// しない（携帯で見ていた Fork がパソコンの行き先を動かさない）。覚えるのは Fork の id だけ（Base は null）。
// 覚えていた Fork が閉じられていれば Base へ（呼ぶ側が開いている Fork の一覧と突き合わせる）。

import { useSyncExternalStore } from "react";

const KEY = "banto.lastThread.v1";

type Store = Record<string, string | null>;

const listeners = new Set<() => void>();
let cache: Store | null = null;

function read(): Store {
  if (cache) return cache;
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    cache = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Store) : {};
  } catch {
    cache = {};
  }
  return cache;
}

/** いま開いている Thread を、その Project の「最後に開いた Thread」として覚える */
export function rememberLastThread(projectId: string, forkId: string | null): void {
  const current = read();
  if (projectId in current && current[projectId] === forkId) return;
  cache = { ...current, [projectId]: forkId };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // 書けなくても画面の中では覚えている（次に読み込み直すまで）
  }
  for (const l of listeners) l();
}

/** 最後に開いた Fork。まだ開いていれば（`openForkIds` にあれば）その id、無ければ null（＝Base Thread） */
export function lastForkOf(store: Store, projectId: string, openForkIds: readonly string[]): string | null {
  const id = store[projectId] ?? null;
  return id !== null && openForkIds.includes(id) ? id : null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // ほかのタブで覚えたものも拾う
  function onStorage(e: StorageEvent) {
    if (e.key !== KEY) return;
    cache = null;
    listener();
  }
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

const EMPTY: Store = {};

/** 覚えている一覧（変われば描き直す）。サーバでは空 */
export function useLastThreads(): Store {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}
