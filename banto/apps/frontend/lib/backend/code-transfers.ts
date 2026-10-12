"use client";

// **別のサーバへ banto のコードを送っている途中のもの**（追加・2026-10-12、Backlog #269）。初めて繋ぐ別のサーバでは、
// 送り終わるまで Module が起きず、AI は tool を1つも呼べない（実機で約4分）——黙って止まって見えないよう、
// サイドバー・その Project の会話・実行場所の設定に「○○にコードを送っています（○MB / ○MB）」を出す。
//
// 真実は host（`RemoteSshRuntime` が送りながら数える）にあり、画面は出来事の流れで写しを持つだけ（規則3）：
//   hello（繋いだ・繋ぎ直した）→ 丸ごと置き換える／code.transfer → その実行場所の分を置き換える（`transfer` 無しで消す）
// 送れなかったときは `failed` が付いて残る（次に送り始めるまで）——黙って消えると、人には終わったように見える

import { useSyncExternalStore } from "react";
import { onRealAppEvent, startRealAppEvents, type RealCodeTransfer } from "./app-events";

let transfers: readonly RealCodeTransfer[] = [];
const listeners = new Set<() => void>();
let wired = false;

function set(next: readonly RealCodeTransfer[]): void {
  transfers = next;
  for (const listener of listeners) listener();
}

/** 聞き始める。**流れを読み始める前に呼ぶ**（hello を取り逃さないため、`real-projects-bootstrap.tsx`） */
export function wireCodeTransfers(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;
  onRealAppEvent((event) => {
    if (event.type === "hello") set(event.codeTransfers ?? []);
    else if (event.type === "code.transfer") {
      const others = transfers.filter((t) => t.runtime !== event.runtime);
      set(event.transfer ? [...others, { runtime: event.runtime, projectIds: event.projectIds, ...event.transfer }] : others);
    }
  });
  startRealAppEvents();
}

function subscribe(listener: () => void): () => void {
  wireCodeTransfers();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** その Project の実行場所へコードを送っている途中なら、その1件 */
export function useProjectCodeTransfer(projectId: string): RealCodeTransfer | undefined {
  return useSyncExternalStore(
    subscribe,
    () => transfers.find((t) => t.projectIds.includes(projectId)),
    () => undefined,
  );
}

/** その実行場所（別のサーバの名前）へコードを送っている途中なら、その1件 */
export function useRuntimeCodeTransfer(runtime: string): RealCodeTransfer | undefined {
  return useSyncExternalStore(
    subscribe,
    () => transfers.find((t) => t.runtime === runtime),
    () => undefined,
  );
}

/** 「banto-dev-vm にコードを送っています（120MB / 809MB）」／送れなかったら「…を送れませんでした（120MB / 809MB で止まりました）」 */
export function codeTransferText(t: RealCodeTransfer): string {
  const mb = (n: number) => `${Math.round(n / 1e6)}MB`;
  return t.failed !== undefined
    ? `${t.runtime} にコードを送れませんでした（${mb(t.sentBytes)} / ${mb(t.totalBytes)} で止まりました）`
    : `${t.runtime} にコードを送っています（${mb(t.sentBytes)} / ${mb(t.totalBytes)}）`;
}
