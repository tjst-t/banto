"use client";

// Backlog の画面の小さな部品（印・状態・ラベル・本文の Markdown）。一覧と詳細の両方で使うので分けた。
import type { ReactNode } from "react";
import { Bug, CircleCheck, Layers, SquareCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import type { BacklogItem, BacklogKind, BacklogPriority, BacklogStatus } from "@/lib/mock/backlog";

export const KIND_LABEL: Record<BacklogKind, string> = {
  story: "ストーリー",
  task: "タスク",
  bug: "バグ",
};

// 状態の呼び名は利用者の言葉で。ready は「着手できる」と仕様は言うが、依存で待っていれば
// 実際には始められない——一覧の「すぐ始められる」の印と取り違えないよう「準備できた」と呼ぶ
export const STATUS_LABEL: Record<BacklogStatus, string> = {
  backlog: "積んだだけ",
  ready: "準備できた",
  "in-progress": "進めている",
  done: "終わった",
  dropped: "やめた",
};

export const OPEN_STATUSES: readonly BacklogStatus[] = ["backlog", "ready", "in-progress"];

export const PRIORITY_LABEL: Record<BacklogPriority, string> = {
  high: "高い",
  normal: "ふつう",
  low: "低い",
};

/**
 * 種類の印。形だけで分ける——役色（stop＝止まっている、など）は意味が決まっているので、種類には塗らない
 */
export function KindMark({ kind, className }: { kind: BacklogKind; className?: string }) {
  const Icon = kind === "story" ? Layers : kind === "bug" ? Bug : SquareCheck;
  return (
    <Icon
      aria-label={KIND_LABEL[kind]}
      role="img"
      className={cn(
        "size-3.5 shrink-0",
        kind === "task" ? "text-ink-3" : "text-ink-2",
        className,
      )}
    />
  );
}

/** 状態。進めているものだけ字を濃く、閉じたものは薄く */
export function StatusText({ status, className }: { status: BacklogStatus; className?: string }) {
  return (
    <span
      data-testid="backlog-status"
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-xs whitespace-nowrap",
        status === "in-progress" ? "font-medium text-foreground" : "text-ink-3",
        className,
      )}
    >
      {status === "done" ? <CircleCheck className="size-3 text-ok" /> : null}
      {STATUS_LABEL[status]}
    </span>
  );
}

export function LabelChip({ children, onRemove }: { children: ReactNode; onRemove?: () => void }) {
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

/** 優先度は高いときだけ目立たせる（字の太さだけ。ふつうは出さない、低いは控えめに） */
export function PriorityMark({ priority }: { priority: BacklogPriority }) {
  if (priority === "normal") return null;
  return priority === "high" ? (
    <span data-testid="backlog-priority-high" className="text-xs font-semibold whitespace-nowrap text-foreground">
      優先度高
    </span>
  ) : (
    <span className="text-xs whitespace-nowrap text-ink-3">優先度低</span>
  );
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 依存の相手などに使う1行の札：種類の印・題・状態 */
export function ItemChip({
  item,
  onOpen,
  testId,
}: {
  item: BacklogItem;
  onOpen: (id: string) => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={() => onOpen(item.id)}
      className="flex w-full min-w-0 items-start gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring"
    >
      <KindMark kind={item.kind} className="mt-0.5" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-xs text-foreground">{item.title}</span>
        <StatusText status={item.status} />
      </span>
    </button>
  );
}

// 本文の Markdown。モックなので段落・見出し・箇条書き・`コード`・**太字** だけを読む
// （本物は Module の画面が自分で描く）
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={i} className="rounded-sm bg-surface-2 px-1 font-mono text-xs">
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
    <div className="flex flex-col gap-2 text-sm text-ink-2">
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
