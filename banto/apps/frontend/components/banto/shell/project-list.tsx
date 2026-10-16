"use client";

// **サイドバーの Project 一覧——グループ**（決定・2026-10-16、v4-frontend.md §6.43。見本はモック `fork/project-org` の
// `mock/components/banto/shell/project-list.tsx`）。
//
// 並びは上から：
//   1. グループに入っていない Project（見出し無し）
//   2. グループ——見出し（色の点＋名前。押すと畳む。畳んでも中の「動いている」「あなたの番」と数は見出しに残す）の下に、
//      その中の Project（12px 下げる）
//
// 操作はどれもサイドバーの中だけで済む：行の「…」の「グループへ移す」・見出しの「…」・ドラッグ（行の上＝その前、
// 見出し＝そのグループの最後、「Project」の見出し＝グループの外）・「Project」の見出しの「すべて畳む」と「＋」。
// 記録は host（グループ・入れ先・並び）、畳んだかはこの端末（`lib/backend/project-groups.ts`）。
//
// スリープ（§6.43 の後半）はまだ繋がっていないので出さない（規則13）。
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  FolderPlus,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import { useRovingFocus } from "@/hooks/use-roving-focus";
import { getActiveProjects, placeProject } from "@/lib/mock/projects";
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
  projectSections,
  removeProjectGroup,
  setGroupCollapsed,
  setGroupsCollapsed,
  updateProjectGroup,
  useCollapsedGroups,
  useProjectGroups,
  type ProjectGroup,
  type ProjectGroupColor,
} from "@/lib/backend/project-groups";
import { ProjectTreeItem } from "./nav-panel";
import { RenameDialog } from "./rename-dialog";
import { DropList, useDropZone } from "./sortable-list";
import type { GroupMenu } from "./sidebar-item-menu";

/** 落とす先の id。行は `row:<Project の id>`（`ProjectTreeItem`） */
const DROP_UNGROUPED = "ungrouped";
const dropGroup = (id: string) => `group:${id}`;

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

/** グループの見出し。押すと畳む／開く */
function GroupHeading({
  group,
  projects,
  collapsed,
  index,
  groupCount,
  onRename,
}: {
  group: ProjectGroup;
  projects: readonly MockProject[];
  collapsed: boolean;
  index: number;
  groupCount: number;
  onRename: (group: ProjectGroup) => void;
}) {
  const { setNodeRef: setDropRef, isOver: dropOver } = useDropZone(dropGroup(group.id));
  const running = useAnyProjectRunning(projects.map((p) => p.id));
  useRealInboxVersion();
  const turn = getRealTurnCountForThreads(
    new Set(projects.flatMap((p) => [p.baseThreadId, ...getThreadsForProject(p.id).map((t) => t.id)])),
  );
  const toggle = () => setGroupCollapsed(group.id, !collapsed);
  return (
    <li
      ref={setDropRef}
      data-testid="sidebar-group"
      data-group-id={group.id}
      data-collapsed={collapsed ? "" : undefined}
      data-drop-over={dropOver ? "" : undefined}
      className={cn("group/heading relative flex h-8 items-center rounded-md", dropOver && "bg-accent-soft")}
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
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
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
  const sections = projectSections(getActiveProjects(), groups);
  const allProjects = sections.flatMap((s) => s.projects);
  const isExpanded = (id: string) => expandedOverride[id] ?? id === activeProjectId;
  // 全部畳んでいるか：グループが全部畳まれ、見えている Thread の目次も1つも開いていない（畳んだグループの中の目次は見えない
  // ——リロードすると、いま開いている Project の目次は既定で開くので、それを数えると畳んだのに「すべて畳む」のままになる）
  const visibleProjects = sections.flatMap((s) => (s.group && collapsedGroups.has(s.group.id) ? [] : s.projects));
  const allCollapsed = groups.every((g) => collapsedGroups.has(g.id)) && visibleProjects.every((p) => !isExpanded(p.id));

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

  /** 落とした1回だけ書く（§6.11）。行の上＝その前、見出し＝そのグループの最後、「Project」の見出し＝グループの外 */
  function onDrop(projectId: string, overId: string) {
    if (overId.startsWith("row:")) {
      const beforeId = overId.slice("row:".length);
      const section = sections.find((s) => s.projects.some((p) => p.id === beforeId));
      if (section) place(projectId, { groupId: section.group?.id ?? null, beforeId });
    } else if (overId.startsWith("group:")) {
      place(projectId, { groupId: overId.slice("group:".length) });
    } else if (overId === DROP_UNGROUPED) {
      place(projectId, { groupId: null });
    }
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
                  />
                  {collapsedGroups.has(group.id) ? null : projects.length === 0 ? (
                    <li data-testid="sidebar-group-empty" className="py-1 pr-2 pl-11 text-xs text-ink-3">
                      Project をここへドラッグするか、行の「…」から入れます
                    </li>
                  ) : (
                    projects.map((p) => renderProject(p, projects, group.id))
                  )}
                </SectionRows>
              ),
            )}
          </SidebarMenu>
        </SidebarGroupContent>
      </DropList>
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
