// **別のサーバに繋がらないお知らせは、実行場所ごとに1枚**（決定・2026-10-16、ユーザー。
// `docs/specs/v4-architecture.md` §2.4 の 3.）。
//
// banto を更新するたびに、別のサーバへの経路が途切れると「browser を繋げませんでした」「terminal を…」が
// Module ごとに何枚も並んだ。理由が「別のサーバに SSH で繋がらない」なら、Module ごとには出さず、実行場所ごとに
// 最初に失敗した時刻を覚え、**3 分を超えて続いたときだけ**1枚出す（短い途切れは黙って繋ぎ直しを続ける）。
// 繋がったら閉じる。待つのは時計で——試し直しの間は伸びるので、次の失敗を待つと 3 分を大きく越える。
//
// **繋がったかは Project ごとの接続で見る**（2026-10-17、v4-security.md §1「SSH の接続は Project ごとに1本」）——お知らせは
// 実行場所ごとに1枚のまま、繋がらなかった Module を Project ごとに覚え、その Project の接続が張れたらその分を外す。
// 動けない Module が残っている Project が無くなったら閉じる

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
  /** 出しているものの理由・繋がらない Project が変わった（画面の印を描き直す。Backlog #383） */
  changed?(runtimeName: string): void;
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
    const reasonChanged = o.reason !== reason;
    o.reason = reason;
    o.modules.set(connName, projectId);
    if (o.raised && reasonChanged) this.opts.changed?.(runtimeName);
  }

  /**
   * その Project の接続が繋がった。その Project の Module を外し、ほかの Project の分も残っていなければ（出していたら閉じて）
   * 途切れていた長さを返す（まだ残っている・途切れていなければ undefined）。`projectId` が無い（先に送るためだけの接続）なら
   * 何もしない——Project の Module が繋がったことにはならない
   */
  recordConnected(runtimeName: string, projectId: string | undefined): number | undefined {
    const o = this.outages.get(runtimeName);
    if (!o || projectId === undefined) return undefined;
    let removed = false;
    for (const [connName, p] of o.modules) {
      if (p !== projectId) continue;
      o.modules.delete(connName);
      removed = true;
    }
    if ([...o.modules.values()].some((p) => p !== undefined)) {
      // 出している印から、繋がった Project を外す（画面の「!」）
      if (removed && o.raised) this.opts.changed?.(runtimeName);
      return undefined;
    }
    this.end(runtimeName, o);
    return this.now() - o.since;
  }

  /**
   * その Project の接続が SSH で繋がらないなら、最後の理由（繋がっている・分からないなら undefined。Backlog #324）。
   * 同じ実行場所のほかの Project が繋がらないだけなら undefined
   */
  unreachableReason(runtimeName: string, projectId: string | undefined): string | undefined {
    const o = this.outages.get(runtimeName);
    return o && [...o.modules.values()].includes(projectId) ? o.reason : undefined;
  }

  /**
   * **出している（3 分を超えて繋がらない）実行場所**（追加・2026-10-17、Backlog #383）。サイドバーの頭文字の「!」に使う
   * ——判定はお知らせと同じ1つ（規則3）。鍵のカードがお知らせを肩代わりしていても、ここには載る
   */
  raised(): Array<{ runtimeName: string; reason: string; since: number; projectIds: string[] }> {
    return [...this.outages]
      .filter(([, o]) => o.raised)
      .map(([runtimeName, o]) => ({ runtimeName, reason: o.reason, since: o.since, projectIds: projectIdsOf(o) }));
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
    this.opts.raise({ runtimeName, reason: o.reason, projectIds: projectIdsOf(o), modules: o.modules.size });
  }
}

/** 動けない Module がある Project */
function projectIdsOf(o: Outage): string[] {
  return [...new Set([...o.modules.values()].filter((p): p is string => p !== undefined))];
}
