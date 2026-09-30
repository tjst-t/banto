// **Module が生きているかを、定期的に確かめる**（決定・2026-09-30、
// `docs/specs/v4-architecture.md` §5.4-0「止まった Module は起こし直す」）。
//
// 繋がりが「閉じた」なら分かるが、**閉じずに黙る**こともある。2026-09-30、自動更新が incusd を
// 再起動したとき、コンテナの中の Module は消えたのに、host 側の `incus exec` は incus-user に
// 繋がったまま残り、host からは標準入出力が開いたままに見えた——呼ぶたびに `Request timed out`
// になり、host を再起動するまで戻らなかった。MCP の `ping`（仕様の Ping。「接続の健全性を
// 確かめるために定期的に送ってよい」）を使い、続けて答えなければ止まったとみなす
// （Kubernetes の liveness probe と同じ考え方）。

export interface LivenessOptions {
  /** 確かめる間隔（ミリ秒）。 */
  intervalMs: number;
  /** 1回の ping を待つ上限（ミリ秒）。 */
  timeoutMs: number;
  /** 何回続けて答えなければ止まったとみなすか。1回の取りこぼしで起こし直さない。 */
  failureThreshold: number;
}

export const LIVENESS: LivenessOptions = {
  intervalMs: 15_000,
  timeoutMs: 10_000,
  failureThreshold: 2,
};

export interface Pingable {
  ping(options?: { timeout?: number }): Promise<unknown>;
}

interface Watched {
  client: Pingable;
  misses: number;
  inFlight: boolean;
  timer?: NodeJS.Timeout;
}

export class LivenessMonitor {
  private readonly watched = new Map<string, Watched>();

  constructor(
    private readonly opts: LivenessOptions,
    /** 止まったとみなした。**見るのはやめてから呼ぶ**——同じ相手を二度知らせない */
    private readonly onDead: (name: string, client: Pingable, reason: string) => void,
  ) {}

  watch(name: string, client: Pingable): void {
    this.unwatch(name);
    const w: Watched = { client, misses: 0, inFlight: false };
    w.timer = setInterval(() => void this.probe(name, w), this.opts.intervalMs);
    // このタイマーだけで host を生かし続けない
    w.timer.unref();
    this.watched.set(name, w);
  }

  unwatch(name: string): void {
    const w = this.watched.get(name);
    if (!w) return;
    clearInterval(w.timer);
    this.watched.delete(name);
  }

  /** host を止めるとき。 */
  stop(): void {
    for (const name of [...this.watched.keys()]) this.unwatch(name);
  }

  private async probe(name: string, w: Watched): Promise<void> {
    // 前の ping がまだ返っていない——重ねて送らない（数えるのは返ってきた結果だけ）
    if (w.inFlight) return;
    w.inFlight = true;
    try {
      await w.client.ping({ timeout: this.opts.timeoutMs });
      w.misses = 0;
    } catch (err) {
      // 待っている間に外された・別の接続に替わった
      if (this.watched.get(name) !== w) return;
      w.misses += 1;
      if (w.misses < this.opts.failureThreshold) return;
      this.unwatch(name);
      const why = err instanceof Error ? err.message : String(err);
      this.onDead(name, w.client, `ping に ${w.misses} 回続けて答えませんでした（${why}）`);
    } finally {
      w.inFlight = false;
    }
  }
}
