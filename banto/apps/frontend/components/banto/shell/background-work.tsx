"use client";

// **バックグラウンドの印**（決定・2026-10-03、ユーザー。v4-frontend.md §6.33、見本は mock/ の pending-replies.tsx）。
// AI が「終わったら届ける」tool で頼み、まだ届いていないもの。「AI が動いている」（行のアイコンが回る）とは別のことなので、
// 別の場所に置く——片方がもう片方を隠さない。
// - Thread の行：名前の下に薄い1行（1件ならカードの題、2件以上なら「バックグラウンドで n 件」）
// - いま開いていない Project の行：頭文字の右下に数
// - 畳んだレール：出さない（レールの作りを見直すまで）
// 文言は「〜待ち」にしない——banto では「判断待ち」「レビュー待ち」が人の番を指すので、人が返事する番に読める。
// 押すと一覧を出し、1件を押すとその Thread へ移って、会話のカードと同じ画面（その呼び出し）を Canvas に開く。
//
// **人の答えを待っているもの**（公開の承認など。Module が `dev.banto/waitingOn` で名乗る、2026-10-04、ユーザー）は
// 「バックグラウンド」と分けて、人の番の色（受信箱のバッジと同じ）で出す——放っておいてよいものに見せない。
// 行は「人を待っている」が上、「バックグラウンド」が下の2行まで。Project の行の数は、人を待っているものがあれば人の番の色。
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Hand, Hourglass } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useBackgroundByThread, useThreadBackground, type BackgroundItem } from "@/lib/backend/background-work";
import { distinctDescription } from "@/lib/card-text";
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

const isHuman = (item: BackgroundItem) => item.waitingOn === "human";

function titleOf(item: BackgroundItem): string {
  return item.title ?? (isHuman(item) ? `${item.module} があなたの答えを待っています` : `${item.module} に頼んだ仕事`);
}

/** 一覧の見出しと1行の文。人を待っているものと、裏の仕事とで言い方を分ける */
const KINDS = {
  human: {
    heading: (n: number) => `あなたの答えを待っているもの（${n}）`,
    line: (n: number) => `あなたの答えを待っています（${n} 件）`,
    // 「いま」のときは「に」を挟まない（「いまに頼んだ」になっていた、2026-10-07）
    since: (ago: string) => `${ago}から待っています`,
  },
  work: {
    heading: (n: number) => `バックグラウンドで動いているもの（${n}）`,
    line: (n: number) => `バックグラウンドで ${n} 件`,
    since: (ago: string) => (ago === "いま" ? "いま頼んだ" : `${ago}に頼んだ`),
  },
} as const;
type Kind = keyof typeof KINDS;

