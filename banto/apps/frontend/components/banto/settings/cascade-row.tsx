"use client";

// 設定のカスケード（§2.2「設定のカスケード」、決定・2026-09-01）：instance 既定 →
// Project 上書き（あれば）→ Thread 作成時に確定。runtime config は既定で
// 全項目が Project 単位に上書き可能——この行がその UI の最小単位。
import type { ReactNode } from "react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

export function CascadeRow({
  id,
  label,
  inheritedLabel,
  overridden,
  onToggle,
  children,
}: {
  id: string;
  label: string;
  /** instance 既定の表示（上書きしていないときはこれが効く） */
  inheritedLabel: string;
  overridden: boolean;
  onToggle: (next: boolean) => void;
  /** 上書き ON のときに出す実際の入力 */
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border-b border-border py-3 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id} className="text-sm font-medium text-foreground">
          {label}
        </Label>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs text-ink-3">この Project で上書き</span>
          <Switch id={id} checked={overridden} onCheckedChange={onToggle} />
        </div>
      </div>
      {overridden ? (
        <div>{children}</div>
      ) : (
        <p className="text-sm text-ink-3">
          instance 既定を継承：<span className="text-ink-2">{inheritedLabel}</span>
        </p>
      )}
    </div>
  );
}
