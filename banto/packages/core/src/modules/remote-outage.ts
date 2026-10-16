// **別のサーバに繋がらないお知らせは、実行場所ごとに1枚**（決定・2026-10-16、ユーザー。
// `docs/specs/v4-architecture.md` §2.4 の 3.）。
//
// banto を更新するたびに、別のサーバへの経路が途切れると「browser を繋げませんでした」「terminal を…」が
// Module ごとに何枚も並んだ。理由が「別のサーバに SSH で繋がらない」なら、Module ごとには出さず、実行場所ごとに
// 最初に失敗した時刻を覚え、**3 分を超えて続いたときだけ**1枚出す（短い途切れは黙って繋ぎ直しを続ける）。
// 繋がったら閉じる。待つのは時計で——試し直しの間は伸びるので、次の失敗を待つと 3 分を大きく越える

export const REMOTE_OUTAGE_NOTICE_AFTER_MS = 3 * 60_000;

export interface RemoteOutageNotice {
  runtimeName: string;
  /** いちばん新しい失敗の理由 */
  reason: string;
  /** 動けない Module がある Project */
  projectIds: string[];
  /** 動けない Module の数 */
  modules: number;
}

export interface RemoteOutageOptions {
  /** 出すまでの長さ（既定 3 分） */
  afterMs?: number;
  /** 出す */
  raise(notice: RemoteOutageNotice): void;
  /** 出したものを閉じる */
  close(runtimeName: string): void;
  /** 試験で時計を差し替えるための穴。取り消す関数を返す */
  schedule?: (fn: () => void, ms: number) => () => void;
  now?: () => number;
}

interface Outage {
  since: number;
  reason: string;
  /** 接続名 → Project */
  modules: Map<string, string | undefined>;
  raised: boolean;
  cancel: () => void;
}

export class RemoteOutageWatch {
  private readonly outages = new Map<string, Outage>();
  private readonly afterMs: number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly now: () => number;

  constructor(private readonly opts: RemoteOutageOptions) {
    this.afterMs = opts.afterMs ?? REMOTE_OUTAGE_NOTICE_AFTER_MS;
    this.now = opts.now ?? Date.now;
    this.schedule =
      opts.schedule ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        timer.unref();
        return () => clearTimeout(timer);
      });
  }

  /** その実行場所の Module を、SSH が繋がらないために繋げなかった */
  recordUnreachable(runtimeName: string, connName: string, projectId: string | undefined, reason: string): void {
    let o = this.outages.get(runtimeName);
    if (!o) {
      const outage: Outage = { since: this.now(), reason, modules: new Map(), raised: false, cancel: () => undefined };
      outage.cancel = this.schedule(() => this.due(runtimeName, outage), this.afterMs);
      this.outages.set(runtimeName, outage);
      o = outage;
    }
    o.reason = reason;
    o.modules.set(connName, projectId);
  }

  /** 繋がった。出していたら閉じる。途切れていた長さを返す（途切れていなければ undefined） */
  recordConnected(runtimeName: string): number | undefined {
    const o = this.outages.get(runtimeName);
    if (!o) return undefined;
    this.end(runtimeName, o);
    return this.now() - o.since;
  }

  /** 実行場所を外した——覚えていたことを捨て、出していたら閉じる */
  forget(runtimeName: string): void {
    const o = this.outages.get(runtimeName);
    if (o) this.end(runtimeName, o);
  }

  private end(runtimeName: string, o: Outage): void {
    o.cancel();
    this.outages.delete(runtimeName);
    if (o.raised) this.opts.close(runtimeName);
  }

  private due(runtimeName: string, o: Outage): void {
    // 時間が来る前に繋がって、また途切れた——その途切れの分は、そちらの時計で待つ
    if (this.outages.get(runtimeName) !== o || o.raised) return;
    o.raised = true;
    const projectIds = [...new Set([...o.modules.values()].filter((p): p is string => p !== undefined))];
    this.opts.raise({ runtimeName, reason: o.reason, projectIds, modules: o.modules.size });
  }
}
