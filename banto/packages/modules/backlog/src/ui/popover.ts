// 小窓——行のメニュー・性質の小窓・絞り込み・項目を選ぶ検索つきの窓（モックの DropdownMenu・Popover＋cmdk）。
//
// 一覧は中身が変わるたびに描き直すので、小窓は一覧の外（body の直下）に置く。開いている間は
// 一覧の読み直しを当てない（board.ts）——開いた小窓の足元が入れ替わらないように。
// キー：↑↓ で動く・Enter で選ぶ・→ で下の段を開く・← / Esc で閉じる。

import type { BacklogItem } from "../model.js";
import { h } from "./dom.js";
import { icon } from "./icons.js";
import { itemMark, KIND_LABEL } from "./parts.js";

export type MenuEntry =
  | {
      type: "item";
      label: string;
      onSelect: () => void;
      disabled?: boolean;
      /** 付けると印つきの項目になり、押しても閉じない（絞り込み） */
      checked?: boolean;
      testid?: string;
    }
  | { type: "sep" }
  | { type: "label"; text: string }
  | { type: "sub"; label: string; entries: MenuEntry[]; testid?: string }
  | { type: "input"; label: string; placeholder: string; onEnter: (value: string) => void };

interface Open {
  el: HTMLElement;
  anchor: HTMLElement;
  onClose?: () => void;
}

const stack: Open[] = [];

export function isPopoverOpen(): boolean {
  return stack.length > 0;
}

/** 開いている小窓を（`from` 段目より上を）閉じる。いちばん下まで閉じたら anchor にフォーカスを返す */
export function closePopovers(from = 0, restoreFocus = false): void {
  const closing = stack.splice(from);
  for (const o of closing.reverse()) {
    o.el.remove();
    o.anchor.removeAttribute("aria-expanded");
    o.onClose?.();
  }
  if (restoreFocus && closing.length > 0) closing[closing.length - 1]!.anchor.focus();
}

document.addEventListener(
  "mousedown",
  (event) => {
    if (stack.length === 0) return;
    const target = event.target as Node;
    if (stack.some((o) => o.el.contains(target))) return;
    // 開いたボタンをもう一度押したら閉じる（押した側のハンドラが開き直さないよう、ここで閉じて印を残す）
    const top = stack[0]!;
    if (top.anchor.contains(target)) top.anchor.dataset.justClosed = "1";
    closePopovers(0);
  },
  true,
);

window.addEventListener("resize", () => closePopovers(0));

function place(el: HTMLElement, anchor: HTMLElement, align: "start" | "end" | "side"): void {
  document.body.appendChild(el);
  const a = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left: number;
  let top: number;
  if (align === "side") {
    left = a.right + 4;
    if (left + w > vw - 8) left = Math.max(8, a.left - w - 4);
    top = a.top - 4;
  } else {
    left = align === "end" ? a.right - w : a.left;
    top = a.bottom + 4;
    if (top + hgt > vh - 8 && a.top - hgt - 4 > 8) top = a.top - hgt - 4;
  }
  left = Math.min(Math.max(8, left), Math.max(8, vw - w - 8));
  top = Math.min(Math.max(8, top), Math.max(8, vh - hgt - 8));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function focusables(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>("button.mi:not(:disabled), input")];
}

function onPopKey(event: KeyboardEvent, level: number): void {
  const o = stack[level];
  if (!o) return;
  const list = focusables(o.el);
  const at = list.indexOf(document.activeElement as HTMLElement);
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closePopovers(level, true);
  } else if (event.key === "ArrowLeft" && level > 0) {
    event.preventDefault();
    closePopovers(level, true);
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if ((document.activeElement as HTMLElement | null)?.tagName === "INPUT" && list.length <= 1) return;
    event.preventDefault();
    const next = event.key === "ArrowDown" ? (at + 1) % list.length : (at - 1 + list.length) % list.length;
    list[next]?.focus();
  } else if (event.key === "Tab") {
    closePopovers(0);
  }
  // 一覧のキー操作（j/k・C など）に届かせない
  event.stopPropagation();
}

/** 開くボタンの押下を「開く／閉じる」に読み替える（開いていたら閉じた印が残っている） */
export function toggleFrom(anchor: HTMLElement): boolean {
  if (anchor.dataset.justClosed) {
    delete anchor.dataset.justClosed;
    return false;
  }
  return true;
}

