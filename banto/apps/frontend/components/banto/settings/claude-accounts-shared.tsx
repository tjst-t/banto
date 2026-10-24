"use client";

// **Claude のアカウントの画面で共通に使うもの**（決定・2026-10-18、v4-frontend.md §6.46）——使用率のメーター・番号つきの並び・
// 契約の種類とリセットの時刻の書き方。banto 全体の設定と Project の設定の両方が使う
import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ClaudeAccountMode, ClaudeAccountView, ClaudeAccountsState, ClaudeTokenUsage, ClaudeUsageWindow } from "@/lib/backend/client";
import { cn } from "@/lib/utils";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const pad = (n: number) => String(n).padStart(2, "0");

/** リセットの時刻：近ければ「あと n時間m分（HH:MM）」、遠ければ「10月22日（水）9:00」 */
export function formatReset(iso: string, now: number): string {
  const at = new Date(iso);
  const left = at.getTime() - now;
  const hm = `${at.getHours()}:${pad(at.getMinutes())}`;
  if (left < 24 * 60 * 60_000) {
    const minutes = Math.max(0, Math.ceil(left / 60_000));
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `あと ${h > 0 ? `${h}時間` : ""}${m}分（${pad(at.getHours())}:${pad(at.getMinutes())}）`;
  }
  return `${at.getMonth() + 1}月${at.getDate()}日（${WEEKDAYS[at.getDay()]}）${hm}`;
}

/** 契約の種類（`max`＋上限の段 `default_claude_max_5x` → 「Max 5x」） */
export function planLabel(subscriptionType: string | undefined, rateLimitTier: string | undefined): string | undefined {
  if (!subscriptionType) return undefined;
  const base = subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1);
  const multiple = /(\d+x)\b/.exec(rateLimitTier ?? "")?.[1];
  return subscriptionType === "max" && multiple ? `${base} ${multiple}` : base;
}

/** そのアカウントの契約（`~/.claude` のものは台帳に無いので、本体のログインから読む） */
export function accountPlan(a: ClaudeAccountView, state: Pick<ClaudeAccountsState, "hostLogin">): string | undefined {
  if (a.kind === "api-key") return "API キー";
  if (a.kind === "host" && state.hostLogin?.loggedIn) return planLabel(state.hostLogin.subscriptionType, state.hostLogin.rateLimitTier);
  return planLabel(a.subscriptionType, a.rateLimitTier);
}

export const percent = (u: number) => Math.round(u * 100);

/** 使い方の呼び名と説明（v4-frontend.md §6.46「使い方」）。並び順は画面に出す順 */
export const MODE_CHOICES: ReadonlyArray<readonly [ClaudeAccountMode, string, string]> = [
  ["balance", "均す", "新しい会話ごとに、並びの中で余裕のあるアカウントを選ぶ（既定）"],
  ["ordered", "上から順に", "並びの先頭から、閾値まで使う"],
];

export const modeName = (mode: ClaudeAccountMode) => MODE_CHOICES.find(([m]) => m === mode)?.[1] ?? mode;

/** 金額の目安（米ドル）：1ドル未満は小数2桁まで、それ以上は小数2桁 */
export function formatUsd(usd: number): string {
  return `$${usd < 0.01 && usd > 0 ? "<0.01" : usd.toFixed(2)}`;
}

/** トークン数：1000 以上は k・100万以上は M */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** 「5時間 41%、週 —」——Project の並びの行の1行。API キーは「使った金額の目安 $1.23」 */
export function usageLine(a: ClaudeAccountView): string {
  if (a.kind === "api-key") return `API キー・使った金額の目安 ${formatUsd(a.tokenUsage?.costUsd ?? 0)}`;
  const p = (w: ClaudeUsageWindow | undefined) => (w ? `${percent(w.utilization)}%` : "—");
  return `5時間 ${p(a.usage?.fiveHour)}、週 ${p(a.usage?.sevenDay)}`;
}

/** 使用率のメーター。閾値の位置に縦の印、越えたら warn の色。分からないものは「—」と一言 */
export function UsageMeter({
  label,
  window,
  threshold,
  now,
  testId,
}: {
  label: string;
  window: ClaudeUsageWindow | undefined;
  /** 0〜1 */
  threshold: number;
  now: number;
  testId?: string;
}) {
  const value = window ? percent(window.utilization) : undefined;
  const over = window !== undefined && window.utilization >= threshold;
  return (
    <div data-testid={testId} data-over={over ? "true" : "false"} className="flex min-w-0 flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-ink-2">{label}</span>
        <span
          data-testid={testId ? `${testId}-value` : undefined}
          className={cn("tabular-nums", over ? "font-semibold text-warn" : "text-foreground")}
        >
          {value === undefined ? "—" : `${value}%`}
        </span>
      </div>
      <div className="relative h-1.5 rounded-full bg-surface-3">
        {value !== undefined ? (
          <div
            className={cn("absolute inset-y-0 left-0 rounded-full", over ? "bg-warn" : "bg-[var(--banto-accent)]")}
            style={{ width: `${Math.min(100, value)}%` }}
          />
        ) : null}
        <div
          className="absolute -top-1 h-3.5 w-px bg-foreground/60"
          style={{ left: `${percent(threshold)}%` }}
          title={`閾値 ${percent(threshold)}%`}
        />
      </div>
      <span data-testid={testId ? `${testId}-reset` : undefined} className="text-xs text-ink-3">
        {!window
          ? "分かりません（リセットを過ぎたか、まだ使っていません）"
          : window.resetsAt
            ? `リセット：${formatReset(window.resetsAt, now)}`
            : "リセットの時刻は分かりません"}
      </span>
    </div>
  );
}

