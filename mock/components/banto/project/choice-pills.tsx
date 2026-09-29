"use client";

// フォームの中の「どれか1つを選ぶ」（アカウント・公開範囲）。見た目は本実装の
// `PillTabs`（2段目・自動幅・薄い受け皿）に合わせる——面を切り替えるタブではなく
// 値を選ぶ入力欄なので、役割は radiogroup。矢印キーで動いて、そのまま選ぶ
import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface Choice<T extends string> {
  value: T;
  label: ReactNode;
}

/** radiogroup / tablist の矢印キー（←→↑↓・Home・End）。動いた先を選ぶ */
export function moveChoiceByKey<T>(
  e: KeyboardEvent<HTMLElement>,
  values: readonly T[],
  current: T,
  select: (next: T) => void,
): void {
  const i = values.indexOf(current);
  let next = i;
  if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % values.length;
  else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + values.length) % values.length;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = values.length - 1;
  else return;
  e.preventDefault();
  select(values[next]);
  // 選んだ札へ焦点を移す（roving tabindex）
  const group = e.currentTarget;
  requestAnimationFrame(() => {
    group.querySelectorAll<HTMLElement>("[data-choice]")[next]?.focus();
  });
}

export function ChoicePills<T extends string>({
  choices,
  value,
  onChange,
  label,
  labelledBy,
  testId,
}: {
  choices: readonly Choice<T>[];
  value: T;
  onChange: (next: T) => void;
  label?: string;
  labelledBy?: string;
  testId?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-labelledby={labelledBy}
      data-testid={testId}
      onKeyDown={(e) =>
        moveChoiceByKey(
          e,
          choices.map((c) => c.value),
          value,
          onChange,
        )
      }
      className="inline-flex w-fit max-w-full shrink-0 flex-wrap gap-0.5 self-start rounded-lg bg-surface-2 p-0.5"
    >
      {choices.map((c) => (
        <button
          key={c.value}
          type="button"
          role="radio"
          data-choice
          aria-checked={value === c.value}
          tabIndex={value === c.value ? 0 : -1}
          data-testid={testId ? `${testId}-${c.value}` : undefined}
          onClick={() => onChange(c.value)}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
            value === c.value
              ? "bg-background text-foreground shadow-sm"
              : "text-ink-3 hover:text-ink-2",
          )}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}
