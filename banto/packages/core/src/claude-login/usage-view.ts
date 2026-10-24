// **AI に見せる Claude の使用量**（追加・2026-10-20、ユーザー報告。`docs/specs/v4-security.md` §2「AI が使用量を見る」）。
//
// AI が自分で見られる使用量（返事の見出し・Claude Code の警告・`/usage`）は、いまの会話のアカウント1つ分だけ。banto は
// 並びの中で会話ごとにアカウントを選び、閾値を越えたら次へ移るので、1つだけを見て「使用量が足りない」と判断を誤る。
// core の tool `claude_usage` で、その Project で使える全部のアカウントの使用量・閾値・この会話がどれかを返す。
// 値は台帳から読むたびに引く（写しを持たない、規則3）。トークン・メールアドレス以外の秘密は無い。

import type { ClaudeAccountStore } from "./accounts.js";
import { blockedBy, headroomRatio } from "./select.js";

export interface ClaudeUsageViewDeps {
  store: Pick<ClaudeAccountStore, "list" | "orderFor" | "thresholds" | "modeFor">;
  /** その会話がいま使っているアカウント（均すときの固定先）。分からなければ undefined */
  pinnedOfThread?: (threadId: string) => string | undefined;
  now?: () => Date;
}

const pct = (u: number) => Math.round(u * 100);

function planOf(subscriptionType: string | undefined, rateLimitTier: string | undefined): string | undefined {
  const tier = rateLimitTier?.match(/max_(\d+x)/)?.[1];
  if (subscriptionType === "max") return tier ? `Max ${tier}` : "Max";
  if (subscriptionType === "pro") return "Pro";
  return subscriptionType;
}

/** tool の返す文（JSON）。人の言葉の要約を先頭に、続けて機械で読める中身 */
export function describeClaudeUsage(deps: ClaudeUsageViewDeps, projectId: string, threadId: string): string {
  const now = deps.now?.() ?? new Date();
  const thresholds = deps.store.thresholds();
  const mode = deps.store.modeFor(projectId);
  const all = new Map(deps.store.list().map((a) => [a.id, a]));
  const pinned = deps.pinnedOfThread?.(threadId);
  const accounts = deps.store.orderFor(projectId).flatMap((id) => {
    const a = all.get(id);
    if (!a) return [];
    const blocked = blockedBy(a.usage, thresholds, now);
    const w = (x: { utilization: number; resetsAt?: string } | undefined) =>
      x ? { percent: pct(x.utilization), ...(x.resetsAt ? { resetsAt: x.resetsAt } : {}) } : null;
    return [
      {
        name: a.kind === "host" ? "このマシンの Claude Code のログイン" : a.label,
        ...(a.kind === "api-key" ? { plan: "API キー（従量課金。5時間・週の枠は無い）" } : planOf(a.subscriptionType, a.rateLimitTier) ? { plan: planOf(a.subscriptionType, a.rateLimitTier) } : {}),
        fiveHour: w(a.usage?.fiveHour),
        sevenDay: w(a.usage?.sevenDay),
        // API キーは枠の代わりに、足してから使ったトークンと金額の目安（米ドル）
        ...(a.kind === "api-key" && a.tokenUsage
          ? {
              spent: {
                inputTokens: a.tokenUsage.inputTokens,
                outputTokens: a.tokenUsage.outputTokens,
                cacheWriteTokens: a.tokenUsage.cacheWriteTokens,
                cacheReadTokens: a.tokenUsage.cacheReadTokens,
                estimatedUsd: Math.round(a.tokenUsage.costUsd * 100) / 100,
                since: a.tokenUsage.since,
              },
            }
          : {}),
        usable: !blocked,
        ...(blocked ? { why: blocked.kind === "rejected" ? "上限で断られています" : `${blocked.window === "5h" ? "5時間" : "週"}の使用率が閾値を越えています` } : {}),
        thisConversation: id === pinned,
        headroom: headroomRatio(a.usage, thresholds, now),
      },
    ];
  });
  const usable = accounts.filter((a) => a.usable);
  const best = [...usable].sort((x, y) => x.headroom - y.headroom)[0];
  const summary =
    accounts.length === 0
      ? "この Project で使える Claude のアカウントがありません。"
      : usable.length === 0
        ? `この Project の ${accounts.length} 個のアカウントはどれも閾値を越えています。上限に当たると会話は止まり、リセットのあと自動で続きます。`
        : `この Project では ${accounts.length} 個のうち ${usable.length} 個のアカウントが閾値（5時間 ${pct(thresholds.fiveHour)}%・週 ${pct(thresholds.sevenDay)}%）の下で使えます。` +
          `いまの会話のアカウントが閾値を越えても、banto が次のアカウントに移して続けます。` +
          (best ? `一番余裕があるのは「${best.name}」（5時間 ${best.fiveHour?.percent ?? "—"}%・週 ${best.sevenDay?.percent ?? "—"}%）。` : "") +
          "使用量を理由に仕事を止めたり減らしたりするのは、全部のアカウントが閾値に近いときだけにしてください。";
  return JSON.stringify(
    {
      summary,
      mode: mode === "balance" ? "均す（会話ごとに余裕のあるアカウントを選ぶ）" : "上から順に（並びの先頭から閾値まで使う）",
      thresholdsPercent: { fiveHour: pct(thresholds.fiveHour), sevenDay: pct(thresholds.sevenDay) },
      accounts: accounts.map(({ headroom: _h, ...rest }) => rest),
      note: "使用率は banto が最後に読んだ値。分からない窓（null）はリセットを過ぎたか、まだ使っていないもの。",
    },
    null,
    2,
  );
}
