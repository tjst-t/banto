"use client";

// Backlog の画面の小さな部品。一覧と詳細の両方で使う。
//
// 左端の印で状態を言う。順番の数字は入れない（2026-10-03、ユーザー「数字の意味がわからない」——並び順は
// 行の位置で分かり、区切りごとに数え直す数字は通し番号に見えた）。ストーリーは別の形（StoryMark）。
//   着手できる（ready かつ待つものが全部終わった）＝青の輪／進めている＝青の輪に進みの弧／
//   待っている＝点線の輪／積んだだけ＝輪なし／終わった＝緑の印／やめた＝横棒
// 塗りの役色は使わない（「塗ってよいのは turn だけ」、scripts/check-tokens.mjs）。
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  isActionable,
  isClosed,
  waitingOn,
  type BacklogItem,
  type BacklogKind,
  type BacklogPriority,
  type BacklogStatus,
} from "@/lib/mock/backlog";

export const KIND_LABEL: Record<BacklogKind, string> = {
  story: "ストーリー",
  task: "タスク",
  bug: "バグ",
};

// ready は「準備できた」と呼ぶ——一覧の「着手できる」（待つものが全部終わった ready）と取り違えないため
export const STATUS_LABEL: Record<BacklogStatus, string> = {
  backlog: "積んだだけ",
  ready: "準備できた",
  "in-progress": "進めている",
  done: "終わった",
  dropped: "やめた",
};

export const OPEN_STATUSES: readonly BacklogStatus[] = [
  "backlog",
  "ready",
  "in-progress",
];

export const PRIORITY_LABEL: Record<BacklogPriority, string> = {
  high: "高い",
  normal: "ふつう",
  low: "低い",
};

/** 一覧で見せる状態。status に「待っているか」を重ねたもの */
export type RankState =
  "actionable" | "in-progress" | "waiting" | "backlog" | "done" | "dropped";

export function rankState(
  item: BacklogItem,
  items: readonly BacklogItem[],
): RankState {
  if (item.status === "done") return "done";
  if (item.status === "dropped") return "dropped";
  if (item.status === "in-progress") return "in-progress";
  if (waitingOn(item, items).length > 0) return "waiting";
  if (isActionable(item, items)) return "actionable";
  return "backlog";
}

export const RANK_STATE_LABEL: Record<RankState, string> = {
  actionable: "着手できる",
  "in-progress": "進めている",
  waiting: "待っている",
  backlog: "積んだだけ",
  done: "終わった",
  dropped: "やめた",
};

/**
 * 状態の印（タスク・バグ）。
 * 大きさは一覧で 22px、子の行と札では 18px
 */
export function RankMark({
  state,
  small = false,
  className,
}: {
  state: RankState;
  small?: boolean;
  className?: string;
}) {
  const size = small ? 18 : 22;
  const r = size / 2 - 1.5;
  const c = size / 2;
  return (
    <span
      role="img"
      aria-label={RANK_STATE_LABEL[state]}
      data-testid="backlog-rank"
      data-state={state}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center",
        small ? "size-4.5" : "size-5.5",
        state === "actionable" || state === "in-progress"
          ? "text-primary"
          : "text-ink-3",
        state === "done" && "text-ok",
        className,
      )}
    >
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className="absolute inset-0 size-full"
        aria-hidden
      >
        {state === "actionable" ? (
          <circle
            cx={c}
            cy={c}
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
          />
        ) : null}
        {state === "in-progress" ? (
          <>
            <circle
              cx={c}
              cy={c}
              r={r}
              fill="none"
              stroke="currentColor"
              strokeOpacity={0.3}
              strokeWidth={1.5}
            />
            {/* 進みの弧（時計の12時から3/4周）。「動いている」を形で言う——数字は読めたまま */}
            <circle
              cx={c}
              cy={c}
              r={r}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeDasharray={`${2 * Math.PI * r * 0.75} ${2 * Math.PI * r}`}
              transform={`rotate(-90 ${c} ${c})`}
            />
          </>
        ) : null}
        {state === "backlog" ? (
          <circle
            cx={c}
            cy={c}
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.25}
          />
        ) : null}
        {state === "waiting" ? (
          <circle
            cx={c}
            cy={c}
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.25}
            strokeDasharray="2 2.4"
          />
        ) : null}
        {state === "done" ? (
          <>
            <circle
              cx={c}
              cy={c}
              r={r}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
            />
            <path
              d={`M${c - r * 0.42} ${c + 0.2} L${c - r * 0.08} ${c + r * 0.36} L${c + r * 0.46} ${c - r * 0.32}`}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        ) : null}
        {state === "dropped" ? (
          <line
            x1={c - r * 0.5}
            y1={c}
            x2={c + r * 0.5}
            y2={c}
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
          />
        ) : null}
      </svg>
    </span>
  );
}

/**
 * ストーリーの印。角の丸い四角を、子のタスクの進み具合で下から満たす——タスク・バグの「輪」と形で分ける
 * （2026-10-03、ユーザー「ストーリーとタスクの区別がつきづらい」）。やめた子は数えない
 */
