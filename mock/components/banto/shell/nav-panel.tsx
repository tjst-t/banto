"use client";

// banto の「どこへ行くか」を1枚にしたもの——Project と、その中で開いている
// Thread の目次。**デスクトップのサイドバーと、モバイルの Drawer が同じこれを使う**
// （規則3——同じ情報構造を2度書かない。片方だけ直して食い違うのを避ける）。
//
// | 面 | 何で包むか |
// |---|---|
// | デスクトップ（展開時） | `Sidebar`（`project-rail.tsx`） |
// | モバイル | 左から出る `Drawer`（`mobile-nav-drawer.tsx`） |
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Bell,
  ChevronRight,
  Clock,
  GitFork,
  GitMerge,
  MessageSquare,
  Plus,
  Search,
  Settings,
} from "lucide-react";
import { useRovingFocus } from "@/hooks/use-roving-focus";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getInboxItems } from "@/lib/mock/inbox";
import { getActiveProjects } from "@/lib/mock/projects";
import { closeThread, getClosedForksForProject, getThreadsForProject } from "@/lib/mock/threads";
import { cn } from "@/lib/utils";
import type { MockProject, MockThread } from "@/lib/mock/types";
import { ThemeToggle } from "./theme-toggle";

/** 判断待ちだけをバッジの件数にする——溜めてよくない（止まっている）方が
 *  急ぎだから（§2.4）。レビュー待ちは溜めてよいので件数に含めない */
export function getJudgmentCount(): number {
  return getInboxItems().filter((item) => item.kind === "judgment").length;
}

/** Project の頭文字。名前の隣、または畳んだレールでは単独で Project を表す */
export function ProjectInitial({ project, active }: { project: MockProject; active: boolean }) {
  return (
    <span
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-semibold",
        active ? "bg-accent-soft text-accent-ink" : "bg-surface-3 text-ink-2",
      )}
    >
      {project.initial}
    </span>
  );
}

export interface NavPanelHandlers {
  onOpenInbox: () => void;
  onOpenPalette: () => void;
  onOpenArchive: () => void;
  onNewProject: () => void;
  /** 行き先を選んだ（＝この面の役目が終わった）。モバイルの Drawer はこれで閉じる */
  onNavigate?: () => void;
}

/**
 * Project 1件——Project 名の行と、その下にぶら下がる Thread の目次
 * （Base Thread ＋ 開いている Fork Thread）。
 *
 * Fork をアイコンの角のバッジに隠していたのをやめ、**開いている Thread は常に
 * 見えている一覧**にした（決定・2026-09-09）——Fork は「いま並行して走っている
 * 作業」なので、探しに行くものではない。
 */
function ProjectTreeItem({
  project,
  activeProjectId,
  activeForkThreadId,
  expanded,
  onToggleExpanded,
  onOpenArchive,
  onNavigate,
}: {
  project: MockProject;
  activeProjectId: string | null;
  activeForkThreadId: string | null;
  expanded: boolean;
  onToggleExpanded: () => void;
  onOpenArchive: () => void;
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const isCurrent = project.id === activeProjectId;
  const threads = getThreadsForProject(project.id);
  const forks = threads.filter((t): t is MockThread => t.kind === "fork");
  const closedForkCount = getClosedForksForProject(project.id).length;

  function foldFork(fork: MockThread) {
    closeThread(fork.id);
    // いま開いている Fork を畳んだら、その Project の Base Thread に戻る
    // ——畳んだ会話が画面に残り続けないように
    if (isCurrent && activeForkThreadId === fork.id) router.push(`/p/${project.id}`);
  }

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={isCurrent}>
        <Link
          href={`/p/${project.id}`}
          data-roving-item
          title={project.basePath}
          onClick={onNavigate}
        >
          <ProjectInitial project={project} active={isCurrent} />
          <span className="truncate">{project.name}</span>
        </Link>
      </SidebarMenuButton>
      {forks.length > 0 ? (
        <SidebarMenuAction
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          aria-label={`${project.name} の Thread 一覧を${expanded ? "畳む" : "開く"}`}
        >
          <ChevronRight className={cn("transition-transform", expanded && "rotate-90")} />
        </SidebarMenuAction>
      ) : null}

      {expanded ? (
        <SidebarMenuSub>
          <SidebarMenuSubItem>
            <SidebarMenuSubButton asChild isActive={isCurrent && activeForkThreadId === null}>
              <Link href={`/p/${project.id}`} data-roving-item onClick={onNavigate}>
                <MessageSquare />
                <span>Base Thread</span>
              </Link>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>

          {forks.map((fork) => (
            <SidebarMenuSubItem key={fork.id} className="group/fork">
              <SidebarMenuSubButton
                asChild
                isActive={isCurrent && activeForkThreadId === fork.id}
                className="pr-8"
              >
                <Link
                  href={`/p/${project.id}?fork=${fork.id}`}
                  data-roving-item
                  title={fork.title}
                  onClick={onNavigate}
                >
                  <GitFork />
                  <span>{fork.title}</span>
                </Link>
              </SidebarMenuSubButton>
              {/* 畳む口を一覧の中にも置く——Fork を開いてヘッダのアイコンを探しに
                  行かなくても、目次の上で片付けられる。削除ではない。
                  タッチでは hover が無いので、モバイルでは常に出す */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => foldFork(fork)}
                    aria-label={`「${fork.title}」を畳む`}
                    className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-md text-ink-3 hover:bg-accent hover:text-foreground focus-visible:opacity-100 md:opacity-0 md:group-hover/fork:opacity-100"
                  >
                    <GitMerge className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">畳む</TooltipContent>
              </Tooltip>
            </SidebarMenuSubItem>
          ))}

          {/* 閉じた Fork の入口は、いま開いている Project にだけ出す——履歴
              （ArchiveDialog）はいま開いている Project の閉じた Fork を見せる
              ので、別 Project の行から開くと中身が食い違う */}
          {isCurrent && closedForkCount > 0 ? (
            <SidebarMenuSubItem>
              <SidebarMenuSubButton asChild size="sm" className="text-ink-3">
                <button
                  type="button"
                  onClick={() => {
                    onNavigate?.();
                    onOpenArchive();
                  }}
                  data-roving-item
                >
                  <Clock />
                  <span>閉じた Fork（{closedForkCount}）</span>
                </button>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ) : null}
        </SidebarMenuSub>
      ) : null}
    </SidebarMenuItem>
  );
}

