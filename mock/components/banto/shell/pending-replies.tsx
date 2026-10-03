"use client";

// **バックグラウンドの印**（モック・2026-10-03、ユーザー決定）。AI が「終わったら届ける」tool で頼み、まだ
// 届いていないもの。「AI が動いている」（行のアイコンが回る）とは別のことなので、別の場所に置く。
// - Thread の行：名前の下に薄い1行（1件ならカードの題、2件以上なら「バックグラウンドで n 件」）
// - いま開いていない Project の行：頭文字の右下に数
// - 畳んだレール：出さない（レールの作りを見直すまで）
// 文言は「〜待ち」にしない——banto では「判断待ち」「レビュー待ち」が人の番を指すので、人が返事する番に読める。
import { useState, type ComponentType } from "react";
import { Hourglass, LoaderCircle } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { getPendingReplies, isThreadRunning, type PendingReply } from "@/lib/mock/background-work";
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
      <p className="px-2 pt-1 text-xs font-medium text-ink-3">バックグラウンドで動いているもの（{countOf(groups)}）</p>
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
  return `${scope}のバックグラウンドで動いているもの（${count}件）を見る`;
}

/** Thread の行の名前の下の1行。行の Link の**外**に置く（押せるものを入れ子にしない） */
export function PendingSubline({
  groups,
  scope,
  className,
}: {
  groups: readonly PendingGroup[];
  scope: string;
  className?: string;
}) {
  const count = countOf(groups);
  if (count === 0) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
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
          <span className="truncate">{count === 1 ? groups[0]!.replies[0]!.title : `バックグラウンドで ${count} 件`}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" className="w-72 p-1.5">
        <PendingList groups={groups} showThread={false} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * いま開いていない Project の行の、頭文字の右下の数。行の Link の外に、頭文字に重ねて置く。
 * 一覧は Thread ごとに分けて出す
 */
export function PendingProjectBadge({ groups, scope }: { groups: readonly PendingGroup[]; scope: string }) {
  // 一覧は行の右端の外に開く——数の右に開くとサイドバーの上に重なる。開くときに行の右端までの距離を測る
  const [offset, setOffset] = useState(8);
  const count = countOf(groups);
  if (count === 0) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label(count, scope)}
          data-testid="pending-marker"
          onPointerDown={(e) => {
            const row = e.currentTarget.closest("li");
            if (row) setOffset(row.getBoundingClientRect().right - e.currentTarget.getBoundingClientRect().right + 8);
          }}
          className="absolute top-4.5 left-6 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-ink-2 px-0.5 text-xs leading-none font-semibold text-on-color tabular-nums ring-2 ring-sidebar hover:brightness-110"
        >
          {count}
        </button>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" sideOffset={offset} className="w-72 p-1.5">
        <PendingList groups={groups} showThread />
      </PopoverContent>
    </Popover>
  );
}