export function StoryMark({
  item,
  items,
  small = false,
  className,
}: {
  item: BacklogItem;
  items: readonly BacklogItem[];
  small?: boolean;
  className?: string;
}) {
  const kids = items.filter(
    (i) => i.parent === item.id && i.status !== "dropped",
  );
  const done = kids.filter((k) => k.status === "done").length;
  const ratio =
    item.status === "done" ? 1 : kids.length === 0 ? 0 : done / kids.length;
  const size = small ? 18 : 22;
  // 角の丸い四角（タスクの丸と形で分ける。2026-10-03、ユーザーがひし形より四角を選んだ）。中を下から、終わった子の割合だけ満たす
  const o = 2;
  const w = size - o * 2;
  const pad = 2.5;
  const inner = w - pad * 2;
  const h = inner * ratio;
  const tone =
    item.status === "done"
      ? "text-ok"
      : item.status === "in-progress"
        ? "text-primary"
        : "text-ink-2";
  return (
    <span
      role="img"
      aria-label={`ストーリー・タスク ${kids.length} 件のうち ${done} 件終わった`}
      data-testid="backlog-story-mark"
      className={cn(
        "inline-flex shrink-0",
        small ? "size-4.5" : "size-5.5",
        tone,
        className,
      )}
    >
      <svg viewBox={`0 0 ${size} ${size}`} className="size-full" aria-hidden>
        <rect
          x={o}
          y={o}
          width={w}
          height={w}
          rx={4}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
        />
        {h > 0 ? (
          <rect
            x={o + pad}
            y={o + pad + inner - h}
            width={inner}
            height={h}
            rx={1.5}
            fill="currentColor"
          />
        ) : null}
      </svg>
    </span>
  );
}

/** 項目の印。ストーリーは円グラフ、タスク・バグは状態の輪 */
export function ItemMark({
  item,
  items,
  small = false,
}: {
  item: BacklogItem;
  items: readonly BacklogItem[];
  small?: boolean;
}) {
  return item.kind === "story" ? (
    <StoryMark item={item} items={items} small={small} />
  ) : (
    <RankMark state={rankState(item, items)} small={small} />
  );
}

/** バグの札。種類で目立つのはバグだけ（ストーリーは字の太さ、タスクは何も付けない） */
export function BugTag() {
  return (
    <span
      data-testid="backlog-bug-tag"
      className="shrink-0 rounded-sm border border-border px-1 text-xs whitespace-nowrap text-ink-2"
    >
      バグ
    </span>
  );
}

/**
 * ストーリーの進み具合。子1件を1区画にして状態を並べる（GitHub の sub-issue progress を、
 * 「どれが動いているか」まで見える形にしたもの）。やめた子は数えない
 */
export function StoryProgress({
  kids,
  items,
}: {
  kids: readonly BacklogItem[];
  items: readonly BacklogItem[];
}) {
  const counted = kids.filter((k) => k.status !== "dropped");
  if (counted.length === 0) return null;
  const done = counted.filter((k) => k.status === "done").length;
  return (
    <span
      data-testid="backlog-progress"
      className="inline-flex shrink-0 items-center gap-2"
      aria-label={`タスク ${counted.length} 件のうち ${done} 件終わった`}
    >
      <span className="flex gap-0.5" aria-hidden>
        {counted.map((k) => {
          const s = rankState(k, items);
          return (
            <span
              key={k.id}
              className={cn(
                "h-2 w-3 rounded-sm ring-1 ring-inset",
                s === "done" ? "bg-ok-soft ring-ok" : null,
                s === "in-progress" ? "bg-background ring-primary" : null,
                s !== "done" && s !== "in-progress"
                  ? "bg-background ring-border"
                  : null,
              )}
            />
          );
        })}
      </span>
      <span className="text-xs text-ink-3 tabular-nums">
        {done}/{counted.length}
      </span>
    </span>
  );
}

/** 優先度は高いときだけ行に出す（ふつう・低いは詳細でだけ） */
export function PriorityMark({ priority }: { priority: BacklogPriority }) {
  if (priority !== "high") return null;
  return (
    <span
      data-testid="backlog-priority-high"
      className="shrink-0 text-xs font-semibold whitespace-nowrap text-foreground"
    >
      優先
    </span>
  );
}

export function LabelChip({
  children,
  onRemove,
}: {
  children: ReactNode;
  onRemove?: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-sm bg-surface-2 px-1.5 text-xs whitespace-nowrap text-ink-2">
      {children}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`ラベル「${String(children)}」を外す`}
          className="rounded-sm text-ink-3 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          ×
        </button>
      ) : null}
    </span>
  );
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function isOpen(item: BacklogItem): boolean {
  return !isClosed(item);
}

// 本文の Markdown。モックなので段落・見出し・箇条書き・`コード`・**太字** だけを読む
// （本物は Module の画面が自分で描く）
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={i}
          className="rounded-sm bg-surface-2 px-1 font-mono text-xs"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold text-foreground">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return part;
  });
}

export function MarkdownBody({ source }: { source: string }) {
  const blocks = source.split(/\n{2,}/);
  return (
    <div className="flex max-w-prose flex-col gap-2.5 text-md text-ink-2">
      {blocks.map((block, i) => {
        const lines = block.split("\n");
        if (lines.every((l) => /^[-*] /.test(l))) {
          return (
            <ul key={i} className="flex list-disc flex-col gap-0.5 pl-5">
              {lines.map((l, j) => (
                <li key={j}>{inline(l.slice(2))}</li>
              ))}
            </ul>
          );
        }
        if (/^#{1,3} /.test(block)) {
          return (
            <p key={i} className="font-semibold text-foreground">
              {inline(block.replace(/^#{1,3} /, ""))}
            </p>
          );
        }
        return <p key={i}>{inline(lines.join(" "))}</p>;
      })}
    </div>
  );
}
