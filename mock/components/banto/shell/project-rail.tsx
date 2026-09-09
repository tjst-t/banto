"use client";

// デスクトップのサイドバー。幅は2段階（決定・2026-09-09、ユーザー指摘
// 「アイコンだけでは Project 名が読めない」）：
//
// | 状態 | 幅 | 何が見えるか |
// |---|---|---|
// | 展開（既定） | 16rem | `NavPanel`——Project 名・その下に開いている Thread の一覧 |
// | 畳んだ状態 | 58px | アイコンだけ。Project 名はツールチップ、Fork はバッジのポップオーバー |
//
// 畳んだ状態は従来のレールそのまま——狭い画面や、会話に集中したいときの逃げ道として残す。
// 切り替えは自分のボタンか ⌘B / Ctrl-B（shadcn の Sidebar が持っている）。
//
// ≥md でのみ表示する——<md では isMobile 判定で描画自体をやめる（モバイルは
// `MobileNavDrawer` が同じ `NavPanel` を左からの Drawer で出す）。
import { useState } from "react";
import Link from "next/link";
import { Bell, Clock, GitFork, PanelLeft, Plus, Search, Settings } from "lucide-react";
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
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { NewProjectDialog } from "@/components/banto/project/new-project-dialog";
import { getActiveProjects } from "@/lib/mock/projects";
import { getThreadsForProject } from "@/lib/mock/threads";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import { cn } from "@/lib/utils";
import { getJudgmentCount, NavPanel, ProjectInitial } from "./nav-panel";
import { ThemeToggle } from "./theme-toggle";

/** 畳んだ状態のレールで使う、正方形のアイコンボタン */
function RailIconButton({
  icon: Icon,
  label,
  onClick,
  children,
}: {
  icon: typeof Bell;
  label: string;
  onClick?: () => void;
  /** バッジ等、ボタンの中に重ねるもの */
  children?: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          className="relative flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-accent hover:text-foreground"
        >
          <Icon className="size-4" />
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

/** 畳んだ状態の中身——アイコンだけの細いレール（従来の見た目） */
function CollapsedRail({
  activeProjectId,
  onOpenInbox,
  onOpenPalette,
  onOpenArchive,
  onNewProject,
}: {
  activeProjectId: string | null;
  onOpenInbox: () => void;
  onOpenPalette: () => void;
  onOpenArchive: () => void;
  onNewProject: () => void;
}) {
  const { toggleSidebar } = useSidebar();
  const judgmentCount = getJudgmentCount();

  return (
    <>
      <SidebarHeader className="items-center gap-2 px-0 py-3">
        <RailIconButton icon={PanelLeft} label="サイドバーを開く（⌘B / Ctrl-B）" onClick={toggleSidebar} />
        <RailIconButton icon={Bell} label="受信箱" onClick={onOpenInbox}>
          {judgmentCount > 0 ? (
            <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-turn text-xs leading-none font-semibold text-on-color">
              {judgmentCount}
            </span>
          ) : null}
        </RailIconButton>
        <RailIconButton icon={Search} label="検索（⌘K / Ctrl-K）" onClick={onOpenPalette} />
      </SidebarHeader>

      {/* shadcn の SidebarContent は collapsible="icon" のとき自分自身に overflow-hidden
          を掛ける（テキストラベルを隠す用途）。畳んだレールは常時アイコンのみなので
          その用途は無く、逆に Fork Thread バッジ（先頭の項目だと -top-0.5 で自分の
          外にはみ出す）の上側を切ってしまっていた——!overflow-visible で外す */}
      <SidebarContent className="!overflow-visible items-center gap-1 px-0">
        <SidebarMenu className="items-center gap-1 px-0">
          {getActiveProjects().map((project) => {
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
                        <ProjectInitial project={project} active={active} />
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
        <RailIconButton icon={Plus} label="新しい Project" onClick={onNewProject} />
      </SidebarContent>

      <SidebarFooter className="items-center gap-2 py-3">
        <RailIconButton icon={Clock} label="履歴" onClick={onOpenArchive} />
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
      </SidebarFooter>
    </>
  );
}

export function ProjectRail({
  activeProjectId,
  activeForkThreadId,
  onOpenInbox,
  onOpenPalette,
  onOpenArchive,
}: {
  /** null＝いま instance 設定（/settings）を見ている */
  activeProjectId: string | null;
  /** いま開いている Fork Thread（目次のどの行を選択中として出すか） */
  activeForkThreadId: string | null;
  onOpenInbox: () => void;
  onOpenPalette: () => void;
  onOpenArchive: () => void;
}) {
  const isMobile = useIsMobile();
  useMockStoreVersion();
  const [showNewProject, setShowNewProject] = useState(false);
  if (isMobile) return null;

  return (
    <Sidebar collapsible="icon" className="border-r border-border">
      <SidebarBody
        activeProjectId={activeProjectId}
        activeForkThreadId={activeForkThreadId}
        onOpenInbox={onOpenInbox}
        onOpenPalette={onOpenPalette}
        onOpenArchive={onOpenArchive}
        onNewProject={() => setShowNewProject(true)}
      />
      <NewProjectDialog open={showNewProject} onOpenChange={setShowNewProject} />
    </Sidebar>
  );
}

/** 幅の状態で中身を切り替える。useSidebar は Sidebar の中でしか読めないので分けている */
function SidebarBody({
  activeProjectId,
  activeForkThreadId,
  onOpenInbox,
  onOpenPalette,
  onOpenArchive,
  onNewProject,
}: {
  activeProjectId: string | null;
  activeForkThreadId: string | null;
  onOpenInbox: () => void;
  onOpenPalette: () => void;
  onOpenArchive: () => void;
  onNewProject: () => void;
}) {
  const { state, toggleSidebar } = useSidebar();

  if (state === "collapsed") {
    return (
      <CollapsedRail
        activeProjectId={activeProjectId}
        onOpenInbox={onOpenInbox}
        onOpenPalette={onOpenPalette}
        onOpenArchive={onOpenArchive}
        onNewProject={onNewProject}
      />
    );
  }

  return (
    <NavPanel
      activeProjectId={activeProjectId}
      activeForkThreadId={activeForkThreadId}
      onOpenInbox={onOpenInbox}
      onOpenPalette={onOpenPalette}
      onOpenArchive={onOpenArchive}
      onNewProject={onNewProject}
      headerAction={
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={toggleSidebar}
              aria-label="サイドバーを畳む"
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-accent hover:text-foreground"
            >
              <PanelLeft className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">サイドバーを畳む（⌘B / Ctrl-B）</TooltipContent>
        </Tooltip>
      }
    />
  );
}
