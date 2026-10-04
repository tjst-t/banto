// Backlog の入口（launcher）の画面。モック（mock/components/banto/canvas/backlog-view.tsx・backlog-list.tsx・
// backlog-detail.tsx・backlog-forms.tsx）を素の DOM に写したもの。形を決めた経緯は
// docs/notes/2026-10-02-backlog-ui-survey.md：
//   - 上の段は1行。絞り込みの札を並べず、**見方**（次にやる／すべて／バグ／閉じたもの）を切り替える
//   - 一覧は1項目1行。左端の印：タスク・バグは状態の輪、ストーリーは子の進みで満ちる四角。
//     「次にやる」ではタスクの題の頭にストーリー名を薄く付ける
//   - 行を押す／Enter で右に詳細（Peek）。↑↓（j/k）で選び、Esc で閉じる、C で足す
//   - 足すのは一覧の中でその場に打つ。並べ替えはドラッグと行のメニュー
//
// **書くのは全部 Module の tool**（admin の board* ——書いた後の一覧ごと返る）。画面は値を作らない。
// AI や手で変わったものを出すため、**見えている間は数秒ごとに読み直す**（版が同じなら中身は送られない）。
//
// 描き方：状態から全部を描き直す。打っている途中の文字は状態に持ち、描き直したらフォーカスと
// スクロールを戻す。読み直しは、打っている間・小窓が開いている間・ドラッグ中には当てない。

import {
  childrenOf,
  dependents,
  isClosed,
  parseNumberRef,
  rankState,
  waitingOn,
  type BacklogDocument,
  type BacklogItem,
  type BacklogKind,
  type BacklogPriority,
  type BacklogStatus,
} from "../model.js";
import { append, h, type Child } from "./dom.js";
import { icon } from "./icons.js";
import {
  KIND_LABEL,
  PRIORITY_LABEL,
  RANK_STATE_LABEL,
  STATUS_LABEL,
  bugTag,
  formatDate,
  itemMark,
  markdownBody,
  numberTag,
  priorityMark,
  rankMark,
} from "./parts.js";
import { isPopoverOpen, openMenu, openPicker, toggleFrom, type MenuEntry } from "./popover.js";
import { callTool, errorMessage, type CallToolResult } from "./protocol.js";
import { toast } from "./toast.js";

/** getBoard・board* の返す形（tools.ts の board()） */
export interface BoardData {
  state: "missing" | "refused" | "ok";
  root: { path: string; name: string };
  /** 一覧を置くブランチ */
  branch: string;
  version: string;
  /** origin との様子（store.ts の SyncState） */
  sync?: { origin: boolean; ahead: number; behind: number; diverged: boolean; pushError?: string; fetchError?: string };
  /** ブランチがまだ無く、作業ツリーに一覧が残っているとき——移すコマンド */
  leftover?: { path: string; command: string };
  /** Project の根が git のリポジトリでない（書けない） */
  notRepository?: string;
  doc?: BacklogDocument;
  problems?: string[];
  reason?: string;
  legacy?: boolean;
  /** 古い形のとき、変換のコマンド */
  convertCommand?: string;
}

type ViewId = "next" | "all" | "bugs" | "closed";

const VIEWS: readonly { id: ViewId; label: string }[] = [
  { id: "next", label: "次にやる" },
  { id: "all", label: "すべて" },
  { id: "bugs", label: "バグ" },
  { id: "closed", label: "閉じたもの" },
];

const POLL_MS = 3000;

interface ListNode {
  item: BacklogItem;
  children?: ListNode[];
  closedKids?: BacklogItem[];
  /** 題の頭に薄く付けるストーリー名 */
  story?: string;
  /** 行の右に薄く添える文脈（閉じた日など） */
  context?: string;
  /** やめた理由など */
  note?: string;
}

interface ListGroup {
  id: string;
  title: string;
  hint?: string;
  nodes: ListNode[];
  /** この区切りの末尾に「足す」を出す（足すときのマイルストーン）。undefined なら出さない */
  composerMilestone?: string | null;
  sortable: boolean;
}

interface Composer {
  kind: BacklogKind;
  title: string;
  count: number;
}

interface Filters {
  milestones: Set<string>;
  labels: Set<string>;
}

function boardOf(result: CallToolResult): BoardData {
  const data = result.structuredContent as (BoardData & { unchanged?: boolean }) | undefined;
  if (!data || typeof data.state !== "string") throw new Error("一覧の結果を読み取れませんでした");
  return data;
}

function matches(item: BacklogItem, f: Filters): boolean {
  if (f.milestones.size > 0 && !f.milestones.has(item.milestone ?? "none")) return false;
  if (f.labels.size > 0 && !item.labels.some((l) => f.labels.has(l))) return false;
  return true;
}

function buildGroups(view: ViewId, doc: BacklogDocument, f: Filters): ListGroup[] {
  const items = doc.items;
  const open = items.filter((i) => !isClosed(i) && matches(i, f));
  const storyTitle = (i: BacklogItem) => (i.parent ? items.find((p) => p.id === i.parent)?.title : undefined);

  if (view === "next") {
    // 動かせるものだけ：進めている、と、着手できる。ストーリーは子で動くので出さない
    const work = open.filter((i) => i.kind !== "story");
    const doing = work.filter((i) => i.status === "in-progress");
    const actionable = work.filter((i) => rankState(i, items) === "actionable");
    const rest = work.length - doing.length - actionable.length;
    const toNode = (i: BacklogItem): ListNode => {
      const story = storyTitle(i);
      return story ? { item: i, story } : { item: i };
    };
    const groups: ListGroup[] = [
      { id: "doing", title: "進めている", nodes: doing.map(toNode), sortable: true },
      {
        id: "actionable",
        title: "着手できる",
        ...(rest > 0 ? { hint: `ほかに待っているもの・積んだだけのものが ${rest} 件（「すべて」で見る）` } : {}),
        nodes: actionable.map(toNode),
        sortable: true,
      },
    ];
    return groups.filter((g) => g.nodes.length > 0 || g.id === "actionable");
  }

  if (view === "bugs") {
    return [
      {
        id: "bugs",
        title: "バグ",
        nodes: open.filter((i) => i.kind === "bug").map((i) => ({ item: i })),
        composerMilestone: null,
        sortable: true,
      },
    ];
  }

  if (view === "closed") {
    const closed = items
      .filter((i) => isClosed(i) && matches(i, f))
      .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""));
    return [
      {
        id: "closed",
        title: "閉じたもの",
        hint: "閉じた日の新しい順",
        nodes: closed.map((i) => ({
          item: i,
          ...(i.status === "dropped" && i.resolution ? { note: `やめた：${i.resolution}` } : {}),
          ...(i.closedAt ? { context: formatDate(i.closedAt) } : {}),
        })),
        sortable: false,
      },
    ];
  }

  // すべて：マイルストーンごと。ストーリーの下に子（終わっていないもの）、閉じた子は畳む
  const top = open.filter((i) => i.parent === null || !open.some((p) => p.id === i.parent));
  const toNode = (i: BacklogItem): ListNode => {
    if (i.kind !== "story") {
      const story = i.parent ? storyTitle(i) : undefined;
      return story ? { item: i, story } : { item: i };
    }
    const kids = childrenOf(i, items);
    return {
      item: i,
      children: kids.filter((k) => !isClosed(k) && matches(k, f)).map((k) => ({ item: k })),
      closedKids: kids.filter(isClosed),
    };
  };
  const groups: ListGroup[] = doc.milestones
    .filter((m) => m.status === "open")
    .map((m) => ({
      id: `m:${m.id}`,
      title: m.title,
      nodes: top.filter((i) => i.milestone === m.id).map(toNode),
      composerMilestone: m.id,
      sortable: true,
    }));
  groups.push({
    id: "none",
    title: "マイルストーン無し",
    nodes: top
      .filter((i) => i.milestone === null || !doc.milestones.some((m) => m.id === i.milestone && m.status === "open"))
      .map(toNode),
    composerMilestone: null,
    sortable: true,
  });
  return groups.filter((g) => g.nodes.length > 0 || g.id === "none");
}

