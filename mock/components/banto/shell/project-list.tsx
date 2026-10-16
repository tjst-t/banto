"use client";

// サイドバーの Project 一覧——グループとスリープ（モック・2026-10-16、Fork「Project の整理（サイドバー）」）。
//
// 並びは上から：
//   1. グループに入っていない Project（見出し無し）
//   2. グループ（色の点＋名前の見出し。押すと畳む。畳むと中の「動いている」「あなたの番」だけ見出しに残る）
//   3. しばらく使っていない Project の提案（自動スリープを「提案する」にしているときだけ）
//   4. スリープ中（一番下に1行。既定で畳んである。開くと薄い行が並び、押せば起きて開く）
//
// 操作はどれもサイドバーの中だけで済む：行の「…」・見出しの「…」・ドラッグ（行を見出しや別の行の上へ）・
// 「Project」の見出しの「＋」（新しい Project／新しいグループ）。携帯は「…」がいつも見えている（hover が無い）
import { useState, type DragEvent, type HTMLAttributes, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  FolderPlus,
  LoaderCircle,
  Moon,
  MoreHorizontal,
  Pencil,
  Plus,
  Settings,
  Sun,
  Trash2,
  X,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useRovingFocus } from "@/hooks/use-roving-focus";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import { closeProject } from "@/lib/mock/projects";
import { getThreadsForProject } from "@/lib/mock/threads";
import { isThreadRunning } from "@/lib/mock/background-work";
import { getFeedItems, sectionOf } from "@/lib/mock/inbox-feed";
import {
  GROUP_COLORS,
  GROUP_DOT_CLASS,
  IDLE_DAYS_FOR_SUGGESTION,
  createGroup,
  dismissSleepSuggestions,
  getAutoSleep,
  getGroups,
  getSidebarSections,
  getSleepSuggestions,
  groupOf,
  idleDays,
  isSleeping,
  isWaking,
  moveGroup,
  moveToGroup,
  nudgeProject,
  placeProject,
  recolorGroup,
  removeGroup,
  renameGroup,
  setAllGroupsCollapsed,
  setAutoSleep,
  sleepProject,
  sleepProjects,
  sleptAt,
  toggleGroupCollapsed,
  wakeProject,
  type GroupColor,
  type ProjectGroup,
} from "@/lib/mock/project-org";
import type { MockProject } from "@/lib/mock/types";
import { cn } from "@/lib/utils";
import { ProjectTreeItem } from "./nav-panel";

const DRAG_TYPE = "application/x-banto-project";

/** その Project のどこかで AI が動いているか */
function projectRunning(projectId: string): boolean {
  return getThreadsForProject(projectId).some((t) => isThreadRunning(t.id));
}

/** その Project で人の番になっているもの（判断待ち＋決めることのある返ってきた会話） */
function yourTurnCount(projectId: string): number {
  return getFeedItems().filter(
    (i) => i.projectId === projectId && (sectionOf(i) === "judgment" || sectionOf(i) === "decide"),
  ).length;
}

/** 見出し・行の右端の「…」の押し口。パソコンでは指を載せたときだけ、携帯ではいつも見える */
function MoreButton({ label, className, hoverGroup }: { label: string; className?: string; hoverGroup: "project" | "heading" }) {
  return (
    <DropdownMenuTrigger asChild>
      <button
        type="button"
        aria-label={label}
        className={cn(
          "flex size-5 items-center justify-center rounded-md text-ink-3 hover:bg-accent hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100",
          hoverGroup === "project" ? "md:opacity-0 md:group-hover/project:opacity-100" : "md:opacity-0 md:group-hover/heading:opacity-100",
          className,
        )}
      >
        <MoreHorizontal className="size-4" />
      </button>
    </DropdownMenuTrigger>
  );
}

