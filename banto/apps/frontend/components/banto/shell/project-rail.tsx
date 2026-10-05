"use client";

// サイドバー。幅は2段階（決定・2026-09-09、ユーザー指摘「幅が狭くてアイコンしか
// 出ないので不便。Project 名が読めたほうがよい」。mock/ で形を決めてから持ってきた）：
//
// | 状態 | 幅 | 何が見えるか |
// |---|---|---|
// | 展開（既定） | 16rem | `NavPanel`——Project 名・その下に開いている Thread の目次 |
// | 畳んだ状態 | 58px | アイコンだけ（従来のレール）。名前はツールチップ、Fork はバッジのポップオーバー |
//
// 切り替えは自分のボタンか ⌘B / Ctrl-B（shadcn の Sidebar が持っている）。
// 畳んだ状態は、会話に集中したいときと狭い画面のための逃げ道として残す。
//
// ≥md でのみ表示する——<md では isMobile 判定で描画自体をやめる
// （Sidebar は isMobile のとき自動で Sheet オーバーレイになるが、
// banto のモバイル意匠はそれではなく MobileTopBar なので、ここで明示的に避ける）。
import { useState } from "react";
import { UrlLink as Link } from "@/components/banto/url-link";
import { Bell, Clock, PanelLeft, Plus, Search, Settings } from "lucide-react";
import { ForkIcon } from "@/components/banto/thread/thread-icons";
import { ThreadRowIcon } from "@/components/banto/thread/thread-row-icon";
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
  useSidebar,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { NewProjectDialog } from "@/components/banto/project/new-project-dialog";
import { usePathname, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { getActiveProjects, renameProject, reorderProjects } from "@/lib/mock/projects";
import { describeFailure } from "@/lib/report-failure";
import { getThreadsForProject } from "@/lib/mock/threads";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import { cn } from "@/lib/utils";
import { isSettingsOpen, projectNavHref, settingsOpenHref, threadRowHref } from "@/lib/settings-link";
import { CONNECTED_FEATURES, SHOW_INSTANCE_SETTINGS } from "@/lib/feature-flags";
import { NavPanel, ProjectInitial, useJudgmentCount } from "./nav-panel";
import { useThreadUnread } from "@/lib/backend/real-inbox";
import { SidebarItemMenu } from "./sidebar-item-menu";
import { SortableList, SortableRow } from "./sortable-list";
import { SidebarResizeHandle } from "./sidebar-resize-handle";
import { ThemeToggle } from "./theme-toggle";

/** 畳んだレールの Fork 一覧の名前。まだ開いていなければ太字（§6.33） */
function RailForkName({ threadId, title }: { threadId: string; title: string }) {
  const unread = useThreadUnread(threadId);
  return <span className={unread ? "truncate font-semibold text-foreground" : "truncate"}>{title}</span>;
}

const SHOW_ARCHIVE = CONNECTED_FEATURES.threadCloseReopen || CONNECTED_FEATURES.projectCloseReopen;

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
  const judgmentCount = useJudgmentCount();
  const projects = getActiveProjects();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  /** 並べ替え。開いたサイドバー（nav-panel.tsx）と同じ口を通る（規則3） */
  function reorderTo(orderedIds: string[]) {
    void reorderProjects(orderedIds).catch((err: unknown) => {
      toast(`並び順を保存できませんでした: ${describeFailure(err)}`);
    });
  }

  function move(index: number, delta: number) {
    const ids = projects.map((p) => p.id);
    const to = index + delta;
    if (to < 0 || to >= ids.length) return;
    const next = [...ids];
    const [moved] = next.splice(index, 1);
    next.splice(to, 0, moved!);
    reorderTo(next);
  }

  return (
    <>
      <SidebarHeader className="items-center gap-2 px-0 py-3">
        <RailIconButton icon={PanelLeft} label="サイドバーを開く（⌘B / Ctrl-B）" onClick={toggleSidebar} />
        {CONNECTED_FEATURES.inbox ? (
          <RailIconButton icon={Bell} label="受信箱" onClick={onOpenInbox}>
            {judgmentCount > 0 ? (
              <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-turn text-xs leading-none font-semibold text-on-color">
                {judgmentCount}
              </span>
            ) : null}
          </RailIconButton>
        ) : null}
        <RailIconButton icon={Search} label="検索（⌘K / Ctrl-K）" onClick={onOpenPalette} />
      </SidebarHeader>

      {/* shadcn の SidebarContent は collapsible="icon" のとき自分自身に overflow-hidden
          を掛ける（テキストラベルを隠す用途）。畳んだレールは常時アイコンのみなので
          その用途は無く、逆に Fork Thread バッジ（先頭の項目だと -top-0.5 で自分の
          外にはみ出す）の上側を切ってしまっていた。
          **かつては overflow-visible で外していたが、Project が増えると一覧が
          下の段（履歴・設定・明暗）の上に溢れ、設定が押せなくなっていた**
          （実測・2026-09-09、E2E で 25 Project のとき設定のクリックが
          Project アイコンに横取りされた）——縦だけスクロールさせ、バッジの
          ぶんの余白（pt-1）を上に取ることで両方を満たす */}
      <SidebarContent className="!overflow-x-hidden !overflow-y-auto items-center gap-1 px-0 pt-1">
        <SidebarMenu className="items-center gap-1 px-0">
          <SortableList ids={projects.map((p) => p.id)} onReorder={reorderTo}>
          {projects.map((project, index) => {
            const active = project.id === activeProjectId;
            const forks = getThreadsForProject(project.id).filter((t) => t.kind === "fork");
            return (
              <SortableRow
                key={project.id}
                id={project.id}
                as="li"
                className="group/menu-item relative flex justify-center"
              >
                {(drag) => (
                  <>
                {/* 畳んだレールでも、掴んで並べ替えられる・右クリックで名前を変えられる
                    （決定・2026-09-11）——幅で操作が変わらないようにする（規則3） */}
                <SidebarItemMenu
                  what="Project"
                  name={project.name}
                  onRename={(name) => renameProject(project.id, name)}
                  onMoveUp={index > 0 ? () => move(index, -1) : undefined}
                  onMoveDown={index < projects.length - 1 ? () => move(index, 1) : undefined}
                >
                  {/* **細いレールに「…」は置かない**（改訂・2026-09-11）——
                      幅 58px にアイコンと並べる余地が無い。ここでの操作の口は
                      右クリック（タッチは長押し）。名前が読める幅にすると
                      行に「…」が出る（nav-panel.tsx） */}
                  {() => (
                  <div className="relative flex justify-center" {...drag}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <SidebarMenuButton
                          asChild
                          className="size-9 justify-center overflow-visible p-0"
                          isActive={active}
                        >
                          <Link
                            href={projectNavHref(
                              project.id,
                              pathname,
                              searchParams,
                              "project-danger",
                            )}
                          >
                            <ProjectInitial project={project} active={active} />
                          </Link>
                        </SidebarMenuButton>
                      </TooltipTrigger>
                      <TooltipContent side="right">{project.name}</TooltipContent>
                    </Tooltip>
                  </div>
                  )}
                </SidebarItemMenu>

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
                            href={threadRowHref(project.id, fork.id)}
                            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink-2 hover:bg-accent hover:text-foreground"
                          >
                            <ThreadRowIcon threadId={fork.id} icon={ForkIcon} className="size-3.5 shrink-0 text-ink-3" />
                            <RailForkName threadId={fork.id} title={fork.title} />
                          </Link>
                        ))}
                      </div>
                    </PopoverContent>
                  </Popover>
                ) : null}
                  </>
                )}
              </SortableRow>
            );
          })}
          </SortableList>
        </SidebarMenu>
        <RailIconButton icon={Plus} label="新しい Project" onClick={onNewProject} />
      </SidebarContent>

      <SidebarFooter className="items-center gap-2 py-3">
        {SHOW_ARCHIVE ? <RailIconButton icon={Clock} label="履歴" onClick={onOpenArchive} /> : null}
        {/* 常設の入口（§10 item17、決定・2026-09-01）——Command Palette を知らないと
            設定に辿り着けない状態を避ける。instance 設定（階層1）は Project の
            外側にあるので、Project 一覧とは分けてここに置く */}
        {SHOW_INSTANCE_SETTINGS ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                href={settingsOpenHref(pathname, searchParams, { project: activeProjectId })}
                aria-label="設定"
                className={cn(
                  "flex size-8 items-center justify-center rounded-md",
                  isSettingsOpen(pathname, searchParams)
                    ? "bg-accent-soft text-accent-ink"
                    : "text-ink-3 hover:bg-accent hover:text-foreground",
                )}
              >
                <Settings className="size-4" />
              </Link>
            </TooltipTrigger>
            <TooltipContent side="right">設定</TooltipContent>
          </Tooltip>
        ) : null}
        <ThemeToggle />
      </SidebarFooter>
    </>
  );
}

