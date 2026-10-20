"use client";

// **自動化の専用の Fork の上に出す1行**（決定・2026-10-15、v4-frontend.md §6.42。見本はモックの trigger-band.tsx）。
// 開いた人が「この会話は、決まった時刻に AI が動く」と分かるように。人はそのまま話しかけてよい。
// 前の回があなたの答えを待っていれば（この会話に生きた判断待ちがある）、人の番の色にして先頭でそう言う。
import { useState } from "react";
import { UrlLink as Link } from "@/components/banto/url-link";
import { Hand, List, Play, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  automationTimeZone,
  automationsCanvasHref,
  describeSource,
  formatWhen,
  runAutomationNow,
  useAutomationEventSources,
} from "@/lib/backend/automations";
import type { RealAutomation } from "@/lib/backend/client";
import { getRealJudgments, useRealInboxVersion } from "@/lib/backend/real-inbox";

export function AutomationBand({ automation: a, threadId }: { automation: RealAutomation; threadId: string }) {
  // 判断待ちは受信箱の写しから引く（台帳の「待っている」は回の終わりの時点のもので、答えたあとも残る）
  useRealInboxVersion();
  const waiting = getRealJudgments().some((j) => j.threadId === threadId);
  // 出来事のきっかけは名乗りの題で言う（時刻・Webhook なら引かない）
  const { sources } = useAutomationEventSources(a.source.kind === "event" ? a.projectId : null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const how = a.target.kind === "dedicated" && a.target.mode === "continue" ? "前の回を引き継ぐ" : "毎回まっさら";

  async function runNow() {
    setBusy(true);
    setMessage(null);
    try {
      const skipped = await runAutomationNow(a.projectId, a.id);
      if (skipped) setMessage(`動かしませんでした：${skipped}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    // 会話の列は Canvas の横で 1/3 まで狭まる——狭いときは文とボタンを2段に分ける（コンテナの幅で見る）
    <div
      className={cn("@container shrink-0 border-b px-4 py-2 text-xs", waiting ? "border-turn/30 bg-turn-soft/60" : "border-border bg-surface-2/60")}
      data-testid="automation-band"
      data-waiting={waiting ? "" : undefined}
    >
      <div className="flex flex-col gap-1.5 @lg:flex-row @lg:items-center @lg:gap-3">
        <p className="flex min-w-0 flex-1 items-center gap-1.5 text-ink-2">
          {waiting ? (
            <Hand className="size-3.5 shrink-0 text-turn" />
          ) : (
            <Zap className={cn("size-3.5 shrink-0", a.paused ? "text-ink-3" : "text-primary")} />
          )}
          <span className="min-w-0" data-testid="automation-band-text">
            {waiting ? <span className="text-foreground">前の回が、あなたの答えを待っています。</span> : null}
            {a.mode === "patrol" ? "見回り" : "自動化"}「{a.name}」で動く会話です（{describeSource(a, sources)}・{how}）。
            {a.paused ? "いまは一時停止中です。" : a.nextFireAt ? `次は ${formatWhen(a.nextFireAt, automationTimeZone(a))}。` : null}
          </span>
        </p>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={() => void runNow()}
            disabled={busy}
            data-testid="automation-band-run"
          >
            <Play className="size-3.5" />
            今すぐ動かす
          </Button>
          <Button asChild variant="ghost" size="sm" className="h-7 gap-1 text-xs">
            {/* 一覧は Canvas として、この会話の隣に開く */}
            <Link href={automationsCanvasHref(a.projectId, threadId)} data-testid="automation-band-list">
              <List className="size-3.5" />
              一覧
            </Link>
          </Button>
        </div>
      </div>
      {message ? (
        <p role="status" className="mt-1 text-ink-2" data-testid="automation-band-message">
          {message}
        </p>
      ) : null}
    </div>
  );
}
