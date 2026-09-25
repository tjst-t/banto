// **host から画面への出来事の流れ**（決定・2026-09-25、`docs/specs/v4-frontend.md` §6.8「host が始めたターンにも繋ぐ」）。
//
// 届いたもので host が自分でターンを始めるようになったので、開いている画面が「知らないうちに始まった」ターンに
// 気づく道が要る。**ポーリングはしない**（受信箱で踏んだ——再描画が assistant-ui のランタイムを壊した）。
// 流すのは「何が起きたか」の知らせだけで、中身は画面が既存の口で取りに行く（繋ぎ直す・記録を読む・受信箱）。

export type AppEvent =
  // cause：人が送ったターンか、届いたもので host が始めたターンか（画面の帯の言い方が変わる）
  | { type: "turn.started"; threadId: string; projectId?: string; cause: "human" | "delivery" }
  | { type: "turn.ended"; threadId: string; projectId?: string }
  | { type: "inbox.changed" };

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