export function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded p-1.5 text-ink-3 hover:bg-surface-2 hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

/**
 * **番号つきの並び**：上へ・下へ・並びから外す（最後の1つは外せない）。並びに無いアカウントは下に「○○を並びに足す」。
 * ドラッグは置かない（携帯でも同じ操作にするため）
 */
export function AccountOrderEditor({
  order,
  accounts,
  disabled,
  onChange,
  renderDetail,
  renderBadge,
  testId,
}: {
  order: string[];
  accounts: ClaudeAccountView[];
  disabled?: boolean;
  onChange: (next: string[]) => void;
  /** 名前の下の1行（既定の並びはメールアドレス、Project の並びは使用率） */
  renderDetail: (a: ClaudeAccountView) => ReactNode;
  renderBadge?: (a: ClaudeAccountView) => ReactNode;
  testId: string;
}) {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const move = (i: number, d: -1 | 1) => {
    const next = [...order];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    onChange(next);
  };
  const missing = accounts.filter((a) => !order.includes(a.id));
  return (
    <div className="flex flex-col gap-2">
      <ol data-testid={testId} className="flex flex-col rounded-lg border border-border">
        {order.map((id, i) => {
          const a = byId.get(id);
          return (
            <li
              key={id}
              data-testid={`${testId}-row`}
              data-account-id={id}
              className="flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0"
            >
              <span className="w-4 shrink-0 text-right text-xs tabular-nums text-ink-3">{i + 1}</span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span data-testid={`${testId}-label`} className="truncate text-sm text-foreground">
                  {a?.label ?? id}
                </span>
                {a ? <span className="truncate text-xs text-ink-3">{renderDetail(a)}</span> : null}
              </span>
              {a && renderBadge ? renderBadge(a) : null}
              <IconButton label="上へ" disabled={disabled || i === 0} onClick={() => move(i, -1)}>
                <ArrowUp className="size-3.5" />
              </IconButton>
              <IconButton label="下へ" disabled={disabled || i === order.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown className="size-3.5" />
              </IconButton>
              <IconButton
                label="並びから外す"
                disabled={disabled || order.length === 1}
                onClick={() => onChange(order.filter((x) => x !== id))}
              >
                <X className="size-3.5" />
              </IconButton>
            </li>
          );
        })}
      </ol>
      {missing.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {missing.map((a) => (
            <Button key={a.id} size="sm" variant="ghost" className="text-xs" disabled={disabled} onClick={() => onChange([...order, a.id])}>
              <Plus className="size-3" />
              {a.label}を並びに足す
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * **API キーの使用量**（v4-distribution.md §3「使用量」）。5時間・週の枠の代わりに、足してから使ったトークン（入力・出力・
 * キャッシュの書き・読み）と金額の目安。値段の表に無いモデルがあれば、その分は金額に入っていないと言う
 */
export function TokenSpend({ usage, testId }: { usage: ClaudeTokenUsage | undefined; testId?: string }) {
  const u = usage ?? { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, costUsd: 0, priceTable: "", since: "" };
  const rows: ReadonlyArray<readonly [string, number, string]> = [
    ["入力", u.inputTokens, "input"],
    ["出力", u.outputTokens, "output"],
    ["キャッシュの書き", u.cacheWriteTokens, "cache-write"],
    ["キャッシュの読み", u.cacheReadTokens, "cache-read"],
  ];
  return (
    <div data-testid={testId} className="flex min-w-0 flex-col gap-1 text-xs">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-ink-2">使った金額の目安</span>
        <span data-testid={testId ? `${testId}-cost` : undefined} className="text-sm font-semibold tabular-nums text-foreground">
          {formatUsd(u.costUsd)}
        </span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-ink-3">
        {rows.map(([label, n, key]) => (
          <div key={key} className="contents">
            <dt>{label}</dt>
            <dd data-testid={testId ? `${testId}-${key}` : undefined} className="text-right tabular-nums">
              {formatTokens(n)}
            </dd>
          </div>
        ))}
      </dl>
      {u.unpricedModels && u.unpricedModels.length > 0 ? (
        <span className="text-ink-3">値段の表に無いモデル（{u.unpricedModels.join("、")}）の分は金額に入っていません</span>
      ) : null}
    </div>
  );
}
