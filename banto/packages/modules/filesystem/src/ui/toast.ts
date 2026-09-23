// 画面の右下に出る短い知らせ（モックの sonner と同じ役）。**失敗も同じ場所に出す**
// ——黙って何も起きない、を作らない（規則2）。

import { h } from "./dom.js";

let container: HTMLElement | undefined;

export function toast(title: string, options: { description?: string; error?: boolean } = {}): void {
  if (!container) {
    container = h("div", { class: "toasts", attrs: { role: "status", "aria-live": "polite" } });
    document.body.appendChild(container);
  }
  const el = h(
    "div",
    { class: options.error ? "toast error" : "toast", data: { testid: "toast" } },
    h("div", { class: "title", text: title }),
    options.description ? h("div", { class: "desc", text: options.description }) : null,
  );
  container.appendChild(el);
  // 並べすぎると中身を覆う——古いものから消す
  while (container.childElementCount > 3) container.firstElementChild?.remove();
  // 失敗は長めに残す（読む前に消えると、何が起きたか分からない）
  setTimeout(() => el.remove(), options.error ? 8000 : 3500);
}
