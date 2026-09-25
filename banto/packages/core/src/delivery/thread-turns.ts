// **同じ Thread のターンは1本ずつ**（決定・2026-09-25、アーキ仕様 §4.2）。
//
// 以前は画面だけが守っていた（自分の画面で走っているターンの間は送れない）。届いたもので host が自分で
// ターンを始めるようになったので、host が守る——人のターンと host のターンがぶつかると、走行中の途中経過
// （`TurnEventBus`）も resume-point も取り合いになる。
//
// **人が送ったものは断らずに順番を待たせる**（改訂・2026-09-25、E2E で発覚）。最初は走っている間に送ると 409 で
// 断っていたが、それでは「判断待ちに答えた直後に送った発言が、前のターンが終わりきる前で消える」——送ったつもりで
// 消えるのは、規則2 に反する。人は `acquire` で並び、前が終わると鍵がそのまま渡る。届いたもので起こすほうは
// `tryAcquire`（並んでいる人がいれば取らない——人のターンが、溜まった届いたものも一緒に積む）。
//
// 鍵を持っている間の**ホップ数**もここに置く——そのターンの中で出した返信用の札が、届いたときに何回目の
// 中継になるかを決める（人が送ったターン＝0）。

export type TurnChange = { type: "started" | "ended"; threadId: string; hop: number };

export class ThreadTurns {
  private readonly running = new Map<string, { hop: number }>();
  private readonly waiting = new Map<string, Array<{ hop: number; grant: (release: () => void) => void }>>();
  private readonly listeners = new Set<(change: TurnChange) => void>();

  /** 鍵を取る。**取れなければ `undefined`**（走っているか、人が並んでいる）。返り値を呼ぶと鍵を返す */
  tryAcquire(threadId: string, hop: number): (() => void) | undefined {
    if (this.running.has(threadId) || (this.waiting.get(threadId)?.length ?? 0) > 0) return undefined;
    return this.start(threadId, hop);
  }

  /** 鍵を取る。**走っていれば、終わるまで並んで待つ**（人が送ったターン）。 */
  acquire(threadId: string, hop: number): Promise<() => void> {
    const now = this.tryAcquire(threadId, hop);
    if (now) return Promise.resolve(now);
    return new Promise((resolve) => {
      const queue = this.waiting.get(threadId) ?? [];
      queue.push({ hop, grant: resolve });
      this.waiting.set(threadId, queue);
    });
  }

  isRunning(threadId: string): boolean {
    return this.running.has(threadId);
  }

  /** 走っているターンのホップ数（走っていなければ `undefined`） */
  hopOf(threadId: string): number | undefined {
    return this.running.get(threadId)?.hop;
  }

  onChange(listener: (change: TurnChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private start(threadId: string, hop: number): () => void {
    this.running.set(threadId, { hop });
    this.emit({ type: "started", threadId, hop });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running.delete(threadId);
      this.emit({ type: "ended", threadId, hop });
      // 並んでいる人がいれば、鍵をそのまま渡す（届いたもので起こすほうに横取りさせない）
      const queue = this.waiting.get(threadId);
      const next = queue?.shift();
      if (queue && queue.length === 0) this.waiting.delete(threadId);
      if (next) next.grant(this.start(threadId, next.hop));
    };
  }

  private emit(change: TurnChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (err) {
        // 聞き手の失敗で鍵の出し入れを止めない——ただし黙らない（規則2）
        console.warn("[host] ターンの出入りの聞き手が例外を投げました:", err);
      }
    }
  }
}
