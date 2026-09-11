"use client";

// サイドバーを開いているときの中身——Project と、その中で開いている Thread の目次
// （決定・2026-09-09、ユーザー指摘「幅が狭くてアイコンしか出ないので不便。
// Project 名が読めたほうがよい」。mock/ で形を決めてから本実装へ持ってきた）。
//
// 畳んだ状態（58px のレール）は `project-rail.tsx` が描く。ここは「名前が読める」側。
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
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
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getInboxItems } from "@/lib/mock/inbox";
import { getRealJudgments, getRealNotices, useRealInboxVersion } from "@/lib/backend/real-inbox";
import { getActiveProjects, reorderProjects, renameProject } from "@/lib/mock/projects";
import {
  foldForkThread,
  getClosedForksForProject,
  getThreadsForProject,
  renameForkThread,
  reorderForks,
} from "@/lib/mock/threads";
import { describeFailure } from "@/lib/report-failure";
import { cn } from "@/lib/utils";
import type { MockProject, MockThread } from "@/lib/mock/types";
import { CONNECTED_FEATURES, SHOW_INSTANCE_SETTINGS } from "@/lib/feature-flags";
import { SidebarItemMenu } from "./sidebar-item-menu";
import { SortableList, SortableRow } from "./sortable-list";
import { ThemeToggle } from "./theme-toggle";

const SHOW_ARCHIVE = CONNECTED_FEATURES.threadCloseReopen || CONNECTED_FEATURES.projectCloseReopen;

/**
 * 受信箱のバッジの件数。**判断待ちだけ**を数える——溜めてよくない
 * （止まっている）方が急ぎだから（§2.4）。レビュー待ちは溜めてよいので含めない。
 * **お知らせも数える**（決定・2026-09-07）——Module が繋がっていないことに
 * 気づける場所はここ1つなので、印が出ないと気づけない
 */
