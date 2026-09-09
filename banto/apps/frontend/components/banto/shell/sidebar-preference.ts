"use client";

// サイドバーの見た目の好み（幅・畳んだかどうか）。**React の外に持つ**。
//
// 理由（ユーザー報告・2026-09-09）：別 Project を開くと、幅が**一度既定に戻ってから
// 変更した幅に直る**という見え方をしていた。`/p/[projectId]` はルートごとに
// layout を持ち、Project を移ると AppShell 自体が作り直される——幅を React の
// state に置き、localStorage を effect で読んでいたので、
// 「既定で1回描く → 読み直して直す」の2段階になっていた。
//
// 値をモジュール側（React の外）に置けば、作り直された AppShell は
// **最初の1回目の描画から正しい幅**を持つ。要件E7「選択が残る」の実装でもある。
import {
  clampSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
} from "./sidebar-resize-handle";

const WIDTH_KEY = "banto.sidebar.width";
const OPEN_KEY = "banto.sidebar.open";

export interface SidebarPreference {
  /** 展開しているか（false＝58px のレール） */
  open: boolean;
  /** 展開しているときの幅（px） */
  width: number;
}

/** サーバは localStorage を知らない——SSR/hydration では既定を返す（不一致を作らない） */
const SERVER_SNAPSHOT: SidebarPreference = { open: true, width: SIDEBAR_WIDTH_DEFAULT };

let snapshot: SidebarPreference | null = null;
const listeners = new Set<() => void>();

function load(): SidebarPreference {
  const savedWidth = Number(window.localStorage.getItem(WIDTH_KEY));
  return {
    open: window.localStorage.getItem(OPEN_KEY) !== "false",
    width:
      Number.isFinite(savedWidth) && savedWidth > 0
        ? clampSidebarWidth(savedWidth)
        : SIDEBAR_WIDTH_DEFAULT,
  };
}

/** `useSyncExternalStore` の getSnapshot——同じ内容なら同じ参照を返す */
export function getSidebarPreference(): SidebarPreference {
  snapshot ??= load();
  return snapshot;
}

export function getServerSidebarPreference(): SidebarPreference {
  return SERVER_SNAPSHOT;
}

export function subscribeSidebarPreference(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

function update(next: SidebarPreference): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

export function setSidebarOpen(open: boolean): void {
  update({ ...getSidebarPreference(), open });
  window.localStorage.setItem(OPEN_KEY, String(open));
}

/**
 * 幅を変える。**ドラッグ中は覚えない**（`persist: false`）——1回のドラッグで
 * 何十回も書かないため。手を離した時点で1回だけ覚える。
 * 覚えていない値でも、この場の見た目としては正しいのでモジュール側には反映する
 */
export function setSidebarWidth(width: number, options?: { persist?: boolean }): void {
  const next = clampSidebarWidth(width);
  update({ ...getSidebarPreference(), width: next });
  if (options?.persist !== false) window.localStorage.setItem(WIDTH_KEY, String(next));
}
