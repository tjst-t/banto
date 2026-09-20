"use client";

// **面を分ける操作の見た目**（抜き出し・2026-09-20）。履歴（`archive-dialog`）で
// 決めた形を、Module を追加する面でも使う——**同じ見た目を2箇所に書かない**（規則3）。
//
// **段が2つあるときは、同じ見た目を重ねない**（決定・2026-09-20、ユーザー指摘
// 「メインタブとサブタブが似ていてバグっぽい」）。形・幅・重さのうち2軸以上を変える：
//
// | 段 | 部品 | 形 |
// |---|---|---|
// | 1段目（どの区画に居るか） | `SegmentedTabs` | **全幅**・下線・区画いっぱい |
// | 2段目（区画の中のモード） | `PillTabs` | **自動幅**・角丸・薄い受け皿の中 |
//
// **3段目は作らない。** それ以上分かれるものは、タブではなく**フォームの項目**
// （ラベルの付いた1行）に降ろす——`PillTabs` はそこでも使えるが、ラベルが付く
// ことで「入力欄の一種」として読める。
import { cn } from "@/lib/utils";

export interface SegmentedTab {
  id: string;
  label: string;
  /** 右に小さく出す数（無ければ出さない） */
  count?: number;
}

export function SegmentedTabs({
  tabs,
  value,
  onChange,
  label,
  testId,
  itemTestId,
}: {
  tabs: readonly SegmentedTab[];
  value: string | null;
  onChange: (id: string) => void;
  /** 読み上げ用（何のタブか） */
  label: string;
  /** 枠につける印 */
  testId?: string;
  /** 各タブにつける印の前置き（既定は `testId`）。**既にある印を変えない**ために持つ */
  itemTestId?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      data-testid={testId}
      className="grid border-b border-border"
      style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          data-testid={itemTestId ?? testId ? `${itemTestId ?? testId}-${t.id}` : undefined}
          data-state={value === t.id ? "active" : "inactive"}
          onClick={() => onChange(t.id)}
          className={cn(
            "flex items-center justify-center gap-1.5 px-2 py-2 text-xs transition-colors",
            value === t.id
              ? "bg-surface-2 text-foreground"
              : "text-ink-3 hover:bg-surface-2/60 hover:text-ink-2",
          )}
        >
          {t.label}
          {t.count === undefined ? null : (
            <span className="text-ink-3 tabular-nums">{t.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * **区画の中のモード切替**（2段目以降）。1段目の下線タブとは**形も幅も違う**
 * ——受け皿の中に収まった小さな札なので、面の上の帯には見えない。
 *
 * ラベルを付けてフォームの中に置けば、そのまま「選ぶ入力欄」として読める。
 */
export function PillTabs({
  tabs,
  value,
  onChange,
  label,
  testId,
  size = "sm",
}: {
  tabs: readonly SegmentedTab[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  testId?: string;
  size?: "sm" | "xs";
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      data-testid={testId}
      // **中身の幅だけ**——縦並びの親の中でも横に伸びない（`stretch` を受けない）
      className="inline-flex w-fit shrink-0 gap-0.5 self-start rounded-lg bg-surface-2 p-0.5"
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          data-testid={testId ? `${testId}-${t.id}` : undefined}
          data-state={value === t.id ? "active" : "inactive"}
          onClick={() => onChange(t.id)}
          className={cn(
            "rounded-md font-medium transition-colors",
            size === "xs" ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-xs",
            value === t.id
              ? "bg-background text-foreground shadow-sm"
              : "text-ink-3 hover:text-ink-2",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
