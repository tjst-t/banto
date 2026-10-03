"use client";

// **バックグラウンドの印**（決定・2026-10-03、ユーザー。v4-frontend.md §6.33、見本は mock/ の pending-replies.tsx）。
// AI が「終わったら届ける」tool で頼み、まだ届いていないもの。「AI が動いている」（行のアイコンが回る）とは別のことなので、
// 別の場所に置く——片方がもう片方を隠さない。
// - Thread の行：名前の下に薄い1行（1件ならカードの題、2件以上なら「バックグラウンドで n 件」）
// - いま開いていない Project の行：頭文字の右下に数
// - 畳んだレール：出さない（レールの作りを見直すまで）
// 文言は「〜待ち」にしない——banto では「判断待ち」「レビュー待ち」が人の番を指すので、人が返事する番に読める。
// 押すと一覧を出し、1件を押すとその Thread へ移って、会話のカードと同じ画面（その呼び出し）を Canvas に開く。
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Hourglass } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useBackgroundByThread, useThreadBackground, type BackgroundItem } from "@/lib/backend/background-work";
import { cn } from "@/lib/utils";

interface ThreadRef {
  id: string;
  /** サイドバーに出している名前（Base Thread なら「Base Thread」） */
  title: string;
  /** Fork なら true（移り先の URL に `fork=` を付ける） */
  fork: boolean;
}

interface Group {
  thread: ThreadRef;
  items: readonly BackgroundItem[];
}

function countOf(groups: readonly Group[]): number {
  return groups.reduce((n, g) => n + g.items.length, 0);
}

function titleOf(item: BackgroundItem): string {
  return item.title ?? `${item.module} に頼んだ仕事`;
}

function minutesAgo(since: string, now: number): string {
  const ms = now - Date.parse(since);
  if (!Number.isFinite(ms) || ms < 60_000) return "いま";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}時間前` : `${Math.floor(h / 24)}日前`;
}

/** 移り先：その Thread を開き、画面と呼び出しが分かれば Canvas にその画面を開く（会話のカードと同じ URL の形） */
function hrefOf(projectId: string, thread: ThreadRef, item: BackgroundItem): string {
  const params = new URLSearchParams();
  if (thread.fork) params.set("fork", thread.id);
  if (item.resourceUri) {
    params.set("canvas", `${item.module}:${item.resourceUri}`);
    if (item.toolCallId) params.set("canvasTool", item.toolCallId);
  }
  const query = params.toString();
  return query ? `/p/${projectId}?${query}` : `/p/${projectId}`;
}

function BackgroundList({
  projectId,
  groups,
  showThread,
  onPicked,
}: {
  projectId: string;
  groups: readonly Group[];
  showThread: boolean;
  onPicked: () => void;
}) {
  const router = useRouter();
  // 開いたときの時刻で「何分前」を出す（開いている間は数え直さない）
  const [now] = useState(() => Date.now());
  return (
    <div className="flex flex-col gap-1" data-testid="background-list">
      <p className="px-2 pt-1 text-xs font-medium text-ink-3">バックグラウンドで動いているもの（{countOf(groups)}）</p>
      {groups.map((g) => (
        <div key={g.thread.id} className="flex flex-col">
          {showThread ? <p className="truncate px-2 pt-1 text-xs text-ink-3">{g.thread.title}</p> : null}
          {g.items.map((item, i) => (
            <button
              key={`${item.toolCallId ?? item.since}-${i}`}
              type="button"
              data-testid="background-item"
              onClick={() => {
                onPicked();
                router.push(hrefOf(projectId, g.thread, item));
              }}
              className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-accent"
            >
              <span className="truncate text-sm text-foreground">{titleOf(item)}</span>
              {item.description ? <span className="line-clamp-2 text-xs text-ink-2">{item.description}</span> : null}
              <span className="text-xs text-ink-3">
                {item.module}・{minutesAgo(item.since, now)}に頼んだ
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function label(count: number, scope: string): string {
  return `${scope}のバックグラウンドで動いているもの（${count}件）を見る`;
}

/** Thread の行の名前の下の1行。行の Link の**外**に置く（押せるものを入れ子にしない） */
export function ThreadBackgroundLine({
  projectId,
  thread,
  className,
}: {
  projectId: string;
  thread: ThreadRef;
  className?: string;
}) {
  const items = useThreadBackground(thread.id);
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  const groups = [{ thread, items }];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label(items.length, thread.title)}
          data-testid="thread-background"
          className={cn(
            "flex w-full items-center gap-1 truncate rounded-md py-0.5 pr-1 pl-8 text-left text-xs text-ink-3 hover:bg-sidebar-accent hover:text-foreground",
            className,
          )}
        >
          <Hourglass className="size-3 shrink-0" />
          <span className="truncate">{items.length === 1 ? titleOf(items[0]!) : `バックグラウンドで ${items.length} 件`}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" className="w-72 p-1.5">
        <BackgroundList projectId={projectId} groups={groups} showThread={false} onPicked={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * いま開いていない Project の行の、頭文字の右下の数。行（`li`、relative）の中に、頭文字に重ねて置く。
 * 一覧は Thread ごとに分けて、行の右端の外に開く（数の右に開くとサイドバーの上に重なる）
 */
export function ProjectBackgroundBadge({
  projectId,
  projectName,
  threads,
}: {
  projectId: string;
  projectName: string;
  threads: readonly ThreadRef[];
}) {
  const byThread = useBackgroundByThread();
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(8);
  const groups = threads
    .map((thread) => ({ thread, items: byThread.get(thread.id)?.items ?? [] }))
    .filter((g) => g.items.length > 0);
  const count = countOf(groups);
  if (count === 0) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label(count, projectName)}
          data-testid="project-background"
          onPointerDown={(e) => {
            const row = e.currentTarget.closest("li");
            if (row) setOffset(row.getBoundingClientRect().right - e.currentTarget.getBoundingClientRect().right + 8);
          }}
          className="absolute top-4.5 left-6 z-10 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-ink-2 px-0.5 text-xs leading-none font-semibold text-on-color tabular-nums ring-2 ring-sidebar hover:brightness-110"
        >
          {count}
        </button>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" sideOffset={offset} className="w-72 p-1.5">
        <BackgroundList projectId={projectId} groups={groups} showThread onPicked={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
