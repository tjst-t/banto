"use client";

// **サイドバーの Project 一覧——グループ**（決定・2026-10-16、v4-frontend.md §6.43。見本はモック `fork/project-org` の
// `mock/components/banto/shell/project-list.tsx`）。
//
// 並びは上から：
//   1. グループに入っていない Project（見出し無し）
//   2. グループ——見出し（色の点＋名前。押すと畳む。畳んでも中の「動いている」「あなたの番」と数は見出しに残す）の下に、
//      その中の Project（12px 下げる）
//   3. しばらく開いていない Project を眠らせるかの問い（`projects.autoSleep` が `ask` で、host の時計が候補にしたものがあるとき
//      だけ。いま開いている Project は入れない）
//   4. 「スリープ中（n）」——一番下に1行。既定は畳んである。開くと薄い行が並び、押すと起こして開く。「…」で
//      `projects.autoSleep` を選ぶ
//
// 操作はどれもサイドバーの中だけで済む：行の「…」の「グループへ移す」「スリープにする」・見出しの「…」・ドラッグ（行の上＝
// その前、見出し＝そのグループの最後、「Project」の見出し＝グループの外、「スリープ中」の見出しと行＝眠らせる、スリープ中の
// 行をグループへ＝起こしてそこへ）・「Project」の見出しの「すべて畳む」と「＋」。
// 記録は host（グループ・入れ先・並び・眠り）、畳んだかはこの端末（`lib/backend/project-groups.ts`）。
import { useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  FolderPlus,
  Check,
  FolderInput,
  LoaderCircle,
  Moon,
  MoreHorizontal,
  Pencil,
  Plus,
  Sun,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarGroup, SidebarGroupContent, SidebarMenu } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { useRovingFocus } from "@/hooks/use-roving-focus";
import { getRealAutoSleep, partlyAwakeReasons, setRealAutoSleep, type RealAutoSleepMode } from "@/lib/backend/client";
import {
  dismissSleepSuggestions,
  getAwakeProjects,
  getSleepingProjects,
  getSleepSuggestions,
  placeProject,
  wakeProject,
} from "@/lib/mock/projects";
import { getThreadsForProject } from "@/lib/mock/threads";
import type { MockProject } from "@/lib/mock/types";
import { describeFailure } from "@/lib/report-failure";
import { cn } from "@/lib/utils";
import { useAnyProjectRunning } from "@/lib/backend/running-threads";
import { getRealTurnCountForThreads, useRealInboxVersion } from "@/lib/backend/real-inbox";
import {
  GROUP_DOT_CLASS,
  PROJECT_GROUP_COLORS,
  createProjectGroup,
  moveProjectGroup,
  placeProjectGroup,
  projectSections,
  removeProjectGroup,
  setGroupCollapsed,
  setGroupsCollapsed,
  setSleepOpen,
  updateProjectGroup,
  useCollapsedGroups,
  useProjectGroups,
  useSleepOpen,
  type ProjectGroup,
  type ProjectGroupColor,
} from "@/lib/backend/project-groups";
import { useProjectWaking } from "@/lib/backend/project-waking";
import { lastForkOf, useLastThreads } from "@/lib/last-thread";
import { projectNavHref, settingsOpenHref } from "@/lib/settings-link";
import { ProjectTreeItem, WakingMark } from "./nav-panel";
import { RenameDialog } from "./rename-dialog";
import { DraggableRow, DropList, useDragItem, useDropZone } from "./sortable-list";
import type { GroupMenu } from "./sidebar-item-menu";
import { useSleepProjects } from "./use-sleep-project";

/** 落とす先の id。行は `row:<Project の id>`（`ProjectTreeItem`）、スリープ中の行は `sleeping:<Project の id>` */
const DROP_UNGROUPED = "ungrouped";
const DROP_SLEEP = "sleep";
const dropGroup = (id: string) => `group:${id}`;
/**
 * グループの見出しを運ぶとき（Backlog #374）。掴む id は `heading:<グループの id>`、落とす先は見出し＝`before:<グループの id>`
 * （その前へ）と、グループの並びの最後（`DROP_GROUP_END`、見出しを運んでいる間だけ出る）
 */
const dragHeading = (id: string) => `heading:${id}`;
const dropBeforeGroup = (id: string) => `before:${id}`;
const DROP_GROUP_END = "group-end";

/** 「…」の頭に出す、いつから眠っているか（自動で眠ったものは「自動でスリープ」） */
export function sleptSince(sleep: NonNullable<MockProject["sleep"]>): string {
  const d = new Date(sleep.since);
  const day = Number.isNaN(d.getTime()) ? "" : `${d.getMonth() + 1}月${d.getDate()}日から`;
  return sleep.by === "auto" ? `${day}自動でスリープ` : `${day}スリープ中`;
}

