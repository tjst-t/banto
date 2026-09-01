"use client";

// prototype の `.rail`（幅58pxの縦レール、Project 切替）に対応。
// ≥md でのみ表示する——<md では isMobile 判定で描画自体をやめる
// （Sidebar は isMobile のとき自動で Sheet オーバーレイになるが、
// banto のモバイル意匠はそれではなく MobileTopBar なので、ここで明示的に避ける）。
import Link from "next/link";
import { Bell, GitFork, Settings } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { mockInboxItems } from "@/lib/mock/inbox";
import { mockProjects } from "@/lib/mock/projects";
import { getThreadsForProject } from "@/lib/mock/threads";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "./theme-toggle";

// 判断待ちだけをバッジの件数にする——溜めてよくない（止まっている）方が
// 急ぎだから（§2.4）。レビュー待ちは溜めてよいので件数に含めない
const judgmentCount = mockInboxItems.filter((item) => item.kind === "judgment").length;

export function ProjectRail({
  activeProjectId,
  onOpenInbox,
}: {
  /** null＝いま instance 設定（/settings）を見ている */
  activeProjectId: string | null;
  onOpenInbox: () => void;
}) {
  const isMobile = useIsMobile();
  if (isMobile) return null;

  return (
    <Sidebar collapsible="icon" className="border-r border-border">
      <SidebarHeader className="items-center gap-2 px-0 py-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onOpenInbox}
              className="relative flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-accent hover:text-foreground"
              aria-label="受信箱"
            >
              <Bell className="size-4" />
              {judgmentCount > 0 ? (
                <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-turn text-xs leading-none font-semibold text-on-color">
                  {judgmentCount}
                </span>
              ) : null}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">受信箱</TooltipContent>
        </Tooltip>
      </SidebarHeader>

      {/* shadcn の SidebarContent は collapsible="icon" のとき自分自身に overflow-hidden
          を掛ける（テキストラベルを隠す用途）。banto のレールは常時アイコンのみなので
          その用途は無く、逆に Fork Thread バッジ（先頭の項目だと -top-0.5 で自分の
          外にはみ出す）の上側を切ってしまっていた——!overflow-visible で外す */}
      <SidebarContent className="!overflow-visible items-center gap-1 px-0">
        <SidebarMenu className="items-center gap-1 px-0">
          {mockProjects.map((project) => {
            const active = project.id === activeProjectId;
            const forks = getThreadsForProject(project.id).filter((t) => t.kind === "fork");
            return (
              <SidebarMenuItem key={project.id} className="relative flex justify-center">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <SidebarMenuButton
                      asChild
                      className="size-9 justify-center overflow-visible p-0"
                      isActive={active}
                    >
                      <Link href={`/p/${project.id}`}>
                        <span
                          className={cn(
                            "flex size-8 items-center justify-center rounded-md text-sm font-semibold !overflow-visible",
                            active
                              ? "bg-accent-soft text-accent-ink"
                              : "text-ink-2 hover:bg-surface-3",
                          )}
                        >
                          {project.initial}
                        </span>
                      </Link>
                    </SidebarMenuButton>
                  </TooltipTrigger>
                  <TooltipContent side="right">{project.name}</TooltipContent>
                </Tooltip>

                {/* 開いている Fork Thread の一覧・切替口。バッジは Link の外に置く
                    ——入れ子の押せるもの（Link の中に button）は無効な HTML になるし、
                    クリックの意図（Project を開く／Fork を選ぶ）も曖昧になる */}
                {forks.length > 0 ? (
                  <Popover>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <PopoverTrigger asChild>
                          <Badge
                            asChild
                            className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full p-0 ring-2 ring-card hover:brightness-110"
                          >
                            <button
                              type="button"
                              aria-label={`${project.name} の Fork Thread（${forks.length}件）を開く`}
                            />
                          </Badge>
                        </PopoverTrigger>
                      </TooltipTrigger>
                      <TooltipContent side="right">Fork Thread（{forks.length}）</TooltipContent>
                    </Tooltip>
                    <PopoverContent side="right" align="start" className="w-60 p-1.5">
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
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarContent>

      <div className="flex flex-col items-center gap-2 py-3">
        {/* 常設の入口（§10 item17、決定・2026-09-01）——Command Palette を知らないと
            設定に辿り着けない状態を避ける。instance 設定（階層1）は Project の
            外側にあるので、Project 一覧とは分けてここに置く */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              href="/settings"
              aria-label="設定"
              className={cn(
                "flex size-8 items-center justify-center rounded-md",
                activeProjectId === null
                  ? "bg-accent-soft text-accent-ink"
                  : "text-ink-3 hover:bg-accent hover:text-foreground",
              )}
            >
              <Settings className="size-4" />
            </Link>
          </TooltipTrigger>
          <TooltipContent side="right">設定</TooltipContent>
        </Tooltip>
        <ThemeToggle />
      </div>
    </Sidebar>
  );
}
