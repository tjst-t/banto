"use client";

// サイドバーを開いているときの中身——Project と、その中で開いている Thread の目次
// （決定・2026-09-09、ユーザー指摘「幅が狭くてアイコンしか出ないので不便。
// Project 名が読めたほうがよい」。mock/ で形を決めてから本実装へ持ってきた）。
//
// 畳んだ状態（58px のレール）は `project-rail.tsx` が描く。ここは「名前が読める」側。
import { useState, type ReactNode } from "react";
import { UrlLink as Link } from "@/components/banto/url-link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  Bell,
  ChevronRight,
  Clock,
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
import { isSettingsOpen, projectNavHref, settingsOpenHref, threadNavHref, threadRowHref } from "@/lib/settings-link";
import { useProjectCategories } from "@/components/banto/settings/project-settings-content";
import type { MockProject, MockThread } from "@/lib/mock/types";
import { CONNECTED_FEATURES, SHOW_INSTANCE_SETTINGS } from "@/lib/feature-flags";
import { SidebarItemMenu } from "./sidebar-item-menu";
import { SortableList, SortableRow } from "./sortable-list";
import { ForkIcon } from "@/components/banto/thread/thread-icons";
import { useCloseForkConfirm } from "@/components/banto/thread/close-fork-confirm";
import { ThreadRowIcon } from "@/components/banto/thread/thread-row-icon";
import { LoaderCircle } from "lucide-react";
import { useProjectRunning } from "@/lib/backend/running-threads";
import { useHostBusy, useProjectBusy } from "@/lib/backend/resources-busy";
import { BusyProjectMark, HostBusyBand } from "@/components/banto/settings/resources-panel";
import { useAnyThreadUnread, useThreadUnread } from "@/lib/backend/real-inbox";
import { ThemeToggle } from "./theme-toggle";
import { ProjectBackgroundBadge, ThreadBackgroundLine } from "./background-work";

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
 * **広いサイドバーの Project の行のアイコン**（追加・2026-10-03、ユーザー要望。§6.33）。いま開いていない Project で、
 * どれかの Thread の AI が動いていれば、頭文字の代わりに回る輪を出す（同じ大きさ・同じ場所）。いま開いている Project は
 * Thread の目次で分かるので頭文字のまま。畳んだレールには出さない（ここだけで使う）
 */
function ProjectRowIcon({ project, active }: { project: MockProject; active: boolean }) {
  const running = useProjectRunning(project.id);
  if (active || !running) return <ProjectInitial project={project} active={active} />;
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-surface-3 text-ink-2">
      <LoaderCircle className="size-4 animate-spin" role="img" aria-label="AI が動いています" data-testid="project-running" />
    </span>
  );
}

