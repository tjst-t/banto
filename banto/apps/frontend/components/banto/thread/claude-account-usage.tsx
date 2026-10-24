"use client";

// 右上の文脈のメーターに添える「いま使っている Claude のアカウントと、その使用量」（追加・2026-10-19、ユーザー要望。
// v4-frontend.md §6.46「右上のメーター」）。切り替わったかを会話の画面のまま分かるように、ボタンには短い名前と
// 5時間・週の率だけ、開いた中に名前・契約・2本のメーターを出す。値は host から読む（手元に写しを持たない、規則3）
// ——開いたとき・その会話のターンが1つ終わったとき（使った量の記録が増えたとき）・1分ごとに取り直す。
import { useCallback, useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  fetchClaudeAccounts,
  fetchProjectClaudeAccounts,
  fetchThreadClaudeAccount,
  type ClaudeAccountView,
  type ClaudeAccountsState,
} from "@/lib/backend/client";
import { accountPlan, formatUsd, percent, TokenSpend, UsageMeter } from "@/components/banto/settings/claude-accounts-shared";

export interface CurrentClaudeAccount {
  account: ClaudeAccountView;
  thresholds: ClaudeAccountsState["thresholds"];
  /** 読んだ時刻（リセットまでの残りを数える基準） */
  readAt: number;
}

const REFRESH_MS = 60_000;

/**
 * その会話がいま使っているアカウント。均すときはその会話の生きている固定先（まだ無ければ undefined——隣の会話の
 * アカウントを出さない、v4-security.md §2「均す」の 9.）。上から順にのときは Project が最後に使ったもので、
 * 中継がまだ1回も送っていなければ並びの先頭（次に使うもの）。
 * 読めない（この banto に口が無い・人のセッションでない）ときは undefined で、メーターには何も足さない
 */
export function useCurrentClaudeAccount(
  projectId: string | undefined,
  threadId: string,
  refreshKey: number,
): CurrentClaudeAccount | undefined {
  const [state, setState] = useState<CurrentClaudeAccount | undefined>(undefined);
  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const [all, mine] = await Promise.all([fetchClaudeAccounts(), fetchProjectClaudeAccounts(projectId)]);
      const id = mine.effectiveMode === "balance" ? (await fetchThreadClaudeAccount(threadId)).accountId : (mine.currentAccount ?? mine.effectiveOrder[0]);
      const account = all.accounts.find((a) => a.id === id);
      setState(account ? { account, thresholds: all.thresholds, readAt: Date.now() } : undefined);
    } catch {
      // 口が無い・読めないときは出さない（会話の画面の邪魔をしない）
      setState(undefined);
    }
  }, [projectId, threadId]);
  useEffect(() => {
    // 最初の1回も時計から呼ぶ（effect の中で直に setState に繋がる呼び出しをしない）
    const first = setTimeout(() => void load(), 0);
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load, refreshKey]);
  return state;
}

/** ボタンに出す短い名前：メールアドレスなら @ の前、このマシンのログインは ~/.claude */
export function shortAccountName(a: ClaudeAccountView): string {
  if (a.kind === "host") return "~/.claude";
  const name = a.label || a.email || a.id;
  return name.includes("@") ? name.slice(0, name.indexOf("@")) : name;
}

/** ボタンの中の1かたまり：アイコン・短い名前（広い画面だけ）・5時間と週の率。閾値を越えた率は warn */
export function ClaudeAccountChip({ current }: { current: CurrentClaudeAccount }) {
  const { account, thresholds } = current;
  const w = (u: { utilization: number } | undefined, th: number) =>
    u ? (
      <span className={cn("tabular-nums", u.utilization >= th && "font-semibold text-warn")}>{percent(u.utilization)}%</span>
    ) : (
      <span className="tabular-nums">—</span>
    );
  return (
    <span data-testid="claude-account-chip" className="flex items-center gap-1 border-l border-border pl-1.5">
      <UserRound className="size-3.5 shrink-0 text-ink-3" />
      <span data-testid="claude-account-chip-name" className="hidden max-w-28 truncate md:inline">
        {shortAccountName(account)}
      </span>
      {account.kind === "api-key" ? (
        // API キーには枠が無い——使った金額の目安を出す（v4-distribution.md §3）
        <span data-testid="claude-account-chip-usage" className="tabular-nums">
          {formatUsd(account.tokenUsage?.costUsd ?? 0)}
        </span>
      ) : (
        <span data-testid="claude-account-chip-usage" className="flex items-center gap-0.5">
          {w(account.usage?.fiveHour, thresholds.fiveHour)}
          <span className="text-ink-3">/</span>
          {w(account.usage?.sevenDay, thresholds.sevenDay)}
        </span>
      )}
    </span>
  );
}

/** 開いた中の節：名前・契約・5時間と週のメーター（設定の画面と同じ部品） */
export function ClaudeAccountSection({ current }: { current: CurrentClaudeAccount }) {
  const { account, thresholds, readAt: now } = current;
  return (
    <div data-testid="claude-account-section" className="border-b border-border px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-xs font-medium text-ink-2">
        <UserRound className="size-3.5 shrink-0 text-ink-3" />
        使っている Claude のアカウント
      </p>
      <p className="mt-1 truncate text-sm text-foreground">{account.kind === "host" ? "このマシンの Claude Code のログイン" : account.label}</p>
      <p className="truncate text-xs text-ink-3">
        {account.kind === "host" ? "~/.claude" : account.kind === "api-key" ? "API キー" : (account.email ?? account.id)}
        {account.kind !== "api-key" && accountPlan(account, {}) ? `（${accountPlan(account, {})}）` : ""}
      </p>
      {account.kind === "api-key" ? (
        <div className="mt-2">
          <TokenSpend usage={account.tokenUsage} />
        </div>
      ) : (
        <div className="mt-2 grid grid-cols-2 gap-3">
          <UsageMeter label="5時間" window={account.usage?.fiveHour} threshold={thresholds.fiveHour} now={now} />
          <UsageMeter label="週" window={account.usage?.sevenDay} threshold={thresholds.sevenDay} now={now} />
        </div>
      )}
    </div>
  );
}
