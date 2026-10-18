// **要求ごとにどのアカウントを使うか**（決定・2026-10-18、ユーザー。`docs/specs/v4-security.md` §2「Claude のアカウントを
// 複数持つ」の 6.）。
//
// その Project の並びの先頭から「5時間の率が5時間の閾値未満、かつ週の率が週の閾値未満、かつ全体の status が rejected で
// ない」の最初のものを使う。値は返事の見出しを正とし、リセットの時刻を過ぎたものは「分からない」＝使える扱い（使えば
// 見出しで分かる）——ゆえに閾値を越えたら次の要求から次へ、リセットを過ぎれば自然に前へ戻る。
//
// **並びの全部が閾値を越えたら、一番早くリセットされるもので続ける**（越えているほうの窓のリセットの時刻。rejected なら
// `-reset` の時刻）。

import { freshUsage, type AccountUsage } from "./accounts.js";

/** 閾値（0〜1）。5時間と週で別々（banto 全体の設定） */
export interface UsageThresholds {
  fiveHour: number;
  sevenDay: number;
}

/** 既定は5時間 95%・週 95%（決定・2026-10-18、ユーザー） */
export const DEFAULT_THRESHOLDS: UsageThresholds = { fiveHour: 0.95, sevenDay: 0.95 };

/** なぜそのアカウントが使えないか。使えるなら undefined */
export type Blocked =
  | { kind: "rejected"; resetsAt?: string; claim?: string }
  | { kind: "threshold"; window: "5h" | "7d"; utilization: number; resetsAt?: string };

/** いま読める（リセットを過ぎていない）使用率から、そのアカウントが使えない理由を引く */
export function blockedBy(usage: AccountUsage | undefined, thresholds: UsageThresholds, now: Date): Blocked | undefined {
  const u = usage ? freshUsage(usage, now) : undefined;
  if (!u) return undefined;
  // モデル別の週の窓が先に尽きると、7d の率が低いまま rejected になる——status を先に見る
  if (u.status === "rejected") {
    return { kind: "rejected", ...(u.statusResetsAt ? { resetsAt: u.statusResetsAt } : {}), ...(u.representativeClaim ? { claim: u.representativeClaim } : {}) };
  }
  if (u.fiveHour && u.fiveHour.utilization >= thresholds.fiveHour) {
    return { kind: "threshold", window: "5h", utilization: u.fiveHour.utilization, ...(u.fiveHour.resetsAt ? { resetsAt: u.fiveHour.resetsAt } : {}) };
  }
  if (u.sevenDay && u.sevenDay.utilization >= thresholds.sevenDay) {
    return { kind: "threshold", window: "7d", utilization: u.sevenDay.utilization, ...(u.sevenDay.resetsAt ? { resetsAt: u.sevenDay.resetsAt } : {}) };
  }
  return undefined;
}

/**
 * そのアカウントが**使えるようになる時刻**（越えている窓・rejected が全部リセットされる時刻）。分からなければ undefined
 * ——比べるときは一番遅い扱い
 */
export function usableAgainAt(usage: AccountUsage | undefined, thresholds: UsageThresholds, now: Date): number | undefined {
  const u = usage ? freshUsage(usage, now) : undefined;
  if (!u) return now.getTime();
  const times: number[] = [];
  let unknown = false;
  const add = (iso: string | undefined) => {
    if (iso === undefined) unknown = true;
    else times.push(Date.parse(iso));
  };
  if (u.status === "rejected") add(u.statusResetsAt);
  if (u.fiveHour && u.fiveHour.utilization >= thresholds.fiveHour) add(u.fiveHour.resetsAt);
  if (u.sevenDay && u.sevenDay.utilization >= thresholds.sevenDay) add(u.sevenDay.resetsAt);
  if (unknown) return undefined;
  return times.length === 0 ? now.getTime() : Math.max(...times);
}

export interface Choice {
  accountId: string;
  /** 並びの全部が閾値を越えている（一番早くリセットされるもので続けている） */
  allOver: boolean;
}

/**
 * **並びから選ぶ**。並びが空なら undefined。`skip` に入っているもの（この要求でもう断られたもの）は選ばない——
 * 全部 skip なら undefined
 */
export function chooseAccount(
  order: readonly string[],
  usageOf: (id: string) => AccountUsage | undefined,
  thresholds: UsageThresholds,
  now: Date,
  skip: ReadonlySet<string> = new Set(),
): Choice | undefined {
  const candidates = order.filter((id) => !skip.has(id));
  if (candidates.length === 0) return undefined;
  const usable = candidates.find((id) => !blockedBy(usageOf(id), thresholds, now));
  if (usable) return { accountId: usable, allOver: false };
  // 全部が越えている：一番早く使えるようになるもの（同じなら並びの前）
  let best = candidates[0]!;
  let bestAt = usableAgainAt(usageOf(best), thresholds, now) ?? Infinity;
  for (const id of candidates.slice(1)) {
    const at = usableAgainAt(usageOf(id), thresholds, now) ?? Infinity;
    if (at < bestAt) {
      best = id;
      bestAt = at;
    }
  }
  return { accountId: best, allOver: true };
}

/** 並び全体が閾値の下に戻る一番早い時刻（全部越えのカードを閉じに行く時刻）。分からなければ undefined */
export function earliestRecovery(order: readonly string[], usageOf: (id: string) => AccountUsage | undefined, thresholds: UsageThresholds, now: Date): number | undefined {
  const times = order.map((id) => usableAgainAt(usageOf(id), thresholds, now)).filter((t): t is number => t !== undefined);
  return times.length === 0 ? undefined : Math.min(...times);
}
