"use client";

// きっかけの専用の Fork の上に出す1行（決定・2026-10-15、`lib/mock/triggers.ts`）。
// 開いた人が「この会話は、何かが起きると AI が勝手に動く」と分かるように。人はそのまま話しかけてよい
import Link from "next/link";
import { Hand, Play, Settings2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { describeSource, runTriggerNow, type MockTrigger } from "@/lib/mock/triggers";
import { useMockStoreVersion } from "@/lib/mock/store-events";

export function TriggerBand({ trigger: t }: { trigger: MockTrigger }) {
  useMockStoreVersion();
  const last = t.runs[0];
  const waiting = last?.result === "waiting";
  const how =
    t.target.kind === "dedicated" && t.target.mode === "continue" ? "前の回の会話を引き継いで" : "毎回まっさらな会話で";

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-4 py-2 text-xs",
        waiting ? "border-turn/30 bg-turn-soft/60" : "border-border bg-surface-2/60",
      )}
      data-testid="trigger-band"
    >
      <p className="flex min-w-0 flex-1 items-center gap-1.5 text-ink-2">
        {waiting ? (
          <Hand className="size-3.5 shrink-0 text-turn" />
        ) : (
          <Zap className={cn("size-3.5 shrink-0", t.paused ? "text-ink-3" : "text-primary")} />
        )}
        <span className="min-w-0">
          {waiting ? <span className="text-foreground">{last.at} の回が、あなたの答えを待っています。</span> : null}
          自動で動く会話です。{describeSource(t.source)}に、{how}動きます。
          {t.paused ? "いまは一時停止中です。" : t.source.kind === "time" ? `次は ${t.nextRun}。` : `${t.nextRun}。`}
        </span>
      </p>
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1 text-xs"
          onClick={() => runTriggerNow(t.id)}
          disabled={waiting || last?.result === "running"}
        >
          <Play className="size-3.5" />
          今すぐ動かす
        </Button>
        <Button asChild variant="ghost" size="sm" className="h-7 gap-1 text-xs">
          <Link href={`/settings?project=${t.projectId}&section=project-triggers`}>
            <Settings2 className="size-3.5" />
            設定
          </Link>
        </Button>
      </div>
    </div>
  );
}