export function useJudgmentCount(): number {
  useRealInboxVersion();
  // 実hostに繋がっていれば実データの件数。繋がっていない間は
  // mock（いまは常に空）——数える対象を2箇所に書かない（規則3）
  return CONNECTED_FEATURES.inbox
    ? getRealJudgments().length + getRealNotices().length
    : getInboxItems().filter((item) => item.kind === "judgment").length;
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

/**
 * Project 1件——Project 名の行と、その下にぶら下がる Thread の目次
 * （Base Thread ＋ 開いている Fork Thread）。
 *
 * Fork をアイコンの角のバッジ（3px の点＋ポップオーバー）に隠していたのをやめ、
 * **開いている Thread は常に見えている一覧**にした——Fork は「いま並行して
 * 走っている作業」なので、探しに行くものではない。
 *
 * **掴んで並べ替えられる／右クリックで名前を変えられる**（決定・2026-09-11、
 * ユーザー要望）。掴む取っ手は Project 名の行そのもの——Fork の行は自分の
 * 一覧の中で並べ替わるので、親の取っ手の外に置く（入れ子の掴み合いを作らない）。
 */
function ProjectTreeItem({
  project,
  activeProjectId,
  activeForkThreadId,
  expanded,
  onToggleExpanded,
  onOpenArchive,
  onNavigate,
  onMoveUp,
  onMoveDown,
}: {
  project: MockProject;
  activeProjectId: string | null;
  activeForkThreadId: string | null;
  expanded: boolean;
  onToggleExpanded: () => void;
  onOpenArchive: () => void;
  onNavigate?: () => void;
  /** 並びの端なら undefined（メニューの項目が押せなくなる） */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  const router = useRouter();
  const isCurrent = project.id === activeProjectId;
  const forks = getThreadsForProject(project.id).filter((t): t is MockThread => t.kind === "fork");
  const closedForkCount = getClosedForksForProject(project.id).length;

  async function foldFork(fork: MockThread) {
    try {
      // 畳む手順そのものは1箇所（lib/mock/threads.ts）——Fork のヘッダから
      // 畳んだときと同じ経路を通る（規則3）
      await foldForkThread(fork.id);
      // いま開いている Fork を畳んだら、その Project の Base Thread に戻る
      // ——畳んだ会話が画面に残り続けないように
      if (isCurrent && activeForkThreadId === fork.id) router.push(`/p/${project.id}`);
    } catch (err) {
      toast(`Fork を畳むのに失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Fork を並べ替える。渡すのは**並び全体**（`lib/mock/threads.ts`） */
  function reorderForksTo(orderedIds: string[]) {
    void reorderForks(project.id, orderedIds).catch((err: unknown) => {
      toast(`並び順を保存できませんでした: ${describeFailure(err)}`);
    });
  }

  function moveFork(index: number, delta: number) {
    const ids = forks.map((f) => f.id);
    const to = index + delta;
    if (to < 0 || to >= ids.length) return;
    const next = [...ids];
    const [moved] = next.splice(index, 1);
    next.splice(to, 0, moved!);
    reorderForksTo(next);
  }

  return (
    <SortableRow id={project.id} as="li" className="group/menu-item relative">
      {(drag, isDragging) => (
        <>
          <SidebarItemMenu
            what="Project"
            name={project.name}
            onRename={(name) => renameProject(project.id, name)}
            onMoveUp={onMoveUp}
            onMoveDown={onMoveDown}
          >
            <div className="relative" {...drag}>
              <SidebarMenuButton asChild isActive={isCurrent}>
                <Link
                  href={`/p/${project.id}`}
                  data-roving-item
                  title={project.basePath}
                  onClick={onNavigate}
                >
                  <ProjectInitial project={project} active={isCurrent} />
                  <span data-testid="sidebar-project-name" className="truncate">
                    {project.name}
                  </span>
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
            </div>
          </SidebarItemMenu>

          {/* **運んでいる間は、目次を畳む**（実測・2026-09-11、ユーザー報告）。
              子を開いた Project は他の行よりずっと背が高く、そのまま運ぶと
              (1) 行き先の高さに合わせて潰れて見え、(2) 背の高いぶん**一番上まで
              届かない**（真ん中どうしで行き先を決めるため）。運んでいる間だけ
              高さを揃える——畳んだ／開いたという人の選択は変えない */}
          {expanded && !isDragging ? (
            <SidebarMenuSub>
              <SidebarMenuSubItem>
                <SidebarMenuSubButton asChild isActive={isCurrent && activeForkThreadId === null}>
                  <Link href={`/p/${project.id}`} data-roving-item onClick={onNavigate}>
                    <MessageSquare />
                    <span>Base Thread</span>
                  </Link>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>

              <SortableList ids={forks.map((f) => f.id)} onReorder={reorderForksTo}>
                {forks.map((fork, index) => (
                  <SortableRow key={fork.id} id={fork.id} as="li" className="group/fork relative">
                    {(forkDrag) => (
                      <SidebarItemMenu
                        what="Fork Thread"
                        name={fork.title}
                        onRename={(title) => renameForkThread(fork.id, title)}
                        onMoveUp={index > 0 ? () => moveFork(index, -1) : undefined}
                        onMoveDown={index < forks.length - 1 ? () => moveFork(index, 1) : undefined}
                      >
                        <div className="relative" {...forkDrag}>
                          <SidebarMenuSubButton
                            asChild
                            isActive={isCurrent && activeForkThreadId === fork.id}
                            className={CONNECTED_FEATURES.threadCloseReopen ? "pr-8" : undefined}
                          >
                            <Link
                              href={`/p/${project.id}?fork=${fork.id}`}
                              data-roving-item
                              title={fork.title}
                              onClick={onNavigate}
                            >
                              <GitFork />
                              <span data-testid="sidebar-fork-name">{fork.title}</span>
                            </Link>
                          </SidebarMenuSubButton>
                          {/* 畳む口を目次の中にも置く——Fork を開いてヘッダのアイコンを
                              探しに行かなくても、その場で片付けられる。削除ではない */}
                          {CONNECTED_FEATURES.threadCloseReopen ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  onClick={() => void foldFork(fork)}
                                  aria-label={`「${fork.title}」を畳む`}
                                  className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-md text-ink-3 opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/fork:opacity-100"
                                >
                                  <GitMerge className="size-3.5" />
                                </button>
                              </TooltipTrigger>
                              <TooltipContent side="right">畳む</TooltipContent>
                            </Tooltip>
                          ) : null}
                        </div>
                      </SidebarItemMenu>
                    )}
                  </SortableRow>
                ))}
              </SortableList>

              {/* 閉じた Fork の入口は、いま開いている Project にだけ出す——履歴
                  （ArchiveDialog）はいま開いている Project の閉じた Fork を見せる
                  ので、別 Project の行から開くと中身が食い違う */}
              {SHOW_ARCHIVE && isCurrent && closedForkCount > 0 ? (
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
        </>
      )}
    </SortableRow>
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
}: {
  activeProjectId: string | null;
  activeForkThreadId: string | null;
  onOpenInbox: () => void;
  onOpenPalette: () => void;
  onOpenArchive: () => void;
  onNewProject: () => void;
  /** 行き先を選んだ（＝この面の役目が終わった）。モバイルの Drawer はこれで閉じる */
  onNavigate?: () => void;
  /** 見出し。既定は製品名 */
  title?: ReactNode;
  /** 見出しの右——サイドバーを畳む／Drawer を閉じる */
  headerAction?: ReactNode;
}) {
  const judgmentCount = useJudgmentCount();
  const { containerRef, onKeyDown } = useRovingFocus<HTMLUListElement>();
  // 開いている Project の目次は既定で開く。人が畳んだ／開いたときだけ、その
  // 選択を覚える（導出できる既定値を保存しない、規則3）
  const [expandedOverride, setExpandedOverride] = useState<Record<string, boolean>>({});
  const projects = getActiveProjects();

  /** 並べ替え。渡すのは**並び全体**——1件ずつの番号は持たない（`lib/mock/projects.ts`） */
  function reorderProjectsTo(orderedIds: string[]) {
    void reorderProjects(orderedIds).catch((err: unknown) => {
      toast(`並び順を保存できませんでした: ${describeFailure(err)}`);
    });
  }

  /** メニューの「上へ／下へ」。掴めない場面でも並べ替えられるようにする */
  function moveProject(index: number, delta: number) {
    const ids = projects.map((p) => p.id);
    const to = index + delta;
    if (to < 0 || to >= ids.length) return;
    const next = [...ids];
    const [moved] = next.splice(index, 1);
    next.splice(to, 0, moved!);
    reorderProjectsTo(next);
  }

  return (
    <>
      <SidebarHeader className="gap-1">
        <div className="flex h-8 items-center justify-between gap-1 pl-2">
          <span className="truncate text-sm font-semibold text-foreground">{title ?? "banto"}</span>
          {headerAction}
        </div>
        <SidebarMenu>
          {CONNECTED_FEATURES.inbox ? (
            <SidebarMenuItem>
              {/* 件数はボタンの**中**に置く——畳んだレールと同じく、受信箱の
                  読み上げ名と本文の両方に件数が乗る（外に出すとボタンの
                  中身が「受信箱」だけになり、件数が本文から消える） */}
              <SidebarMenuButton
                onClick={() => {
                  onNavigate?.();
                  onOpenInbox();
                }}
                // 読み上げ名は畳んだレールと同じにする（幅で名前が変わらない）
                aria-label={judgmentCount > 0 ? `受信箱（${judgmentCount}件）` : "受信箱"}
              >
                <Bell />
                <span className="flex-1 truncate">受信箱</span>
                {judgmentCount > 0 ? (
                  <span className="flex h-5 min-w-5 items-center justify-center rounded-md bg-turn px-1 text-xs font-semibold text-on-color tabular-nums">
                    {judgmentCount}
                  </span>
                ) : null}
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : null}
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => {
                onNavigate?.();
                onOpenPalette();
              }}
              aria-label="検索（Command Palette）"
            >
              <Search />
              <span className="flex-1 truncate">検索</span>
              <span className="text-xs text-ink-3">⌘K</span>
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
              <SortableList ids={projects.map((p) => p.id)} onReorder={reorderProjectsTo}>
              {projects.map((project, index) => (
                <ProjectTreeItem
                  key={project.id}
                  project={project}
                  onMoveUp={index > 0 ? () => moveProject(index, -1) : undefined}
                  onMoveDown={index < projects.length - 1 ? () => moveProject(index, 1) : undefined}
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
              </SortableList>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="gap-1">
        <SidebarMenu>
          {SHOW_ARCHIVE ? (
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
          ) : null}
          {/* 常設の入口（決定・2026-09-01）——Command Palette を知らないと
              設定に辿り着けない状態を避ける。instance 設定は Project の
              外側にあるので、Project 一覧とは分けてここに置く */}
          {SHOW_INSTANCE_SETTINGS ? (
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={activeProjectId === null}>
                <Link href="/settings" onClick={onNavigate}>
                  <Settings />
                  <span className="truncate">設定</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : null}
        </SidebarMenu>
        <div className="flex items-center justify-between pl-2">
          <span className="text-xs text-ink-3">テーマ</span>
          <ThemeToggle />
        </div>
      </SidebarFooter>
    </>
  );
}
