// **host から画面への出来事の流れ**（決定・2026-09-25、`docs/specs/v4-frontend.md` §6.8「host が始めたターンにも繋ぐ」）。
//
// 届いたもので host が自分でターンを始めるようになったので、開いている画面が「知らないうちに始まった」ターンに
// 気づく道が要る。**ポーリングはしない**（受信箱で踏んだ——再描画が assistant-ui のランタイムを壊した）。
// 流すのは「何が起きたか」の知らせだけで、中身は画面が既存の口で取りに行く（繋ぎ直す・記録を読む・受信箱）。

import type { AwaitingReply } from "../project-thread/types.js";

/**
 * **バックグラウンドで動いているもの1件**（追加・2026-10-03、v4-frontend.md §6.33）。返事待ちの札（`AwaitingReply`）から
 * 人に見せてよい分だけを写す——**札そのもの（`replyTo`）は画面に出さない**（届けるための推測できない印なので）
 */
export interface BackgroundItem {
  /** 約束した Module（宣言の名前。画面を開くときの Module の名前と同じ） */
  module: string;
  /** 頼んだ時刻（ISO） */
  since: string;
  toolName?: string;
  toolCallId?: string;
  resourceUri?: string;
  title?: string;
  description?: string;
}

export function backgroundItemsOf(awaiting: readonly AwaitingReply[] | undefined): BackgroundItem[] {
  return (awaiting ?? []).map((r) => ({ module: r.moduleName, since: r.since, ...(r.work ?? {}) }));
}

export type AppEvent =
  // cause：人が送ったターンか、届いたもので host が始めたターンか（画面の帯の言い方が変わる）
  | { type: "turn.started"; threadId: string; projectId?: string; cause: "human" | "delivery" }
  | { type: "turn.ended"; threadId: string; projectId?: string }
  | { type: "inbox.changed" }
  // 「端末を追加」の札が使われた（決定・2026-10-03）。札を出した画面が「端末が入りました」と出す
  | { type: "auth.device_added"; codeId: string; label: string }
  // その Thread のバックグラウンドの仕事が増えた・減った。**その Thread の分を丸ごと**送る（画面は置き換える）
  | { type: "background.changed"; threadId: string; projectId?: string; items: BackgroundItem[] };

export class AppEventBus {
  private readonly listeners = new Set<(event: AppEvent) => void>();

  publish(event: AppEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.warn("[host] 画面への知らせの聞き手が例外を投げました:", err);
      }
    }
  }

  subscribe(listener: (event: AppEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
