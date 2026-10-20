"use client";

// **任務を持つ Thread の行の下の薄い1行**（決定・2026-10-20、ユーザー。v4-frontend.md §6.47）。裏の仕事の行（§6.33）と同じ形で
// 「任務：次は 10:30（3/20）」「任務：〈出来事の題〉を待っています」。枠を使い切った・止まっているときは人の番の色。押すと任務の面。
// 任務が動いていて裏の仕事もあるときは、裏の仕事の行が「任務・バックグラウンドで n 件」にまとめる（`background-work.tsx`）ので出さない
import { useState } from "react";
import { Target } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MissionPanel } from "@/components/banto/thread/mission-panel";
import { useThreadBackground } from "@/lib/backend/background-work";
import { missionIsOpen, missionLineOf, missionNeedsHuman, useThreadMission } from "@/lib/backend/missions";
import { cn } from "@/lib/utils";

export function ThreadMissionLine({ threadId, threadTitle }: { threadId: string; threadTitle: string }) {
  const mission = useThreadMission(threadId);
  const work = useThreadBackground(threadId).filter((i) => i.waitingOn !== "human");
  const [open, setOpen] = useState(false);
  if (!missionIsOpen(mission)) return null;
  if (mission.status === "active" && work.length > 0) return null;
  const human = missionNeedsHuman(mission);
  const line = missionLineOf(mission);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${threadTitle}の${line}（任務の面を開く）`}
          data-testid="thread-mission"
          data-status={mission.status}
          className={cn(
            "flex w-full items-center gap-1 truncate rounded-md py-0.5 pr-1 pl-8 text-left text-xs hover:bg-sidebar-accent",
            human ? "font-medium text-turn" : "text-ink-3 hover:text-foreground",
          )}
        >
          <Target className="size-3 shrink-0" />
          <span className="truncate">{line}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" className="w-96 p-3">
        <MissionPanel threadId={threadId} mission={mission} />
      </PopoverContent>
    </Popover>
  );
}