/**
 * **眠っている Project を起こして開く**（§6.43。最後に開いていた Thread、§6.40）。起こすのは `modules/prepare` を投げる
 * だけ——開いた画面も同じものを頼むが、進んでいるものを分け合う
 */
function useOpenSleeping(onNavigate?: () => void): (project: MockProject) => void {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const lastThreads = useLastThreads();
  return (project) => {
    void wakeProject(project.id).catch(report(`「${project.name}」を起こせませんでした`));
    const forks = getThreadsForProject(project.id).filter((t) => t.kind === "fork");
    const lastForkId = lastForkOf(lastThreads, project.id, forks.map((f) => f.id));
    onNavigate?.();
    router.push(projectNavHref(project.id, pathname, searchParams, "project-general", lastForkId));
  };
}

/** 見出しの右端の小さな押し口（すべて畳む・＋）の形 */
const HEADER_BUTTON =
  "flex size-5 items-center justify-center rounded-md text-ink-3 outline-hidden hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring";

/** 失敗は toast で知らせる（黙らない、規則2）。画面は書き終えたもの・戻したものを出している */
function report(what: string) {
  return (err: unknown) => toast(`${what}: ${describeFailure(err)}`);
}

/**
 * 見出しの「…」。パソコンでは指を載せたときだけ、携帯ではいつも見える。位置は Project の行と同じ `right-7`
 * （右端 `right-1` は開く・畳む）
 */
function HeadingMore({ label }: { label: string }) {
  return (
    <DropdownMenuTrigger asChild>
      <button
        type="button"
        aria-label={label}
        data-testid="sidebar-group-more"
        className={cn(
          HEADER_BUTTON,
          "absolute top-1.5 right-7 focus-visible:opacity-100 data-[state=open]:opacity-100 md:opacity-0 md:group-hover/heading:opacity-100",
        )}
      >
        <MoreHorizontal className="size-4" />
      </button>
    </DropdownMenuTrigger>
  );
}

/**
 * グループの見出し。押すと畳む／開く。掴んで（§6.11 と同じ掴み方）ほかのグループの見出しへ落とすとその前へ。
 * Project の行を落とすとそのグループの最後へ——同じ見出しが、運んでいるものの種類で別の落とす先になる
 */
