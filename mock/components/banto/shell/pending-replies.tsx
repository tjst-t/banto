"use client";

// **返事待ちの印**（モック・2026-10-03）。サイドバーの Thread の行と、いま開いていない Project の行に出す。
// 「AI が動いている」（行のアイコンが回る）とは別のことなので、別の場所に置く——片方がもう片方を隠さない。
// 置き場所は3案を切り替えて見比べる（`PendingDemoSwitcher`）。
import type { ComponentType, ReactNode } from "react";
import { Hourglass, LoaderCircle } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  getPendingReplies,
  isThreadRunning,
  PLACEMENT_LABELS,
  setPendingDemo,
  usePendingDemo,
  type PendingPlacement,
  type PendingReply,
} from "@/lib/mock/background-work";
import { cn } from "@/lib/utils";

/** 行のアイコン。その Thread で AI が動いている間だけ回る輪に替える（本物の §6.33 と同じ） */
export function ThreadRowIcon({ icon: Icon, threadId }: { icon: ComponentType<{ className?: string }>; threadId: string }) {
  // 大きさは自分で持つ——角の印で包むと、行の `[&>svg]:size-4` が届かなくなる
  if (!isThreadRunning(threadId)) return <Icon className="size-4 shrink-0" />;
  return <LoaderCircle className="size-4 shrink-0 animate-spin" role="img" aria-label="AI が動いています" />;
}

export interface PendingGroup {
  threadTitle: string;
  replies: readonly PendingReply[];
}

/** Thread の束から、返事待ちを Thread ごとに集める（空の Thread は落とす） */
export function collectPending(threads: ReadonlyArray<{ id: string; title: string }>): PendingGroup[] {
  return threads
    .map((t) => ({ threadTitle: t.title, replies: getPendingReplies(t.id) }))
    .filter((g) => g.replies.length > 0);
}

function countOf(groups: readonly PendingGroup[]): number {
  return groups.reduce((n, g) => n + g.replies.length, 0);
}

/** 待っているものの一覧（押したとき・角の印では指を載せたときに出す） */
function PendingList({ groups, showThread }: { groups: readonly PendingGroup[]; showThread: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="px-2 pt-1 text-xs font-medium text-ink-3">返事待ち（{countOf(groups)}）</p>
      {groups.map((g) => (
        <div key={g.threadTitle} className="flex flex-col">
          {showThread ? <p className="truncate px-2 pt-1 text-xs text-ink-3">{g.threadTitle}</p> : null}
          {g.replies.map((r) => (
            <div key={r.id} className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 hover:bg-accent">
              <span className="truncate text-sm text-foreground">{r.title}</span>
              <span className="line-clamp-2 text-xs text-ink-2">{r.description}</span>
              <span className="text-xs text-ink-3">
                {r.moduleTitle}・{r.minutesAgo}分前に頼んだ
              </span>
            </div>
          ))}
        </div>
      ))}
      <p className="border-t border-border px-2 pt-1.5 pb-1 text-xs text-ink-3">
        押すと、その Module の画面でその仕事を開く（モックでは開かない）
      </p>
    </div>
  );
}

function label(count: number, scope: string): string {
  return `${scope}で返事を待っているもの（${count}件）を見る`;
}

/**
 * 「右端」と「名前の下」の印。行の Link の**外**に置く（押せるものを入れ子にしない）。
 * `rightOffset`：行の右端にほかの押せるもの（畳む・目次の開閉）があるとき、その分だけ左へずらす
 */
export function PendingMarker({
  groups,
  scope,
  showThread,
  placement,
  className,
}: {
  groups: readonly PendingGroup[];
  scope: string;
  showThread: boolean;
  placement: Exclude<PendingPlacement, "corner">;
  className?: string;
}) {
  const count = countOf(groups);
  if (count === 0) return null;
  const trigger =
    placement === "right" ? (
      <button
        type="button"
        aria-label={label(count, scope)}
        data-testid="pending-marker"
        className={cn(
          "absolute flex h-5 items-center gap-0.5 rounded-md px-1 text-xs text-ink-2 tabular-nums hover:bg-accent hover:text-foreground",
          className,
        )}
      >
        <Hourglass className="size-3" />
        {count}
      </button>
    ) : (
      <button
        type="button"
        aria-label={label(count, scope)}
        data-testid="pending-marker"
        className={cn(
          "flex w-full items-center gap-1 truncate rounded-md py-0.5 text-left text-xs text-ink-3 hover:bg-accent hover:text-foreground",
          className,
        )}
      >
        <Hourglass className="size-3 shrink-0" />
        <span className="truncate">
          {count === 1 ? groups[0]!.replies[0]!.title : `${groups[0]!.replies[0]!.title} ほか ${count - 1} 件`}
        </span>
      </button>
    );
  return (
    <Popover>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent side="right" align="start" className="w-72 p-1.5">
        <PendingList groups={groups} showThread={showThread} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * 「アイコンの角」の印。行のアイコンに重ねる小さな数。行の中（Link の中）にあるので押せるものにはせず、
 * 一覧は指を載せたときに出す
 */
export function PendingCorner({
  groups,
  scope,
  showThread,
  children,
}: {
  groups: readonly PendingGroup[];
  scope: string;
  showThread: boolean;
  children: ReactNode;
}) {
  const count = countOf(groups);
  if (count === 0) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="relative inline-flex shrink-0" aria-label={label(count, scope)} data-testid="pending-marker">
          {children}
          <span className="absolute -right-1.5 -bottom-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-ink-2 px-0.5 text-xs leading-none font-semibold text-on-color tabular-nums ring-2 ring-sidebar">
            {count}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" className="w-72 bg-popover p-1.5 text-popover-foreground shadow-md">
        <PendingList groups={groups} showThread={showThread} />
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * 畳んだレールの印。頭文字の右下に重ねる小さな数（右上は Fork の一覧の印が使っている）。
 * レールでは Thread の行が見えないので、いま開いている Project の分も出す
 */
export function PendingRailBadge({ groups, scope }: { groups: readonly PendingGroup[]; scope: string }) {
  const count = countOf(groups);
  if (count === 0) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label(count, scope)}
          data-testid="pending-marker"
          className="absolute -right-0.5 -bottom-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-ink-2 px-0.5 text-xs leading-none font-semibold text-on-color tabular-nums ring-2 ring-sidebar hover:brightness-110"
        >
          {count}
        </button>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" className="w-72 p-1.5">
        <PendingList groups={groups} showThread />
      </PopoverContent>
    </Popover>
  );
}

/** 見比べるための切り替え（モックだけ）。画面の右下に置く */
export function PendingDemoSwitcher() {
  const demo = usePendingDemo();
  return (
    <div className="fixed right-3 bottom-3 z-50 flex flex-col gap-1.5 rounded-lg border border-border bg-popover p-2 text-xs text-ink-2 shadow-md">
      <span className="font-medium text-ink-3">返事待ちの印（見本の切り替え）</span>
      <div className="flex gap-1">
        {(Object.keys(PLACEMENT_LABELS) as PendingPlacement[]).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPendingDemo({ placement: p })}
            aria-pressed={demo.placement === p}
            className={cn(
              "rounded-md px-2 py-1 hover:bg-accent",
              demo.placement === p && "bg-accent-soft text-accent-ink",
            )}
          >
            {PLACEMENT_LABELS[p]}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-1.5">
        <input type="checkbox" checked={demo.inRail} onChange={(e) => setPendingDemo({ inRail: e.target.checked })} />
        畳んだレールにも出す
      </label>
    </div>
  );
}
