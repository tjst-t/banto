"use client";

// Backlog の画面の小さな部品。一覧と詳細の両方で使う。
//
// 芯は**順番の印**（RankMark）——並び順はそのまま優先順（v4-modules.md §4.4）なので、左端に順番の数字を立て、
// 数字の囲みで状態を言う。課題管理でよくある「状態の丸」（Linear 等）をそのまま借りず、banto の Backlog が
// 持つ一番の性質（順番＝優先）を印にした（docs/notes/2026-10-02-backlog-ui-survey.md）。
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
 * 順番の印。`n` は区切り（またはストーリー）の中での順番。閉じたものは順番を持たないので数字を出さない。
 * 大きさは一覧で 22px、子の行と札では 18px
 */
export function RankMark({
  state,
  n,
  small = false,
  className,
}: {
  state: RankState;
  n?: number;
  small?: boolean;
  className?: string;
}) {
  const size = small ? 18 : 22;
  const r = size / 2 - 1.5;
  const c = size / 2;
  const showNumber = n !== undefined && state !== "done" && state !== "dropped";
  return (
    <span
      role="img"
      aria-label={
        n !== undefined && showNumber
          ? `${n}番目・${RANK_STATE_LABEL[state]}`
          : RANK_STATE_LABEL[state]
      }
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
      {showNumber ? (
        <span
          className={cn(
            "relative leading-none font-medium tabular-nums",
            small ? "text-xs" : "text-sm",
            state === "backlog" || state === "waiting"
              ? "text-ink-3"
              : "text-primary",
          )}
        >
          {n}
        </span>
      ) : null}
    </span>
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
