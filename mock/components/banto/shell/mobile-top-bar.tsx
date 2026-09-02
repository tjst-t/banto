"use client";

// prototype の `@media (max-width:760px)` で `.rail` が上部バーになる挙動に対応。
// <md でのみ表示する（≥md では ProjectRail が縦レールとして出る）。
import { useState } from "react";
import Link from "next/link";
import { Bell, Clock, Plus, Search, Settings } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { NewProjectDialog } from "@/components/banto/project/new-project-dialog";
import { getInboxItems } from "@/lib/mock/inbox";
import { getActiveProjects } from "@/lib/mock/projects";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "./theme-toggle";

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
      <button
        type="button"
        onClick={onOpenPalette}
        className="flex size-9 items-center justify-center rounded-md text-ink-3"
        aria-label="検索（Command Palette）"
      >
        <Search className="size-4" />
      </button>
      <button
        type="button"
        onClick={onOpenArchive}
        className="flex size-9 items-center justify-center rounded-md text-ink-3"
        aria-label="履歴"
      >
        <Clock className="size-4" />
      </button>

      <nav className="flex flex-1 items-center gap-1 overflow-x-auto">
        {getActiveProjects().map((project) => {
          const active = project.id === activeProjectId;
          return (
            <Link
              key={project.id}
              href={`/p/${project.id}`}
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-md text-sm font-semibold",
                active ? "bg-accent-soft text-accent-ink" : "bg-surface-3 text-ink-2",
              )}
            >
              {project.initial}
            </Link>
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
      <ThemeToggle />
      <NewProjectDialog open={showNewProject} onOpenChange={setShowNewProject} />
    </header>
  );
}