export function openMenu(
  anchor: HTMLElement,
  entries: MenuEntry[],
  opts: { align?: "start" | "end"; level?: number; testid?: string; onClose?: () => void } = {},
): void {
  const level = opts.level ?? 0;
  closePopovers(level);
  const el = h("div", { class: "pop", attrs: { role: "menu" }, data: { testid: opts.testid ?? "backlog-menu" } });
  el.addEventListener("keydown", (e) => onPopKey(e, level));
  for (const entry of entries) {
    if (entry.type === "sep") {
      el.append(h("div", { class: "sep", attrs: { role: "separator" } }));
    } else if (entry.type === "label") {
      el.append(h("div", { class: "label", text: entry.text }));
    } else if (entry.type === "input") {
      const input = h("input", { attrs: { placeholder: entry.placeholder, "aria-label": entry.label } });
      input.addEventListener("keydown", (e) => {
        if (e.isComposing) return;
        if (e.key === "Enter" && input.value.trim() !== "") {
          e.preventDefault();
          const value = input.value.trim();
          closePopovers(0);
          entry.onEnter(value);
        }
      });
      el.append(h("div", { attrs: { style: "padding:4px" } }, input));
    } else if (entry.type === "sub") {
      const btn = h(
        "button",
        { class: "mi", attrs: { type: "button", role: "menuitem", "aria-haspopup": "menu" }, data: entry.testid ? { testid: entry.testid } : {} },
        h("span", { class: "t", text: entry.label }),
        h("span", { class: "sub" }, icon("ChevronRight")),
      );
      const openSub = () => {
        if (stack[level + 1]?.anchor === btn) return;
        btn.setAttribute("aria-expanded", "true");
        openMenu(btn, entry.entries, { level: level + 1, testid: "backlog-submenu" });
      };
      btn.addEventListener("click", openSub);
      btn.addEventListener("mouseenter", openSub);
      btn.addEventListener("keydown", (e) => {
        if (e.key === "ArrowRight" || e.key === "Enter") {
          e.preventDefault();
          openSub();
          focusables(stack[level + 1]!.el)[0]?.focus();
        }
      });
      el.append(btn);
    } else {
      const checkable = entry.checked !== undefined;
      const tick = h("span", { class: "tick" }, entry.checked ? icon("Check") : null);
      const btn = h(
        "button",
        {
          class: "mi",
          attrs: {
            type: "button",
            role: checkable ? "menuitemcheckbox" : "menuitem",
            ...(checkable ? { "aria-checked": String(entry.checked) } : {}),
          },
          data: entry.testid ? { testid: entry.testid } : {},
        },
        checkable ? tick : null,
        h("span", { class: "t", text: entry.label }),
      );
      btn.disabled = entry.disabled === true;
      // 下の段が開いていたら、別の行に乗ったところで閉じる
      btn.addEventListener("mouseenter", () => closePopovers(level + 1));
      btn.addEventListener("click", () => {
        if (checkable) {
          const now = btn.getAttribute("aria-checked") !== "true";
          btn.setAttribute("aria-checked", String(now));
          tick.replaceChildren(...(now ? [icon("Check")] : []));
          entry.onSelect();
          return;
        }
        closePopovers(0, true);
        entry.onSelect();
      });
      el.append(btn);
    }
  }
  anchor.setAttribute("aria-expanded", "true");
  stack.push({ el, anchor, ...(opts.onClose ? { onClose: opts.onClose } : {}) });
  place(el, anchor, level > 0 ? "side" : (opts.align ?? "start"));
  if (level === 0) focusables(el)[0]?.focus();
}

/** 項目を1つ選ぶ検索つきの小窓（依存の相手・親のストーリー） */
export function openPicker(
  anchor: HTMLElement,
  opts: {
    candidates: readonly BacklogItem[];
    items: readonly BacklogItem[];
    placeholder: string;
    emptyText?: string;
    onPick: (id: string) => void;
  },
): void {
  closePopovers(0);
  const el = h("div", { class: "pop wide", attrs: { role: "dialog", "aria-label": opts.placeholder }, data: { testid: "backlog-picker" } });
  const input = h("input", { attrs: { placeholder: opts.placeholder, "aria-label": opts.placeholder } });
  const results = h("div", { class: "results", attrs: { role: "listbox" } });
  let active = 0;
  let shown: BacklogItem[] = [];
  const render = () => {
    const q = input.value.trim().toLowerCase();
    shown = opts.candidates.filter((c) => q === "" || `${c.title} ${c.id}`.toLowerCase().includes(q));
    active = Math.min(active, Math.max(0, shown.length - 1));
    results.replaceChildren(
      ...(shown.length === 0
        ? [h("div", { class: "none", text: opts.emptyText ?? "合う項目がありません" })]
        : shown.map((c, i) => {
            const btn = h(
              "button",
              { class: "mi", attrs: { type: "button", role: "option", "aria-selected": String(i === active) }, data: { testid: "backlog-picker-option" } },
              itemMark(c, opts.items, true),
              h("span", { class: "t", text: c.title }),
              c.kind !== "task" ? h("span", { class: "k", text: KIND_LABEL[c.kind] }) : null,
            );
            if (i === active) btn.dataset.active = "";
            btn.addEventListener("click", () => {
              closePopovers(0, true);
              opts.onPick(c.id);
            });
            return btn;
          })),
    );
  };
  input.addEventListener("input", () => {
    active = 0;
    render();
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (shown.length > 0) active = (active + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
      render();
      results.querySelector<HTMLElement>("[data-active]")?.scrollIntoView({ block: "nearest" });
      e.stopPropagation();
      return;
    }
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      const pick = shown[active];
      if (pick) {
        closePopovers(0, true);
        opts.onPick(pick.id);
      }
      e.stopPropagation();
      return;
    }
    onPopKey(e, 0);
  });
  el.append(h("div", { class: "search" }, input), results);
  render();
  anchor.setAttribute("aria-expanded", "true");
  stack.push({ el, anchor });
  place(el, anchor, "start");
  input.focus();
}
