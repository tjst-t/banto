"use client";

// サイドバーを開いているときの中身——Project と、その中で開いている Thread の目次
// （決定・2026-09-09、ユーザー指摘「幅が狭くてアイコンしか出ないので不便。
// Project 名が読めたほうがよい」。mock/ で形を決めてから本実装へ持ってきた）。
//
// 畳んだ状態（58px のレール）は `project-rail.tsx` が描く。ここは「名前が読める」側。
import { type ReactNode } from "react";
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
  Zap,
} from "lucide-react";
import {
  SidebarContent,
  SidebarFooter,
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
import { getRealInboxBadgeCount, useRealInboxVersion } from "@/lib/backend/real-inbox";
import { renameProject } from "@/lib/mock/projects";
import {
  foldForkThread,
  getThreadsForProject,
  renameForkThread,
  reorderForks,
} from "@/lib/mock/threads";
import { describeFailure } from "@/lib/report-failure";
import { requestForkDialog, type ForkStartMode } from "@/lib/fork-request";
import { cn } from "@/lib/utils";
import { lastForkOf, useLastThreads } from "@/lib/last-thread";
import { isSettingsOpen, settingsToggleHref, projectNavHref, settingsOpenHref, threadNavHref, threadRowHref } from "@/lib/settings-link";
import { useProjectCategories } from "@/components/banto/settings/project-settings-content";
import type { MockProject, MockThread } from "@/lib/mock/types";
import { CONNECTED_FEATURES, SHOW_INSTANCE_SETTINGS } from "@/lib/feature-flags";
import { SidebarItemMenu, type GroupMenu } from "./sidebar-item-menu";
import { DraggableRow, SortableList, SortableRow } from "./sortable-list";
import { ProjectList } from "./project-list";
import { ForkIcon } from "@/components/banto/thread/thread-icons";
import { useCloseForkConfirm } from "@/components/banto/thread/close-fork-confirm";
import { ThreadRowIcon } from "@/components/banto/thread/thread-row-icon";
import { LoaderCircle } from "lucide-react";
import { useProjectRunning } from "@/lib/backend/running-threads";
import { useProjectWaking } from "@/lib/backend/project-waking";
import { useHostBusy, useProjectBusy } from "@/lib/backend/resources-busy";
import { BusyProjectMark, HostBusyBand } from "@/components/banto/settings/resources-panel";
import { MovingProjectMark } from "@/components/banto/shell/moving-project-mark";
import { PrivilegedProjectMark } from "@/components/banto/shell/privileged-project-mark";
import { UnreachableProjectMark } from "@/components/banto/shell/unreachable-project-mark";
import { useAnyThreadUnread, useThreadUnread } from "@/lib/backend/real-inbox";
import { ThemeToggle } from "./theme-toggle";
import { automationsCanvasHref, useAutomations } from "@/lib/backend/automations";
import { ProjectBackgroundBadge, ThreadBackgroundLine } from "./background-work";
import { ThreadRateLimitWaitLine } from "./rate-limit-wait-line";
import { ThreadMissionLine } from "./mission-line";
import { ProjectCodeTransferLine } from "./code-transfer";

const SHOW_ARCHIVE = CONNECTED_FEATURES.threadCloseReopen || CONNECTED_FEATURES.projectCloseReopen;

/** 一番下の行のボタン（履歴・設定）。テーマ（ThemeToggle の labeled）と同じ形・同じ幅に揃える */
const FOOTER_BUTTON =
  "flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 text-xs text-ink-2 outline-hidden hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring";

/**
 * 受信箱のバッジの件数。**人が答えないと先へ進まないもの**——判断待ちと「決めることがある」返ってきた会話
 * （改訂・2026-10-15、v4-frontend.md §6.41）。返ってきただけの会話・お知らせは数えない
 * （それまではお知らせも数えていた——決定・2026-09-07）
 */
export function useJudgmentCount(): number {
  useRealInboxVersion();
  // 実hostに繋がっていれば実データの件数。繋がっていない間は
  // mock（いまは常に空）——数える対象を2箇所に書かない（規則3）
  return CONNECTED_FEATURES.inbox
    ? getRealInboxBadgeCount()
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

/** 起こしている Project の行の印（v4-frontend.md §6.43）。「…」と同じ位置に出す */
export function WakingMark() {
  return (
    <span data-testid="sidebar-project-waking" className="absolute top-2 right-7 flex items-center gap-1 text-xs text-ink-3">
      <LoaderCircle className="size-3 animate-spin" aria-hidden />
      起こしています
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
 *
 * **グループの中の行は 12px 下げる**（2026-10-16、§6.43）。下げるのは行（`li`）ごと——頭文字の右下の数も、
 * ぶら下がる目次も同じだけ右へ。右端の押し口（開く・畳む＝`right-1`、「…」＝`right-7`）の位置は変わらない。
 * 落とす先は Project 名の行（`row:<id>`）——そこに落とすと、その Project の前に入る（`project-list.tsx`）
 */
export function ProjectTreeItem({
  project,
  activeProjectId,
  activeForkThreadId,
  expanded,
  onToggleExpanded,
  onExpand,
  onNavigate,
  keepOpenOnProjectSwitch,
  onMoveUp,
  onMoveDown,
  indented = false,
  groupMenu,
  onSleep,
}: {
  project: MockProject;
  activeProjectId: string | null;
  activeForkThreadId: string | null;
  expanded: boolean;
  onToggleExpanded: () => void;
  /** 目次を開く（人が畳んでいても開く）。別 Project へ移って Drawer を残すとき */
  onExpand: () => void;
  onNavigate?: () => void;
  /** NavPanel の同名の引数を見よ */
  keepOpenOnProjectSwitch?: boolean;
  /** 並びの端なら undefined（メニューの項目が押せなくなる） */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  /** グループの中の行 */
  indented?: boolean;
  /** 行の「…」の「グループへ移す」 */
  groupMenu?: GroupMenu;
  /** 行の「…」の「スリープにする」（v4-frontend.md §6.43） */
  onSleep?: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // その Project の層で最初に開く節（繋がっているものは Project ごとに違う）
  const settingsEntrySection = useProjectCategories(project.id)[0]?.section ?? "project-danger";
  const isCurrent = project.id === activeProjectId;
  const busyReason = useProjectBusy(project.id);
  // 起こしている間（`modules/prepare` が返るまで）は「…」の場所に「起こしています」（§6.43）
  const waking = useProjectWaking(project.id);
  const forks = getThreadsForProject(project.id).filter((t): t is MockThread => t.kind === "fork");
  // **いま開いていない Project で、まだ開いていない Thread があれば名前を太字に**（2026-10-03、§6.33）
  const anyUnread = useAnyThreadUnread([project.baseThreadId, ...forks.map((f) => f.id)]);
  const projectUnread = !isCurrent && anyUnread;
  // **ほかの Project から移るときは、その Project で最後に開いていた Thread へ**（2026-10-13、§6.40）
  const lastThreads = useLastThreads();
  const lastForkId = isCurrent ? null : lastForkOf(lastThreads, project.id, forks.map((f) => f.id));
  // **自動化**（v4-frontend.md §6.42）。目次を開いている Project の分だけ取る——専用の Fork の稲妻の印と、
  // 自動化の届け先の Thread（専用の Fork・既存の Thread）の「…」の「自動化の設定を開く」に使う。
  // 目次の「自動化（n）」の行はやめた（2026-10-18、ユーザー）
  const automations = useAutomations(expanded ? project.id : null);
  const dedicatedForks = new Set((automations ?? []).flatMap((a) => (a.target.kind === "dedicated" && a.target.threadId ? [a.target.threadId] : [])));
  const automationThreads = new Set((automations ?? []).flatMap((a) => (a.target.threadId ? [a.target.threadId] : [])));
  /** その Thread を開き、隣に自動化の画面（Canvas）を開く。Base なら forkId は null */
  function openAutomations(forkId: string | null) {
    router.push(automationsCanvasHref(project.id, forkId));
    onNavigate?.();
  }

  /**
   * **サイドバーから Fork を作る**（2026-10-11、ユーザー）。ダイアログは会話の面が持つ（`lib/fork-request.ts`）
   * ——別の Project の行なら、その Project へ移ってから開く。設定を開いていれば閉じる
   */
  function startFork(parentThreadId: string, start: ForkStartMode) {
    requestForkDialog({ projectId: project.id, parentThreadId, start });
    if (!isCurrent || isSettingsOpen(pathname, searchParams)) {
      router.push(threadRowHref(project.id, isCurrent ? activeForkThreadId : null));
    }
    onNavigate?.();
  }

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
    <DraggableRow
      id={project.id}
      dropId={`row:${project.id}`}
      as="li"
      className={cn("group/menu-item relative", indented && "pl-3")}
    >
      {(drag, isDragging, drop) => (
        <>
          <SidebarItemMenu
            what="Project"
            name={project.name}
            onRename={(name) => renameProject(project.id, name)}
            onMoveUp={onMoveUp}
            onMoveDown={onMoveDown}
            groupMenu={groupMenu}
            onSleep={onSleep}
            // **「…」はいつも開く・畳む（chevron）の左**（2026-10-16、§6.43）——chevron が無い行（Fork の無い Project）でも
            // 同じ位置にして、右端は空けておく。見出しの「…」とも縦にそろう
            moreClassName="right-7"
          >
            {(more) => (
            <div
              ref={drop.setNodeRef}
              data-drop-over={drop.isOver ? "" : undefined}
              // 落とす先なら、この行の上に線を引く（ここに落とすと、この行の前に入る）
              className={cn(
                "relative",
                drop.isOver && "before:absolute before:inset-x-1 before:-top-0.5 before:z-10 before:h-0.5 before:rounded-full before:bg-accent",
              )}
              {...drag}
            >
              <SidebarMenuButton asChild isActive={isCurrent} className="pr-14">
                <Link
                  // **設定を開いているときは、その Project の設定へ切り替える**
                  // （決定・2026-09-11、§6.16）——いま見ている Project なら会話へ戻る
                  href={projectNavHref(
                    project.id,
                    pathname,
                    searchParams,
                    settingsEntrySection,
                    lastForkId,
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
                    // **名前を押しても目次を開け閉めする**（2026-10-18、ユーザー要望、§6.40）——いま見ている Project なら
                    // 開く／畳むを切り替え、ほかの Project なら（「すべて畳む」で畳んでいても）開く。移る先は今までどおり
                    if (isCurrent) onToggleExpanded();
                    else onExpand();
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
                  {/* 別の実行場所へ移している印（追加・2026-10-12、Backlog #270） */}
                  <MovingProjectMark projectId={project.id} projectName={project.name} />
                  {/* 特権コンテナの印（追加・2026-10-20、Backlog 462 番） */}
                  {project.privileged ? <PrivilegedProjectMark projectName={project.name} /> : null}
                </Link>
              </SidebarMenuButton>
              {waking ? <WakingMark /> : more}
              {/* 別のサーバに繋がらない印（Backlog #383）。頭文字の左上——右下の裏の仕事の数とぶつからない。
                  いま開いている Project にも出す。行の Link の外に置く（押せるものを入れ子にしない） */}
              <UnreachableProjectMark projectId={project.id} className="top-0 left-0.5" onNavigate={onNavigate} />
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
          {/* 別のサーバへコードを送っている間（Backlog #269）。畳んでいても見えるよう、目次の外に出す */}
          <ProjectCodeTransferLine projectId={project.id} testId="sidebar-code-transfer" className="py-0.5 pr-1 pl-8" />

          {/* **運んでいる間は、目次を畳む**（実測・2026-09-11、ユーザー報告）。
              子を開いた Project は他の行よりずっと背が高く、そのまま運ぶと
              (1) 行き先の高さに合わせて潰れて見え、(2) 背の高いぶん**一番上まで
              届かない**（真ん中どうしで行き先を決めるため）。運んでいる間だけ
              高さを揃える——畳んだ／開いたという人の選択は変えない */}
          {expanded && !isDragging ? (
            <SidebarMenuSub>
              <SidebarMenuSubItem className="group/fork relative">
                <SidebarItemMenu
                  what="Base Thread"
                  name="Base Thread"
                  onFork={() => startFork(project.baseThreadId, "continue")}
                  onOpenAutomations={automationThreads.has(project.baseThreadId) ? () => openAutomations(null) : undefined}
                >
                  {(more) => (
                    <div className="relative">
                      <SidebarMenuSubButton asChild isActive={isCurrent && activeForkThreadId === null} className="pr-8">
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
                      {more}
                    </div>
                  )}
                </SidebarItemMenu>
                <ThreadBackgroundLine projectId={project.id} thread={{ id: project.baseThreadId, title: "Base Thread", fork: false }} />
                <ThreadRateLimitWaitLine threadId={project.baseThreadId} />
                <ThreadMissionLine threadId={project.baseThreadId} threadTitle="Base Thread" />
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
                        // **Fork からも分けられる**（2026-10-11、ユーザー）
                        onFork={() => startFork(fork.id, "continue")}
                        onOpenAutomations={automationThreads.has(fork.id) ? () => openAutomations(fork.id) : undefined}
                      >
                        {(more) => (
                        <div className="relative" {...forkDrag}>
                          <SidebarMenuSubButton
                            asChild
                            isActive={isCurrent && activeForkThreadId === fork.id}
                            className="pr-8"
                          >
                            <Link
                              href={threadRowHref(project.id, fork.id)}
                              data-roving-item
                              title={fork.title}
                              onClick={onNavigate}
                            >
                              {/* 自動化の専用の Fork は稲妻（§6.42）。動いたあと未読なら太字になるのは他の Fork と同じ */}
                              <ThreadRowIcon threadId={fork.id} icon={dedicatedForks.has(fork.id) ? Zap : ForkIcon} />
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
                      <ThreadRateLimitWaitLine threadId={fork.id} />
                      <ThreadMissionLine threadId={fork.id} threadTitle={fork.title} />
                      </>
                    )}
                  </SortableRow>
                ))}
              </SortableList>

              {/* **まっさらな Fork を作る**（2026-10-11、ユーザー）。会話を引き継いで分けるのは各行の「…」の「ここから Fork…」。
                  「閉じた Fork（N）」の行はやめた——左下の履歴と同じものだった */}
              <SidebarMenuSubItem>
                <SidebarMenuSubButton asChild size="sm" className="text-ink-3">
                  <button
                    type="button"
                    data-testid="sidebar-new-fork"
                    data-roving-item
                    onClick={() => startFork(project.baseThreadId, "fresh")}
                  >
                    <Plus />
                    <span>新しい Fork</span>
                  </button>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            </SidebarMenuSub>
          ) : null}
          {closeForkDialog}
        </>
      )}
    </DraggableRow>
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
  return (
    <>
      {/* 検索の下に薄い線（2026-10-12、ユーザー要望。§6.39）——上の入口と Project 一覧を分ける */}
      <SidebarHeader className="gap-1 border-b border-sidebar-border">
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

      {/* **Project 一覧だけがスクロールする**（§6.39）。上の入口と下の行は動かない。細いスクロールバーは globals.css の .sidebar-scroll */}
      <SidebarContent className="sidebar-scroll [scrollbar-gutter:stable]">
        {/* この機械全体が混んでいる（§6.36）。押すと設定の「資源」 */}
        {hostBusy !== undefined ? (
          <HostBusyBand
            reason={hostBusy}
            href={settingsOpenHref(pathname, searchParams, { section: "resources" })}
            {...(onNavigate ? { onNavigate } : {})}
          />
        ) : null}
        {/* Project の一覧——グループ・すべて畳む・ドラッグ（§6.43、`project-list.tsx`） */}
        <ProjectList
          activeProjectId={activeProjectId}
          activeForkThreadId={activeForkThreadId}
          onNewProject={onNewProject}
          onNavigate={onNavigate}
          keepOpenOnProjectSwitch={keepOpenOnProjectSwitch}
        />
      </SidebarContent>

      {/* **履歴・設定・テーマは一番下の1行に横に並べる**（2026-10-12、ユーザー要望。§6.39）——以前は3段で
          Project 一覧の高さを削っていた。上に薄い線を引いて Project 一覧と分ける。
          設定は常設の入口（決定・2026-09-01）——Command Palette を知らないと設定に辿り着けない状態を避ける */}
      <SidebarFooter className="border-t border-sidebar-border p-1.5">
        <div className="flex items-center gap-1" data-testid="sidebar-footer-row">
          {SHOW_ARCHIVE ? (
            <button
              type="button"
              className={FOOTER_BUTTON}
              onClick={() => {
                onNavigate?.();
                onOpenArchive();
              }}
            >
              <Clock className="size-4 shrink-0" />
              <span className="truncate">履歴</span>
            </button>
          ) : null}
          {SHOW_INSTANCE_SETTINGS ? (
            <Link
              href={settingsToggleHref(pathname, searchParams, { project: activeProjectId })}
              onClick={onNavigate}
              aria-current={isSettingsOpen(pathname, searchParams) ? "page" : undefined}
              data-active={isSettingsOpen(pathname, searchParams) ? "" : undefined}
              className={cn(FOOTER_BUTTON, "data-[active]:bg-accent-soft data-[active]:text-accent-ink")}
            >
              <Settings className="size-4 shrink-0" />
              <span className="truncate">設定</span>
            </Link>
          ) : null}
          <ThemeToggle labeled className="min-w-0 flex-1" />
        </div>
      </SidebarFooter>
    </>
  );
}
