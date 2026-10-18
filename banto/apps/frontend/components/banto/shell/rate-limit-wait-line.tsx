"use client";

// **上限が戻るのを待っている Thread の行の下の薄い1行**（決定・2026-10-18、v4-frontend.md §6.46）。裏の仕事（§6.33）と同じ形の
// 時計のアイコンの1行「上限が戻るのを待っています（HH:MM）」。人の番の色にはしない——リセットのあと host が自動で続ける
import { Clock } from "lucide-react";
import { clockOf, useRateLimitWait } from "@/lib/backend/rate-limit-waits";

export function ThreadRateLimitWaitLine({ threadId }: { threadId: string }) {
  const continueAt = useRateLimitWait(threadId);
  if (continueAt === undefined) return null;
  return (
    <span data-testid="thread-rate-limit-waiting" className="flex w-full items-center gap-1 truncate py-0.5 pr-1 pl-8 text-xs text-ink-3">
      <Clock className="size-3 shrink-0" />
      <span className="truncate">上限が戻るのを待っています（{clockOf(continueAt)}）</span>
    </span>
  );
}