/** キーボードで動くときの順（畳んだストーリーの子は飛ばす） */
function flattenIds(groups: readonly ListGroup[], collapsed: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const walk = (nodes: readonly ListNode[]) => {
    for (const node of nodes) {
      out.push(node.item.id);
      if (node.children && !collapsed.has(node.item.id)) walk(node.children);
    }
  };
  for (const g of groups) walk(g.nodes);
  return out;
}

function toggled(set: ReadonlySet<string>, v: string): Set<string> {
  const next = new Set(set);
  if (next.has(v)) next.delete(v);
  else next.add(v);
  return next;
}

export class BacklogBoard {
  private data: BoardData | null = null;
  private loadError: string | null = null;
  private view: ViewId = "next";
  private selectedId: string | null = null;
  private peek = false;
  private collapsed = new Set<string>();
  private shownClosed = new Set<string>();
  private filters: Filters = { milestones: new Set(), labels: new Set() };
  /** 開いている「足す」——キーは "top"・"group:<id>"・"story:<id>" */
  private composers = new Map<string, Composer>();
  private editingTitle: string | null = null;
  private editingText: { field: "doneWhen" | "body"; draft: string } | null = null;
  private dropping: string | null = null;
  private splitting: { text: string; chain: boolean } | null = null;
  private drag: { id: string; siblings: string[]; target?: { id: string; where: "before" | "after" } } | null = null;
  private writing = 0;
  private readonly screen: HTMLElement;

