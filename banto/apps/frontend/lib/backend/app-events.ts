"use client";

// **host から画面への出来事の流れ**（決定・2026-09-25、`docs/specs/v4-frontend.md` §6.8「host が始めたターンにも繋ぐ」）。
//
// 届いたもの（待たない仕事の完了など）で host が自分でターンを始めるようになったので、開いている画面が
// 「知らないうちに始まった」ターンに気づく道が要る。**ポーリングはしない**（受信箱で踏んだ——再描画が
// assistant-ui のランタイムを壊した）。流れてくるのは「何が起きたか」だけで、中身は既存の口で取りに行く：
//   turn.started → その Thread を開いていれば繋ぎ直す（`reattached-turn.ts`）
//   inbox.changed → 受信箱を取り直す
//
// 合言葉をヘッダで送るので EventSource は使わない（ターンの SSE と同じく fetch で読む）。途切れたら数秒おいて
// 繋ぎ直す——**繋がっていない間も人は止めない**（開き直せば記録から見える）。

import { getBackendConfig } from "./client";
import { refreshRealInbox } from "./real-inbox";
import { refreshThreadFromHost } from "./adapter";

export type RealAppEvent =
  | { type: "hello" }
  | { type: "turn.started"; threadId: string; projectId?: string; cause?: "human" | "delivery" }
  | { type: "turn.ended"; threadId: string; projectId?: string }
  | { type: "inbox.changed" };

const listeners = new Set<(event: RealAppEvent) => void>();
/** host が始めたターンか（帯の言い方を変える）。ターンが終われば消す */
const startedByDelivery = new Set<string>();
let started = false;

export function onRealAppEvent(listener: (event: RealAppEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** その Thread で走っているターンが、届いたもので host が始めたものか */
export function isDeliveryTurn(threadId: string): boolean {
  return startedByDelivery.has(threadId);
}

/** 流れを読み始める（何度呼んでも1本だけ）。 */
export function startRealAppEvents(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  void loop();
}

async function loop(): Promise<void> {
  for (;;) {
    try {
      await readOnce();
    } catch (err) {
      // 途切れた——数秒おいて繋ぎ直す（黙って諦めない。記録は host に残っている）
      console.warn("[banto] host からの知らせが途切れました。繋ぎ直します:", err);
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

async function readOnce(): Promise<void> {
  const config = getBackendConfig();
  if (!config) return; // まだ繋ぎ先が決まっていない——次の周回で見る
  const res = await fetch(`${config.baseUrl}/api/events`, { headers: { authorization: `Bearer ${config.token}` } });
  if (!res.ok || !res.body) throw new Error(`知らせの流れに繋げませんでした（${res.status}）`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      if (!part.startsWith("data: ")) continue;
      dispatch(JSON.parse(part.slice(6)) as RealAppEvent);
    }
  }
}

function dispatch(event: RealAppEvent): void {
  if (event.type === "turn.started" && event.cause === "delivery") startedByDelivery.add(event.threadId);
  if (event.type === "turn.ended" && startedByDelivery.delete(event.threadId)) {
    // 届いたもので host が始めたターンが終わった——記録から取り直す（繋ぎ直す前に終わっていても会話に出る）
    void refreshThreadFromHost(event.threadId).catch((err: unknown) =>
      console.warn("[banto] 届いたものに答えた会話を取り直せませんでした:", err),
    );
  }
  if (event.type === "inbox.changed") void refreshRealInbox();
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      console.warn("[banto] host からの知らせの聞き手が例外を投げました:", err);
    }
  }
}
