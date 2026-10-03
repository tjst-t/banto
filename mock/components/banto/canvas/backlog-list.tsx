"use client";

// Backlog の一覧。1項目1行（Linear の行と同じく、左から 順番の印・題・右寄せの最小限の印）。
// 行に出すのは「次に動くか」を決めるものだけ：待っている相手の名前・優先・ストーリーの進み。
// ラベル・マイルストーン・完了条件などは詳細で見る（行を押す／Enter）。
//
// 並べ替えはドラッグ（Jira の Rank・Linear の手動の順と同じ）と、行のメニューの「一つ上へ／一つ下へ」。
// 動かせるのは同じ段の中だけ（区切りの直下どうし・同じストーリーの子どうし）——段をまたぐと、
// 何と入れ替わったかが分からないため。
import { useState, type DragEvent, type ReactNode } from "react";
import { ChevronRight, Ellipsis, GripVertical, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  isClosed,
  moveItem,
  updateItem,
  waitingOn,
  type BacklogItem,
  type BacklogStatus,
} from "@/lib/mock/backlog";
import {
  BugTag,
  PriorityMark,
  ItemMark,
  RankMark,
  STATUS_LABEL,
  rankState,
} from "./backlog-parts";
import { InlineComposer } from "./backlog-forms";

export interface ListNode {
  item: BacklogItem;
  /** ストーリーの子（終わっていないもの） */
  children?: ListNode[];
  /** ストーリーの子のうち閉じたもの。「終わった n 件」で畳んでおく */
  closedKids?: BacklogItem[];
  /** 題の頭に薄く付けるストーリー名（「次にやる」など、ストーリーの下に並んでいないとき） */
  story?: string;
  /** 行の右に薄く添える文脈（「次にやる」でどのストーリーの下か、など） */
  context?: string;
  /** 閉じたものの一覧で、やめた理由などを添える */
  note?: string;
}

export interface ListGroup {
  id: string;
  title: string;
  /** 区切りの見出しの右に添える1行 */
  hint?: string;
  nodes: ListNode[];
  /** この区切りの末尾に「足す」を出す（足すときのマイルストーン） */
  composerMilestone?: string | null;
  /** 並べ替えできるか（閉じたものの一覧はできない） */
  sortable: boolean;
}

/** キーボードで動くときの順（畳んだストーリーの子は飛ばす） */
export function flattenIds(
  groups: readonly ListGroup[],
  collapsed: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  const walk = (nodes: readonly ListNode[]) => {
    for (const node of nodes) {
      out.push(node.item.id);
      if (node.children && !collapsed.has(node.item.id)) walk(node.children);
    }
  };
  for (const g of groups) walk(g.nodes);
  return out;
}

type DropAt = { id: string; where: "before" | "after" } | null;

