"use client";

// 矢印キーでの一覧移動（roving tabindex パターン、規則12——名前のある機構）。
// Command Palette は cmdk がこれを内蔵しているが、Archive・Settings・受信箱の
// 一覧は banto 自身で組んだ plain な button の縦並びなので、Tab では1つずつ
// 移動できても ArrowUp/Down では動かない——このフックで揃える。
// 対象の行には `data-roving-item` を付け、リストのコンテナに
// `ref={containerRef}` と `onKeyDown={onKeyDown}` を渡すだけでよい。
import { useRef, type KeyboardEvent } from "react";

export function useRovingFocus<T extends HTMLElement = HTMLDivElement>() {
  const containerRef = useRef<T>(null);

  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const container = containerRef.current;
    if (!container) return;

    const items = Array.from(
      container.querySelectorAll<HTMLElement>("[data-roving-item]"),
    ).filter((el) => el.offsetParent !== null && !el.hasAttribute("disabled"));
    if (items.length === 0) return;

    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    let nextIndex = currentIndex;
    if (e.key === "ArrowDown") nextIndex = currentIndex < 0 ? 0 : Math.min(currentIndex + 1, items.length - 1);
    else if (e.key === "ArrowUp") nextIndex = currentIndex < 0 ? items.length - 1 : Math.max(currentIndex - 1, 0);
    else if (e.key === "Home") nextIndex = 0;
    else if (e.key === "End") nextIndex = items.length - 1;

    if (nextIndex === currentIndex && currentIndex !== -1) return;
    e.preventDefault();
    items[nextIndex]?.focus();
  }

  return { containerRef, onKeyDown };
}
