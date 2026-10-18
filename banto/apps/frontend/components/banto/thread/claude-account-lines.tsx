"use client";

// **会話の中の Claude のアカウントの印**（決定・2026-10-18、ユーザー「モックの形でよい」。v4-frontend.md §6.46、見本は
// fork/multi-claude-accounts の `mock/app/claude-accounts` の「会話」）。
//   - 切り替えの1行：発言の間に、左右に線を引いた薄い1行。並びの全部が閾値を越えたときは warn の色。AI の文脈には入っていない
//   - 上限で止まったターンの帯：会話の終わりに stop-soft の帯
//   - 待ちの帯：入力欄の上に、自動で続ける時刻と残りの時間・「今すぐ続ける」「待つのをやめる」。残りは1分ごとに描き直す
import { useEffect, useState } from "react";
import { CircleAlert, Clock, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cancelRealRateLimitWait, continueRealRateLimitWait, type RealAccountSwitch } from "@/lib/backend/client";
import { clockOf, remainingOf, useRateLimitWait } from "@/lib/backend/rate-limit-waits";
import { reportFailure } from "@/lib/report-failure";
import { cn } from "@/lib/utils";

/** 外したアカウントは台帳に名前が無い */
const nameOf = (label: string | undefined) => label ?? "外したアカウント";

/** 切り替えの1行の文（v4-frontend.md §6.46「会話の中」） */
export function accountSwitchText(s: RealAccountSwitch): string {
  const to = nameOf(s.toLabel);
  if (s.allOver) return `並びのアカウントがどれも閾値を越えています。一番早くリセットされる「${to}」で続けます`;
  const from = nameOf(s.fromLabel);
  const r = s.reason;
  const why =
    r.kind === "threshold"
      ? `${from}の${r.window === "7d" ? "週" : "5時間"} ${Math.round((r.utilization ?? 0) * 100)}%`
      : r.kind === "rejected"
        ? `${from}が上限で断りました`
        : r.kind === "recovered"
          ? `「${to}」がリセットされました`
          : r.kind === "order"
            ? "並びが変わりました"
            : `${from}が使えませんでした`;
  return `Claude のアカウントを「${to}」に切り替えました（${why}）`;
}

export function AccountSwitchLine({ change }: { change: RealAccountSwitch }) {
  return (
    <div
      data-testid="thread-account-switch"
      data-all-over={change.allOver ? "" : undefined}
      className={cn("flex items-center gap-2 text-xs", change.allOver ? "text-warn" : "text-ink-3")}
    >
      <span className="h-px flex-1 bg-border" />
      <RefreshCw className="size-3 shrink-0" />
      <span className="text-center">{accountSwitchText(change)}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/** 最後のターンが上限で終わった（会話の終わりに出す） */
export function RateLimitStoppedBand() {
  return (
    <div
      data-testid="thread-rate-limit-stopped"
      className="flex items-start gap-2 rounded-md border border-stop/40 bg-stop-soft px-3 py-2 text-xs text-foreground"
    >
      <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-stop" />
      Claude の使用量の上限に当たったので、このターンは途中で止まりました。
    </div>
  );
}

/** 1分ごとに進む「いま」（残りの時間を描き直す） */
function useMinuteClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    // 分の変わり目に合わせて描き直す（最初の1回は次の分まで）
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(Date.now());
      timer = setTimeout(tick, 60_000 - (Date.now() % 60_000));
    };
    timer = setTimeout(tick, 60_000 - (Date.now() % 60_000));
    return () => clearTimeout(timer);
  }, [active]);
  return now;
}

/** **上限が戻るのを待っている**——入力欄の上の帯。待ちは host の出来事の流れから（`rate-limit-waits.ts`） */
export function RateLimitWaitBanner({ threadId }: { threadId: string }) {
  const continueAt = useRateLimitWait(threadId);
  const now = useMinuteClock(continueAt !== undefined);
  const [busy, setBusy] = useState(false);
  if (continueAt === undefined) return null;
  const act = (what: "continue" | "cancel") => {
    setBusy(true);
    // 帯は host の知らせ（rate_limit_wait.changed）で消える——ここで先に消さない（規則3）
    void (what === "continue" ? continueRealRateLimitWait(threadId) : cancelRealRateLimitWait(threadId))
      .catch((err: unknown) => reportFailure(what === "continue" ? "今すぐ続けられませんでした" : "待つのをやめられませんでした", err))
      .finally(() => setBusy(false));
  };
  return (
    <div
      data-testid="thread-rate-limit-wait"
      data-continue-at={continueAt}
      className="mb-2 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-2 px-4 py-3"
    >
      <Clock className="size-4 shrink-0 text-primary" />
      <div className="flex min-w-48 flex-1 flex-col">
        <span className="text-sm text-foreground" data-testid="thread-rate-limit-wait-when">
          {clockOf(continueAt)} に自動で続けます（あと {remainingOf(continueAt, now)}）
        </span>
        <span className="text-xs text-ink-3">上限が戻ったら、止まったところから続けます。何か送ると、待たずにその発言で始めます。</span>
      </div>
      {/* 携帯の幅ではボタンを下の段に回す（flex-wrap） */}
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={busy} data-testid="thread-rate-limit-continue" onClick={() => act("continue")}>
          今すぐ続ける
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} data-testid="thread-rate-limit-cancel" onClick={() => act("cancel")}>
          待つのをやめる
        </Button>
      </div>
    </div>
  );
}
