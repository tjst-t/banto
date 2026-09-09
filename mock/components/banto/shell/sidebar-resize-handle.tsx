"use client";

// サイドバーの幅をドラッグで変える（決定・2026-09-09、ユーザー要望）。
// 幅そのものは AppShell が持ち（`--sidebar-width` として SidebarProvider に渡す）、
// ここは「境界を掴んで動かす」入力だけを担う——真実は一箇所（規則3）。
//
// 掴む場所は Canvas の境界（panel-stack.tsx）と同じ作り方に揃えた：
// `role="separator"` の細い帯を pointer events で動かす。
// キーボードでも動かせる（矢印キー）——マウスでしか変えられない寸法にしない。
import type { PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent } from "react";

export const SIDEBAR_WIDTH_DEFAULT = 256;
export const SIDEBAR_WIDTH_MIN = 200;
export const SIDEBAR_WIDTH_MAX = 480;
/** 矢印キー1回ぶん */
const KEYBOARD_STEP = 16;

export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(width)));
}

export function SidebarResizeHandle({
  width,
  onResize,
  onResizeEnd,
}: {
  width: number;
  /** ドラッグ中の逐次更新（保存はしない） */
  onResize: (width: number) => void;
  /** 手を離した・キーで動かし終えた——ここで覚える */
  onResizeEnd: (width: number) => void;
}) {
  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    // 左ボタン以外は無視（右クリックでドラッグが始まらないように）
    if (e.button !== 0) return;
    e.preventDefault();
    let latest = width;

    // 動かしている間だけ、幅のアニメーションを止める（globals.css）——
    // 200ms の transition が乗ったままだと、指の位置に遅れて付いてくる。
    // 文字の選択と cursor もここで固定する
    document.documentElement.dataset.sidebarResizing = "1";

    function onMove(ev: PointerEvent) {
      // サイドバーは画面の左端に固定されているので、幅＝ポインタのX座標
      latest = clampSidebarWidth(ev.clientX);
      onResize(latest);
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      delete document.documentElement.dataset.sidebarResizing;
      onResizeEnd(latest);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home") return;
    e.preventDefault();
    const next =
      e.key === "Home"
        ? SIDEBAR_WIDTH_DEFAULT
        : clampSidebarWidth(width + (e.key === "ArrowRight" ? KEYBOARD_STEP : -KEYBOARD_STEP));
    onResize(next);
    onResizeEnd(next);
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="サイドバーの幅"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_WIDTH_MIN}
      aria-valuemax={SIDEBAR_WIDTH_MAX}
      tabIndex={0}
      title="ドラッグで幅を変える（ダブルクリックで既定に戻す）"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => {
        onResize(SIDEBAR_WIDTH_DEFAULT);
        onResizeEnd(SIDEBAR_WIDTH_DEFAULT);
      }}
      // 掴める帯は境界をまたいで少し広く取り（w-2）、線そのものは hover と
      // フォーカスのときだけ出す——常時線を引かないのは Canvas の境界と同じ
      className="group absolute inset-y-0 -right-1 z-20 flex w-2 touch-none items-center justify-center [cursor:col-resize] focus-visible:outline-none"
    >
      <div className="h-full w-0.5 bg-transparent transition-colors group-hover:bg-border group-focus-visible:bg-accent" />
    </div>
  );
}