/** 名前を聞く小窓（新しいグループ・名前を変える） */
function NameDialog({
  open,
  title,
  description,
  initial,
  submitLabel,
  onSubmit,
  onOpenChange,
}: {
  open: boolean;
  title: string;
  description?: string;
  initial: string;
  submitLabel: string;
  onSubmit: (name: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <NameDialogBody
          key={String(open)}
          title={title}
          description={description}
          initial={initial}
          submitLabel={submitLabel}
          onSubmit={(name) => {
            onSubmit(name);
            onOpenChange(false);
          }}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function NameDialogBody({
  title,
  description,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  title: string;
  description?: string;
  initial: string;
  submitLabel: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const trimmed = name.trim();
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (trimmed) onSubmit(trimmed);
      }}
    >
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description ? <DialogDescription>{description}</DialogDescription> : null}
      </DialogHeader>
      <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="名前" />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          やめる
        </Button>
        <Button type="submit" disabled={!trimmed}>
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** 「グループへ移す」の中身（行のメニューから） */
function MoveToGroupItems({ project, onNewGroup }: { project: MockProject; onNewGroup: () => void }) {
  const current = groupOf(project.id)?.id ?? null;
  return (
    <>
      {getGroups().map((g) => (
        <DropdownMenuItem key={g.id} onSelect={() => moveToGroup(project.id, g.id)}>
          <span className={cn("size-2 shrink-0 rounded-full", GROUP_DOT_CLASS[g.color])} />
          <span className="flex-1 truncate">{g.name}</span>
          {current === g.id ? <Check className="text-ink-3" /> : null}
        </DropdownMenuItem>
      ))}
      <DropdownMenuItem onSelect={() => moveToGroup(project.id, null)}>
        <span className="size-2 shrink-0 rounded-full border border-ink-3" />
        <span className="flex-1">グループに入れない</span>
        {current === null ? <Check className="text-ink-3" /> : null}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={onNewGroup}>
        <FolderPlus />
        新しいグループを作って入れる…
      </DropdownMenuItem>
    </>
  );
}

/** 行の「…」——起きている Project */
function ProjectRowMenu({
  project,
  hasChevron,
  onNewGroup,
  onOpenSettings,
}: {
  project: MockProject;
  hasChevron: boolean;
  onNewGroup: (projectId: string) => void;
  onOpenSettings: (projectId: string) => void;
}) {
  return (
    <DropdownMenu>
      <MoreButton
        label={`${project.name} の操作`}
        hoverGroup="project"
        className={cn("absolute top-1.5", hasChevron ? "right-7" : "right-1")}
      />
      <DropdownMenuContent side="right" align="start" className="w-56">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <FolderPlus />
            グループへ移す
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-56">
            <MoveToGroupItems project={project} onNewGroup={() => onNewGroup(project.id)} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem onSelect={() => nudgeProject(project.id, -1)}>
          <ArrowUp />
          上へ
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => nudgeProject(project.id, 1)}>
          <ArrowDown />
          下へ
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => sleepProject(project.id)}>
          <Moon />
          スリープにする
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onOpenSettings(project.id)}>
          <Settings />
          Project の設定
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => closeProject(project.id)}>
          <X />
          閉じる…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** グループの見出し。押すと畳む。畳んでいるときは中の「動いている」「あなたの番」を右に残す */