function GroupHeading({
  group,
  projects,
  collapsed,
  index,
  groupCount,
  onRename,
  onSleepAll,
}: {
  group: ProjectGroup;
  projects: readonly MockProject[];
  collapsed: boolean;
  index: number;
  groupCount: number;
  onRename: (group: ProjectGroup) => void;
  /** 中の Project を全部眠らせる（眠らせられなかったものは理由を1行ずつ） */
  onSleepAll: () => void;
}) {
  const { setNodeRef: setDropRef, isOver: rowOver } = useDropZone(dropGroup(group.id));
  const drag = useDragItem({ id: dragHeading(group.id), kind: "heading", dropId: dropBeforeGroup(group.id) });
  const dropOver = rowOver || drag.isOver;
  const running = useAnyProjectRunning(projects.map((p) => p.id));
  useRealInboxVersion();
  const turn = getRealTurnCountForThreads(
    new Set(projects.flatMap((p) => [p.baseThreadId, ...getThreadsForProject(p.id).map((t) => t.id)])),
  );
  const toggle = () => setGroupCollapsed(group.id, !collapsed);
  return (
    <li
      ref={(el) => {
        setDropRef(el);
        drag.setNodeRef(el);
        drag.setDropRef(el);
      }}
      {...drag.handle}
      onClickCapture={drag.onClickCapture}
      data-testid="sidebar-group"
      data-group-id={group.id}
      data-collapsed={collapsed ? "" : undefined}
      data-dragging={drag.isDragging ? "" : undefined}
      data-drop-over={dropOver ? "" : undefined}
      style={drag.style}
      className={cn(
        "group/heading relative flex h-8 items-center rounded-md",
        rowOver && "bg-accent-soft",
        // グループを運んでいるときは「その前へ」——行の上と同じ線
        drag.isOver &&
          "before:absolute before:inset-x-1 before:-top-0.5 before:z-10 before:h-0.5 before:rounded-full before:bg-accent",
      )}
    >
      <button
        type="button"
        data-roving-item
        onClick={toggle}
        aria-expanded={!collapsed}
        className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md pr-14 pl-2 text-left outline-hidden hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      >
        {/* 点は Project の頭文字と同じ 24px の枠の真ん中——点と頭文字、見出しの名前と Project の名前の左端が縦にそろう */}
        <span className="flex size-6 shrink-0 items-center justify-center" aria-hidden>
          <span data-testid="sidebar-group-dot" data-color={group.color} className={cn("size-2 rounded-full", GROUP_DOT_CLASS[group.color])} />
        </span>
        <span data-testid="sidebar-group-name" className="truncate text-sm font-medium text-ink-2">
          {group.name}
        </span>
        {collapsed ? (
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {running ? (
              <LoaderCircle
                className="size-3.5 animate-spin text-ink-2"
                role="img"
                aria-label="AI が動いています"
                data-testid="sidebar-group-running"
              />
            ) : null}
            {turn > 0 ? (
              <span
                data-testid="sidebar-group-turn"
                className="flex h-4 min-w-4 items-center justify-center rounded-full bg-turn px-1 text-xs leading-none font-semibold text-on-color tabular-nums"
                aria-label={`あなたの番 ${turn} 件`}
              >
                {turn}
              </span>
            ) : null}
            <span data-testid="sidebar-group-count" className="text-xs text-ink-3 tabular-nums" aria-label={`Project ${projects.length} 件`}>
              {projects.length}
            </span>
          </span>
        ) : null}
      </button>
      <DropdownMenu>
        <HeadingMore label={`グループ「${group.name}」の操作`} />
        <DropdownMenuContent side="right" align="start" className="w-56">
          <DropdownMenuItem onSelect={() => onRename(group)}>
            <Pencil />
            名前を変える…
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <span className={cn("size-2 shrink-0 rounded-full", GROUP_DOT_CLASS[group.color])} />
              色
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup
                value={group.color}
                onValueChange={(v) =>
                  void updateProjectGroup(group.id, { color: v as ProjectGroupColor }).catch(report("色を変えられませんでした"))
                }
              >
                {PROJECT_GROUP_COLORS.map((c) => (
                  <DropdownMenuRadioItem key={c.id} value={c.id}>
                    <span className={cn("size-2 shrink-0 rounded-full", GROUP_DOT_CLASS[c.id])} />
                    {c.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem
            disabled={index <= 0}
            onSelect={() => void moveProjectGroup(group.id, -1).catch(report("グループを動かせませんでした"))}
          >
            <ArrowUp />
            グループを上へ
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={index >= groupCount - 1}
            onSelect={() => void moveProjectGroup(group.id, 1).catch(report("グループを動かせませんでした"))}
          >
            <ArrowDown />
            グループを下へ
          </DropdownMenuItem>
          <DropdownMenuItem disabled={projects.length === 0} onSelect={onSleepAll}>
            <Moon />
            中の Project を全部スリープに
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {/* 確かめの小窓は出さない——消えるものが無い（中の Project はグループの外へ出るだけ） */}
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => void removeProjectGroup(group.id).catch(report("グループをなくせませんでした"))}
          >
            <Trash2 />
            グループをなくす
          </DropdownMenuItem>
          <p className="px-1.5 pb-1 text-xs text-ink-3">中の Project は消えず、グループの外に出ます</p>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* 開く・畳むはいつも右端（Project の行の Thread の目次と同じ位置） */}
      <button
        type="button"
        onClick={toggle}
        aria-label={`グループ「${group.name}」を${collapsed ? "開く" : "畳む"}`}
        aria-expanded={!collapsed}
        className="absolute top-1.5 right-1 flex size-5 items-center justify-center rounded-md text-sidebar-foreground hover:bg-sidebar-accent"
      >
        <ChevronRight className={cn("size-4 transition-transform", !collapsed && "rotate-90")} />
      </button>
    </li>
  );
}

/** グループの並びの最後（見出しを運んでいる間だけ出る）。落とすと一番下のグループへ */
function GroupEndZone() {
  const { setNodeRef, isOver } = useDropZone(DROP_GROUP_END, "heading");
  return (
    <li
      ref={setNodeRef}
      data-testid="sidebar-group-end"
      data-drop-over={isOver ? "" : undefined}
      aria-hidden
      className={cn(
        "relative h-8",
        isOver && "before:absolute before:inset-x-1 before:top-0 before:h-0.5 before:rounded-full before:bg-accent",
      )}
    />
  );
}

/** 「Project」の見出し。落とすとグループの外へ。右に「すべて畳む／すべて開く」と「＋」 */
function ProjectsHeading({
  allCollapsed,
  onToggleAll,
  onNewProject,
  onNewGroup,
}: {
  allCollapsed: boolean;
  onToggleAll: () => void;
  onNewProject: () => void;
  onNewGroup: () => void;
}) {
  const { setNodeRef: setDropRef, isOver: dropOver } = useDropZone(DROP_UNGROUPED);
  const toggleLabel = allCollapsed ? "すべて開く" : "すべて畳む";
  return (
    <div
      ref={setDropRef}
      data-testid="sidebar-projects-heading"
      data-drop-over={dropOver ? "" : undefined}
      className={cn(
        "flex h-8 shrink-0 items-center gap-0.5 rounded-md pr-1 pl-2 text-xs font-medium text-sidebar-foreground/70",
        dropOver && "bg-accent-soft",
      )}
    >
      <span className="flex-1">Project</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" aria-label={toggleLabel} onClick={onToggleAll} className={HEADER_BUTTON}>
            {allCollapsed ? <ChevronsUpDown className="size-4" /> : <ChevronsDownUp className="size-4" />}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{toggleLabel}</TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="Project・グループを足す" className={HEADER_BUTTON}>
            <Plus className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" className="w-48">
          <DropdownMenuItem onSelect={onNewProject}>
            <Plus />
            新しい Project…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onNewGroup}>
            <FolderPlus />
            新しいグループ…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <AutoSleepSubmenu />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * **しばらく開いていない Project を眠らせるかの問い**（§6.43）。スリープ中の見出しのすぐ上に、破線の枠で静かに。
 * 落とす先にはしない
 */
function SleepSuggestion({ projects, onSleep }: { projects: readonly MockProject[]; onSleep: () => void }) {
  const [dismissing, setDismissing] = useState(false);
  if (projects.length === 0) return null;
  return (
    <li data-testid="sidebar-sleep-suggestion" className="my-1 rounded-md border border-dashed border-border px-2.5 py-2">
      <p className="text-xs text-ink-2">14日以上開いていない Project が {projects.length} 件あります</p>
      <p data-testid="sidebar-sleep-suggestion-names" className="mt-0.5 truncate text-xs text-ink-3">
        {projects.map((p) => `${p.name}（${p.idle?.days ?? 0}日）`).join("、")}
      </p>
      <div className="mt-1.5 flex gap-1">
        <Button size="sm" variant="secondary" className="h-6 px-2 text-xs" onClick={onSleep}>
          <Moon className="size-3" />
          スリープにする
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs text-ink-3"
          disabled={dismissing}
          onClick={() => {
            setDismissing(true);
            void dismissSleepSuggestions(projects.map((p) => p.id))
              .catch(report("「今はしない」を保存できませんでした"))
              .finally(() => setDismissing(false));
          }}
        >
          今はしない
        </Button>
      </div>
    </li>
  );
}

/**
 * 自動スリープ（banto 全体の設定 `projects.autoSleep`）を host から読む。開いたときに読み直す（写しを持たない、規則3）。
 * 「スリープ中」の見出しの「…」と「Project」の見出しの「＋」の2か所で使う（2026-10-17、ユーザー「眠っている Project が無くても
 * 変えられるように」）
 */
function useAutoSleepMode() {
  const [mode, setMode] = useState<RealAutoSleepMode | null>(null);
  const reload = () => {
    setMode(null);
    void getRealAutoSleep().then(setMode, report("設定を読めませんでした"));
  };
  return { mode, setMode, reload };
}

/** 選択肢と説明（2か所で同じ中身） */
function AutoSleepChoices({
  mode,
  setMode,
}: {
  mode: RealAutoSleepMode | null;
  setMode: (m: RealAutoSleepMode) => void;
}) {
  return (
    <>
        <DropdownMenuLabel className="text-xs font-normal text-ink-3">14日開いていない Project を</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={mode ?? ""}
          onValueChange={(v) => {
            const next = v as RealAutoSleepMode;
            void setRealAutoSleep(next).then(setMode, report("設定を保存できませんでした"));
          }}
        >
          <DropdownMenuRadioItem value="ask" disabled={mode === null}>
            スリープにするか聞く
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="auto" disabled={mode === null}>
            自動でスリープにする
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="off" disabled={mode === null}>
            何もしない
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <p className="px-1.5 pb-1 text-xs text-ink-3">
          スリープ中はコンテナ・Module・Service を止めて資源を返します。会話はそのまま残ります。開いたとき・自動化の時刻が来たとき・メッセージなどが届いたときは自動で起きます
        </p>
    </>
  );
}

/**
 * 「Project」の見出しの「＋」の中の「しばらく開いていない Project」——眠っている Project が無くて「スリープ中」の見出しが
 * 出ていないときも、ここから変えられる（2026-10-17、ユーザー）
 */
function AutoSleepSubmenu() {
  const { mode, setMode, reload } = useAutoSleepMode();
  return (
    <DropdownMenuSub
      onOpenChange={(open) => {
        if (open) reload();
      }}
    >
      <DropdownMenuSubTrigger data-testid="sidebar-auto-sleep-submenu">
        <Moon />
        しばらく開いていない Project
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-64" data-testid="sidebar-auto-sleep-menu">
        <AutoSleepChoices mode={mode} setMode={setMode} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** 「スリープ中」の見出しの「…」：しばらく開いていない Project をどうするか */
function AutoSleepMenu() {
  const { mode, setMode, reload } = useAutoSleepMode();
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) reload();
      }}
    >
      <HeadingMore label="スリープ中の設定" />
      <DropdownMenuContent side="right" align="end" className="w-64" data-testid="sidebar-auto-sleep-menu">
        <AutoSleepChoices mode={mode} setMode={setMode} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 一番下の「スリープ中（n）」。押すと開く・畳む（既定は畳んである）。落とすと眠らせる */
function SleepHeading({ count, open }: { count: number; open: boolean }) {
  const { setNodeRef: setDropRef, isOver: dropOver } = useDropZone(DROP_SLEEP);
  const toggle = () => setSleepOpen(!open);
  return (
    <li
      ref={setDropRef}
      data-testid="sidebar-sleep-heading"
      data-open={open ? "" : undefined}
      data-drop-over={dropOver ? "" : undefined}
      className={cn("group/heading relative flex h-8 items-center rounded-md", dropOver && "bg-accent-soft")}
    >
      <button
        type="button"
        data-roving-item
        onClick={toggle}
        aria-expanded={open}
        className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md pr-14 pl-2 text-left text-ink-3 outline-hidden hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      >
        <span className="flex size-6 shrink-0 items-center justify-center" aria-hidden>
          <Moon className="size-3.5" />
        </span>
        <span className="truncate text-sm">スリープ中</span>
        <span data-testid="sidebar-sleep-count" className="ml-auto text-xs tabular-nums" aria-label={`Project ${count} 件`}>
          {count}
        </span>
      </button>
      <AutoSleepMenu />
      <button
        type="button"
        onClick={toggle}
        aria-label={`スリープ中を${open ? "畳む" : "開く"}`}
        aria-expanded={open}
        className="absolute top-1.5 right-1 flex size-5 items-center justify-center rounded-md text-sidebar-foreground hover:bg-sidebar-accent"
      >
        <ChevronRight className={cn("size-4 transition-transform", open && "rotate-90")} />
      </button>
    </li>
  );
}

/**
 * **スリープ中の1行**（§6.43）。頭文字は塗らずに枠だけ、名前は薄く、属していたグループがあれば名前の右に小さく薄い点。
 * 押すと起こして開く。掴んでグループ（の見出し・行）へ落とすと起こしてそこへ
 */
function SleepingRow({
  project,
  group,
  groups,
  onOpen,
  onPlace,
  onNewGroup,
}: {
  project: MockProject;
  group: ProjectGroup | undefined;
  groups: readonly ProjectGroup[];
  onOpen: (project: MockProject) => void;
  onPlace: (groupId: string | null) => void;
  onNewGroup: () => void;
}) {
  const waking = useProjectWaking(project.id);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const since = project.sleep ? sleptSince(project.sleep) : "";
  // 自動化のため一部起きている（出来事を待たれている Module があって、コンテナを止めていない——アーキ §2.2）
  const awake = partlyAwakeReasons(project.partlyAwake ?? []);
  return (
    <DraggableRow id={project.id} dropId={`sleeping:${project.id}`} as="li" className="group/menu-item relative">
      {(drag, _isDragging, drop) => (
          <div
            ref={drop.setNodeRef}
            data-drop-over={drop.isOver ? "" : undefined}
            className={cn(
              "relative",
              drop.isOver && "before:absolute before:inset-x-1 before:-top-0.5 before:z-10 before:h-0.5 before:rounded-full before:bg-accent",
            )}
            {...drag}
          >
            <button
              type="button"
              data-roving-item
              data-testid="sidebar-sleeping-project"
              data-project-id={project.id}
              onClick={() => onOpen(project)}
              title={`押すと起こして開きます（${since}）${awake.length > 0 ? `\n${awake.join("\n")}` : ""}`}
              className="flex h-8 w-full items-center gap-2 rounded-md pr-14 pl-2 text-left text-sm text-ink-3 outline-hidden hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            >
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border text-xs font-semibold">
                {project.initial}
              </span>
              <span data-testid="sidebar-sleeping-name" className="min-w-0 truncate">
                {project.name}
              </span>
              {group ? (
                <span
                  data-testid="sidebar-sleeping-group-dot"
                  data-group-id={group.id}
                  className={cn("size-1.5 shrink-0 rounded-full opacity-60", GROUP_DOT_CLASS[group.color])}
                  aria-label={`グループ ${group.name}`}
                />
              ) : null}
              {awake.length > 0 ? (
                <Zap
                  data-testid="sidebar-sleeping-partly-awake"
                  className="size-3 shrink-0 opacity-60"
                  aria-label={awake.join("。")}
                />
              ) : null}
            </button>
            {waking ? (
              <WakingMark />
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    data-testid="sidebar-sleeping-more"
                    aria-label={`「${project.name}」の操作`}
                    className={cn(
                      HEADER_BUTTON,
                      "absolute top-1.5 right-7 focus-visible:opacity-100 data-[state=open]:opacity-100 md:opacity-0 md:group-hover/menu-item:opacity-100",
                    )}
                  >
                    <MoreHorizontal className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="right" align="start" className="w-56">
                  {awake.map((reason) => (
                    <DropdownMenuLabel
                      key={reason}
                      data-testid="sidebar-sleeping-awake-reason"
                      className="flex gap-1.5 text-xs font-normal text-ink-2"
                    >
                      <Zap className="mt-0.5 size-3 shrink-0" />
                      {reason}
                    </DropdownMenuLabel>
                  ))}
                  <DropdownMenuLabel className="text-xs font-normal text-ink-3">{since}</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={() => onOpen(project)}>
                    <Sun />
                    起こして開く
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => void wakeProject(project.id).catch(report(`「${project.name}」を起こせませんでした`))}
                  >
                    <Sun />
                    起こすだけ（開かない）
                  </DropdownMenuItem>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <FolderInput />
                      グループへ移す
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-56">
                      {groups.map((g) => (
                        <DropdownMenuItem key={g.id} onSelect={() => onPlace(g.id)}>
                          <span className={cn("size-2 shrink-0 rounded-full", GROUP_DOT_CLASS[g.color])} />
                          <span className="flex-1 truncate">{g.name}</span>
                          {group?.id === g.id ? <Check className="text-ink-3" aria-label="いま入っている" /> : null}
                        </DropdownMenuItem>
                      ))}
                      <DropdownMenuItem onSelect={() => onPlace(null)}>
                        <span className="size-2 shrink-0 rounded-full border border-ink-3" />
                        <span className="flex-1">グループに入れない</span>
                        {group === undefined ? <Check className="text-ink-3" aria-label="いま入っている" /> : null}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={onNewGroup}>
                        <FolderPlus />
                        新しいグループを作って入れる…
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuSeparator />
                  {/* 閉じる確かめは Project の設定の「一般」にある（`project-general-panel.tsx`）——同じ手順へ連れていく */}
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() =>
                      router.push(settingsOpenHref(pathname, searchParams, { project: project.id, section: "project-general" }))
                    }
                  >
                    <X />
                    閉じる…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
      )}
    </DraggableRow>
  );
}

export function ProjectList({
  activeProjectId,
  activeForkThreadId,
  onNewProject,
  onNavigate,
  keepOpenOnProjectSwitch,
}: {
  activeProjectId: string | null;
  activeForkThreadId: string | null;
  onNewProject: () => void;
  onNavigate?: () => void;
  keepOpenOnProjectSwitch?: boolean;
}) {
  const { containerRef, onKeyDown } = useRovingFocus<HTMLUListElement>();
  // 開いている Project の目次は既定で開く。人が畳んだ／開いたときだけ、その選択を覚える（導出できる既定値を保存しない、規則3）
  const [expandedOverride, setExpandedOverride] = useState<Record<string, boolean>>({});
  // 名前の小窓：新しいグループ（入れる Project があれば一緒に入れる）／グループの名前を変える。閉じても中身は残す
  // ——閉じる動きの間に題が「名前を変える」へ替わって見えないように
  const [nameDialog, setNameDialogState] = useState<
    { kind: "new"; projectId?: string } | { kind: "rename"; group: ProjectGroup } | null
  >(null);
  const [nameDialogOpen, setNameDialogOpen] = useState(false);
  function setNameDialog(next: NonNullable<typeof nameDialog>) {
    setNameDialogState(next);
    setNameDialogOpen(true);
  }
  const groups = useProjectGroups();
  const collapsedGroups = useCollapsedGroups();
  const sleepOpen = useSleepOpen();
  const sections = projectSections(getAwakeProjects(), groups);
  const sleeping = getSleepingProjects();
  const suggestions = getSleepSuggestions(activeProjectId);
  const allProjects = sections.flatMap((s) => s.projects);
  const { requestSleep, dialog: sleepDialog } = useSleepProjects();
  const openSleeping = useOpenSleeping(onNavigate);
  const isExpanded = (id: string) => expandedOverride[id] ?? id === activeProjectId;
  // 全部畳んでいるか：グループが全部畳まれ、見えている Thread の目次も1つも開いていない（畳んだグループの中の目次は見えない
  // ——リロードすると、いま開いている Project の目次は既定で開くので、それを数えると畳んだのに「すべて畳む」のままになる）
  const visibleProjects = sections.flatMap((s) => (s.group && collapsedGroups.has(s.group.id) ? [] : s.projects));
  const allCollapsed =
    groups.every((g) => collapsedGroups.has(g.id)) && visibleProjects.every((p) => !isExpanded(p.id)) && !sleepOpen;

  function toggleAll() {
    if (allCollapsed) {
      // グループを全部開き、Thread の目次は既定（いま開いている Project だけ開く）に戻す
      setGroupsCollapsed([], false);
      setExpandedOverride({});
    } else {
      setGroupsCollapsed(
        groups.map((g) => g.id),
        true,
      );
      setExpandedOverride(Object.fromEntries(allProjects.map((p) => [p.id, false])));
    }
  }

  function place(projectId: string, target: { groupId: string | null; beforeId?: string }) {
    void placeProject(projectId, target).catch(report("並び順を保存できませんでした"));
  }

  /**
   * 落とした1回だけ書く（§6.11）。行の上＝その前、見出し＝そのグループの最後、「Project」の見出し＝グループの外、
   * 「スリープ中」の見出し・スリープ中の行＝眠らせる。眠っているものをグループ側へ落としたら、起こしてそこへ
   */
  function onDrop(activeId: string, overId: string) {
    if (activeId.startsWith("heading:")) {
      onDropGroup(activeId.slice("heading:".length), overId);
      return;
    }
    const projectId = activeId;
    const asleep = sleeping.find((p) => p.id === projectId);
    if (overId === DROP_SLEEP || overId.startsWith("sleeping:")) {
      const awake = allProjects.find((p) => p.id === projectId);
      if (awake) requestSleep([awake]);
      return;
    }
    let target: { groupId: string | null; beforeId?: string } | undefined;
    if (overId.startsWith("row:")) {
      const beforeId = overId.slice("row:".length);
      const section = sections.find((s) => s.projects.some((p) => p.id === beforeId));
      if (section) target = { groupId: section.group?.id ?? null, beforeId };
    } else if (overId.startsWith("group:")) {
      target = { groupId: overId.slice("group:".length) };
    } else if (overId === DROP_UNGROUPED) {
      target = { groupId: null };
    }
    if (!target) return;
    place(projectId, target);
    if (asleep) void wakeProject(projectId).catch(report(`「${asleep.name}」を起こせませんでした`));
  }

  /** グループの見出しを落とした（§6.11——落とした1回だけ並び全体を書く。書けなければ元に戻る） */
  function onDropGroup(groupId: string, overId: string) {
    const beforeId =
      overId === DROP_GROUP_END ? null : overId.startsWith("before:") ? overId.slice("before:".length) : undefined;
    if (beforeId === undefined) return;
    void placeProjectGroup(groupId, beforeId).catch(report("グループを動かせませんでした"));
  }

  function groupMenuFor(project: MockProject, current: string | null): GroupMenu {
    return {
      groups: groups.map((g) => ({ id: g.id, name: g.name, dotClass: GROUP_DOT_CLASS[g.color] })),
      current,
      onPick: (groupId) => {
        if (groupId !== current) place(project.id, { groupId });
      },
      onNew: () => setNameDialog({ kind: "new", projectId: project.id }),
    };
  }

  function renderProject(project: MockProject, siblings: readonly MockProject[], groupId: string | null) {
    const index = siblings.indexOf(project);
    return (
      <ProjectTreeItem
        key={project.id}
        project={project}
        indented={groupId !== null}
        groupMenu={groupMenuFor(project, groupId)}
        onSleep={() => requestSleep([project])}
        // 「上へ／下へ」は同じ塊（グループ・グループの外）の中で。端なら押せない
        onMoveUp={index > 0 ? () => place(project.id, { groupId, beforeId: siblings[index - 1]!.id }) : undefined}
        onMoveDown={
          index < siblings.length - 1
            ? () => place(project.id, { groupId, ...(siblings[index + 2] ? { beforeId: siblings[index + 2]!.id } : {}) })
            : undefined
        }
        activeProjectId={activeProjectId}
        activeForkThreadId={activeForkThreadId}
        expanded={isExpanded(project.id)}
        onToggleExpanded={() =>
          setExpandedOverride((prev) => ({ ...prev, [project.id]: !(prev[project.id] ?? project.id === activeProjectId) }))
        }
        onExpand={() => setExpandedOverride((prev) => ({ ...prev, [project.id]: true }))}
        onNavigate={onNavigate}
        keepOpenOnProjectSwitch={keepOpenOnProjectSwitch}
      />
    );
  }

  async function submitName(name: string) {
    if (!nameDialog) return;
    if (nameDialog.kind === "rename") {
      await updateProjectGroup(nameDialog.group.id, { name });
      return;
    }
    const created = await createProjectGroup(name);
    if (nameDialog.projectId) await placeProject(nameDialog.projectId, { groupId: created.id });
  }

  return (
    <SidebarGroup>
      <DropList onDrop={onDrop}>
        {(activeId) => {
          // 運んでいるグループは畳んだ高さで運ぶ（人の開閉の選択は変えない——§6.11 の「運んでいる間は目次を畳む」と同じ）
          const carried = activeId?.startsWith("heading:") ? activeId.slice("heading:".length) : null;
          const lastGroupIndex = sections.findLastIndex((s) => s.group !== null);
          return (
            <>
            <ProjectsHeading
              allCollapsed={allCollapsed}
              onToggleAll={toggleAll}
              onNewProject={() => {
                onNavigate?.();
                onNewProject();
              }}
              onNewGroup={() => setNameDialog({ kind: "new" })}
            />
            <SidebarGroupContent>
              <SidebarMenu ref={containerRef} onKeyDown={onKeyDown} data-testid="sidebar-project-list">
                {sections.map(({ group, projects }, i) =>
                  group === null ? (
                    <SectionRows key="ungrouped">{projects.map((p) => renderProject(p, projects, null))}</SectionRows>
                  ) : (
                    <SectionRows key={group.id}>
                      <GroupHeading
                        group={group}
                        projects={projects}
                        collapsed={collapsedGroups.has(group.id)}
                        index={i - 1}
                        groupCount={groups.length}
                        onRename={(g) => setNameDialog({ kind: "rename", group: g })}
                        onSleepAll={() => requestSleep(projects)}
                      />
                      {collapsedGroups.has(group.id) || carried === group.id ? null : projects.length === 0 ? (
                        <li data-testid="sidebar-group-empty" className="py-1 pr-2 pl-11 text-xs text-ink-3">
                          Project をここへドラッグするか、行の「…」から入れます
                        </li>
                      ) : (
                        projects.map((p) => renderProject(p, projects, group.id))
                      )}
                      {carried !== null && i === lastGroupIndex ? <GroupEndZone /> : null}
                    </SectionRows>
                  ),
                )}
                <SleepSuggestion projects={suggestions} onSleep={() => requestSleep(suggestions)} />
                {sleeping.length > 0 ? (
                  <>
                    <SleepHeading count={sleeping.length} open={sleepOpen} />
                    {sleepOpen
                      ? sleeping.map((p) => (
                          <SleepingRow
                            key={p.id}
                            project={p}
                            group={groups.find((g) => g.id === p.groupId)}
                            groups={groups}
                            onOpen={openSleeping}
                            onPlace={(groupId) => place(p.id, { groupId })}
                            onNewGroup={() => setNameDialog({ kind: "new", projectId: p.id })}
                          />
                        ))
                      : null}
                  </>
                ) : null}
              </SidebarMenu>
            </SidebarGroupContent>
            </>
          );
        }}
      </DropList>
      {sleepDialog}
      <RenameDialog
        open={nameDialogOpen}
        onOpenChange={setNameDialogOpen}
        what="グループ"
        currentName={nameDialog?.kind === "rename" ? nameDialog.group.name : ""}
        onSubmit={submitName}
        wording={
          nameDialog?.kind === "new"
            ? {
                title: "新しいグループ",
                description: "サイドバーの見出しになります。例：開発・検証・くらし。色はあとで変えられます。",
                submit: "作る",
                submitting: "作っています…",
                failed: "グループを作れませんでした",
              }
            : undefined
        }
      />
    </SidebarGroup>
  );
}

/** 見出しと行を同じ ul に並べる（グループごとに入れ子の ul を作らない——上下の矢印キーで続けて移れるように） */
function SectionRows({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
