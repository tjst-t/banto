"use client";

// **サイドバーの Project の行の「移しています」の印**（追加・2026-10-12、ユーザー要望。Backlog #270 runtime-move-visible）。
// AI が動いている印・混んでいる印と並ぶ。中身（どこからどこへ・進み具合）は会話の面の帯（`runtime-move-banner.tsx`）
import { ArrowRightLeft } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useRuntimeMove } from "@/lib/backend/runtime-moves";

export function MovingProjectMark({ projectId, projectName }: { projectId: string; projectName: string }) {
  const move = useRuntimeMove(projectId);
  if (!move) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          data-testid="sidebar-project-moving"
          aria-label={`${projectName} を移しています`}
          className="flex size-5 shrink-0 items-center justify-center text-turn"
        >
          <ArrowRightLeft className="size-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">
        移しています（{move.from.label} から {move.to.label} へ）
      </TooltipContent>
    </Tooltip>
  );
}
