"use client";

// Backlog の一覧。マイルストーンごとに区切り（その中はファイルの中の順＝優先順）、最後に「マイルストーン無し」。
// ストーリーは開閉でき、子のタスクを下に字下げで並べる。子が絞り込みで見えていて親が見えていないときは、
// 子を区切りの直下に出して「どのストーリーの下か」を添える（親を見せるために条件を緩めない）。
//
// 並び順は行のメニューの「一つ上へ」「一つ下へ」（moveItem）。動かす相手は、いま見えている同じ段の隣
// ——見えていない項目をまたいで動かすと、何と入れ替わったかが分からないため。
import { useState } from "react";
import { ChevronDown, ChevronRight, CirclePlay, Ellipsis, Hourglass } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  childrenOf,
  isActionable,
  isClosed,
  moveItem,
  waitingOn,
  type BacklogFile,
  type BacklogItem,
} from "@/lib/mock/backlog";
import { KindMark, LabelChip, PriorityMark, StatusText } from "./backlog-parts";

export interface BacklogSection {
  id: string;
  title: string;
  rows: BacklogItem[];
}

/** 見えている項目から、区切りと段（ストーリーの下か、区切りの直下か）を組む */
export function buildSections(file: BacklogFile, shown: readonly BacklogItem[]): BacklogSection[] {
  const shownIds = new Set(shown.map((i) => i.id));
  const top = shown.filter((i) => i.parent === null || !shownIds.has(i.parent));
  const sections = [
    ...file.milestones.map((m) => ({ id: m.id, title: m.title, rows: top.filter((i) => i.milestone === m.id) })),
    {
      id: "none",
      title: "マイルストーン無し",
      rows: top.filter((i) => i.milestone === null || !file.milestones.some((m) => m.id === i.milestone)),
    },
  ];
  return sections.filter((s) => s.rows.length > 0);
}

export function BacklogList({
  projectId,
  file,
  sections,
  shown,
  selectedId,
  onSelect,
}: {
  projectId: string;
  file: BacklogFile;
  sections: readonly BacklogSection[];
  shown: readonly BacklogItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const shownIds = new Set(shown.map((i) => i.id));

  function toggle(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function renderRows(rows: readonly BacklogItem[], depth: 0 | 1) {
    return rows.map((item, index) => {
      const kids = item.kind === "story" ? childrenOf(item, file.items) : [];
      const shownKids = kids.filter((k) => shownIds.has(k.id));
      const open = !collapsed.has(item.id);
      return (
        <li key={item.id} data-testid="backlog-row-item" data-item-id={item.id}>
          <BacklogRow
            projectId={projectId}
            item={item}
            items={file.items}
            depth={depth}
            orphanOf={depth === 0 && item.parent ? file.items.find((i) => i.id === item.parent) : undefined}
            kids={kids}
            open={open}
            selected={selectedId === item.id}
            prev={rows[index - 1]}
            next={rows[index + 1]}
            onToggle={() => toggle(item.id)}
            onSelect={() => onSelect(item.id)}
          />
          {item.kind === "story" && open && shownKids.length > 0 ? (
            <ul className="ml-4 border-l border-border pl-3" aria-label={`「${item.title}」のタスク`}>
              {renderRows(shownKids, 1)}
            </ul>
          ) : null}
        </li>
      );
    });
  }

  return (
    <div className="flex flex-col gap-6">
      {sections.map((s) => (
        <section key={s.id} aria-labelledby={`backlog-section-${s.id}`} data-testid="backlog-section" data-section={s.id}>
          <h3
            id={`backlog-section-${s.id}`}
            className="mb-1 flex items-baseline gap-2 border-b border-border pb-1.5 text-md font-semibold text-foreground"
          >
            {s.title}
            <span className="text-xs font-normal text-ink-3 tabular-nums">{s.rows.length} 件</span>
          </h3>
          <ul className="flex flex-col">{renderRows(s.rows, 0)}</ul>
        </section>
      ))}
    </div>
  );
}

function BacklogRow({
  projectId,
  item,
  items,
  depth,
  orphanOf,
  kids,
  open,
  selected,
  prev,
  next,
  onToggle,
  onSelect,
}: {
  projectId: string;
  item: BacklogItem;
  items: readonly BacklogItem[];
  depth: 0 | 1;
  orphanOf: BacklogItem | undefined;
  kids: readonly BacklogItem[];
  open: boolean;
  selected: boolean;
  prev: BacklogItem | undefined;
  next: BacklogItem | undefined;
  onToggle: () => void;
  onSelect: () => void;
}) {
  const waiting = isClosed(item) ? [] : waitingOn(item, items);
  const actionable = isActionable(item, items);
  // 進み具合は「終わった／やめていないもの」——やめたタスクは分母からも外す（終わった数に混ぜると進んで見える）
  const countedKids = kids.filter((k) => k.status !== "dropped");
  const doneKids = countedKids.filter((k) => k.status === "done").length;
  const closed = isClosed(item);

  return (
    <div
      data-testid="backlog-row"
      data-selected={selected || undefined}
      className={cn(
        "group flex items-start gap-1 rounded-md py-1.5 pr-1 pl-0.5 hover:bg-surface-2",
        selected && "bg-surface-2",
      )}
    >
      {item.kind === "story" && kids.length > 0 ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={open ? `「${item.title}」のタスクを畳む` : `「${item.title}」のタスクを開く`}
          className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm text-ink-3 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
      ) : (
        <span className="size-5 shrink-0" aria-hidden />
      )}
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected || undefined}
        data-testid="backlog-row-open"
        className="flex min-w-0 flex-1 items-start gap-2 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-ring"
      >
        <KindMark kind={item.kind} className="mt-1" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            data-testid="backlog-row-title"
            className={cn(
              "text-sm",
              closed ? "text-ink-3" : "text-foreground",
              item.kind === "story" && depth === 0 && "font-medium",
            )}
          >
            {item.title}
          </span>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <StatusText status={item.status} />
            {item.status === "dropped" && item.resolution ? (
              <span className="truncate text-xs text-ink-3">{item.resolution}</span>
            ) : null}
            {actionable ? (
              <span data-testid="backlog-actionable" className="inline-flex items-center gap-1 text-xs font-medium text-ok">
                <CirclePlay className="size-3" />
                着手できる
              </span>
            ) : null}
            {waiting.length > 0 ? (
              <span data-testid="backlog-waiting" className="inline-flex items-center gap-1 text-xs text-ink-2">
                <Hourglass className="size-3 text-warn" />
                待ち {waiting.length} 件
              </span>
            ) : null}
            {closed ? null : <PriorityMark priority={item.priority} />}
            {countedKids.length > 0 ? (
              <span data-testid="backlog-progress" className="text-xs text-ink-3 tabular-nums">
                タスク {doneKids}／{countedKids.length} 終わった
              </span>
            ) : null}
            {orphanOf ? <span className="truncate text-xs text-ink-3">「{orphanOf.title}」の下</span> : null}
            {item.labels.length > 0 ? (
              <span className="flex flex-wrap gap-1">
                {item.labels.map((l) => (
                  <LabelChip key={l}>{l}</LabelChip>
                ))}
              </span>
            ) : null}
          </span>
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          data-testid="backlog-row-menu"
          aria-label={`「${item.title}」の操作`}
          className="flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-3 opacity-60 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring data-[state=open]:opacity-100"
        >
          <Ellipsis className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={!prev} onSelect={() => prev && moveItem(projectId, item.id, prev.id, "before")}>
            一つ上へ
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!next} onSelect={() => next && moveItem(projectId, item.id, next.id, "after")}>
            一つ下へ
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
