// **banto 本体（host のプロセス）がどれだけ止まっていたかを測る**（決定・2026-10-09、ユーザー。
// `docs/specs/v4-architecture.md` §5.4-0「banto 本体が止まっていた間の時間切れは Module のせいにしない」）。
//
// 本番の記録で、Module の ping の時間切れが Project の Module 全部と同時に起き、直後にコンテナの外の
// Module にも「宛先の分からない返事」が出ていた。Module は答えていたのに、本体の event loop が止まり、
// 再開したとき期限の来たタイマー（時間切れ）が溜まった入力より先に回って、遅れた返事を捨てていた。
//
// 測り方：短い間隔のタイマーを回し、予定よりどれだけ遅れて来たかを「止まっていた長さ」として残す。
// 止まっている間はこのタイマーも来ないので、再開した最初の1回の遅れが、止まっていた長さになる。
// CPU が host 全体で詰まって本体に順番が回らないときも、同じように遅れとして見える。

export interface Stall {
  /** 止まりが明けた時刻（ms、Date.now）。 */
  endedAt: number;
  /** 止まっていた長さ（ms）。 */
  ms: number;
}

export interface HostStallOptions {
  /** タイマーの間隔（ms）。 */
  tickMs: number;
  /** これより短い遅れは止まりとして残さない（GC・ふつうの揺れ）。 */
  minStallMs: number;
  /** 止まりを覚えておく長さ（ms）。 */
  keepMs: number;
  /** ログに残すのはこれ以上の止まり（ms）。 */
  logStallMs: number;
}

export const HOST_STALL: HostStallOptions = {
  tickMs: 250,
  minStallMs: 100,
  keepMs: 10 * 60_000,
  logStallMs: 1_000,
};

export class HostStallMeter {
  private readonly stalls: Stall[] = [];
  private timer?: NodeJS.Timeout;
  private last = 0;

  constructor(
    private readonly opts: HostStallOptions = HOST_STALL,
    private readonly onStall?: (stall: Stall) => void,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.timer) return;
    this.last = this.now();
    this.timer = setInterval(() => this.tick(), this.opts.tickMs);
    // このタイマーだけで host を生かし続けない
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** タイマーが来たとき。試験からも直接呼ぶ。 */
  tick(): void {
    const t = this.now();
    const late = t - this.last - this.opts.tickMs;
    this.last = t;
    if (late >= this.opts.minStallMs) this.record({ endedAt: t, ms: late });
  }

  /** 止まりを足す（試験用にも使う）。 */
  record(stall: Stall): void {
    this.stalls.push(stall);
    const horizon = stall.endedAt - this.opts.keepMs;
    while (this.stalls.length > 0 && this.stalls[0]!.endedAt < horizon) this.stalls.shift();
    if (stall.ms >= this.opts.logStallMs) this.onStall?.(stall);
  }

  /**
   * [from, to] の間に本体が止まっていた長さの合計（ms）。止まりは「明けた時刻から長さ分さかのぼった
   * 区間」とみなし、範囲と重なる分だけを数える。
   */
  stalledBetween(from: number, to: number): number {
    let sum = 0;
    for (const s of this.stalls) {
      const start = s.endedAt - s.ms;
      const overlap = Math.min(to, s.endedAt) - Math.max(from, start);
      if (overlap > 0) sum += overlap;
    }
    return sum;
  }

  /** 直近 windowMs の中で一番長かった止まり（ms）。 */
  maxWithin(windowMs: number): number {
    const since = this.now() - windowMs;
    let max = 0;
    for (const s of this.stalls) if (s.endedAt >= since && s.ms > max) max = s.ms;
    return max;
  }

  /** 新しい順に n 件。 */
  recent(n: number): Stall[] {
    return this.stalls.slice(-n).reverse();
  }
}