export function NavPanel({
  activeProjectId,
  activeForkThreadId,
  onOpenInbox,
  onOpenPalette,
  onOpenArchive,
  onNewProject,
  onNavigate,
  title,
  headerAction,
}: NavPanelHandlers & {
  activeProjectId: string | null;
  activeForkThreadId: string | null;
  /** 見出し。既定は製品名 */
  title?: ReactNode;
  /** 見出しの右——デスクトップは「畳む」、モバイルは「閉じる」 */
  headerAction?: ReactNode;
}) {
  const judgmentCount = getJudgmentCount();
  const { containerRef, onKeyDown } = useRovingFocus<HTMLUListElement>();
  // 開いている Project の目次は既定で開く。人が畳んだ／開いたときだけ、その
  // 選択を覚える（導出できる既定値を保存しない、規則3）
  const [expandedOverride, setExpandedOverride] = useState<Record<string, boolean>>({});

  return (
    <>
      <SidebarHeader className="gap-1">
        <div className="flex h-8 items-center justify-between gap-1 pl-2">
          <span className="truncate text-sm font-semibold text-foreground">{title ?? "banto"}</span>
          {headerAction}
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => {
                onNavigate?.();
                onOpenInbox();
              }}
            >
              <Bell />
              <span className="truncate">受信箱</span>
            </SidebarMenuButton>
            {judgmentCount > 0 ? (
              <SidebarMenuBadge className="bg-turn font-semibold text-on-color">
                {judgmentCount}
              </SidebarMenuBadge>
            ) : null}
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => {
                onNavigate?.();
                onOpenPalette();
              }}
            >
              <Search />
              <span className="flex-1 truncate">検索</span>
              {/* 打鍵の案内はキーボードがある画面だけ */}
              <span className="hidden text-xs text-ink-3 md:inline">⌘K</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Project</SidebarGroupLabel>
          <SidebarGroupAction
            onClick={() => {
              onNavigate?.();
              onNewProject();
            }}
            aria-label="新しい Project"
          >
            <Plus />
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu ref={containerRef} onKeyDown={onKeyDown}>
              {getActiveProjects().map((project) => (
                <ProjectTreeItem
                  key={project.id}
                  project={project}
                  activeProjectId={activeProjectId}
                  activeForkThreadId={activeForkThreadId}
                  expanded={expandedOverride[project.id] ?? project.id === activeProjectId}
                  onToggleExpanded={() =>
                    setExpandedOverride((prev) => ({
                      ...prev,
                      [project.id]: !(prev[project.id] ?? project.id === activeProjectId),
                    }))
                  }
                  onOpenArchive={onOpenArchive}
                  onNavigate={onNavigate}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="gap-1">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => {
                onNavigate?.();
                onOpenArchive();
              }}
            >
              <Clock />
              <span className="truncate">履歴</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {/* 常設の入口（決定・2026-09-01）——Command Palette を知らないと
              設定に辿り着けない状態を避ける。instance 設定は Project の
              外側にあるので、Project 一覧とは分けてここに置く */}
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={activeProjectId === null}>
              <Link href="/settings" onClick={onNavigate}>
                <Settings />
                <span className="truncate">設定</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="flex items-center justify-between pl-2">
          <span className="text-xs text-ink-3">テーマ</span>
          <ThemeToggle />
        </div>
      </SidebarFooter>
    </>
  );
}