function GroupHeading({
  group,
  projects,
  dropActive,
  dropHandlers,
  onRename,
}: {
  group: ProjectGroup;
  projects: readonly MockProject[];
  dropActive: boolean;
  dropHandlers: DropHandlers;
  onRename: (group: ProjectGroup) => void;
}) {
  const running = projects.some((p) => projectRunning(p.id));
  const turn = projects.reduce((n, p) => n + yourTurnCount(p.id), 0);
  const groups = getGroups();
  const index = groups.findIndex((g) => g.id === group.id);
  return (
    <li
      className={cn(
        "group/heading relative mt-3 flex h-7 items-center rounded-md first:mt-0",
        dropActive && "bg-accent-soft",
      )}
      {...dropHandlers}
    >
      <button
        type="button"
        data-roving-item
        onClick={() => toggleGroupCollapsed(group.id)}
        aria-expanded={!group.collapsed}
        className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md pr-8 pl-2 text-left hover:bg-accent"
      >
        <span className={cn("size-2 shrink-0 rounded-full", GROUP_DOT_CLASS[group.color])} aria-hidden />
        <span className="truncate text-xs font-medium text-ink-2">{group.name}</span>
        <ChevronRight
          className={cn("size-3 shrink-0 text-ink-3 transition-transform", !group.collapsed && "rotate-90")}
          aria-hidden
        />
        {group.collapsed ? (
          <span className="ml-auto flex items-center gap-1.5">
            {running ? <LoaderCircle className="size-3.5 animate-spin text-ink-2" role="img" aria-label="AI が動いています" /> : null}
            {turn > 0 ? (
              <span
                className="flex h-4 min-w-4 items-center justify-center rounded-full bg-turn px-1 text-xs leading-none font-semibold text-on-color tabular-nums"
                aria-label={`あなたの番 ${turn} 件`}
              >
                {turn}
              </span>
            ) : null}
            <span className="text-xs text-ink-3 tabular-nums">{projects.length}</span>
          </span>
        ) : null}
      </button>
      <DropdownMenu>
        <MoreButton label={`グループ「${group.name}」の操作`} hoverGroup="heading" className="absolute right-1" />
        <DropdownMenuContent side="right" align="start" className="w-52">
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
              <DropdownMenuRadioGroup value={group.color} onValueChange={(v) => recolorGroup(group.id, v as GroupColor)}>
                {GROUP_COLORS.map((c) => (
                  <DropdownMenuRadioItem key={c.id} value={c.id}>
                    <span className={cn("size-2 shrink-0 rounded-full", GROUP_DOT_CLASS[c.id])} />
                    {c.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem disabled={index <= 0} onSelect={() => moveGroup(group.id, -1)}>
            <ArrowUp />
            グループを上へ
          </DropdownMenuItem>
          <DropdownMenuItem disabled={index >= groups.length - 1} onSelect={() => moveGroup(group.id, 1)}>
            <ArrowDown />
            グループを下へ
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={projects.length === 0}
            onSelect={() => sleepProjects(projects.map((p) => p.id))}
          >
            <Moon />
            中の Project を全部スリープに
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => removeGroup(group.id)}>
            <Trash2 />
            グループをなくす
          </DropdownMenuItem>
          <p className="px-1.5 pb-1 text-xs text-ink-3">中の Project は消えず、グループの外に出ます</p>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/** しばらく開いていない Project を寝かせる提案。静かに、スリープの見出しのすぐ上に出す */
function SleepSuggestion({ projects }: { projects: readonly MockProject[] }) {
  if (projects.length === 0) return null;
  const ids = projects.map((p) => p.id);
  return (
    <li className="mt-3 rounded-md border border-dashed border-border px-2.5 py-2">
      <p className="text-xs text-ink-2">
        {IDLE_DAYS_FOR_SUGGESTION}日以上開いていない Project が {projects.length} 件あります
      </p>
      <p className="mt-0.5 truncate text-xs text-ink-3">
        {projects.map((p) => `${p.name}（${idleDays(p.id)}日）`).join("、")}
      </p>
      <div className="mt-1.5 flex gap-1">
        <Button size="sm" variant="secondary" className="h-6 px-2 text-xs" onClick={() => sleepProjects(ids)}>
          <Moon className="size-3" />
          スリープにする
        </Button>
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs text-ink-3" onClick={() => dismissSleepSuggestions(ids)}>
          今はしない
        </Button>
      </div>
    </li>
  );
}

/** スリープ中の1行。薄く出し、押せば起こしてから開く */
function SleepingRow({
  project,
  onOpen,
  onNewGroup,
}: {
  project: MockProject;
  onOpen: (project: MockProject) => void;
  onNewGroup: (projectId: string) => void;
}) {
  const group = groupOf(project.id);
  return (
    <SidebarMenuItem className="group/project">
      <button
        type="button"
        data-roving-item
        onClick={() => onOpen(project)}
        title={`押すと起こして開きます（${sleptAt(project.id)}からスリープ）`}
        className="flex h-8 w-full items-center gap-2 rounded-md pr-8 pl-2 text-left text-sm text-ink-3 hover:bg-accent hover:text-foreground"
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border text-xs font-semibold">
          {project.initial}
        </span>
        <span className="min-w-0 flex-1 truncate">{project.name}</span>
        {group ? (
          <span className={cn("size-1.5 shrink-0 rounded-full opacity-60", GROUP_DOT_CLASS[group.color])} aria-label={`グループ ${group.name}`} />
        ) : null}
      </button>
      <DropdownMenu>
        <MoreButton label={`${project.name} の操作`} hoverGroup="project" className="absolute top-1.5 right-1" />
        <DropdownMenuContent side="right" align="start" className="w-56">
          <DropdownMenuLabel className="text-xs font-normal text-ink-3">{sleptAt(project.id)}からスリープ中</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => onOpen(project)}>
            <Sun />
            起こして開く
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => wakeProject(project.id)}>
            <Sun />
            起こすだけ（開かない）
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <FolderPlus />
              グループへ移す
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-56">
              <MoveToGroupItems project={project} onNewGroup={() => onNewGroup(project.id)} />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => closeProject(project.id)}>
            <X />
            閉じる…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

/** 一番下の「スリープ中」。畳んだ1行が既定 */
function SleepSection({
  projects,
  open,
  onToggle,
  dropActive,
  dropHandlers,
  children,
}: {
  projects: readonly MockProject[];
  open: boolean;
  onToggle: () => void;
  dropActive: boolean;
  dropHandlers: DropHandlers;
  children: ReactNode;
}) {
  const mode = getAutoSleep();
  return (
    <>
      <li
        className={cn("group/heading relative mt-3 flex h-7 items-center rounded-md", dropActive && "bg-accent-soft")}
        {...dropHandlers}
      >
        <button
          type="button"
          data-roving-item
          onClick={onToggle}
          aria-expanded={open}
          className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md pr-8 pl-2 text-left text-ink-3 hover:bg-accent hover:text-foreground"
        >
          <Moon className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate text-xs font-medium">スリープ中</span>
          <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} aria-hidden />
          <span className="ml-auto text-xs tabular-nums">{projects.length}</span>
        </button>
        <DropdownMenu>
          <MoreButton label="スリープの設定" hoverGroup="heading" className="absolute right-1" />
          <DropdownMenuContent side="right" align="end" className="w-64">
            <DropdownMenuLabel className="text-xs font-normal text-ink-3">
              {IDLE_DAYS_FOR_SUGGESTION}日開いていない Project を
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup value={mode} onValueChange={(v) => setAutoSleep(v as typeof mode)}>
              <DropdownMenuRadioItem value="suggest">スリープにするか聞く</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="auto">自動でスリープにする</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="off">何もしない</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <p className="px-1.5 py-1 text-xs text-ink-3">
              スリープ中はコンテナ・Module・Service を止めて資源を返します。会話はそのまま残ります。開いたとき・自動化の時刻が来たとき・メッセージなどが届いたときは自動で起きます
            </p>
          </DropdownMenuContent>
        </DropdownMenu>
      </li>
      {open ? children : null}
    </>
  );
}

type DropHandlers = Pick<HTMLLIElementProps, "onDragOver" | "onDragLeave" | "onDrop">;
type HTMLLIElementProps = HTMLAttributes<HTMLLIElement>;

/** 行の目印——ドラッグで落とした先。見出しなら「その最後へ」、行なら「その前へ」 */
type DropKey = string | null;

export function ProjectList({
  activeProjectId,
  activeForkThreadId,
  onOpenArchive,
  onNewProject,
  onNavigate,
}: {
  activeProjectId: string | null;
  activeForkThreadId: string | null;
  onOpenArchive: () => void;
  onNewProject: () => void;
  onNavigate?: () => void;
}) {
  useMockStoreVersion();
  const router = useRouter();
  const { containerRef, onKeyDown } = useRovingFocus<HTMLUListElement>();
  const [expandedOverride, setExpandedOverride] = useState<Record<string, boolean>>({});
  const [sleepOpen, setSleepOpen] = useState(false);
  const [dropKey, setDropKey] = useState<DropKey>(null);
  // 名前の小窓：新しいグループ（入れる Project があれば一緒に入れる）／グループの名前を変える
  const [nameDialog, setNameDialog] = useState<
    { kind: "new"; projectId?: string } | { kind: "rename"; group: ProjectGroup } | null
  >(null);

  const { ungrouped, groups, sleeping } = getSidebarSections();
  const suggestions = getSleepSuggestions();
  const allProjectIds = [...ungrouped, ...groups.flatMap((g) => g.projects)].map((p) => p.id);
  // 全部畳んでいるか：グループが全部畳まれ、開いている Thread の目次も無い（スリープ中も閉じている）
  const allCollapsed =
    groups.every(({ group }) => group.collapsed) &&
    !sleepOpen &&
    allProjectIds.every((id) => !(expandedOverride[id] ?? id === activeProjectId));

  function dragProps(project: MockProject, groupId: string | null): HTMLLIElementProps {
    const key = `row:${project.id}`;
    return {
      draggable: true,
      onDragStart: (e) => {
        e.dataTransfer.setData(DRAG_TYPE, project.id);
        e.dataTransfer.effectAllowed = "move";
      },
      onDragEnd: () => setDropKey(null),
      ...dropOn(key, (id) => placeProject(id, { groupId, beforeId: project.id })),
      className: cn(dropKey === key && "before:absolute before:inset-x-1 before:-top-px before:h-0.5 before:rounded-full before:bg-accent"),
    };
  }

  function dropOn(key: string, onDropped: (projectId: string) => void): DropHandlers {
    return {
      onDragOver: (e: DragEvent<HTMLLIElement>) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        e.stopPropagation();
        if (dropKey !== key) setDropKey(key);
      },
      onDragLeave: () => setDropKey((k) => (k === key ? null : k)),
      onDrop: (e: DragEvent<HTMLLIElement>) => {
        const id = e.dataTransfer.getData(DRAG_TYPE);
        setDropKey(null);
        if (!id) return;
        e.preventDefault();
        e.stopPropagation();
        onDropped(id);
      },
    };
  }

  function renderProject(project: MockProject, groupId: string | null) {
    const waking = isWaking(project.id);
    return (
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
        itemProps={dragProps(project, groupId)}
        rowMenu={({ hasChevron }) =>
          waking ? (
            <span className={cn("absolute top-2 flex items-center gap-1 text-xs text-ink-3", hasChevron ? "right-7" : "right-2")}>
              <LoaderCircle className="size-3 animate-spin" aria-hidden />
              起こしています
            </span>
          ) : (
            <ProjectRowMenu
              project={project}
              hasChevron={hasChevron}
              onNewGroup={(projectId) => setNameDialog({ kind: "new", projectId })}
              onOpenSettings={(projectId) => {
                onNavigate?.();
                router.push(`/settings?project=${projectId}`);
              }}
            />
          )
        }
      />
    );
  }

  function openSleeping(project: MockProject) {
    wakeProject(project.id);
    onNavigate?.();
    router.push(`/p/${project.id}`);
  }

  return (
    <SidebarGroup>
      {/* 「Project」の見出し。ここに落とすとグループの外へ出す */}
      <div
        className={cn(
          "group/heading flex h-8 shrink-0 items-center gap-0.5 rounded-md px-2 text-xs font-medium text-sidebar-foreground/70",
          dropKey === "ungrouped" && "bg-accent-soft",
        )}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
          e.preventDefault();
          setDropKey("ungrouped");
        }}
        onDragLeave={() => setDropKey((k) => (k === "ungrouped" ? null : k))}
        onDrop={(e) => {
          const id = e.dataTransfer.getData(DRAG_TYPE);
          setDropKey(null);
          if (id) placeProject(id, { groupId: null });
        }}
      >
        <span className="flex-1">Project</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={allCollapsed ? "すべて開く" : "すべて畳む"}
              onClick={() => {
                if (allCollapsed) {
                  setAllGroupsCollapsed(false);
                  setExpandedOverride({});
                } else {
                  // グループ・Project の Thread の目次・スリープ中を全部畳む
                  setAllGroupsCollapsed(true);
                  setExpandedOverride(Object.fromEntries(allProjectIds.map((id) => [id, false])));
                  setSleepOpen(false);
                }
              }}
              className="flex size-5 items-center justify-center rounded-md text-ink-3 hover:bg-accent hover:text-foreground"
            >
              {allCollapsed ? <ChevronsUpDown className="size-4" /> : <ChevronsDownUp className="size-4" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{allCollapsed ? "すべて開く" : "すべて畳む"}</TooltipContent>
        </Tooltip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Project・グループを足す"
              className="flex size-5 items-center justify-center rounded-md text-ink-3 hover:bg-accent hover:text-foreground"
            >
              <Plus className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start" className="w-48">
            <DropdownMenuItem
              onSelect={() => {
                onNavigate?.();
                onNewProject();
              }}
            >
              <Plus />
              新しい Project…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setNameDialog({ kind: "new" })}>
              <FolderPlus />
              新しいグループ…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <SidebarGroupContent>
        <SidebarMenu ref={containerRef} onKeyDown={onKeyDown}>
          {ungrouped.map((p) => renderProject(p, null))}

          {groups.map(({ group, projects }) => (
            <GroupSectionRows key={group.id}>
              <GroupHeading
                group={group}
                projects={projects}
                dropActive={dropKey === `group:${group.id}`}
                dropHandlers={dropOn(`group:${group.id}`, (id) => placeProject(id, { groupId: group.id }))}
                onRename={(g) => setNameDialog({ kind: "rename", group: g })}
              />
              {group.collapsed ? null : projects.length === 0 ? (
                <li className="py-1 pl-6 text-xs text-ink-3">Project をここへドラッグするか、行の「…」から入れます</li>
              ) : (
                projects.map((p) => renderProject(p, group.id))
              )}
            </GroupSectionRows>
          ))}

          <SleepSuggestion projects={suggestions} />

          {sleeping.length > 0 ? (
            <SleepSection
              projects={sleeping}
              open={sleepOpen}
              onToggle={() => setSleepOpen((v) => !v)}
              dropActive={dropKey === "sleep"}
              dropHandlers={dropOn("sleep", (id) => {
                if (!isSleeping(id)) sleepProject(id);
              })}
            >
              {sleeping.map((p) => (
                <SleepingRow
                  key={p.id}
                  project={p}
                  onOpen={openSleeping}
                  onNewGroup={(projectId) => setNameDialog({ kind: "new", projectId })}
                />
              ))}
            </SleepSection>
          ) : null}
        </SidebarMenu>
      </SidebarGroupContent>

      <NameDialog
        open={nameDialog !== null}
        title={nameDialog?.kind === "rename" ? "グループの名前を変える" : "新しいグループ"}
        description={
          nameDialog?.kind === "new"
            ? "サイドバーの見出しになります。例：開発・検証・くらし"
            : undefined
        }
        initial={nameDialog?.kind === "rename" ? nameDialog.group.name : ""}
        submitLabel={nameDialog?.kind === "rename" ? "変える" : "作る"}
        onOpenChange={(open) => {
          if (!open) setNameDialog(null);
        }}
        onSubmit={(name) => {
          if (!nameDialog) return;
          if (nameDialog.kind === "rename") renameGroup(nameDialog.group.id, name);
          else {
            const g = createGroup(name);
            if (nameDialog.projectId) placeProject(nameDialog.projectId, { groupId: g.id });
          }
        }}
      />
    </SidebarGroup>
  );
}

/** 見出しと行を同じ ul に並べる（グループごとに入れ子の ul を作らない——上下の矢印キーで続けて移れるように） */
function GroupSectionRows({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
