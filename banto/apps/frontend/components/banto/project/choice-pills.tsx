"use client";

// **少数の中から1つを選ぶ欄**（追加・2026-10-21、チャットの「Project にする」・設定の「チャット」。モック
// `fork/draft-projects` の `mock/components/banto/project/choice-pills.tsx` の形）。ラベルの付いたフォームの1行として使う
// ——面を分けるタブ（`SegmentedTabs`・`PillTabs`）とは役目が違うので、読み上げも radio にする。
import { cn } from "@/lib/utils";

export interface Choice<T extends string> {
  value: T;
  label: string;
}

export function ChoicePills<T extends string>({
  choices,
  value,
  onChange,
  labelledBy,
  disabled,
  testId,
}: {
  choices: readonly Choice<T>[];
  value: T;
  onChange: (value: T) => void;
  /** 何を選ぶ欄か（見出しの id） */
  labelledBy: string;
  disabled?: boolean;
  /** 各札に `data-testid` と `data-value` を付ける */
  testId?: string;
}) {
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="flex flex-wrap gap-1.5">
      {choices.map((c) => (
        <button
          key={c.value}
          type="button"
          role="radio"
          aria-checked={value === c.value}
          disabled={disabled}
          data-testid={testId}
          data-value={c.value}
          onClick={() => onChange(c.value)}
          className={cn(
            "rounded-md border px-3 py-1.5 text-xs transition-colors disabled:opacity-50",
            value === c.value
              ? "border-[var(--banto-accent)] bg-accent-soft font-medium text-accent-ink"
              : "border-border text-ink-2 hover:bg-surface-2",
          )}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}
