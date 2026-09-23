// 要素を組み立てる小道具。**文字は必ず textContent で入れる**（innerHTML に
// 人の文字列を入れない——ファイル名にも中身にも他人の文字が入りうる）。

export type Child = Node | string | null | undefined | false;

export interface Props {
  class?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string>;
  data?: Record<string, string>;
  on?: { [E in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[E]) => void };
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.title) el.title = props.title;
  for (const [k, v] of Object.entries(props.attrs ?? {})) el.setAttribute(k, v);
  for (const [k, v] of Object.entries(props.data ?? {})) el.dataset[k] = v;
  for (const [event, handler] of Object.entries(props.on ?? {})) {
    el.addEventListener(event, handler as EventListener);
  }
  append(el, ...children);
  return el;
}

export function append(parent: Node, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
}

export function replaceChildren(parent: Element, ...children: Child[]): void {
  parent.replaceChildren();
  append(parent, ...children);
}
