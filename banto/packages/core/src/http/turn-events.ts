// **ターンの外から起きた判断待ちを、走行中のターンの画面へ流す**ための細い口。
//
// docs/specs/v4-frontend.md「Module 間中継の承認」は「発生源は会話・Factory・
// 機構だけでなく、**host 自身の中継ロジックも発生源になれる**」と決めている。
// ところが SSE を書いているのは turn-runner の generator で、中継ゲート
// （relay/approval-gate.ts）はそこから呼ばれていない——両者を繋ぐのがこれ。
//
// **判断待ちの真実は受信箱（Event Store）のまま**。ここを流れるのは
// 「いま出た」という合図だけで、答える経路は他の判断待ちと同じ
// `/api/inbox/:id/answer` 1つ（規則3）。

import type { TurnStreamEvent } from "./turn-runner.js";

export class TurnEventBus {
  private readonly listeners = new Map<string, Set<(event: TurnStreamEvent) => void>>();

  subscribe(threadId: string, listener: (event: TurnStreamEvent) => void): () => void {
    let set = this.listeners.get(threadId);
    if (!set) {
      set = new Set();
      this.listeners.set(threadId, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(threadId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(threadId);
    };
  }

  /** 聞いている人がいなければ何もしない——判断待ちは受信箱に残っている。 */
  publish(threadId: string, event: TurnStreamEvent): void {
    for (const listener of this.listeners.get(threadId) ?? []) listener(event);
  }
}
