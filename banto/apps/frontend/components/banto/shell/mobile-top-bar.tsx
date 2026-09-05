"use client";

// prototype の `@media (max-width:760px)` で `.rail` が上部バーになる挙動に対応。
// <md でのみ表示する（≥md では ProjectRail が縦レールとして出る）。
import { useState } from "react";
import Link from "next/link";
import { Bell, Clock, GitFork, Plus, Search, Settings } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { NewProjectDialog } from "@/components/banto/project/new-project-dialog";
import { getInboxItems } from "@/lib/mock/inbox";
import { getActiveProjects } from "@/lib/mock/projects";
import { getThreadsForProject } from "@/lib/mock/threads";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import { cn } from "@/lib/utils";
import { CONNECTED_FEATURES } from "@/lib/feature-flags";
import { ThemeToggle } from "./theme-toggle";

const SHOW_ARCHIVE = CONNECTED_FEATURES.threadCloseReopen || CONNECTED_FEATURES.projectCloseReopen;

export function MobileTopBar({
  activeProjectId,
  onOpenInbox,
  onOpenPalette,
  onOpenArchive,
}: {
  /** null＝いま instance 設定（/settings）を見ている */
  activeProjectId: string | null;
  onOpenInbox: () => void;
  onOpenPalette: () => void;
  onOpenArchive: () => void;
}) {
  const isMobile = useIsMobile();
  useMockStoreVersion();
  const [showNewProject, setShowNewProject] = useState(false);
  const judgmentCount = getInboxItems().filter((item) => item.kind === "judgment").length;
  if (!isMobile) return null;

  return (
    <header className="flex h-[50px] shrink-0 items-center gap-1 border-b border-border bg-surface-2 px-2">
      {CONNECTED_FEATURES.inbox ? (
        <button
          type="button"
          onClick={onOpenInbox}
          className="relative flex size-9 items-center justify-center rounded-md text-ink-3"
          aria-label="受信箱"
        >
          <Bell className="size-4" />
          {judgmentCount > 0 ? (
            <span className="absolute top-0.5 right-0.5 flex size-4 items-center justify-center rounded-full bg-turn text-xs leading-none font-semibold text-on-color">
              {judgmentCount}
            </span>
          ) : null}
        </button>
      ) : null}
      <button
        type="button"
        onClick={onOpenPalette}
        className="flex size-9 items-center justify-center rounded-md text-ink-3"
        aria-label="検索（Command Palette）"
      >
        <Search className="size-4" />
      </button>
      {SHOW_ARCHIVE ? (
        <button
          type="button"
          onClick={onOpenArchive}
          className="flex size-9 items-center justify-center rounded-md text-ink-3"
          aria-label="履歴"
        >
          <Clock className="size-4" />
        </button>
      ) : null}

      <nav className="flex flex-1 items-center gap-1 overflow-x-auto">
        {getActiveProjects().map((project) => {
          const active = project.id === activeProjectId;
          const forks = getThreadsForProject(project.id).filter((t) => t.kind === "fork");
          return (
            <div key={project.id} className="relative shrink-0">
              <Link
                href={`/p/${project.id}`}
                className={cn(
                  "flex size-8 items-center justify-center rounded-md text-sm font-semibold",
                  active ? "bg-accent-soft text-accent-ink" : "text-ink-2",
                )}
              >
                {project.initial}
              </Link>
              {/* デスクトップ（project-rail.tsx）と同じFork Thread切替口——
                  モバイルのみ表示が抜けていた（指摘・2026-09-04） */}
              {forks.length > 0 ? (
                <Popover>
                  <PopoverTrigger asChild>
                    <Badge
                      asChild
                      className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full p-0 ring-2 ring-surface-2"
                    >
                      <button
                        type="button"
                        aria-label={`${project.name} の Fork Thread（${forks.length}件）を開く`}
                      />
                    </Badge>
                  </PopoverTrigger>
                  <PopoverContent side="bottom" align="start" className="w-60 p-1.5">
                    <p className="px-2 py-1 text-xs font-medium text-ink-3">
                      {project.name} の Fork Thread
                    </p>
                    <div className="flex flex-col">
                      {forks.map((fork) => (
                        <Link
                          key={fork.id}
                          href={`/p/${project.id}?fork=${fork.id}`}
                          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink-2 hover:bg-accent hover:text-foreground"
                        >
                          <GitFork className="size-3.5 shrink-0 text-ink-3" />
                          <span className="truncate">{fork.title}</span>
                        </Link>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
              ) : null}
            </div>
          );
        })}
        <button
          type="button"
          onClick={() => setShowNewProject(true)}
          aria-label="新しい Project"
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-ink-3"
        >
          <Plus className="size-4" />
        </button>
      </nav>

      {CONNECTED_FEATURES.settings ? (
        <Link
          href="/settings"
          aria-label="設定"
          className={cn(
            "flex size-9 items-center justify-center rounded-md",
            activeProjectId === null ? "bg-accent-soft text-accent-ink" : "text-ink-3",
          )}
        >
          <Settings className="size-4" />
        </Link>
      ) : null}
      <ThemeToggle />
      <NewProjectDialog open={showNewProject} onOpenChange={setShowNewProject} />
    </header>
  );
}
