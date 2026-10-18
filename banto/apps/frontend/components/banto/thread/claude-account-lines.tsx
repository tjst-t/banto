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

/**
 * 最後のターンが上限で終わった（会話の一番下に出す）。自動では続けないときは、その理由も（§6.46——6回続けて断られたら、
 * 待ちの帯の代わりに「続けて上限に当たったので、自動で続けるのをやめました」）。続けるのは受信箱のカードかこの会話で送る
 */
export function RateLimitStoppedBand({ stop }: { stop: "stopped" | "gave_up" | "unknown_reset" }) {
  return (
    <div
      data-testid="thread-rate-limit-stopped"
      data-stop={stop}
      className="flex items-start gap-2 rounded-md border border-stop/40 bg-stop-soft px-3 py-2 text-xs text-foreground"
    >
      <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-stop" />
      <div className="flex flex-col gap-0.5">
        <span>Claude の使用量の上限に当たったので、このターンは途中で止まりました。</span>
        {stop === "gave_up" ? (
          <span data-testid="thread-rate-limit-gave-up">
            続けて上限に当たったので、自動で続けるのをやめました。続けるなら、受信箱のカードの「続ける」を押すか、この会話で次を送ってください。
          </span>
        ) : stop === "unknown_reset" ? (
          <span data-testid="thread-rate-limit-gave-up">
            上限がいつ戻るかが分からないので、自動では続けません。続けるなら、受信箱のカードの「続ける」を押すか、この会話で次を送ってください。
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * **残りの分が変わるたびに進む「いま」**（残りの時間を描き直す）。描き直すのは壁時計の分の頭ではなく、残り
 * （`continueAt` − いま）が分の境を越える時刻——表示（分は切り捨て）は越えたその時に変わる。壁時計の分の頭に合わせると、
 * 残りが境を越えてから最長で1分近く古い分を出し続けていた（レビュー指摘、E2E が 11% の位相で落ちた）。
 * 待ちが替わったら呼ぶ側が作り直す（`key`）——初めの値は useState の初期値
 */
function useRemainingClock(continueAt: string): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const at = Date.parse(continueAt);
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      // 次に残りが分の境を越えるまで（ちょうど境なら1分後）。少しだけ遅らせて、越えた後に読む
      const left = (at - Date.now()) % 60_000;
      timer = setTimeout(tick, (left > 0 ? left : 60_000 + left) + 50);
    };
    const tick = () => {
      setNow(Date.now());
      schedule();
    };
    schedule();
    return () => clearTimeout(timer);
  }, [continueAt]);
  return now;
}

/** **上限が戻るのを待っている**——入力欄の上の帯。待ちは host の出来事の流れから（`rate-limit-waits.ts`） */
export function RateLimitWaitBanner({ threadId }: { threadId: string }) {
  const continueAt = useRateLimitWait(threadId);
  if (continueAt === undefined) return null;
  // 待ちが替わったら作り直す（残りの時計を新しい時刻で始める）
  return <RateLimitWaitBody key={continueAt} threadId={threadId} continueAt={continueAt} />;
}

function RateLimitWaitBody({ threadId, continueAt }: { threadId: string; continueAt: string }) {
  const now = useRemainingClock(continueAt);
  const [busy, setBusy] = useState(false);
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
