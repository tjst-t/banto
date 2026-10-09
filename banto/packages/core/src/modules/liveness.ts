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

/**
 * banto 本体が止まっていた間の時間切れを Module のせいにしないための口（追加・2026-10-09、
 * `docs/specs/v4-architecture.md` §5.4-0）。本体の event loop が止まると、再開したとき時間切れのタイマーが
 * 溜まった返事より先に回り、答えていた Module が「答えなかった」ことになる。
 */
export interface StallSource {
  /** [from, to]（Date.now の ms）の間に本体が止まっていた長さの合計（ms） */
  stalledBetween(from: number, to: number): number;
}

export class LivenessMonitor {
  private readonly watched = new Map<string, Watched>();

  constructor(
    private readonly opts: LivenessOptions,
    /** 止まったとみなした。**見るのはやめてから呼ぶ**——同じ相手を二度知らせない */
    private readonly onDead: (name: string, client: Pingable, reason: string) => void,
    private readonly stalls?: StallSource,
    /** 本体が止まっていたので数えなかった（ログ用） */
    private readonly onInconclusive?: (name: string, stalledMs: number, elapsedMs: number) => void,
    private readonly now: () => number = Date.now,
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
    let again = false;
    const sentAt = this.now();
    try {
      await w.client.ping({ timeout: this.opts.timeoutMs });
      w.misses = 0;
    } catch (err) {
      // 待っている間に外された・別の接続に替わった
      if (this.watched.get(name) !== w) return;
      // 本体が止まっていた分を引くと、1回の上限まで待てていない——確かめられなかっただけなので数えず、
      // すぐにもう一度送る。本体が止まっていないのにすぐ失敗したもの（接続の異常）は今までどおり数える
      const failedAt = this.now();
      // 止まりは、再開したあとの測りのタイマーで初めて残る。この時間切れと同じ回に期限の来たタイマーを
      // 先に回し切ってから数える（setImmediate はその回のタイマーが全部終わったあとに来る）
      if (this.stalls) await new Promise<void>((r) => setImmediate(r));
      if (this.watched.get(name) !== w) return;
      const stalled = this.stalls?.stalledBetween(sentAt, failedAt) ?? 0;
      if (stalled > 0 && failedAt - sentAt - stalled < this.opts.timeoutMs) {
        this.onInconclusive?.(name, stalled, failedAt - sentAt);
        again = true;
        return;
      }
      w.misses += 1;
      if (w.misses < this.opts.failureThreshold) return;
      this.unwatch(name);
      const why = err instanceof Error ? err.message : String(err);
      this.onDead(name, w.client, `ping に ${w.misses} 回続けて答えませんでした（${why}）`);
    } finally {
      w.inFlight = false;
      if (again && this.watched.get(name) === w) void this.probe(name, w);
    }
  }
}
