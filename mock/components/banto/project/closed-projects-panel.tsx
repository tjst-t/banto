"use client";

// 終了した Project の一覧（サイドバー下部の時計アイコンから開く）。
// 削除ではなく終了——概要を読み返し、再度開ける。
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Clock, RotateCcw } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getClosedProjects, reopenProject } from "@/lib/mock/projects";
import { getAllThreadsForProject } from "@/lib/mock/threads";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import { cn } from "@/lib/utils";

export function ClosedProjectsPanel() {
  useMockStoreVersion();
  const router = useRouter();
  const closedProjects = getClosedProjects();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  function handleReopen(id: string) {
    reopenProject(id);
    router.push(`/p/${id}`);
  }

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-accent hover:text-foreground"
              aria-label="終了した Project"
            >
              <Clock className="size-4" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="right">終了した Project（{closedProjects.length}）</TooltipContent>
      </Tooltip>
      <PopoverContent side="right" align="end" className="w-72 p-1.5">
        <p className="px-2 py-1 text-xs font-medium text-ink-3">終了した Project</p>
        {closedProjects.length === 0 ? (
          <p className="px-2 py-2 text-xs text-ink-3">無い</p>
        ) : (
          <div className="flex flex-col">
            {closedProjects.map((project) => {
              const expanded = expandedId === project.id;
              const threadCount = getAllThreadsForProject(project.id).length;
              return (
                <div key={project.id}>
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : project.id)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                  >
                    <span
                      className={cn(
                        "flex size-6 shrink-0 items-center justify-center rounded-md bg-surface-3 text-xs font-semibold text-ink-2",
                      )}
                    >
                      {project.initial}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  </button>
                  {expanded ? (
                    <div className="mb-1 flex flex-col gap-1.5 rounded-md bg-surface-2 px-2.5 py-2 text-xs text-ink-3">
                      <div className="flex items-center justify-between gap-2">
                        <span>Base パス</span>
                        <span className="truncate font-mono text-ink-2">{project.basePath}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span>終了日</span>
                        <span className="text-ink-2">{project.closedAt}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span>Thread</span>
                        <span className="text-ink-2">{threadCount}件</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleReopen(project.id)}
                        className="mt-1 flex items-center justify-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs text-ink-2 hover:bg-accent"
                      >
                        <RotateCcw className="size-3.5" /> 再度開く
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
