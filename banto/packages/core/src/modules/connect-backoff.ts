// **繋げなかった・止まった Module を、間を伸ばしながら試し直す**（決定・2026-09-30、
// `docs/specs/v4-architecture.md` §5.4-0「止まった Module は起こし直す」）。
//
// 以前は失敗を「宣言が変わるまで」覚えて、二度と試さなかった。すると一時的な失敗
// （Incus の再起動中の `Error: Shutting down` 等）でも、host を再起動するまでその Module は
// 戻らなかった。Kubernetes の再起動の間隔（CrashLoopBackOff）と同じ形にする：失敗や停止が
// 続くほど間を倍にし（上限あり）、**あきらめない**。しばらく動き続けたら間を戻す。

export interface BackoffOptions {
  /** 最初の間（ミリ秒）。 */
  baseMs: number;
  /** 間の上限（ミリ秒）。 */
  maxMs: number;
  /** これだけ動き続けたら、続けて止まった回数を数え直す（ミリ秒）。 */
  stableMs: number;
  /** 試験で時計を差し替えるための穴。 */
  now?: () => number;
}

export const CONNECT_BACKOFF: BackoffOptions = {
  baseMs: 5_000,
  maxMs: 5 * 60_000,
  stableMs: 10 * 60_000,
};

interface Entry {
  /** 宣言の中身（指紋）。変わったら、すぐ試す。 */
  fingerprint: string;
  /** 続けて失敗・停止した回数。 */
  streak: number;
  /** いま繋がっていない理由。繋がったら消える。 */
  reason?: string;
  /** 次に試してよい時刻。 */
  retryAt: number;
  /** 繋がった時刻（動き続けた長さを測る）。 */
  connectedAt?: number;
  /** この連続した失敗について、人に知らせたか。 */
  notified: boolean;
}

export class ConnectBackoff {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(private readonly opts: BackoffOptions = CONNECT_BACKOFF) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * 今は試さないほうがよいか。**同じ宣言のまま、次の時刻の前**なら理由を返す。
   * 宣言が変わっていたら、覚えていたことを捨てて試させる（人が直したのに壊れていると言い続けない）。
   */
  blocked(name: string, fingerprint: string): string | undefined {
    const e = this.entries.get(name);
    if (!e?.reason) return undefined;
    if (e.fingerprint !== fingerprint) {
      this.entries.delete(name);
      return undefined;
    }
    return this.now() < e.retryAt ? e.reason : undefined;
  }

  /** 繋げなかった。**知らせるべきなら true**（連続した失敗の最初の1回だけ）。 */
  recordFailure(name: string, fingerprint: string, reason: string): boolean {
    const e = this.next(name, fingerprint, reason);
    const notify = !e.notified;
    e.notified = true;
    return notify;
  }

  /** 繋がっていたものが止まった。 */
  recordLost(name: string, fingerprint: string, reason: string): void {
    this.next(name, fingerprint, reason);
  }

  recordConnected(name: string, fingerprint: string): void {
    const e = this.entries.get(name);
    this.entries.set(name, {
      fingerprint,
      streak: e?.fingerprint === fingerprint ? e.streak : 0,
      retryAt: 0,
      connectedAt: this.now(),
      notified: false,
    });
  }

  /** いま繋がっていない理由（画面に出す）。 */
  failure(name: string): { reason: string; retryAt: number } | undefined {
    const e = this.entries.get(name);
    return e?.reason ? { reason: e.reason, retryAt: e.retryAt } : undefined;
  }

  /** 次に試してよい時刻。覚えていなければ今。 */
  retryAt(name: string): number {
    return this.entries.get(name)?.retryAt ?? this.now();
  }

  /** 続けて失敗・停止した回数。 */
  streak(name: string): number {
    return this.entries.get(name)?.streak ?? 0;
  }

  /** 畳んだ・消した・ログインし直した——覚えていたことを捨てる。 */
  clear(name: string): void {
    this.entries.delete(name);
  }

  private next(name: string, fingerprint: string, reason: string): Entry {
    const now = this.now();
    const found = this.entries.get(name);
    const prev = found?.fingerprint === fingerprint ? found : undefined;
    // しばらく動き続けていたなら、前の失敗は数えない（たまに止まるだけのものを長く待たせない）
    const stable = prev?.connectedAt !== undefined && now - prev.connectedAt >= this.opts.stableMs;
    const streak = (prev && !stable ? prev.streak : 0) + 1;
    const delay = Math.min(this.opts.baseMs * 2 ** (streak - 1), this.opts.maxMs);
    const e: Entry = {
      fingerprint,
      streak,
      reason,
      retryAt: now + delay,
      notified: prev?.notified ?? false,
    };
    this.entries.set(name, e);
    return e;
  }
}
