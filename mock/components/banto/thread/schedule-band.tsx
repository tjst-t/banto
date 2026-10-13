"use client";

// 予定の専用の Fork の上に出す1行（決定・2026-10-13、`lib/mock/schedules.ts`）。
// 開いた人が「この会話は時刻が来ると AI が勝手に動く」と分かるように。人はそのまま話しかけてよい
import Link from "next/link";
import { CalendarClock, Hand, Play, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { describeRepeat, runScheduleNow, timeZoneLabel, type MockSchedule } from "@/lib/mock/schedules";
import { useMockStoreVersion } from "@/lib/mock/store-events";

export function ScheduleBand({ schedule: s }: { schedule: MockSchedule }) {
  useMockStoreVersion();
  const last = s.runs[0];
  const waiting = last?.result === "waiting";

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-4 py-2 text-xs",
        waiting ? "border-turn/30 bg-turn-soft/60" : "border-border bg-surface-2/60",
      )}
      data-testid="schedule-band"
    >
      <p className="flex min-w-0 flex-1 items-center gap-1.5 text-ink-2">
        {waiting ? (
          <Hand className="size-3.5 shrink-0 text-turn" />
        ) : (
          <CalendarClock className={cn("size-3.5 shrink-0", s.paused ? "text-ink-3" : "text-primary")} />
        )}
        <span className="min-w-0">
          {waiting ? (
            <span className="text-foreground">{last.at} の回が、あなたの答えを待っています。</span>
          ) : null}
          予定で動く会話です。{describeRepeat(s.repeat)}（{timeZoneLabel(s.timeZone)}）に、
          {s.mode === "fresh" ? "毎回まっさらな会話で" : "前の回の会話を引き継いで"}動きます。
          {s.paused ? "いまは一時停止中です。" : `次は ${s.nextRun}。`}
        </span>
      </p>
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1 text-xs"
          onClick={() => runScheduleNow(s.id)}
          disabled={waiting || last?.result === "running"}
        >
          <Play className="size-3.5" />
          今すぐ動かす
        </Button>
        <Button asChild variant="ghost" size="sm" className="h-7 gap-1 text-xs">
          <Link href={`/settings?project=${s.projectId}&section=project-schedules`}>
            <Settings2 className="size-3.5" />
            予定の設定
          </Link>
        </Button>
      </div>
    </div>
  );
}
