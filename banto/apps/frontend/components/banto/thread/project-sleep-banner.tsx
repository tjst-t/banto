"use client";

// **眠っている Project の会話の面の帯**（追加・2026-10-16、v4-frontend.md §6.43「スリープ」）。
//
// 開いている Project が眠った（自動で眠った・別の画面で眠らせた——`projects.changed` で写しが替わる）ら、会話の上に
// 「スリープ中です」を出す。会話は読めて、送ればターンが開いて起きる（アーキ §2.2）。起きるまで——この画面が
// `modules/prepare` を投げて待っている間、または送ったターンが走り出してから起きた知らせが届くまで——は「起こしています」。
import { LoaderCircle, Moon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getProject, wakeProject } from "@/lib/mock/projects";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import { useProjectWaking } from "@/lib/backend/project-waking";
import { useProjectRunning } from "@/lib/backend/running-threads";
import { reportFailure } from "@/lib/report-failure";

export function ProjectSleepBanner({ projectId }: { projectId: string }) {
  useMockStoreVersion();
  const asleep = getProject(projectId).sleep !== undefined;
  const preparing = useProjectWaking(projectId);
  const running = useProjectRunning(projectId);
  if (preparing || (asleep && running)) {
    return (
      <div
        role="status"
        data-testid="project-sleep-banner"
        data-state="waking"
        className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-2 px-3 py-2 text-sm text-ink-2"
      >
        <LoaderCircle className="size-4 shrink-0 animate-spin text-ink-3" aria-hidden />
        <span className="min-w-0 flex-1">起こしています…</span>
      </div>
    );
  }
  if (!asleep) return null;
  return (
    <div
      role="status"
      data-testid="project-sleep-banner"
      data-state="asleep"
      className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-2 px-3 py-2 text-sm text-ink-2"
    >
      <Moon className="size-4 shrink-0 text-ink-3" aria-hidden />
      <span className="min-w-0 flex-1">スリープ中です。会話は読めます。送ると起きます</span>
      <Button
        size="sm"
        variant="outline"
        className="h-7 shrink-0"
        onClick={() => void wakeProject(projectId).catch((err: unknown) => reportFailure("この Project を起こせませんでした", err))}
      >
        起こす
      </Button>
    </div>
  );
}