function split(groups: readonly Group[]): Record<Kind, Group[]> {
  const pick = (want: boolean) =>
    groups.map((g) => ({ thread: g.thread, items: g.items.filter((i) => isHuman(i) === want) })).filter((g) => g.items.length > 0);
  return { human: pick(true), work: pick(false) };
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
  const parts = split(groups);
  return (
    <div className="flex flex-col gap-1" data-testid="background-list">
      {(["human", "work"] as const).map((kind) =>
        parts[kind].length === 0 ? null : (
          <section key={kind} className="flex flex-col" data-kind={kind}>
            <p className={cn("px-2 pt-1 text-xs font-medium", kind === "human" ? "text-turn" : "text-ink-3")}>
              {KINDS[kind].heading(countOf(parts[kind]))}
            </p>
            {parts[kind].map((g) => (
              <div key={g.thread.id} className="flex flex-col">
                {showThread ? <p className="truncate px-2 pt-1 text-xs text-ink-3">{g.thread.title}</p> : null}
                {g.items.map((item, i) => (
                  <button
                    key={`${item.toolCallId ?? item.since}-${i}`}
                    type="button"
                    data-testid="background-item"
                    data-kind={kind}
                    onClick={() => {
                      onPicked();
                      router.push(hrefOf(projectId, g.thread, item));
                    }}
                    className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                  >
                    <span className="truncate text-sm text-foreground">{titleOf(item)}</span>
                    {/* 題と同じ文なら出さない（Shell の待たない形で呼び名を付けなかったとき、題も説明もコマンド。2026-10-08） */}
                    {distinctDescription(item.title, item.description) ? (
                      <span data-testid="background-item-description" className="line-clamp-2 text-xs text-ink-2">
                        {item.description}
                      </span>
                    ) : null}
                    <span className="text-xs text-ink-3">
                      {item.module}・{KINDS[kind].since(minutesAgo(item.since, now))}
                    </span>
                    {item.keptAt ? (
                      // **起こし直しのあと続けている**（2026-10-05、アーキ仕様 §2.5「2.」）——続けると答えてから長く届かない
                      // ものに人が気づけるよう、いつから続けているかを出す
                      <span data-testid="background-item-kept" className="text-xs text-ink-3">
                        起こし直しのあと続けています（{minutesAgo(item.keptAt, now)}から）
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            ))}
          </section>
        ),
      )}
    </div>
  );
}

function label(count: number, scope: string, kind: Kind | "all" = "work"): string {
  if (kind === "human") return `${scope}であなたの答えを待っているもの（${count}件）を見る`;
  if (kind === "all") return `${scope}で動いているもの・あなたの答えを待っているもの（${count}件）を見る`;
  return `${scope}のバックグラウンドで動いているもの（${count}件）を見る`;
}

/**
 * Thread の行の名前の下の行。人を待っているもの・裏の仕事を1行ずつ（あるほうだけ）。行の Link の**外**に置く
 * （押せるものを入れ子にしない）。どちらの行を押しても、両方の入った一覧を出す
 */
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
  const [open, setOpen] = useState<Kind | null>(null);
  if (items.length === 0) return null;
  const groups = [{ thread, items }];
  const parts = split(groups);
  return (
    <>
      {(["human", "work"] as const).map((kind) => {
        const mine = parts[kind][0]?.items ?? [];
        if (mine.length === 0) return null;
        const Icon = kind === "human" ? Hand : Hourglass;
        return (
          <Popover key={kind} open={open === kind} onOpenChange={(next) => setOpen(next ? kind : null)}>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={label(mine.length, thread.title, kind)}
                data-testid={kind === "human" ? "thread-waiting-human" : "thread-background"}
                className={cn(
                  "flex w-full items-center gap-1 truncate rounded-md py-0.5 pr-1 pl-8 text-left text-xs hover:bg-sidebar-accent",
                  kind === "human" ? "font-medium text-turn" : "text-ink-3 hover:text-foreground",
                  className,
                )}
              >
                <Icon className="size-3 shrink-0" />
                <span className="truncate">{mine.length === 1 ? titleOf(mine[0]!) : KINDS[kind].line(mine.length)}</span>
              </button>
            </PopoverTrigger>
            <PopoverContent side="right" align="start" className="w-72 p-1.5">
              <BackgroundList projectId={projectId} groups={groups} showThread={false} onPicked={() => setOpen(null)} />
            </PopoverContent>
          </Popover>
        );
      })}
    </>
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
  // 人を待っているものがあれば、人の番の色にする（数は全部）
  const human = countOf(split(groups).human) > 0;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label(count, projectName, human ? "all" : "work")}
          data-testid="project-background"
          data-human={human ? "" : undefined}
          onPointerDown={(e) => {
            const row = e.currentTarget.closest("li");
            if (row) setOffset(row.getBoundingClientRect().right - e.currentTarget.getBoundingClientRect().right + 8);
          }}
          className={cn(
            "absolute top-4.5 left-6 z-10 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5 text-xs leading-none font-semibold text-on-color tabular-nums ring-2 ring-sidebar hover:brightness-110",
            human ? "bg-turn" : "bg-ink-2",
          )}
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
