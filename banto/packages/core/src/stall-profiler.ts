// **banto 本体が止まったときに、何をしていたかを残す**（2026-10-10、Fork「資源の逼迫」）。
//
// 2026-10-09 23:49:19、ある Thread のターンの始まりで本体が 9.9 秒止まった。止まりは host-stall.ts で分かるが、何が
// CPU を使っていたかはログからは分からない（ターンの始まりから SDK に渡すまでの間、としか言えない）。同じ時刻に始まった
// 別の Thread のターンは止まっていないので、毎回起きるものではない。
//
// そこで、ターンが始まったら CPU の記録（V8 のサンプリング。記録は別のスレッドで取るので、本体が同期の処理で止まっていても
// 取れる）を 15 秒だけ取り、その間に本体が 2 秒以上止まっていたときだけ `<データ置き場>/profiles/` に残す。止まらなければ
// 捨てる。記録を取っている間に次のターンが始まれば、窓を延ばす。残したらログに場所を出す。

import { Session } from "node:inspector/promises";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface StallProfilerOptions {
  dir: string;
  /** [from, to] の間に本体が止まっていた長さの合計（ms） */
  stalledBetween(from: number, to: number): number;
  /** 窓の長さ（ms） */
  windowMs?: number;
  /** これ以上止まっていたら残す（ms） */
  keepIfStalledMs?: number;
  /** 残しておく数（古いものから消す） */
  keep?: number;
  now?: () => number;
}

export class StallProfiler {
  private session?: Session;
  private startedAt = 0;
  private until = 0;
  private timer?: NodeJS.Timeout;
  private label = "";
  private readonly now: () => number;

  constructor(private readonly opts: StallProfilerOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** 記録を取り始める（取っている最中なら窓を延ばす）。失敗しても仕事は止めない */
  async capture(label: string): Promise<void> {
    const windowMs = this.opts.windowMs ?? 15_000;
    this.until = this.now() + windowMs;
    if (this.session) {
      this.label = `${this.label}+${label}`;
      return;
    }
    try {
      const session = new Session();
      session.connect();
      await session.post("Profiler.enable");
      // 既定の 1ms より粗くして重さを抑える（止まりは秒の単位なので十分）
      await session.post("Profiler.setSamplingInterval", { interval: 5_000 });
      await session.post("Profiler.start");
      this.session = session;
      this.startedAt = this.now();
      this.label = label;
      this.schedule();
    } catch (err) {
      console.warn("[host] CPU の記録を取り始められませんでした:", err);
    }
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.finish(), Math.max(0, this.until - this.now()));
    this.timer.unref();
  }

  private async finish(): Promise<void> {
    // 窓が延びていたら待ち直す
    if (this.now() < this.until) return this.schedule();
    const session = this.session;
    if (!session) return;
    this.session = undefined;
    const from = this.startedAt;
    const to = this.now();
    try {
      const { profile } = (await session.post("Profiler.stop")) as { profile: unknown };
      session.disconnect();
      const stalled = this.opts.stalledBetween(from, to);
      if (stalled < (this.opts.keepIfStalledMs ?? 2_000)) return;
      await mkdir(this.opts.dir, { recursive: true });
      const name = `${new Date(from).toISOString().replace(/[:.]/g, "-")}-${this.label.replace(/[^\w.+-]/g, "_").slice(0, 80)}.cpuprofile`;
      const path = join(this.opts.dir, name);
      await writeFile(path, JSON.stringify(profile));
      console.warn(`[host] 本体が ${(stalled / 1000).toFixed(1)} 秒止まった間の CPU の記録を残しました: ${path}`);
      await this.prune();
    } catch (err) {
      console.warn("[host] CPU の記録を残せませんでした:", err);
    }
  }

  private async prune(): Promise<void> {
    const keep = this.opts.keep ?? 10;
    const files = (await readdir(this.opts.dir).catch(() => [] as string[])).filter((f) => f.endsWith(".cpuprofile")).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) await rm(join(this.opts.dir, f), { force: true });
  }

  /** host を止めるとき */
  stop(): void {
    clearTimeout(this.timer);
    this.session?.disconnect();
    this.session = undefined;
  }
}