export function ProjectRail({
  activeProjectId,
  activeForkThreadId,
  width,
  onResize,
  onResizeEnd,
  onOpenInbox,
  onOpenPalette,
  onOpenArchive,
}: {
  /** null＝いま instance 設定（/settings）を見ている */
  activeProjectId: string | null;
  /** いま開いている Fork Thread（目次のどの行を選択中として出すか） */
  activeForkThreadId: string | null;
  /** 展開しているときの幅（px）。持っているのは AppShell（規則3） */
  width: number;
  onResize: (width: number) => void;
  onResizeEnd: (width: number) => void;
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
        width={width}
        onResize={onResize}
        onResizeEnd={onResizeEnd}
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
  width,
  onResize,
  onResizeEnd,
  onOpenInbox,
  onOpenPalette,
  onOpenArchive,
  onNewProject,
}: {
  activeProjectId: string | null;
  activeForkThreadId: string | null;
  width: number;
  onResize: (width: number) => void;
  onResizeEnd: (width: number) => void;
  onOpenInbox: () => void;
  onOpenPalette: () => void;
  onOpenArchive: () => void;
  onNewProject: () => void;
}) {
  const { state, toggleSidebar } = useSidebar();

  if (state === "collapsed") {
    // 畳んでいるときは幅が決め打ち（58px のレール）なので、掴む口は出さない
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
    <>
    <SidebarResizeHandle width={width} onResize={onResize} onResizeEnd={onResizeEnd} />
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
              aria-label="サイドバーを折りたたむ"
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-accent hover:text-foreground"
            >
              <PanelLeft className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">サイドバーを折りたたむ（⌘B / Ctrl-B）</TooltipContent>
        </Tooltip>
      }
    />
    </>
  );
}
