"use client";

// **並びの Claude のアカウントが全部閾値を越えたカード**（決定・2026-10-18、ユーザー「モックの形でよい」。v4-frontend.md §6.46
// 「受信箱」、見本は fork/multi-claude-accounts の `mock/app/claude-accounts` の「受信箱」）。本文は並び・続けているもの・
// 一番早いリセットの時刻と、アカウントごとのメーター。名前・使用率・閾値は host が読むたびに台帳から添える（規則3）。
// どれかが閾値の下に戻ると host がカードを閉じる（人は押さなくてよい）。
import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { RealNoticeClaudeAccounts, RealUsageWindow } from "@/lib/backend/client";
import { clockOf } from "@/lib/backend/rate-limit-waits";
import { CONNECTED_FEATURES } from "@/lib/feature-flags";
import { cn } from "@/lib/utils";

type Account = RealNoticeClaudeAccounts["accounts"][number];

/** そのアカウントが使えるようになる時刻（越えている窓・断っている status が全部リセットされる時刻）。分からなければ undefined */
function usableAgainAt(a: Account, th: RealNoticeClaudeAccounts["thresholds"]): number | undefined {
  const times: Array<string | undefined> = [];
  if (a.status === "rejected") times.push(a.statusResetsAt);
  if (a.fiveHour && a.fiveHour.utilization >= th.fiveHour) times.push(a.fiveHour.resetsAt);
  if (a.sevenDay && a.sevenDay.utilization >= th.sevenDay) times.push(a.sevenDay.resetsAt);
  if (times.length === 0 || times.some((t) => t === undefined)) return undefined;
  return Math.max(...times.map((t) => Date.parse(t!)));
}

/** 使用率のメーター（閾値の位置に縦の印。越えたら warn の色）。リセットを過ぎた・まだ使っていない窓は「—」 */
function Meter({ label, window, threshold }: { label: string; window: RealUsageWindow | undefined; threshold: number }) {
  const value = window ? Math.round(window.utilization * 100) : undefined;
  const over = window !== undefined && window.utilization >= threshold;
  const th = Math.round(threshold * 100);
  return (
    <div className="flex flex-col gap-1" data-testid="inbox-claude-accounts-meter" data-over={over ? "" : undefined}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate text-ink-2">{label}</span>
        <span className={cn("tabular-nums", over ? "font-semibold text-warn" : "text-foreground")}>{value === undefined ? "—" : `${value}%`}</span>
      </div>
      <div className="relative h-1.5 rounded-full bg-surface-3">
        {value !== undefined ? (
          <div className={cn("absolute inset-y-0 left-0 rounded-full", over ? "bg-warn" : "bg-primary")} style={{ width: `${Math.min(100, value)}%` }} />
        ) : null}
        <div className="absolute -top-1 h-3.5 w-px bg-foreground/60" style={{ left: `${th}%` }} title={`閾値 ${th}%`} />
      </div>
      <span className="text-xs text-ink-3">
        {window === undefined ? "分かりません（リセットを過ぎた・まだ使っていない）" : window.resetsAt ? `リセット：${clockOf(window.resetsAt)}` : "リセットの時刻は分かりません"}
      </span>
    </div>
  );
}

export function ClaudeAccountsAllOverNotice({ card }: { card: RealNoticeClaudeAccounts }) {
  const using = card.accounts.find((a) => a.id === card.using);
  const usingName = using?.label ?? "外したアカウント";
  const at = using ? usableAgainAt(using, card.thresholds) : undefined;
  const names = card.accounts.map((a) => a.label).join("・");
  return (
    <div className="mt-1 flex flex-col gap-3" data-testid="inbox-claude-accounts">
      <p className="text-sm text-ink-2" data-testid="inbox-claude-accounts-detail">
        {card.projectName ? `Project ${card.projectName} の` : "この Project の"}並び（{names}）はどれも閾値を越えています。
        {at !== undefined ? `一番早く ${clockOf(new Date(at).toISOString())} にリセットされる` : "一番早くリセットされる"}「{usingName}」で続けています。
        {/* 文の間に空白を入れない（JSX は改行をまたぐ文を空白でつなぐ） */}
        {"上限に当たると会話は止まり、リセットのあと自動で続けます。"}
      </p>
      <div className="grid gap-3 rounded-md bg-surface-2 px-3 py-3 sm:grid-cols-2">
        {card.accounts.flatMap((a) => [
          <Meter key={`${a.id}-5h`} label={`${a.label}　5時間`} window={a.fiveHour} threshold={card.thresholds.fiveHour} />,
          <Meter key={`${a.id}-7d`} label={`${a.label}　週`} window={a.sevenDay} threshold={card.thresholds.sevenDay} />,
        ])}
      </div>
      <p className="text-xs text-ink-3">どれかが閾値の下に戻ったら、このカードは自動で閉じます。</p>
      {/* 並びを直す入口（§6.46「受信箱」）——Project の並び（Project 設定「Claude のアカウント」）と、アカウントを足す
          （banto 全体の設定「Claude のアカウント」の「アカウントを足す」）。設定の節が出ないときは置かない（規則13） */}
      {CONNECTED_FEATURES.claudeAccounts ? (
        <div className="flex justify-end gap-2">
          <Link
            href={`/settings?${new URLSearchParams({ project: card.projectId, section: "project-claude-accounts" }).toString()}`}
            data-testid="inbox-claude-accounts-project-settings"
            className="flex h-8 items-center rounded-md px-3 text-xs text-ink-2 hover:bg-accent"
          >
            Project の設定を開く
          </Link>
          <Button asChild size="sm" className="h-8 text-xs">
            <Link href="/settings?section=claude-accounts" data-testid="inbox-claude-accounts-add">
              アカウントを足す
            </Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
