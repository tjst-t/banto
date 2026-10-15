// **変換の順番と公平**（決定・2026-10-15、`docs/specs/v4-modules.md` §2.2「変換役」）。
//
// 変換は同時に1件。待ちは Project ごとに3件まで（超えたら断る）、Project の間は順番に回す——1つの Project の連投で
// 他の Project を止めない。名前のある機構：ラウンドロビン（鍵ごとの FIFO を、鍵の順に1件ずつ）

/** 待ちが溢れた（その Project の待ちが上限に達している） */
export class QueueFullError extends Error {}

interface Waiter {
  start(): void;
}

export class FairQueue {
  /** 鍵（Project）ごとの待ち。先に来たものから */
  private readonly waiting = new Map<string, Waiter[]>();
  /** 待ちのある鍵の、回す順。先頭が次に回る */
  private readonly rotation: string[] = [];
  private busy = false;

  constructor(private readonly maxWaitingPerKey = 3) {}

  /** いまの待ちの数（その鍵の。走っているものは数えない） */
  waitingFor(key: string): number {
    return this.waiting.get(key)?.length ?? 0;
  }

  /**
   * `fn` を順番が来たら走らせる。`fn` には待った時間（ms）を渡す。その鍵の待ちが上限なら `QueueFullError` で断る
   * （走っているものは待ちに数えない）
   */
  async run<T>(key: string, fn: (waitedMs: number) => Promise<T>): Promise<T> {
    const queued = performance.now();
    if (!this.busy && this.rotation.length === 0) return this.execute(fn, 0);
    const list = this.waiting.get(key) ?? [];
    if (list.length >= this.maxWaitingPerKey) {
      throw new QueueFullError(`変換が混んでいます（この Project の待ちが ${this.maxWaitingPerKey} 件あります）。少し待ってからもう一度頼んでください`);
    }
    return new Promise<T>((resolve, reject) => {
      list.push({
        start: () => {
          this.execute(fn, Math.round(performance.now() - queued)).then(resolve, reject);
        },
      });
      if (!this.waiting.has(key)) {
        this.waiting.set(key, list);
        this.rotation.push(key);
      }
    });
  }

  private async execute<T>(fn: (waitedMs: number) => Promise<T>, waitedMs: number): Promise<T> {
    this.busy = true;
    try {
      return await fn(waitedMs);
    } finally {
      this.busy = false;
      this.next();
    }
  }

  /** 次の鍵から1件。まだ待ちがあれば、その鍵を列の後ろへ回す */
  private next(): void {
    const key = this.rotation.shift();
    if (key === undefined) return;
    const list = this.waiting.get(key)!;
    const waiter = list.shift()!;
    if (list.length > 0) this.rotation.push(key);
    else this.waiting.delete(key);
    waiter.start();
  }
}