/** Thread の名前。AI が返したあと人がまだ開いていなければ太字（§6.33） */
function ThreadRowName({ threadId, children, testId }: { threadId: string; children: ReactNode; testId?: string }) {
  const unread = useThreadUnread(threadId);
  return (
    <span data-testid={testId} data-unread={unread ? "" : undefined} className={cn("truncate", unread && "font-semibold text-foreground")}>
      {children}
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
  onExpand,
  onOpenArchive,
  onNavigate,
  keepOpenOnProjectSwitch,
  onMoveUp,
  onMoveDown,
}: {
  project: MockProject;
  activeProjectId: string | null;
  activeForkThreadId: string | null;
  expanded: boolean;
  onToggleExpanded: () => void;
  /** 目次を開く（人が畳んでいても開く）。別 Project へ移って Drawer を残すとき */
  onExpand: () => void;
  onOpenArchive: () => void;
  onNavigate?: () => void;
  /** NavPanel の同名の引数を見よ */
  keepOpenOnProjectSwitch?: boolean;
  /** 並びの端なら undefined（メニューの項目が押せなくなる） */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // その Project の層で最初に開く節（繋がっているものは Project ごとに違う）
  const settingsEntrySection = useProjectCategories(project.id)[0]?.section ?? "project-danger";
  const isCurrent = project.id === activeProjectId;
  const busyReason = useProjectBusy(project.id);
  const forks = getThreadsForProject(project.id).filter((t): t is MockThread => t.kind === "fork");
  // **いま開いていない Project で、まだ開いていない Thread があれば名前を太字に**（2026-10-03、§6.33）
  const anyUnread = useAnyThreadUnread([project.baseThreadId, ...forks.map((f) => f.id)]);
  const projectUnread = !isCurrent && anyUnread;
  const closedForkCount = getClosedForksForProject(project.id).length;

  // 裏の仕事が残っていれば、閉じる前に確かめる（v4-frontend.md §6「Fork を閉じるときの警告」）
  const { confirmClose, dialog: closeForkDialog } = useCloseForkConfirm();

  async function closeFork(fork: MockThread) {
    try {
      // Close の手順そのものは1箇所（lib/mock/threads.ts）——Fork のヘッダから
      // Close したときと同じ経路を通る（規則3）
      await foldForkThread(fork.id);
      // いま開いている Fork を Close したら、その Project の Base Thread に戻る
      // ——閉じた会話が画面に残り続けないように
      if (isCurrent && activeForkThreadId === fork.id) {
        router.push(threadNavHref(project.id, null, pathname, searchParams, settingsEntrySection));
      }
    } catch (err) {
      toast(`Fork を Close できませんでした: ${err instanceof Error ? err.message : String(err)}`);
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
            // 目次の開閉（chevron）がある行では、その左に置く
            moreClassName={forks.length > 0 ? "right-7" : undefined}
          >
            {(more) => (
            <div className="relative" {...drag}>
              <SidebarMenuButton asChild isActive={isCurrent}>
                <Link
                  // **設定を開いているときは、その Project の設定へ切り替える**
                  // （決定・2026-09-11、§6.16）——いま見ている Project なら会話へ戻る
                  href={projectNavHref(
                    project.id,
                    pathname,
                    searchParams,
                    settingsEntrySection,
                  )}
                  data-roving-item
                  title={project.basePath}
                  onClick={(e) => {
                    // **別 Project へ移っても、Fork があれば Drawer を閉じない**（2026-10-02、ユーザー要望）
                    // ——下の画面はその Project の Base Thread に替わり、Drawer はその Project の目次を
                    // 開いて待つ。Fork へはもう1回押すだけ、Base でよければ閉じるだけ。Fork が無ければ
                    // 選ぶものが無いので、今までどおり閉じる
                    if (keepOpenOnProjectSwitch && !isCurrent && forks.length > 0) {
                      onExpand();
                      // 開いた目次が Drawer の下にはみ出していたら見える所まで送る（描き終わってから）
                      const row = e.currentTarget.closest("li");
                      requestAnimationFrame(() =>
                        requestAnimationFrame(() => row?.scrollIntoView({ block: "nearest" })),
                      );
                      return;
                    }
                    onNavigate?.();
                  }}
                >
                  <ProjectRowIcon project={project} active={isCurrent} />
                  <span
                    data-testid="sidebar-project-name"
                    data-unread={projectUnread ? "" : undefined}
                    className={cn("truncate", projectUnread && "font-semibold text-foreground")}
                  >
                    {project.name}
                  </span>
                  {/* 混んでいる印（§6.36）。いま開いている Project にも出す */}
                  {busyReason !== undefined ? <BusyProjectMark projectName={project.name} reason={busyReason} /> : null}
                </Link>
              </SidebarMenuButton>
              {more}
              {/* バックグラウンドの数（§6.33）。いま開いている Project は下の Thread の行で見えるので出さない */}
              {isCurrent ? null : (
                <ProjectBackgroundBadge
                  projectId={project.id}
                  projectName={project.name}
                  threads={[
                    { id: project.baseThreadId, title: "Base Thread", fork: false },
                    ...forks.map((f) => ({ id: f.id, title: f.title, fork: true })),
                  ]}
                />
              )}
              {forks.length > 0 ? (
                <SidebarMenuAction
                  onClick={onToggleExpanded}
                  aria-expanded={expanded}
                  aria-label={`${project.name} の Thread 一覧を${expanded ? "折りたたむ" : "開く"}`}
                >
                  <ChevronRight className={cn("transition-transform", expanded && "rotate-90")} />
                </SidebarMenuAction>
              ) : null}
            </div>
            )}
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
                  <Link
                    // 設定を開いていても、設定を閉じてその会話を出す（2026-10-05、`threadRowHref`）
                    href={threadRowHref(project.id, null)}
                    data-roving-item
                    onClick={onNavigate}
                  >
                    <ThreadRowIcon threadId={project.baseThreadId} icon={MessageSquare} />
                    <ThreadRowName threadId={project.baseThreadId} testId="sidebar-base-name">Base Thread</ThreadRowName>
                  </Link>
                </SidebarMenuSubButton>
                <ThreadBackgroundLine projectId={project.id} thread={{ id: project.baseThreadId, title: "Base Thread", fork: false }} />
              </SidebarMenuSubItem>

              <SortableList ids={forks.map((f) => f.id)} onReorder={reorderForksTo}>
                {forks.map((fork, index) => (
                  <SortableRow key={fork.id} id={fork.id} as="li" className="group/fork relative">
                    {(forkDrag) => (
                      <>
                      <SidebarItemMenu
                        what="Fork Thread"
                        name={fork.title}
                        onRename={(title) => renameForkThread(fork.id, title)}
                        onMoveUp={index > 0 ? () => moveFork(index, -1) : undefined}
                        onMoveDown={index < forks.length - 1 ? () => moveFork(index, 1) : undefined}
                        // Close の口はメニューの中へ移した（改訂・2026-09-11、ユーザー要望）
                        // ——行に出しっぱなしの操作を1つに減らす。削除ではなく整理
                        onClose={
                          CONNECTED_FEATURES.threadCloseReopen
                            ? () => confirmClose(fork.id, fork.title, () => void closeFork(fork))
                            : undefined
                        }
                      >
                        {(more) => (
                        <div className="relative" {...forkDrag}>
                          <SidebarMenuSubButton
                            asChild
                            isActive={isCurrent && activeForkThreadId === fork.id}
                            className={CONNECTED_FEATURES.threadCloseReopen ? "pr-8" : undefined}
                          >
                            <Link
                              href={threadRowHref(project.id, fork.id)}
                              data-roving-item
                              title={fork.title}
                              onClick={onNavigate}
                            >
                              <ThreadRowIcon threadId={fork.id} icon={ForkIcon} />
                              <ThreadRowName threadId={fork.id} testId="sidebar-fork-name">{fork.title}</ThreadRowName>
                            </Link>
                          </SidebarMenuSubButton>
                          {/* 操作はここ1つ（「…」）——右クリックと同じものが出る。
                              Close（合流のアイコンで出していたもの）もこの中 */}
                          {more}
                        </div>
                        )}
                      </SidebarItemMenu>
                      <ThreadBackgroundLine projectId={project.id} thread={{ id: fork.id, title: fork.title, fork: true }} />
                      </>
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
          {closeForkDialog}
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
  keepOpenOnProjectSwitch,
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
  /**
   * 別 Project を選んだとき、その Project に Fork があれば `onNavigate` を呼ばずに目次を開いて残る
   * （モバイルの Drawer。2026-10-02、ユーザー要望——別 Project の Fork へ1回で行けるように）
   */
  keepOpenOnProjectSwitch?: boolean;
  /** 見出し。既定は製品名 */
  title?: ReactNode;
  /** 見出しの右——サイドバーを畳む／Drawer を閉じる */
  headerAction?: ReactNode;
}) {
  const judgmentCount = useJudgmentCount();
  const hostBusy = useHostBusy();
  const pathname = usePathname();
  const searchParams = useSearchParams();
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
        {/* この機械全体が混んでいる（§6.36）。押すと設定の「資源」 */}
        {hostBusy !== undefined ? (
          <HostBusyBand
            reason={hostBusy}
            href={settingsOpenHref(pathname, searchParams, { section: "resources" })}
            {...(onNavigate ? { onNavigate } : {})}
          />
        ) : null}
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
                  onExpand={() => setExpandedOverride((prev) => ({ ...prev, [project.id]: true }))}
                  onOpenArchive={onOpenArchive}
                  onNavigate={onNavigate}
                  keepOpenOnProjectSwitch={keepOpenOnProjectSwitch}
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
              <SidebarMenuButton asChild isActive={isSettingsOpen(pathname, searchParams)}>
                <Link
                  href={settingsOpenHref(pathname, searchParams, { project: activeProjectId })}
                  onClick={onNavigate}
                >
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