export function BacklogList({
  projectId,
  groups,
  items,
  selectedId,
  collapsed,
  onToggle,
  onSelect,
  onOpen,
}: {
  projectId: string;
  groups: readonly ListGroup[];
  items: readonly BacklogItem[];
  selectedId: string | null;
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<DropAt>(null);
  const [composerAt, setComposerAt] = useState<string | null>(null);
  const [shownClosed, setShownClosed] = useState<ReadonlySet<string>>(
    new Set(),
  );

  function renderNodes(
    nodes: readonly ListNode[],
    group: ListGroup,
    depth: 0 | 1,
  ): ReactNode {
    const siblingIds = nodes.map((n) => n.item.id);
    return nodes.map((node, index) => {
      const { item } = node;
      const isStory = item.kind === "story";
      const open = !collapsed.has(item.id);
      const hasKids =
        (node.children?.length ?? 0) > 0 || (node.closedKids?.length ?? 0) > 0;
      const kidsAll = [
        ...(node.children?.map((c) => c.item) ?? []),
        ...(node.closedKids ?? []),
      ];
      return (
        <li key={item.id} data-testid="backlog-row-item" data-item-id={item.id}>
          <Row
            projectId={projectId}
            node={node}
            items={items}
            depth={depth}
            selected={selectedId === item.id}
            open={open}
            hasKids={hasKids}
            kids={kidsAll}
            sortable={group.sortable}
            prevId={siblingIds[index - 1]}
            nextId={siblingIds[index + 1]}
            dragging={dragId === item.id}
            dropWhere={dropAt?.id === item.id ? dropAt.where : null}
            onToggle={() => onToggle(item.id)}
            onSelect={() => onSelect(item.id)}
            onOpen={() => onOpen(item.id)}
            onAddChild={
              isStory ? () => setComposerAt(`story:${item.id}`) : undefined
            }
            onDragStart={() => setDragId(item.id)}
            onDragEnd={() => {
              setDragId(null);
              setDropAt(null);
            }}
            onDragOverRow={(where) => {
              if (dragId && dragId !== item.id && siblingIds.includes(dragId))
                setDropAt({ id: item.id, where });
            }}
            onDropRow={() => {
              if (dragId && dropAt && siblingIds.includes(dragId))
                moveItem(projectId, dragId, dropAt.id, dropAt.where);
              setDragId(null);
              setDropAt(null);
            }}
          />
          {isStory && open && hasKids ? (
            <div className="relative ml-[1.1875rem] border-l border-border pl-2.5">
              {node.children && node.children.length > 0 ? (
                <ul aria-label={`「${item.title}」のタスク`}>
                  {renderNodes(node.children, group, 1)}
                </ul>
              ) : null}
              {node.closedKids && node.closedKids.length > 0 ? (
                <ClosedKids
                  kids={node.closedKids}
                  items={items}
                  shown={shownClosed.has(item.id)}
                  onShow={() =>
                    setShownClosed((prev) => new Set(prev).add(item.id))
                  }
                  selectedId={selectedId}
                  onOpen={onOpen}
                />
              ) : null}
              {composerAt === `story:${item.id}` ? (
                <InlineComposer
                  projectId={projectId}
                  milestone={item.milestone}
                  parent={item}
                  onClose={() => setComposerAt(null)}
                />
              ) : null}
            </div>
          ) : null}
          {isStory && open && !hasKids && composerAt === `story:${item.id}` ? (
            <div className="ml-[1.1875rem] border-l border-border pl-2.5">
              <InlineComposer
                projectId={projectId}
                milestone={item.milestone}
                parent={item}
                onClose={() => setComposerAt(null)}
              />
            </div>
          ) : null}
        </li>
      );
    });
  }

  return (
    <div className="flex flex-col gap-7" data-testid="backlog-list">
      {groups.map((g) => (
        <section
          key={g.id}
          aria-labelledby={`backlog-group-${g.id}`}
          data-testid="backlog-section"
          data-section={g.id}
        >
          <h3
            id={`backlog-group-${g.id}`}
            className="sticky top-0 z-10 -mx-2 mb-1 flex items-baseline gap-2 bg-card px-2 py-1.5 text-sm font-semibold whitespace-nowrap text-ink-2"
          >
            {g.title}
            <span className="font-normal text-ink-3 tabular-nums">
              {g.nodes.length}
            </span>
            {g.hint ? (
              <span className="ml-auto truncate text-xs font-normal text-ink-3">
                {g.hint}
              </span>
            ) : null}
          </h3>
          {g.nodes.length > 0 ? (
            <ul className="flex flex-col">{renderNodes(g.nodes, g, 0)}</ul>
          ) : null}
          {g.composerMilestone !== undefined ? (
            composerAt === `group:${g.id}` ? (
              <InlineComposer
                projectId={projectId}
                milestone={g.composerMilestone}
                onClose={() => setComposerAt(null)}
              />
            ) : (
              <button
                type="button"
                onClick={() => setComposerAt(`group:${g.id}`)}
                data-testid="backlog-group-add"
                className="mt-0.5 flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-md text-ink-3 hover:bg-surface-2 hover:text-ink-2 focus-visible:outline-2 focus-visible:outline-ring"
              >
                <Plus className="size-3.5" />
                足す
              </button>
            )
          ) : null}
        </section>
      ))}
    </div>
  );
}

function ClosedKids({
  kids,
  items,
  shown,
  onShow,
  selectedId,
  onOpen,
}: {
  kids: readonly BacklogItem[];
  items: readonly BacklogItem[];
  shown: boolean;
  onShow: () => void;
  selectedId: string | null;
  onOpen: (id: string) => void;
}) {
  if (!shown) {
    return (
      <button
        type="button"
        onClick={onShow}
        data-testid="backlog-closed-kids"
        className="flex h-7 items-center gap-2 rounded-md px-2 text-xs text-ink-3 hover:text-ink-2 focus-visible:outline-2 focus-visible:outline-ring"
      >
        <RankMark state="done" small />
        閉じたタスク {kids.length} 件を出す
      </button>
    );
  }
  return (
    <ul aria-label="閉じたタスク">
      {kids.map((k) => (
        <li key={k.id} data-testid="backlog-row-item" data-item-id={k.id}>
          <button
            type="button"
            onClick={() => onOpen(k.id)}
            data-selected={selectedId === k.id || undefined}
            className={cn(
              "flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring",
              selectedId === k.id && "bg-surface-2",
            )}
          >
            <RankMark state={rankState(k, items)} small />
            <span className="min-w-0 flex-1 truncate text-md text-ink-3">
              {k.title}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Row({
  projectId,
  node,
  items,
  depth,
  selected,
  open,
  hasKids,
  kids,
  sortable,
  prevId,
  nextId,
  dragging,
  dropWhere,
  onToggle,
  onSelect,
  onOpen,
  onAddChild,
  onDragStart,
  onDragEnd,
  onDragOverRow,
  onDropRow,
}: {
  projectId: string;
  node: ListNode;
  items: readonly BacklogItem[];
  depth: 0 | 1;
  selected: boolean;
  open: boolean;
  hasKids: boolean;
  kids: readonly BacklogItem[];
  sortable: boolean;
  prevId: string | undefined;
  nextId: string | undefined;
  dragging: boolean;
  dropWhere: "before" | "after" | null;
  onToggle: () => void;
  onSelect: () => void;
  onOpen: () => void;
  onAddChild?: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverRow: (where: "before" | "after") => void;
  onDropRow: () => void;
}) {
  const { item } = node;
  const state = rankState(item, items);
  const waiting = isClosed(item) ? [] : waitingOn(item, items);
  const isStory = item.kind === "story";
  const closed = isClosed(item);

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    if (!sortable) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    onDragOverRow(e.clientY < rect.top + rect.height / 2 ? "before" : "after");
  }

  return (
    <div
      data-testid="backlog-row"
      data-selected={selected || undefined}
      data-state={state}
      draggable={sortable}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", item.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={(e) => {
        e.preventDefault();
        onDropRow();
      }}
      className={cn(
        "group relative flex h-9 items-center gap-2 rounded-md pr-1 pl-0.5",
        "hover:bg-surface-2",
        selected && "bg-surface-2",
        dragging && "opacity-40",
      )}
    >
      {dropWhere ? (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute right-1 left-1 h-0.5 rounded-sm bg-ring",
            dropWhere === "before" ? "-top-px" : "-bottom-px",
          )}
        />
      ) : null}
      {sortable ? (
        <GripVertical
          aria-hidden
          className="absolute top-1/2 -left-4 size-3.5 -translate-y-1/2 cursor-grab text-ink-3 opacity-0 group-hover:opacity-100"
        />
      ) : null}
      {isStory && hasKids ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={
            open
              ? `「${item.title}」のタスクを畳む`
              : `「${item.title}」のタスクを開く`
          }
          className="flex size-4 shrink-0 items-center justify-center rounded-sm text-ink-3 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <ChevronRight
            className={cn(
              "size-3.5 transition-transform motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
        </button>
      ) : (
        <span className="w-4 shrink-0" aria-hidden />
      )}
      <button
        type="button"
        onClick={() => {
          onSelect();
          onOpen();
        }}
        aria-current={selected || undefined}
        data-testid="backlog-row-open"
        className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-ring"
      >
        <ItemMark item={item} items={items} small={depth === 1} />
        {item.kind === "bug" ? <BugTag /> : null}
        {node.story ? (
          <span
            data-testid="backlog-row-story"
            title={node.story}
            className="max-w-1/3 shrink-0 truncate text-md text-ink-3"
          >
            {node.story}
          </span>
        ) : null}
        {node.story ? (
          <span aria-hidden className="-mx-1 shrink-0 text-md text-ink-3">
            ／
          </span>
        ) : null}
        <span
          data-testid="backlog-row-title"
          className={cn(
            "min-w-0 truncate",
            isStory && depth === 0 ? "text-lg" : "text-md",
            closed
              ? "text-ink-3"
              : state === "waiting" || state === "backlog"
                ? "text-ink-2"
                : "text-foreground",
            isStory && "font-semibold text-foreground",
          )}
        >
          {item.title}
        </span>
        {waiting.length > 0 ? (
          <span
            data-testid="backlog-waiting"
            title={waiting.map((w) => w.title).join("\n")}
            className="max-w-40 min-w-0 shrink-[4] truncate text-xs text-ink-3"
          >
            {waiting.length === 1
              ? `待ち：${waiting[0].title}`
              : `待ち：${waiting.length} 件`}
          </span>
        ) : null}
        {node.note ? (
          <span className="min-w-0 shrink truncate text-xs text-ink-3">
            {node.note}
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-3 pl-2">
          {closed ? null : <PriorityMark priority={item.priority} />}
          {node.context ? (
            <span className="hidden max-w-48 truncate text-xs text-ink-3 @lg:inline">
              {node.context}
            </span>
          ) : null}
          {isStory ? <StoryCount kids={kids} /> : null}
        </span>
      </button>
      <RowMenu
        projectId={projectId}
        item={item}
        prevId={sortable ? prevId : undefined}
        nextId={sortable ? nextId : undefined}
        onAddChild={onAddChild}
      />
    </div>
  );
}

const MENU_STATUSES: readonly BacklogStatus[] = [
  "backlog",
  "ready",
  "in-progress",
  "done",
];

function RowMenu({
  projectId,
  item,
  prevId,
  nextId,
  onAddChild,
}: {
  projectId: string;
  item: BacklogItem;
  prevId: string | undefined;
  nextId: string | undefined;
  onAddChild?: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="backlog-row-menu"
        aria-label={`「${item.title}」の操作`}
        className="flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-3 opacity-0 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring data-[state=open]:opacity-100"
      >
        <Ellipsis className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="text-md">
            状態を変える
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {MENU_STATUSES.map((s) => (
              <DropdownMenuItem
                key={s}
                disabled={item.status === s}
                onSelect={() => updateItem(projectId, item.id, { status: s })}
                className="text-md"
              >
                {STATUS_LABEL[s]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem
          onSelect={() =>
            updateItem(projectId, item.id, {
              priority: item.priority === "high" ? "normal" : "high",
            })
          }
          className="text-md"
        >
          {item.priority === "high" ? "優先を外す" : "優先にする"}
        </DropdownMenuItem>
        {onAddChild ? (
          <DropdownMenuItem onSelect={onAddChild} className="text-md">
            タスクを足す
          </DropdownMenuItem>
        ) : null}
        {prevId || nextId ? <DropdownMenuSeparator /> : null}
        {prevId || nextId ? (
          <>
            <DropdownMenuItem
              disabled={!prevId}
              onSelect={() =>
                prevId && moveItem(projectId, item.id, prevId, "before")
              }
              className="text-md"
            >
              一つ上へ
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!nextId}
              onSelect={() =>
                nextId && moveItem(projectId, item.id, nextId, "after")
              }
              className="text-md"
            >
              一つ下へ
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** ストーリーの行の右に「終わった数/全部」。やめた子は数えない（印の円グラフと同じ数え方） */
function StoryCount({ kids }: { kids: readonly BacklogItem[] }) {
  const counted = kids.filter((k) => k.status !== "dropped");
  if (counted.length === 0) return null;
  const done = counted.filter((k) => k.status === "done").length;
  return (
    <span
      data-testid="backlog-progress"
      className="text-xs text-ink-3 tabular-nums"
    >
      {done}/{counted.length}
    </span>
  );
}