  constructor(private readonly host: HTMLElement) {
    this.screen = h("div", { class: "screen", attrs: { tabindex: "-1" }, data: { testid: "backlog-view" } });
    this.screen.addEventListener("keydown", (e) => this.onKeyDown(e));
    host.replaceChildren(this.screen);
    this.render();
    void this.load();
    window.setInterval(() => void this.poll(), POLL_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void this.poll();
    });
  }

  // ---- 読む・書く ----

  private async load(): Promise<void> {
    try {
      // 開いたときだけ origin から取ってくる（3秒ごとの読み直しでは取ってこない）
      this.apply(boardOf(await callTool("getBoard", { fetch: true })));
      this.loadError = null;
    } catch (err) {
      this.loadError = errorMessage(err);
    }
    this.render();
    this.screen.focus({ preventScroll: true });
  }

  /** 読み直し。打っている間・小窓・ドラッグ・書いている途中は当てない（次の回に回す） */
  private async poll(): Promise<void> {
    if (document.visibilityState !== "visible" || this.writing > 0 || this.drag || isPopoverOpen()) return;
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
    try {
      const result = await callTool("getBoard", this.data ? { since: this.data.version } : {});
      const data = result.structuredContent as { unchanged?: boolean } | undefined;
      if (data?.unchanged) return;
      // 待っている間に打ち始めたなら、描き直さない（次の回に回す）
      const now = document.activeElement;
      if (this.writing > 0 || isPopoverOpen() || now instanceof HTMLInputElement || now instanceof HTMLTextAreaElement) return;
      this.apply(boardOf(result));
      this.loadError = null;
      this.render();
    } catch {
      // 読み直しの失敗は黙って次の回へ——前に見えていたものを消さない（書く操作の失敗は必ず知らせる）
    }
  }

  private apply(data: BoardData): void {
    this.data = data;
    const items = data.doc?.items ?? [];
    if (this.selectedId && !items.some((i) => i.id === this.selectedId)) {
      this.selectedId = null;
      this.peek = false;
    }
  }

  private get doc(): BacklogDocument | undefined {
    return this.data?.state === "ok" ? this.data.doc : undefined;
  }

  private get items(): BacklogItem[] {
    return this.doc?.items ?? [];
  }

  /** 書く。結果の一覧で描き直す。**失敗は必ず知らせる**（黙って戻さない、規則2） */
  private async write(tool: string, args: Record<string, unknown>): Promise<boolean> {
    this.writing++;
    try {
      this.apply(boardOf(await callTool(tool, args)));
      return true;
    } catch (err) {
      toast("変えられませんでした", { description: errorMessage(err), error: true });
      return false;
    } finally {
      this.writing--;
      this.render();
    }
  }

  private update(id: string, patch: Record<string, unknown>): Promise<boolean> {
    return this.write("boardUpdateItem", { id, ...patch });
  }

  // ---- キー操作 ----

  private order(): string[] {
    const doc = this.doc;
    return doc ? flattenIds(buildGroups(this.view, doc, this.filters), this.collapsed) : [];
  }

  private step(delta: -1 | 1): void {
    const order = this.order();
    if (order.length === 0) return;
    const at = this.selectedId ? order.indexOf(this.selectedId) : -1;
    const next = at < 0 ? (delta === 1 ? 0 : order.length - 1) : Math.min(order.length - 1, Math.max(0, at + delta));
    this.select(order[next]!);
  }

  private select(id: string, open = this.peek): void {
    this.selectedId = id;
    this.peek = open;
    this.resetDetailDrafts();
    this.render();
    this.screen
      .querySelector(`[data-item-id="${CSS.escape(id)}"] > [data-testid="backlog-row"]`)
      ?.scrollIntoView({ block: "nearest" });
  }

  private resetDetailDrafts(): void {
    this.editingTitle = null;
    this.editingText = null;
    this.dropping = null;
    this.splitting = null;
  }

  private closePeek(): void {
    this.peek = false;
    this.resetDetailDrafts();
    this.render();
    this.screen.focus({ preventScroll: true });
  }

  private onKeyDown(e: KeyboardEvent): void {
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, [contenteditable=true], .pop")) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!this.doc) return;
    if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault();
      this.step(1);
    } else if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault();
      this.step(-1);
    } else if (e.key === "Enter" && this.selectedId && !t.closest("button, a")) {
      e.preventDefault();
      this.select(this.selectedId, true);
    } else if (e.key === "Escape" && this.peek) {
      e.preventDefault();
      this.closePeek();
    } else if (e.key === "c" || e.key === "C") {
      e.preventDefault();
      this.openComposer("top");
    } else if (e.key === "#") {
      // 番号で開く——絞り込みの小窓の先頭の欄に打つ（# そのものは欄に入れない）
      e.preventDefault();
      this.screen.querySelector<HTMLButtonElement>('[data-focus="filter"]')?.click();
    }
  }

  /** 番号（42・#42）で開く。どの見方にいても開く（詳細は一覧の全部から引く）。無ければ知らせる */
  private openByNumber(text: string): void {
    const n = parseNumberRef(text);
    const item = n === undefined ? undefined : this.items.find((i) => i.number === n);
    if (!item) {
      toast(n === undefined ? "番号は #42 か 42 の形で打ちます" : `#${n} はありません`, { error: true });
      return;
    }
    this.select(item.id, true);
  }

  private openComposer(key: string, kind?: BacklogKind): void {
    if (!this.composers.has(key)) {
      this.composers.set(key, { kind: kind ?? (this.view === "bugs" ? "bug" : "task"), title: "", count: 0 });
    }
    this.render();
    this.screen.querySelector<HTMLInputElement>(`[data-focus="composer:${CSS.escape(key)}"]`)?.focus();
  }

  private closeComposer(key: string): void {
    this.composers.delete(key);
    this.render();
    this.screen.focus({ preventScroll: true });
  }

  // ---- 描く ----

  private render(): void {
    // 描き直しても、フォーカス・打っている途中の位置・スクロールを保つ
    const active = document.activeElement as HTMLElement | null;
    const focusKey = active && this.screen.contains(active) ? active.dataset.focus : undefined;
    const selection =
      active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
        ? [active.selectionStart, active.selectionEnd]
        : null;
    const scrolls = new Map<string, number>();
    for (const el of this.screen.querySelectorAll<HTMLElement>("[data-scroll]")) scrolls.set(el.dataset.scroll!, el.scrollTop);
    const rootFocused = active === this.screen;

    this.screen.replaceChildren();
    append(this.screen, ...this.renderScreen());

    for (const el of this.screen.querySelectorAll<HTMLElement>("[data-scroll]")) {
      const top = scrolls.get(el.dataset.scroll!);
      if (top !== undefined) el.scrollTop = top;
    }
    if (focusKey) {
      const next = this.screen.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focusKey)}"]`);
      if (next) {
        next.focus({ preventScroll: true });
        if (selection && (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement)) {
          next.setSelectionRange(selection[0], selection[1]);
        }
      } else {
        this.screen.focus({ preventScroll: true });
      }
    } else if (rootFocused) {
      this.screen.focus({ preventScroll: true });
    }
  }

  private renderScreen(): Child[] {
    const data = this.data;
    const selected = this.peek && this.selectedId ? this.items.find((i) => i.id === this.selectedId) : undefined;
    this.screen.classList.toggle("peeking", Boolean(selected));
    const list = h(
      "div",
      { class: "list-pane", data: { testid: "backlog-list-pane" } },
      this.renderHead(),
      h("div", { class: "body", data: { scroll: "list" } }, h("div", { class: "wrap" }, ...this.renderBody())),
    );
    if (!data || !selected || !this.doc) return [list];
    return [
      list,
      h(
        "aside",
        { class: "detail-pane", attrs: { "aria-label": `「${selected.title}」の詳細` } },
        this.renderDetail(this.doc, selected),
      ),
    ];
  }

  private renderHead(): HTMLElement {
    const data = this.data;
    const doc = this.doc;
    const tools = h("div", { class: "head-tools" });
    if (data?.state !== "refused") {
      const filterCount = this.filters.milestones.size + this.filters.labels.size;
      const filterBtn = h(
        "button",
        { class: "btn ghost", attrs: { type: "button", "aria-haspopup": "menu" }, data: { testid: "backlog-filter", focus: "filter" } },
        icon("ListFilter"),
        "絞り込み",
        filterCount > 0 ? h("span", { class: "filter-count", text: String(filterCount) }) : null,
      );
      filterBtn.disabled = !doc;
      filterBtn.addEventListener("click", () => {
        if (toggleFrom(filterBtn)) openMenu(filterBtn, this.filterEntries(), { align: "end", testid: "backlog-filter-menu" });
      });
      const addBtn = h(
        "button",
        { class: "btn primary", attrs: { type: "button" }, data: { testid: "backlog-add-open", focus: "add-open" } },
        icon("Plus"),
        "足す",
      );
      addBtn.disabled = !data;
      addBtn.addEventListener("click", () => this.openComposer("top"));
      tools.append(filterBtn, addBtn);
    }
    const head = h(
      "header",
      { class: "head" },
      h(
        "div",
        { class: "wrap" },
        h(
          "div",
          { class: "head-row" },
          h("h2", { text: "Backlog" }),
          data
            ? h("span", {
                class: "source truncate",
                text: data.branch,
                title: `${data.root.path} の ${data.branch} ブランチ（中は tasks.json）`,
                data: { testid: "backlog-source" },
              })
            : null,
          tools,
        ),
        data?.state === "refused" ? h("div", { attrs: { style: "height:4px" } }) : this.renderViews(),
      ),
    );
    return head;
  }

  private filterEntries(): MenuEntry[] {
    const doc = this.doc;
    if (!doc) return [];
    const labels = [...new Set(doc.items.flatMap((i) => i.labels))].sort((a, b) => a.localeCompare(b, "ja"));
    const entries: MenuEntry[] = [
      { type: "input", label: "番号で開く", placeholder: "#42 で開く", testid: "backlog-jump", onEnter: (v) => this.openByNumber(v) },
      { type: "sep" },
    ];
    if (doc.milestones.length > 0) {
      entries.push({ type: "label", text: "マイルストーン" });
      for (const m of [...doc.milestones, { id: "none", title: "マイルストーン無し" }]) {
        entries.push({
          type: "item",
          label: m.title,
          checked: this.filters.milestones.has(m.id),
          onSelect: () => {
            this.filters = { ...this.filters, milestones: toggled(this.filters.milestones, m.id) };
            this.render();
          },
        });
      }
      entries.push({ type: "sep" });
    }
    entries.push({ type: "label", text: "ラベル" });
    if (labels.length === 0) entries.push({ type: "item", label: "ラベルはまだありません", disabled: true, onSelect: () => undefined });
    for (const l of labels) {
      entries.push({
        type: "item",
        label: l,
        checked: this.filters.labels.has(l),
        onSelect: () => {
          this.filters = { ...this.filters, labels: toggled(this.filters.labels, l) };
          this.render();
        },
      });
    }
    return entries;
  }

  private renderViews(): HTMLElement {
    const items = this.items;
    const counts: Record<ViewId, number> = {
      next: items.filter((i) => i.kind !== "story" && (i.status === "in-progress" || rankState(i, items) === "actionable")).length,
      all: items.filter((i) => !isClosed(i)).length,
      bugs: items.filter((i) => i.kind === "bug" && !isClosed(i)).length,
      closed: items.filter(isClosed).length,
    };
    return h(
      "nav",
      { class: "views", attrs: { "aria-label": "見方" }, data: { testid: "backlog-views" } },
      ...VIEWS.map((v) => {
        const b = h(
          "button",
          {
            attrs: { type: "button", ...(this.view === v.id ? { "aria-current": "page" } : {}) },
            data: { testid: `backlog-view-${v.id}`, focus: `view:${v.id}` },
          },
          v.label,
          h("span", { class: "count", text: String(counts[v.id]) }),
        );
        b.addEventListener("click", () => {
          this.view = v.id;
          this.composers.delete("top");
          this.render();
        });
        return b;
      }),
    );
  }

  private renderBody(): Child[] {
    const data = this.data;
    if (!data) {
      return [
        h("p", {
          class: "quiet-text",
          text: this.loadError ? `一覧を読めませんでした：${this.loadError}` : "読み込んでいます…",
          data: { testid: "backlog-loading" },
        }),
      ];
    }
    // 書けない（Project の根が git のリポジトリでない）——足す誘いは出さない
    if (data.notRepository) {
      return [h("div", { class: "notice warn", attrs: { role: "status" }, data: { testid: "backlog-not-repository" } }, icon("TriangleAlert"), h("p", { text: data.notRepository }))];
    }
    const sync = this.renderSync(data);
    if (data.state === "refused") return [...(sync ? [sync] : []), this.renderRefused(data)];
    const doc = data.doc ?? { format: "banto-backlog/1" as const, milestones: [], items: [] };
    const out: Child[] = [];
    if (sync) out.push(sync);
    if (data.state === "missing") {
      out.push(
        h(
          "div",
          { class: "notice", data: { testid: "backlog-missing" } },
          h(
            "div",
            {},
            h("p", {}, "まだ一覧のブランチ ", h("code", { text: data.branch }), " がありません。最初の項目を足すと、コードの履歴とつながらないブランチとして作ります。"),
            data.leftover
              ? h(
                  "p",
                  { data: { testid: "backlog-leftover" } },
                  "作業ツリーに ",
                  h("code", { text: data.leftover.path }),
                  " があります。ブランチへ移すには（自動では移しません）：",
                  h("code", { class: "cmd", text: data.leftover.command, data: { testid: "backlog-move-command" } }),
                )
              : null,
          ),
        ),
      );
    }
    if ((data.problems ?? []).length > 0) {
      out.push(
        h(
          "div",
          { class: "notice warn", attrs: { role: "status" }, data: { testid: "backlog-problems" } },
          icon("TriangleAlert"),
          h(
            "div",
            {},
            h("p", { text: "一覧に直すところがあります（手で直したときに入ったもの）。この問題を増やす変更は断ります。" }),
            h("ul", {}, ...(data.problems ?? []).map((p) => h("li", { text: p }))),
          ),
        ),
      );
    }
    const filterCount = this.filters.milestones.size + this.filters.labels.size;
    if (filterCount > 0) {
      const clear = h("button", { class: "linkish", text: "外す", attrs: { type: "button" } });
      clear.addEventListener("click", () => {
        this.filters = { milestones: new Set(), labels: new Set() };
        this.render();
      });
      out.push(h("p", { class: "filtering" }, "絞り込み中", clear));
    }
    if (this.composers.has("top")) out.push(this.renderComposer("top", null));
    const groups = buildGroups(this.view, doc, this.filters);
    if (doc.items.length === 0 && !this.composers.has("top")) {
      out.push(this.renderInvite());
    } else if (groups.every((g) => g.nodes.length === 0)) {
      out.push(this.renderEmpty());
    }
    if (doc.items.length > 0) {
      out.push(this.renderGroups(doc, groups.filter((g) => g.nodes.length > 0 || g.composerMilestone !== undefined)));
    }
    out.push(h("p", { class: "keys", text: "↑↓ で選ぶ　Enter で開く　Esc で閉じる　C で足す　# で番号から開く　行はつかんで並べ替え（上ほど先にやる）" }));
    return out;
  }

  /** origin との様子で、知らせることがあれば（食い違い・送っていない・取ってこれなかった）。無ければ null */
  private renderSync(data: BoardData): HTMLElement | null {
    const sync = data.sync;
    if (!sync?.origin) return null;
    const lines: Child[] = [];
    if (sync.diverged) {
      lines.push(
        h("p", { data: { testid: "backlog-sync-diverged" } }, `手元と origin の ${data.branch} が分かれています（手元だけに ${sync.ahead} 件・origin だけに ${sync.behind} 件）。揃えるまで書き込みません。`),
      );
    } else if (sync.ahead > 0) {
      lines.push(h("p", { data: { testid: "backlog-sync-ahead" } }, `origin に送っていない変更が ${sync.ahead} 件あります。`));
      if (sync.pushError) lines.push(h("p", { class: "quiet-text", text: `送れなかった理由：${sync.pushError}`, data: { testid: "backlog-sync-push-error" } }));
    }
    // 取ってこれなかった理由は、送れなかった理由と同じなら重ねて出さない（同じ origin に届かないだけ）
    if (sync.fetchError && sync.fetchError !== sync.pushError) {
      lines.push(h("p", { class: "quiet-text", text: `origin から取ってこれませんでした：${sync.fetchError}`, data: { testid: "backlog-sync-fetch-error" } }));
    }
    if (lines.length === 0) return null;
    return h("div", { class: "notice warn", attrs: { role: "status" }, data: { testid: "backlog-sync" } }, icon("TriangleAlert"), h("div", {}, ...lines));
  }

  private renderRefused(data: BoardData): HTMLElement {
    return h(
      "div",
      { class: "refused", data: { testid: "backlog-refused" } },
      h("h3", {}, "ブランチ ", h("code", { text: data.branch }), " の tasks.json を読めません"),
      h("p", { text: data.reason ?? "" }),
      data.legacy
        ? h(
            "p",
            {},
            "Backlog はこの中身を読まず、書き込みもしません（壊さないため）。書き出して変換のスクリプトで ",
            h("code", { text: "banto-backlog/1" }),
            " に読み替え、中身を確かめてからブランチへ移し直します：",
          )
        : h("p", { text: "ブランチの中身を直すと、ここに一覧が出ます。" }),
      data.convertCommand ? h("p", {}, h("code", { class: "cmd", text: data.convertCommand, data: { testid: "backlog-convert-command" } })) : null,
      h("p", { class: "quiet-text", text: "別のブランチを使うなら、設定の Backlog でブランチ名を変えられます。" }),
    );
  }

  private renderInvite(): HTMLElement {
    const add = h("button", { class: "btn primary", attrs: { type: "button" }, data: { testid: "backlog-invite-add" } }, icon("Plus"), "足す");
    add.addEventListener("click", () => this.openComposer("top"));
    return h("div", { class: "empty", data: { testid: "backlog-empty" } }, h("p", { text: "まだ何も積んでいません。" }), add);
  }

  private renderEmpty(): HTMLElement {
    if (this.view === "next") {
      const all = h("button", { class: "btn", attrs: { type: "button" }, text: "すべてを見る" });
      all.addEventListener("click", () => {
        this.view = "all";
        this.render();
      });
      return h(
        "div",
        { class: "empty", data: { testid: "backlog-empty" } },
        h("p", { text: "いま着手できるものはありません。待っているものと積んだだけのものは「すべて」にあります。" }),
        all,
      );
    }
    const text = this.view === "bugs" ? "開いているバグはありません。" : this.view === "closed" ? "まだ閉じたものはありません。" : "まだ何も積んでいません。";
    return h("div", { class: "empty", data: { testid: "backlog-empty" } }, h("p", { text }));
  }

  // ---- 一覧 ----

  private renderGroups(doc: BacklogDocument, groups: ListGroup[]): HTMLElement {
    return h(
      "div",
      { class: "groups", data: { testid: "backlog-list" } },
      ...groups.map((g) => {
        const section = h(
          "section",
          { attrs: { "aria-labelledby": `backlog-group-${g.id}` }, class: "group", data: { testid: "backlog-section", section: g.id } },
          h(
            "h3",
            { attrs: { id: `backlog-group-${g.id}` } },
            g.title,
            h("span", { class: "n", text: String(g.nodes.length) }),
            g.hint ? h("span", { class: "hint", text: g.hint }) : null,
          ),
        );
        if (g.nodes.length > 0) section.append(h("ul", { class: "rows" }, ...this.renderNodes(doc, g.nodes, g, 0)));
        if (g.composerMilestone !== undefined) {
          const key = `group:${g.id}`;
          if (this.composers.has(key)) {
            section.append(this.renderComposer(key, g.composerMilestone));
          } else {
            const add = h(
              "button",
              { class: "group-add", attrs: { type: "button" }, data: { testid: "backlog-group-add", focus: `group-add:${g.id}` } },
              icon("Plus"),
              "足す",
            );
            add.addEventListener("click", () => this.openComposer(key, this.view === "bugs" ? "bug" : "task"));
            section.append(add);
          }
        }
        return section;
      }),
    );
  }

  private renderNodes(doc: BacklogDocument, nodes: readonly ListNode[], group: ListGroup, depth: 0 | 1): HTMLElement[] {
    const siblingIds = nodes.map((n) => n.item.id);
    return nodes.map((node, index) => {
      const { item } = node;
      const isStory = item.kind === "story";
      const open = !this.collapsed.has(item.id);
      const kids = [...(node.children?.map((c) => c.item) ?? []), ...(node.closedKids ?? [])];
      const hasKids = kids.length > 0;
      const li = h("li", { data: { testid: "backlog-row-item", itemId: item.id } });
      li.append(this.renderRow(doc, node, group, depth, siblingIds, index, hasKids, open, kids));
      const storyKey = `story:${item.id}`;
      if (isStory && open && (hasKids || this.composers.has(storyKey))) {
        const box = h("div", { class: "kids" });
        if (node.children && node.children.length > 0) {
          box.append(
            h("ul", { class: "rows", attrs: { "aria-label": `「${item.title}」のタスク` } }, ...this.renderNodes(doc, node.children, group, 1)),
          );
        }
        if (node.closedKids && node.closedKids.length > 0) box.append(this.renderClosedKids(item.id, node.closedKids));
        if (this.composers.has(storyKey)) box.append(this.renderComposer(storyKey, item.milestone, item));
        li.append(box);
      }
      return li;
    });
  }

  private renderClosedKids(storyId: string, kids: readonly BacklogItem[]): HTMLElement {
    const items = this.items;
    if (!this.shownClosed.has(storyId)) {
      const b = h(
        "button",
        { class: "closed-kids", attrs: { type: "button" }, data: { testid: "backlog-closed-kids" } },
        rankMark("done", true),
        `閉じたタスク ${kids.length} 件を出す`,
      );
      b.addEventListener("click", () => {
        this.shownClosed = new Set(this.shownClosed).add(storyId);
        this.render();
      });
      return b;
    }
    return h(
      "ul",
      { class: "rows", attrs: { "aria-label": "閉じたタスク" } },
      ...kids.map((k) => {
        const b = h(
          "button",
          { class: "closed-row", attrs: { type: "button" }, data: { focus: `row:${k.id}`, ...(this.selectedId === k.id ? { selected: "" } : {}) } },
          rankMark(rankState(k, items), true),
          numberTag(k),
          h("span", { class: "t", text: k.title }),
        );
        b.addEventListener("click", () => this.select(k.id, true));
        return h("li", { data: { testid: "backlog-row-item", itemId: k.id } }, b);
      }),
    );
  }

  private renderRow(
    doc: BacklogDocument,
    node: ListNode,
    group: ListGroup,
    depth: 0 | 1,
    siblingIds: string[],
    index: number,
    hasKids: boolean,
    open: boolean,
    kids: readonly BacklogItem[],
  ): HTMLElement {
    const items = doc.items;
    const { item } = node;
    const state = rankState(item, items);
    const closed = isClosed(item);
    const waiting = closed ? [] : waitingOn(item, items);
    const isStory = item.kind === "story";
    const row = h("div", {
      class: "row",
      data: { testid: "backlog-row", state, ...(this.selectedId === item.id ? { selected: "" } : {}) },
    });
    if (group.sortable) {
      row.draggable = true;
      row.append(icon("GripVertical", "icon grip"));
      this.wireDrag(row, item.id, siblingIds);
    }
    if (isStory && hasKids) {
      const chev = h(
        "button",
        {
          class: "chev",
          attrs: {
            type: "button",
            "aria-expanded": String(open),
            "aria-label": open ? `「${item.title}」のタスクを畳む` : `「${item.title}」のタスクを開く`,
          },
          data: { focus: `chev:${item.id}` },
        },
        icon("ChevronRight"),
      );
      chev.addEventListener("click", () => {
        this.collapsed = toggled(this.collapsed, item.id);
        this.render();
      });
      row.append(chev);
    } else {
      row.append(h("span", { class: "chev-space", attrs: { "aria-hidden": "true" } }));
    }
    const titleClass = ["row-title"];
    if (closed) titleClass.push("closed");
    else if (state === "waiting" || state === "backlog") titleClass.push("dim");
    if (isStory) titleClass.push("story", ...(depth === 0 ? ["top"] : []));
    const right = h("span", { class: "row-right" });
    if (!closed) {
      const p = priorityMark(item.priority);
      if (p) right.append(p);
    }
    if (node.context) right.append(h("span", { class: "row-context", text: node.context }));
    if (isStory) {
      const counted = kids.filter((k) => k.status !== "dropped");
      if (counted.length > 0) {
        right.append(
          h("span", {
            class: "progress",
            text: `${counted.filter((k) => k.status === "done").length}/${counted.length}`,
            data: { testid: "backlog-progress" },
          }),
        );
      }
    }
    const openBtn = h(
      "button",
      {
        class: "row-open",
        attrs: { type: "button", ...(this.selectedId === item.id ? { "aria-current": "true" } : {}) },
        data: { testid: "backlog-row-open", focus: `row:${item.id}` },
      },
      itemMark(item, items, depth === 1),
      numberTag(item),
      item.kind === "bug" ? bugTag() : null,
      node.story ? h("span", { class: "row-story", text: node.story, title: node.story, data: { testid: "backlog-row-story" } }) : null,
      node.story ? h("span", { class: "row-sep", text: "／", attrs: { "aria-hidden": "true" } }) : null,
      h("span", { class: titleClass.join(" "), text: item.title, data: { testid: "backlog-row-title" } }),
      waiting.length > 0
        ? h("span", {
            class: "row-waiting",
            text: waiting.length === 1 ? `待ち：${waiting[0]!.title}` : `待ち：${waiting.length} 件`,
            title: waiting.map((w) => w.title).join("\n"),
            data: { testid: "backlog-waiting" },
          })
        : null,
      node.note ? h("span", { class: "row-note", text: node.note }) : null,
      right,
    );
    openBtn.addEventListener("click", () => this.select(item.id, true));
    row.append(openBtn);

    const menuBtn = h(
      "button",
      {
        class: "icon-btn row-menu",
        attrs: { type: "button", "aria-label": `「${item.title}」の操作`, "aria-haspopup": "menu" },
        data: { testid: "backlog-row-menu", focus: `menu:${item.id}` },
      },
      icon("Ellipsis", "icon-md"),
    );
    const prevId = group.sortable ? siblingIds[index - 1] : undefined;
    const nextId = group.sortable ? siblingIds[index + 1] : undefined;
    menuBtn.addEventListener("click", () => {
      if (!toggleFrom(menuBtn)) return;
      const entries: MenuEntry[] = [
        {
          type: "sub",
          label: "状態を変える",
          testid: "backlog-menu-status",
          entries: (["backlog", "ready", "in-progress", "done"] as const).map((s) => ({
            type: "item" as const,
            label: STATUS_LABEL[s],
            disabled: item.status === s,
            testid: `backlog-menu-status-${s}`,
            onSelect: () => void this.update(item.id, { status: s }),
          })),
        },
        {
          type: "item",
          label: item.priority === "high" ? "優先を外す" : "優先にする",
          testid: "backlog-menu-priority",
          onSelect: () => void this.update(item.id, { priority: item.priority === "high" ? "normal" : "high" }),
        },
      ];
      if (isStory) {
        entries.push({
          type: "item",
          label: "タスクを足す",
          testid: "backlog-menu-add-task",
          onSelect: () => {
            this.collapsed.delete(item.id);
            this.openComposer(`story:${item.id}`, "task");
          },
        });
      }
      if (prevId || nextId) {
        entries.push(
          { type: "sep" },
          {
            type: "item",
            label: "一つ上へ",
            disabled: !prevId,
            testid: "backlog-menu-up",
            onSelect: () => void (prevId && this.write("boardMoveItem", { id: item.id, before: prevId })),
          },
          {
            type: "item",
            label: "一つ下へ",
            disabled: !nextId,
            testid: "backlog-menu-down",
            onSelect: () => void (nextId && this.write("boardMoveItem", { id: item.id, after: nextId })),
          },
        );
      }
      openMenu(menuBtn, entries, { align: "end" });
    });
    row.append(menuBtn);
    return row;
  }

  /**
   * ドラッグで並べ替える。**同じ段の中だけ**（区切りの直下どうし・同じストーリーの子どうし）——段をまたぐと
   * 何と入れ替わったかが分からない。ドラッグ中は描き直さない（つかんだ行が消えるとドラッグが切れる）
   */
  private wireDrag(row: HTMLElement, id: string, siblings: string[]): void {
    const clearMarks = () => {
      for (const el of this.screen.querySelectorAll(".row .drop")) el.remove();
    };
    row.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData("text/plain", id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      this.drag = { id, siblings };
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      clearMarks();
      this.drag = null;
    });
    row.addEventListener("dragover", (e) => {
      const drag = this.drag;
      if (!drag || drag.id === id || !drag.siblings.includes(id)) return;
      e.preventDefault();
      const rect = row.getBoundingClientRect();
      const where = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
      if (drag.target?.id === id && drag.target.where === where) return;
      drag.target = { id, where };
      clearMarks();
      row.append(h("span", { class: `drop ${where}`, attrs: { "aria-hidden": "true" } }));
    });
    row.addEventListener("drop", (e) => {
      const drag = this.drag;
      if (!drag?.target || drag.target.id !== id) return;
      e.preventDefault();
      const { id: moving, target } = { id: drag.id, target: drag.target };
      clearMarks();
      this.drag = null;
      void this.write("boardMoveItem", { id: moving, [target.where]: target.id });
    });
  }

  // ---- その場で足す ----

  private renderComposer(key: string, milestone: string | null, parent?: BacklogItem): HTMLElement {
    const c = this.composers.get(key)!;
    const input = h("input", {
      attrs: {
        placeholder: parent ? `「${parent.title}」のタスクの題` : `${KIND_LABEL[c.kind]}の題`,
        "aria-label": "足す項目の題",
      },
      data: { testid: "backlog-composer-title", focus: `composer:${key}` },
    });
    input.value = c.title;
    input.addEventListener("input", () => {
      c.title = input.value;
    });
    input.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "Enter") {
        e.preventDefault();
        void this.submitComposer(key, milestone, parent);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.closeComposer(key);
      }
    });
    const kinds = parent
      ? h("span", { text: "タスクとして足します" })
      : h(
          "div",
          { class: "kinds", attrs: { role: "radiogroup", "aria-label": "種類" } },
          ...(["task", "bug", "story"] as const).map((k) => {
            const b = h("button", {
              text: KIND_LABEL[k],
              attrs: { type: "button", role: "radio", "aria-checked": String(c.kind === k) },
              data: { testid: `backlog-composer-kind-${k}`, focus: `composer-kind:${key}:${k}` },
            });
            b.addEventListener("click", () => {
              c.kind = k;
              this.render();
              this.screen.querySelector<HTMLInputElement>(`[data-focus="composer:${CSS.escape(key)}"]`)?.focus();
            });
            return b;
          }),
        );
    return h(
      "div",
      { class: "composer", data: { testid: "backlog-composer" } },
      h("div", { class: "composer-line" }, icon("Plus"), input),
      h(
        "div",
        { class: "composer-foot" },
        kinds,
        h("span", { text: `${c.count > 0 ? `${c.count} 件足しました。` : ""}Enter で足す、Esc で閉じる`, data: { testid: "backlog-composer-note" } }),
      ),
    );
  }

  private async submitComposer(key: string, milestone: string | null, parent?: BacklogItem): Promise<void> {
    const c = this.composers.get(key);
    const title = c?.title.trim();
    if (!c || !title) return;
    const kind: BacklogKind = parent ? "task" : c.kind;
    const ok = await this.write("boardCreateItem", {
      kind,
      title,
      status: parent ? "ready" : "backlog",
      ...(parent ? { parent: parent.id } : {}),
      milestone: parent ? parent.milestone : milestone,
    });
    if (ok) {
      c.title = "";
      c.count++;
      this.render();
      this.screen.querySelector<HTMLInputElement>(`[data-focus="composer:${CSS.escape(key)}"]`)?.focus();
    }
  }

  // ---- 詳細（Peek）----

  private renderDetail(doc: BacklogDocument, item: BacklogItem): HTMLElement {
    const items = doc.items;
    const parent = item.parent ? items.find((i) => i.id === item.parent) : undefined;
    const closed = isClosed(item);

    const where = h("p", { class: "where", data: { testid: "backlog-detail-where" } }, numberTag(item));
    if (parent) {
      const b = h("button", { text: parent.title, attrs: { type: "button" }, data: { testid: "backlog-detail-parent" } });
      b.addEventListener("click", () => this.select(parent.id, true));
      where.append(b, h("span", { text: " のタスク" }));
    } else {
      where.append(KIND_LABEL[item.kind]);
    }
    const iconButton = (name: "ChevronUp" | "ChevronDown" | "X", label: string, fn: () => void, testid?: string) => {
      const b = h(
        "button",
        { class: "icon-btn", attrs: { type: "button", "aria-label": label }, data: { focus: `detail:${label}`, ...(testid ? { testid } : {}) } },
        icon(name),
      );
      b.addEventListener("click", fn);
      return b;
    };

    const body = h(
      "div",
      { class: "detail-body", data: { scroll: `detail:${item.id}` } },
      this.renderTitle(item),
      this.renderProperties(doc, item),
      this.renderDependencies(item, items),
      item.kind === "story" ? this.renderStoryTasks(item, items) : null,
      this.renderTextBlock(item, "doneWhen", "完了条件", "何を測れたら終わりかを書きます", "backlog-detail-donewhen"),
      this.renderTextBlock(item, "body", "本文", "なぜやるか・経緯・確かめ方を書きます", "backlog-detail-body"),
      item.refs.length > 0
        ? h(
            "section",
            { class: "section" },
            this.sectionTitle("参照"),
            h("ul", { class: "refs" }, ...item.refs.map((r) => h("li", { text: r }))),
          )
        : null,
      h(
        "section",
        { class: "section" },
        this.sectionTitle("取り組んだ Thread"),
        item.threads.length === 0
          ? h("p", { class: "quiet-text", text: "まだどの Thread でも取り組んでいません。" })
          : h(
              "ul",
              { class: "threads", data: { testid: "backlog-threads" } },
              // Thread を開く口は Canvas に無い——押せるように見せない（規則13）。id を出す
              ...item.threads.map((t) =>
                h("li", { title: `Project ${t.projectId}` }, icon("MessageSquare"), h("span", { class: "mono", text: `Thread ${t.threadId}` })),
              ),
            ),
      ),
      h(
        "p",
        { class: "stamp" },
        `${formatDate(item.createdAt)}に作成、${formatDate(item.updatedAt)}に更新${item.closedAt ? `、${formatDate(item.closedAt)}に閉じた` : ""}。`,
        h("span", { class: "mono", text: item.id, data: { testid: "backlog-detail-id" } }),
      ),
    );

    return h(
      "div",
      { class: "detail", data: { testid: "backlog-detail" } },
      h(
        "div",
        { class: "detail-top" },
        where,
        iconButton("ChevronUp", "前の項目", () => this.step(-1)),
        iconButton("ChevronDown", "次の項目", () => this.step(1)),
        iconButton("X", "詳細を閉じる", () => this.closePeek(), "backlog-detail-close"),
      ),
      body,
      this.renderActions(item, closed),
    );
  }

  private sectionTitle(text: string, action?: Child): HTMLElement {
    return h("div", { class: "section-title" }, h("h4", { text }), action ?? null);
  }

  private renderTitle(item: BacklogItem): HTMLElement {
    if (this.editingTitle !== null) {
      const input = h("input", { class: "title-input", attrs: { "aria-label": "題" }, data: { focus: "title-edit", testid: "backlog-title-input" } });
      input.value = this.editingTitle;
      let done = false;
      const finish = (save: boolean) => {
        if (done) return;
        done = true;
        const value = input.value.trim();
        this.editingTitle = null;
        if (save && value && value !== item.title) void this.update(item.id, { title: value });
        else this.render();
      };
      input.addEventListener("input", () => {
        this.editingTitle = input.value;
      });
      input.addEventListener("keydown", (e) => {
        if (e.isComposing) return;
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        }
      });
      // 描き直しで外された入力欄の blur では残さない（外したのは画面で、人ではない）
      input.addEventListener("blur", () => {
        if (input.isConnected) finish(true);
      });
      return input;
    }
    const title = h("h3", { class: "detail-title", text: item.title, data: { testid: "backlog-detail-title" } });
    title.addEventListener("click", () => {
      this.editingTitle = item.title;
      this.render();
      this.screen.querySelector<HTMLInputElement>('[data-focus="title-edit"]')?.focus();
    });
    return title;
  }

  private propButton(content: Child[], opts: { quiet?: boolean; strong?: boolean; disabled?: boolean; testid: string }): HTMLButtonElement {
    const cls = ["prop", ...(opts.quiet ? ["quiet"] : []), ...(opts.strong ? ["strong"] : [])];
    const b = h("button", { class: cls.join(" "), attrs: { type: "button" }, data: { testid: opts.testid, focus: opts.testid } }, ...content);
    b.disabled = opts.disabled === true;
    return b;
  }

  private renderProperties(doc: BacklogDocument, item: BacklogItem): HTMLElement {
    const items = doc.items;
    const closed = isClosed(item);
    const state = rankState(item, items);
    const props = h("div", { class: "props", data: { testid: "backlog-properties" } });

    const status = this.propButton(
      [itemMark(item, items, true), state === "actionable" || state === "waiting" ? RANK_STATE_LABEL[state] : STATUS_LABEL[item.status]],
      { disabled: closed, testid: "backlog-prop-status" },
    );
    status.addEventListener("click", () => {
      if (!toggleFrom(status)) return;
      openMenu(
        status,
        (["backlog", "ready", "in-progress"] as const satisfies readonly BacklogStatus[]).map((s) => ({
          type: "item" as const,
          label: STATUS_LABEL[s],
          disabled: item.status === s,
          testid: `backlog-status-${s}`,
          onSelect: () => void this.update(item.id, { status: s }),
        })),
      );
    });
    props.append(status);

    const priority = this.propButton([`優先度 ${PRIORITY_LABEL[item.priority]}`], { strong: item.priority === "high", testid: "backlog-prop-priority" });
    priority.addEventListener("click", () => {
      if (!toggleFrom(priority)) return;
      openMenu(
        priority,
        (["high", "normal", "low"] as const satisfies readonly BacklogPriority[]).map((p) => ({
          type: "item" as const,
          label: PRIORITY_LABEL[p],
          disabled: item.priority === p,
          onSelect: () => void this.update(item.id, { priority: p }),
        })),
      );
    });
    props.append(priority);

    if (!item.parent) {
      const milestone = doc.milestones.find((m) => m.id === item.milestone);
      const ms = this.propButton([milestone ? milestone.title : "マイルストーン無し"], { quiet: !milestone, testid: "backlog-prop-milestone" });
      ms.addEventListener("click", () => {
        if (!toggleFrom(ms)) return;
        const entries: MenuEntry[] = doc.milestones.map((m) => ({
          type: "item" as const,
          label: m.title,
          disabled: item.milestone === m.id,
          onSelect: () => void this.update(item.id, { milestone: m.id }),
        }));
        if (entries.length > 0) entries.push({ type: "sep" });
        entries.push({ type: "item", label: "マイルストーン無し", disabled: item.milestone === null, onSelect: () => void this.update(item.id, { milestone: null }) });
        openMenu(ms, entries);
      });
      props.append(ms);
    }

    if (item.kind === "task") {
      const stories = items.filter((i) => i.kind === "story" && !isClosed(i) && i.id !== item.id && i.id !== item.parent);
      const pb = this.propButton([item.parent ? "ストーリーを替える" : "ストーリーに入れる"], { quiet: !item.parent, testid: "backlog-prop-parent" });
      pb.addEventListener("click", () => {
        if (!toggleFrom(pb)) return;
        openPicker(pb, {
          candidates: stories,
          items,
          placeholder: "ストーリーを探す",
          emptyText: "入れられるストーリーがありません",
          onPick: (id) => void this.update(item.id, { parent: id, milestone: items.find((i) => i.id === id)?.milestone ?? null }),
        });
      });
      props.append(pb);
    }

    for (const l of item.labels) {
      const rm = h("button", { text: "×", attrs: { type: "button", "aria-label": `ラベル「${l}」を外す` } });
      rm.addEventListener("click", () => void this.update(item.id, { labels: item.labels.filter((x) => x !== l) }));
      props.append(h("span", { class: "chip", data: { testid: "backlog-label" } }, l, rm));
    }
    const labelBtn = this.propButton(["ラベル"], { quiet: true, testid: "backlog-prop-label" });
    labelBtn.addEventListener("click", () => {
      if (!toggleFrom(labelBtn)) return;
      const others = [...new Set(items.flatMap((i) => i.labels))].filter((l) => !item.labels.includes(l)).sort((a, b) => a.localeCompare(b, "ja"));
      openMenu(labelBtn, [
        {
          type: "input",
          label: "新しいラベル",
          placeholder: "新しいラベル",
          onEnter: (v) => void (item.labels.includes(v) ? undefined : this.update(item.id, { labels: [...item.labels, v] })),
        },
        ...others.map((l) => ({ type: "item" as const, label: l, onSelect: () => void this.update(item.id, { labels: [...item.labels, l] }) })),
      ]);
    });
    props.append(labelBtn);
    return props;
  }

  /** 依存の流れ——上から「これが待っているもの」→「この項目」→「これを待っているもの」を1本の線で繋ぐ */
  private renderDependencies(item: BacklogItem, items: readonly BacklogItem[]): HTMLElement {
    const before = item.dependsOn.map((id) => items.find((i) => i.id === id)).filter((i): i is BacklogItem => i !== undefined);
    const after = dependents(item, items);
    const excluded = new Set([item.id, ...item.dependsOn, ...after.map((a) => a.id)]);
    const candidates = items.filter((i) => !excluded.has(i.id) && !isClosed(i));
    const openDeps = before.filter((b) => b.status !== "done");
    const add = h("button", { class: "btn ghost xs", attrs: { type: "button" }, data: { testid: "backlog-dep-add", focus: "dep-add" } }, icon("Plus"), "待つものを足す");
    add.addEventListener("click", () => {
      if (!toggleFrom(add)) return;
      openPicker(add, {
        candidates,
        items,
        placeholder: "待つ項目を探す",
        onPick: (id) => void this.update(item.id, { dependsOn: [...item.dependsOn, id] }),
      });
    });
    const section = h("section", { class: "section", attrs: { "aria-label": "依存" }, data: { testid: "backlog-deps" } }, this.sectionTitle("依存", add));
    if (before.length === 0 && after.length === 0) {
      section.append(h("p", { class: "quiet-text", text: "待つものも、これを待っているものもありません。", data: { testid: "backlog-dep-summary" } }));
      return section;
    }
    const ol = h("ol");
    for (const b of before) {
      ol.append(
        h(
          "li",
          { data: { testid: "backlog-dep-before" } },
          this.itemLine(b, items, {
            onRemove: () => void this.update(item.id, { dependsOn: item.dependsOn.filter((x) => x !== b.id) }),
          }),
        ),
      );
    }
    ol.append(h("li", { class: "self", data: { testid: "backlog-dep-self" } }, this.itemLine(item, items, { self: true })));
    for (const a of after) ol.append(h("li", { data: { testid: "backlog-dep-after" } }, this.itemLine(a, items)));
    const closed = isClosed(item);
    const summary = closed
      ? after.length > 0
        ? `${after.length} 件がこれを待っていました。`
        : "閉じています。"
      : openDeps.length > 0
        ? `${openDeps.length} 件が終わるまで始められません。`
        : before.length > 0
          ? "待っていたものは全部終わりました。"
          : "待つものはありません。";
    section.append(
      h("div", { class: "flow" }, h("span", { class: "line", attrs: { "aria-hidden": "true" } }), ol),
      h("p", {
        class: "flow-summary",
        text: summary + (!closed && after.length > 0 ? `終われば ${after.length} 件が進めます。` : ""),
        data: { testid: "backlog-dep-summary" },
      }),
    );
    return section;
  }

  private itemLine(item: BacklogItem, items: readonly BacklogItem[], opts: { self?: boolean; onRemove?: () => void } = {}): HTMLElement {
    const content: Child[] = [
      itemMark(item, items, true),
      numberTag(item),
      h("span", { class: opts.self ? "t self" : "t", text: item.title }),
      h("span", { class: "s", text: RANK_STATE_LABEL[rankState(item, items)] }),
    ];
    const line = h("div", { class: "item-line" });
    if (opts.self) {
      line.append(h("div", { class: "open", attrs: { style: "cursor:default" } }, ...content));
    } else {
      const b = h("button", { class: "open", attrs: { type: "button" }, data: { focus: `line:${item.id}` } }, ...content);
      b.addEventListener("click", () => this.select(item.id, true));
      line.append(b);
    }
    if (opts.onRemove) {
      const rm = h("button", { class: "icon-btn rm", attrs: { type: "button", "aria-label": `「${item.title}」を待つのをやめる` } }, icon("X"));
      rm.addEventListener("click", opts.onRemove);
      line.append(rm);
    }
    return line;
  }

  private renderStoryTasks(story: BacklogItem, items: readonly BacklogItem[]): HTMLElement {
    const kids = childrenOf(story, items);
    const closed = isClosed(story);
    let action: HTMLElement | null = null;
    if (!closed && !this.splitting) {
      action = h("button", { class: "btn ghost xs", attrs: { type: "button" }, data: { testid: "backlog-split-open", focus: "split-open" } }, icon("Plus"), "タスクに分ける");
      action.addEventListener("click", () => {
        this.splitting = { text: "", chain: true };
        this.render();
        this.screen.querySelector<HTMLTextAreaElement>('[data-focus="split-input"]')?.focus();
      });
    }
    const section = h("section", { class: "section", attrs: { "aria-label": "タスク" } }, this.sectionTitle("タスク", action));
    if (this.splitting) section.append(this.renderSplit(story));
    if (kids.length === 0 && !this.splitting) {
      section.append(h("p", { class: "quiet-text", text: "まだタスクに分けていません。取りかかるときに分けます。" }));
    } else if (kids.length > 0) {
      section.append(
        h("ul", { class: "kid-list", data: { testid: "backlog-detail-kids" } }, ...kids.map((k) => h("li", {}, this.itemLine(k, items)))),
      );
    }
    if (!closed && kids.length > 0 && kids.every(isClosed)) {
      section.append(
        h("p", {
          class: "all-done",
          text: "タスクは全部閉じました。ストーリーも終わりなら、下の「終わったにする」で閉じます。",
          data: { testid: "backlog-story-all-done" },
        }),
      );
    }
    return section;
  }

  private renderSplit(story: BacklogItem): HTMLElement {
    const s = this.splitting!;
    const titles = () =>
      s.text
        .split("\n")
        .map((l) => l.replace(/^[-*・]\s*/, "").trim())
        .filter((l) => l.length > 0);
    const area = h("textarea", {
      attrs: { rows: "4", placeholder: "1行に1件、タスクの題を書く\n例：設定に場所の欄を足す", "aria-label": "分けるタスク（1行に1件）" },
      data: { testid: "backlog-split-input", focus: "split-input" },
    });
    area.value = s.text;
    const submit = h("button", { class: "btn primary", attrs: { type: "button" }, data: { testid: "backlog-split-submit" } });
    const refresh = () => {
      const n = titles().length;
      submit.textContent = n > 0 ? `${n} 件のタスクに分ける` : "タスクに分ける";
      submit.disabled = n === 0;
    };
    refresh();
    const run = async () => {
      const list = titles();
      if (list.length === 0) return;
      const ok = await this.write("boardSplitStory", {
        storyId: story.id,
        tasks: list.map((title, i) => ({ title, ...(s.chain && i > 0 ? { waitsFor: [i - 1] } : {}) })),
      });
      if (ok) {
        this.splitting = null;
        this.render();
      }
    };
    area.addEventListener("input", () => {
      s.text = area.value;
      refresh();
    });
    area.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.splitting = null;
        this.render();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void run();
      }
    });
    submit.addEventListener("click", () => void run());
    const chain = h("input", { attrs: { type: "checkbox", role: "switch" }, data: { testid: "backlog-split-chain" } });
    chain.checked = s.chain;
    chain.addEventListener("change", () => {
      s.chain = chain.checked;
    });
    const cancel = h("button", { class: "btn ghost", text: "やめる", attrs: { type: "button" } });
    cancel.addEventListener("click", () => {
      this.splitting = null;
      this.render();
    });
    return h(
      "div",
      { class: "split", data: { testid: "backlog-split" } },
      area,
      h("label", { class: "switch" }, chain, "上から順に待つ（2行目は1行目が終わるまで始めない）"),
      h("div", { class: "actions-right" }, cancel, submit),
    );
  }

  private renderTextBlock(item: BacklogItem, field: "doneWhen" | "body", title: string, empty: string, testid: string): HTMLElement {
    const value = item[field];
    const editing = this.editingText?.field === field ? this.editingText : null;
    let action: HTMLElement | null = null;
    if (!editing) {
      action = h("button", { class: "btn ghost xs", text: "書き直す", attrs: { type: "button" }, data: { testid: `${testid}-edit`, focus: `${testid}-edit` } });
      action.addEventListener("click", () => {
        this.editingText = { field, draft: value };
        this.render();
        this.screen.querySelector<HTMLTextAreaElement>(`[data-focus="text-edit:${field}"]`)?.focus();
      });
    }
    const section = h("section", { class: "section", data: { testid } }, this.sectionTitle(title, action));
    if (editing) {
      const area = h("textarea", { attrs: { rows: field === "body" ? "8" : "3", "aria-label": title }, data: { focus: `text-edit:${field}`, testid: `${testid}-input` } });
      area.value = editing.draft;
      area.addEventListener("input", () => {
        editing.draft = area.value;
      });
      area.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          this.editingText = null;
          this.render();
        }
      });
      const cancel = h("button", { class: "btn ghost", text: "やめる", attrs: { type: "button" } });
      cancel.addEventListener("click", () => {
        this.editingText = null;
        this.render();
      });
      const save = h("button", { class: "btn primary", text: "残す", attrs: { type: "button" }, data: { testid: `${testid}-save` } });
      save.addEventListener("click", async () => {
        const ok = await this.update(item.id, { [field]: editing.draft.trim() });
        if (ok) {
          this.editingText = null;
          this.render();
        }
      });
      section.append(h("div", { class: "edit-area" }, area, h("div", { class: "actions-right" }, cancel, save)));
    } else if (value) {
      section.append(field === "body" ? markdownBody(value) : h("p", { class: "text-value", text: value }));
    } else {
      section.append(h("p", { class: "quiet-text", text: empty }));
    }
    return section;
  }

  private renderActions(item: BacklogItem, closed: boolean): HTMLElement {
    const foot = h("footer", { class: "detail-foot", data: { testid: "backlog-detail-actions" } });
    if (closed) {
      const reopen = h("button", { class: "btn", text: "開き直す", attrs: { type: "button" }, data: { testid: "backlog-reopen" } });
      reopen.addEventListener("click", () => void this.update(item.id, { status: "ready" }));
      foot.append(
        h(
          "div",
          { class: "foot-row spread" },
          h(
            "p",
            { data: { testid: "backlog-closed-note" } },
            item.status === "done" ? "終わりました" : "やめました",
            item.resolution ? h("span", { text: `：${item.resolution}` }) : null,
          ),
          reopen,
        ),
      );
      return foot;
    }
    if (this.dropping !== null) {
      const input = h("input", {
        attrs: { placeholder: "やめる理由（例：別の項目と重なっていた）", "aria-label": "やめる理由" },
        data: { testid: "backlog-drop-reason", focus: "drop-reason" },
      });
      input.value = this.dropping;
      const submit = h("button", { class: "btn", text: "やめる", attrs: { type: "submit" }, data: { testid: "backlog-drop-submit" } });
      submit.disabled = this.dropping.trim() === "";
      input.addEventListener("input", () => {
        this.dropping = input.value;
        submit.disabled = input.value.trim() === "";
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          this.dropping = null;
          this.render();
        }
      });
      const back = h("button", { class: "btn ghost", text: "戻る", attrs: { type: "button" } });
      back.addEventListener("click", () => {
        this.dropping = null;
        this.render();
      });
      const form = h("form", { class: "drop-form" }, input, h("div", { class: "actions-right" }, back, submit));
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const reason = (this.dropping ?? "").trim();
        if (!reason) return;
        const ok = await this.update(item.id, { status: "dropped", resolution: reason });
        if (ok) {
          this.dropping = null;
          this.render();
        }
      });
      foot.append(form);
      return foot;
    }
    const done = h("button", { class: "btn primary", text: "終わったにする", attrs: { type: "button" }, data: { testid: "backlog-close-done" } });
    done.addEventListener("click", () => void this.update(item.id, { status: "done" }));
    const drop = h("button", { class: "btn ghost", text: "やめる", attrs: { type: "button" }, data: { testid: "backlog-close-drop" } });
    drop.addEventListener("click", () => {
      this.dropping = "";
      this.render();
      this.screen.querySelector<HTMLInputElement>('[data-focus="drop-reason"]')?.focus();
    });
    foot.append(h("div", { class: "foot-row" }, done, drop));
    return foot;
  }
}
