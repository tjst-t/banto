// **PDF を元の見た目で読む画面**（`ui://banto-filesystem/document`、v4-modules.md §2.2「PDF・Office…」、2026-10-15）。
//
// showFile が PDF を見せるとき、host がこの画面を選ぶ（`dev.banto/ui-by-extension`）。会話の中では
// 高さを決めたカード（「大きく表示」つき）、大きく開くと画面いっぱい。どちらも同じ描き方：
//   - **中身はバイトの範囲で受ける**（`readFileRange`、1回 4MiB まで）——pdf.js は末尾の xref から読むので
//     ページでは切り出せない。小さなファイルは1回で全部読み、大きなものは `PDFDataRangeTransport` で要る範囲だけ
//   - **ページごとに canvas＋文字の層**（選べる・探せる）。**描くのは見えているページとその前後だけ**。
//     見えなくなったら `renderTask.cancel()` で止め、絵も捨てる（100 ページを全部描くとメモリが持たない）
//   - CMap・標準フォントは pdf.js が fetch したがるが、Canvas の CSP は fetch を塞いでいる（緩めない）ので
//     `readPdfAsset` で受ける
//   - **コメント**（`comments.ts`、Backlog #307）：ページ・選んだ文・ドラッグした範囲を指して付ける。一覧は右（狭いとき・
//     会話の中では下）。押すとそのページへ飛び、文には印、範囲には枠を出す

import { CommentsPanel, type CommentAnchor, type CommentRect, type CommentTarget } from "./comments.js";
import { h, replaceChildren } from "./dom.js";
import { icon } from "./icons.js";
import {
  base64ToBytes,
  callTool,
  errorMessage,
  reportSize,
  requestDisplayMode,
  textOf,
  type CallToolResult,
  type DisplayMode,
} from "./protocol.js";
import {
  isRenderingCancelled,
  pdfjs,
  type PdfDocument,
  type PdfPage,
  type PdfRenderTask,
  type PdfTextContent,
  type PdfTextLayer,
} from "./pdfjs.js";

/** `readFileRange` の1回の上限（サーバの `READ_RANGE_MAX_BYTES` と同じ） */
const RANGE_MAX = 4 * 1024 * 1024;
/** pdf.js がまとめて頼む単位。小さすぎると往復が増え、大きすぎると要らない分まで運ぶ */
const RANGE_CHUNK = 512 * 1024;
const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/** 画面のファイルのバイトを読む（範囲が 4MiB を超えるときは分けて頼む） */
async function readRange(path: string, begin: number, end: number): Promise<Uint8Array> {
  const out = new Uint8Array(end - begin);
  let at = begin;
  while (at < end) {
    const length = Math.min(RANGE_MAX, end - at);
    const result = JSON.parse(textOf(await callTool("readFileRange", { path, offset: at, length }))) as {
      length?: unknown;
      data?: unknown;
    };
    if (typeof result.data !== "string") throw new Error("readFileRange の結果に中身がありません");
    const bytes = base64ToBytes(result.data);
    if (bytes.length === 0) throw new Error(`ファイルが途中で終わっています（${at} バイト目、読み込み中に書き換わったかもしれません）`);
    out.set(bytes, at - begin);
    at += bytes.length;
  }
  return out;
}

/** pdf.js が fetch で読む資料（CMap・標準フォント）を、この Module の tool から受ける */
class AssetFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const assetKind = kind === "cMapUrl" ? "cmap" : kind === "standardFontDataUrl" ? "standardFont" : undefined;
    if (!assetKind) throw new Error(`この画面では読めない資料です（${kind}）`);
    const result = JSON.parse(textOf(await callTool("readPdfAsset", { kind: assetKind, name: filename }))) as { data?: unknown };
    if (typeof result.data !== "string") throw new Error(`pdf.js の資料が空でした（${filename}）`);
    return base64ToBytes(result.data);
  }
}

interface PageSlot {
  index: number;
  el: HTMLDivElement;
  /** その倍率で描き終えた・描いている */
  renderedScale?: number;
  task?: PdfRenderTask;
  textLayer?: PdfTextLayer;
  /** 描き直しの世代——途中で止めた描画の続きが、後から来た描画を上書きしないように */
  generation: number;
}

interface Match {
  page: number;
  /** 文字の層の要素（items）の番号のうち、当たったところに掛かるもの */
  items: number[];
}

type LoadState = { kind: "waiting" } | { kind: "loading"; path: string } | { kind: "error"; message: string } | { kind: "ready" };

export class PdfDocumentView {
  private displayMode: DisplayMode;
  private path = "";
  private size = 0;
  private state: LoadState = { kind: "waiting" };
  private doc?: PdfDocument;
  private loadingTask?: { destroy(): Promise<void> };
  private readonly pages: PageSlot[] = [];
  private readonly pageCache = new Map<number, Promise<PdfPage>>();
  private readonly textCache = new Map<number, Promise<PdfTextContent>>();
  /** 1ページ目の幅（倍率1）。ページ枠の大きさの目安にする（他のページは描いたときに合わせる） */
  private baseWidth = 612;
  private baseHeight = 792;
  private readonly pageSizes = new Map<number, { width: number; height: number }>();
  private zoom = 0;
  private fitScale = 1;
  private readonly visible = new Set<number>();
  private observer?: IntersectionObserver;
  private currentPage = 1;
  private note = "";
  private noteError = false;

  // --- 探す ---
  private query = "";
  private matches: Match[] = [];
  private matchIndex = -1;
  private searching = false;
  private searchToken = 0;

  // --- コメント ---
  private readonly comments: CommentsPanel;
  private commentsOpen = false;
  /** 一覧から飛んだ先（そのページを描いたときに、文には印・範囲には枠を出す） */
  private focused?: CommentAnchor;
  /** 範囲を囲んでいる途中なら、囲み終えたときに呼ぶ */
  private drawing?: (anchor: Extract<CommentAnchor, { kind: "region" }>) => void;

  // --- 固定の要素（描き直しで作り直さない——作り直すとスクロールと入力が飛ぶ）---
  private readonly scroller: HTMLDivElement;
  private readonly pagesEl: HTMLDivElement;
  private readonly pageLabel: HTMLSpanElement;
  private readonly zoomLabel: HTMLSpanElement;
  private readonly searchInput: HTMLInputElement;
  private readonly searchCount: HTMLSpanElement;
  private readonly status: HTMLDivElement;
  private readonly noteEl: HTMLParagraphElement;
  private readonly pathEl: HTMLSpanElement;
  private readonly fullscreenBtn: HTMLButtonElement;
  private readonly commentsBtn: HTMLButtonElement;
  private readonly commentsCount: HTMLSpanElement;

  constructor(
    private readonly root: HTMLElement,
    options: {
      displayMode: DisplayMode;
      /** host が `ui/message` を受けるか（会話の中で開いた画面）。受けなければコメントは「コピー」で持ち出す */
      canReturnComments: boolean;
    },
  ) {
    this.displayMode = options.displayMode;
    const target: CommentTarget = {
      selectedText: () => this.selectedText(),
      currentPage: () => (this.state.kind === "ready" ? this.currentPage : undefined),
      startRegion: (done) => this.startRegion(done),
      jumpTo: (anchor) => this.jumpTo(anchor),
    };
    this.commentsCount = h("span", { class: "count", data: { testid: "comments-toggle-count" } });
    this.comments = new CommentsPanel(target, { canReturn: options.canReturnComments, onChange: () => this.onCommentsChange() });
    this.commentsBtn = h(
      "button",
      {
        class: "btn",
        title: "コメントの一覧を開く・閉じる",
        attrs: { type: "button", "aria-pressed": "false" },
        data: { testid: "comments-toggle" },
        on: { click: () => this.toggleComments() },
      },
      icon("MessageSquare"),
      "コメント",
      this.commentsCount,
    );
    this.pathEl = h("span", { class: "badge truncate", text: "（PDF）", data: { testid: "open-path" } });
    this.pageLabel = h("span", { class: "pdf-page-label", data: { testid: "pdf-page-label" } });
    this.zoomLabel = h("span", { class: "pdf-zoom-label", data: { testid: "pdf-zoom" } });
    this.searchInput = h("input", {
      class: "pdf-search-input",
      attrs: { type: "search", placeholder: "PDF の中を探す", "aria-label": "PDF の中を探す" },
      data: { testid: "pdf-search" },
      on: {
        keydown: (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (this.searchInput.value !== this.query) void this.search(this.searchInput.value);
            else this.step(e.shiftKey ? -1 : 1);
          }
        },
      },
    });
    this.searchCount = h("span", { class: "pdf-search-count", data: { testid: "pdf-search-count" } });
    this.fullscreenBtn = h(
      "button",
      { class: "btn", attrs: { type: "button" }, on: { click: () => void this.askFullscreen() } },
      icon("Maximize2"),
      "大きく表示",
    );
    const iconButton = (label: string, name: Parameters<typeof icon>[0], onClick: () => void) =>
      h("button", { class: "icon-btn strong", title: label, attrs: { type: "button", "aria-label": label }, on: { click: onClick } }, icon(name));
    const toolbar = h(
      "div",
      { class: "pdf-toolbar" },
      icon("FileText", "icon muted"),
      this.pathEl,
      this.pageLabel,
      h("span", { class: "spacer-fill" }),
      h(
        "div",
        { class: "pdf-search" },
        icon("Search", "icon muted"),
        this.searchInput,
        this.searchCount,
        iconButton("前の一致", "ChevronUp", () => this.step(-1)),
        iconButton("次の一致", "ChevronDown", () => this.step(1)),
      ),
      iconButton("縮小", "ZoomOut", () => this.changeZoom(-1)),
      this.zoomLabel,
      iconButton("拡大", "ZoomIn", () => this.changeZoom(1)),
      this.commentsBtn,
      this.fullscreenBtn,
    );
    this.status = h("div", { class: "state" });
    this.pagesEl = h("div", { class: "pdf-pages" });
    this.scroller = h("div", { class: "pdf-scroller", data: { testid: "pdf-scroller" } }, this.status, this.pagesEl);
    this.scroller.addEventListener("scroll", () => this.updateCurrentPage(), { passive: true });
    this.pagesEl.addEventListener("pointerdown", (e) => this.onRegionPointerDown(e));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.comments.cancelRegion();
    });
    this.noteEl = h("p", { class: "note" });
    this.comments.el.hidden = true;
    const body = h("div", { class: "pdf-body" }, this.scroller, this.comments.el);
    replaceChildren(this.root, h("div", { class: "pdf-view", data: { testid: "pdf-view" } }, toolbar, body, this.noteEl));
    new ResizeObserver(() => this.onResize()).observe(this.scroller);
    this.render();
  }

  setToolInput(args: Record<string, unknown>): void {
    if (typeof args.path === "string" && args.path && !this.path) {
      this.pathEl.textContent = args.path;
    }
    // 呼んだ人が fullscreen を頼んでいたら、開いた直後にそう頼む（listDirectory・showFile のテキストと同じ）
    if (args.displayMode === "fullscreen" && this.displayMode === "inline") void this.askFullscreen();
  }

  /** showFile の結果（`{path, size}`）。path は Module が確かめた根からの相対 */
  setToolResult(result: CallToolResult): void {
    try {
      if (result.isError) throw new Error(textOf(result) || "ファイルを開けませんでした");
      const shown = JSON.parse(textOf(result)) as { path?: unknown; size?: unknown };
      if (typeof shown.path !== "string" || !shown.path) throw new Error("見せるファイルが結果に入っていません");
      if (typeof shown.size !== "number") throw new Error("ファイルの大きさが結果に入っていません");
      if (shown.path === this.path && this.state.kind !== "error") return;
      void this.open(shown.path, shown.size);
    } catch (err) {
      this.state = { kind: "error", message: errorMessage(err) };
      this.render();
    }
  }

  setCancelled(): void {
    if (this.state.kind === "waiting") this.state = { kind: "error", message: "取り消されました" };
    this.render();
  }

  setDisplayMode(mode: DisplayMode): void {
    if (mode === this.displayMode) return;
    this.displayMode = mode;
    document.body.dataset.mode = mode;
    this.render();
  }

  // ======================================================================
  // 読み込み
  // ======================================================================

  private async open(path: string, size: number): Promise<void> {
    await this.close();
    this.path = path;
    this.size = size;
    this.pathEl.textContent = path;
    this.state = { kind: "loading", path };
    this.render();
    void this.comments.load(path);
    try {
      const lib = pdfjs();
      const common = {
        // Canvas の CSP は eval・WASM・fetch を塞いでいる（緩めない）——どれも使わない形にする
        isEvalSupported: false,
        useWasm: false,
        useWorkerFetch: false,
        cMapPacked: true,
        BinaryDataFactory: AssetFactory,
      };
      let task;
      if (size <= RANGE_MAX) {
        task = lib.getDocument({ ...common, data: await readRange(path, 0, size) });
      } else {
        // 大きなファイルは要る範囲だけ運ぶ。先読み（autoFetch）はしない——見ないページのために 50MB を運ばない
        const transport = new lib.PDFDataRangeTransport(size, null);
        transport.requestDataRange = (begin: number, end: number) => {
          readRange(path, begin, end).then(
            (chunk) => transport.onDataRange(begin, chunk),
            (err: unknown) => {
              this.note = `PDF の中身を読めませんでした：${errorMessage(err)}`;
              this.noteError = true;
              this.render();
            },
          );
        };
        task = lib.getDocument({ ...common, range: transport, rangeChunkSize: RANGE_CHUNK, disableAutoFetch: true, disableStream: true });
      }
      this.loadingTask = task;
      const doc = await task.promise;
      if (this.path !== path) {
        await doc.destroy();
        return;
      }
      this.doc = doc;
      const first = await this.page(1);
      const vp = first.getViewport({ scale: 1 });
      this.baseWidth = vp.width;
      this.baseHeight = vp.height;
      this.state = { kind: "ready" };
      this.buildPages(doc.numPages);
      this.render();
    } catch (err) {
      const name = (err as { name?: unknown } | null)?.name;
      const message =
        name === "PasswordException"
          ? "パスワードのかかった PDF は、この画面ではまだ開けません"
          : name === "InvalidPDFException"
            ? "PDF として読めませんでした（壊れているか、PDF ではありません）"
            : errorMessage(err);
      this.state = { kind: "error", message };
      this.render();
    }
  }

  private async close(): Promise<void> {
    this.observer?.disconnect();
    this.observer = undefined;
    for (const slot of this.pages) this.discard(slot);
    this.pages.length = 0;
    this.pageCache.clear();
    this.textCache.clear();
    this.pageSizes.clear();
    this.visible.clear();
    this.matches = [];
    this.matchIndex = -1;
    this.query = "";
    this.pagesEl.replaceChildren();
    const doc = this.doc;
    const task = this.loadingTask;
    this.doc = undefined;
    this.loadingTask = undefined;
    await (doc ? doc.destroy() : task?.destroy());
  }

  private page(n: number): Promise<PdfPage> {
    const doc = this.doc;
    if (!doc) return Promise.reject(new Error("PDF を開いていません"));
    let p = this.pageCache.get(n);
    if (!p) {
      p = doc.getPage(n);
      this.pageCache.set(n, p);
      p.catch(() => this.pageCache.delete(n));
    }
    return p;
  }

  private text(n: number): Promise<PdfTextContent> {
    let t = this.textCache.get(n);
    if (!t) {
      t = this.page(n).then((p) => p.getTextContent());
      this.textCache.set(n, t);
      t.catch(() => this.textCache.delete(n));
    }
    return t;
  }

  // ======================================================================
  // ページ
  // ======================================================================

  private get scale(): number {
    return this.zoom > 0 ? this.zoom : this.fitScale;
  }

  /** 幅に合わせる倍率（大きく開いたときは読みやすい大きさで止める） */
  private computeFitScale(): number {
    const width = this.scroller.clientWidth - 32;
    if (width <= 0) return 1;
    const fit = width / this.baseWidth;
    return Math.max(0.25, Math.min(fit, this.displayMode === "fullscreen" ? 1.75 : 1.5));
  }

  private buildPages(count: number): void {
    this.fitScale = this.computeFitScale();
    this.observer = new IntersectionObserver((entries) => this.onIntersect(entries), { root: this.scroller });
    for (let i = 1; i <= count; i++) {
      const el = h("div", { class: "pdf-page", attrs: { "aria-label": `${i} ページ` }, data: { page: String(i), testid: "pdf-page" } });
      const slot: PageSlot = { index: i, el, generation: 0 };
      this.pages.push(slot);
      this.sizeSlot(slot);
      this.pagesEl.appendChild(el);
      this.observer.observe(el);
    }
  }

  private sizeSlot(slot: PageSlot): void {
    const size = this.pageSizes.get(slot.index) ?? { width: this.baseWidth, height: this.baseHeight };
    slot.el.style.width = `${Math.floor(size.width * this.scale)}px`;
    slot.el.style.height = `${Math.floor(size.height * this.scale)}px`;
  }

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      const n = Number((entry.target as HTMLElement).dataset.page);
      if (entry.isIntersecting) this.visible.add(n);
      else this.visible.delete(n);
    }
    this.updateWanted();
    this.updateCurrentPage();
  }

  /** **見えているページとその前後だけ描く**。外れたものは止めて捨てる */
  private updateWanted(): void {
    const wanted = new Set<number>();
    for (const n of this.visible) for (const m of [n - 1, n, n + 1]) if (m >= 1 && m <= this.pages.length) wanted.add(m);
    for (const slot of this.pages) {
      if (wanted.has(slot.index)) {
        if (slot.renderedScale !== this.scale) void this.renderPage(slot);
      } else if (slot.renderedScale !== undefined) {
        this.discard(slot);
      }
    }
  }

  /** 描画を止め（`renderTask.cancel()`）、絵と文字の層を捨てる */
  private discard(slot: PageSlot): void {
    slot.generation++;
    slot.task?.cancel();
    slot.textLayer?.cancel();
    slot.task = undefined;
    slot.textLayer = undefined;
    slot.renderedScale = undefined;
    slot.el.replaceChildren();
    slot.el.classList.remove("rendered");
    // 描き終えた分の中身は pdf.js の側でも手放す（ページの物そのものは残す——また見に来たらすぐ描ける）
    void this.pageCache.get(slot.index)?.then((p) => p.cleanup()).catch(() => undefined);
  }

  private async renderPage(slot: PageSlot): Promise<void> {
    slot.task?.cancel();
    slot.textLayer?.cancel();
    const generation = ++slot.generation;
    const scale = this.scale;
    slot.renderedScale = scale;
    const stale = () => generation !== slot.generation;
    try {
      const page = await this.page(slot.index);
      if (stale()) return;
      const base = page.getViewport({ scale: 1 });
      if (!this.pageSizes.has(slot.index)) {
        this.pageSizes.set(slot.index, { width: base.width, height: base.height });
        this.sizeSlot(slot);
      }
      const viewport = page.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;
      const canvas = h("canvas", { class: "pdf-canvas" });
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const textEl = h("div", { class: "textLayer" });
      slot.el.style.setProperty("--scale-factor", String(scale));
      slot.el.style.setProperty("--user-unit", String(viewport.userUnit ?? 1));
      slot.el.replaceChildren(canvas, textEl);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas が使えません");
      const task = page.render({ canvasContext: ctx, viewport, ...(ratio !== 1 ? { transform: [ratio, 0, 0, ratio, 0, 0] } : {}) });
      slot.task = task;
      await task.promise;
      if (stale()) return;
      slot.task = undefined;
      const content = await this.text(slot.index);
      if (stale()) return;
      const textLayer = new (pdfjs().TextLayer)({ textContentSource: content, container: textEl, viewport });
      slot.textLayer = textLayer;
      await textLayer.render();
      if (stale()) return;
      slot.el.classList.add("rendered");
      this.paintMatches(slot);
      void this.paintFocus(slot);
    } catch (err) {
      if (isRenderingCancelled(err) || stale()) return;
      slot.renderedScale = undefined;
      slot.el.replaceChildren(h("div", { class: "state error" }, icon("TriangleAlert"), `${slot.index} ページを描けませんでした：${errorMessage(err)}`));
    }
  }

  private updateCurrentPage(): void {
    if (this.pages.length === 0) return;
    // 見えている真ん中の線が掛かっているページ（探した文字は真ん中に出すので、その文字のページになる）
    const middle = this.scroller.scrollTop + this.scroller.clientHeight / 2;
    let current = 1;
    for (const slot of this.pages) {
      if (slot.el.offsetTop <= middle) current = slot.index;
      else break;
    }
    if (current !== this.currentPage || !this.pageLabel.textContent) {
      this.currentPage = current;
      this.pageLabel.textContent = `${current} / ${this.pages.length} ページ`;
    }
  }

  private onResize(): void {
    if (this.state.kind !== "ready") return;
    const next = this.computeFitScale();
    if (Math.abs(next - this.fitScale) < 0.01) return;
    this.fitScale = next;
    if (this.zoom === 0) this.relayout();
  }

  private changeZoom(direction: 1 | -1): void {
    if (this.state.kind !== "ready") return;
    const now = this.scale;
    const next =
      direction > 0 ? ZOOM_STEPS.find((z) => z > now + 0.001) ?? ZOOM_STEPS.at(-1)! : [...ZOOM_STEPS].reverse().find((z) => z < now - 0.001) ?? ZOOM_STEPS[0]!;
    this.zoom = next;
    this.relayout();
  }

  /** 倍率が変わった——枠の大きさを合わせ、いまの場所を保ったまま描き直す */
  private relayout(): void {
    const anchor = this.currentPage;
    for (const slot of this.pages) this.sizeSlot(slot);
    const target = this.pages[anchor - 1];
    if (target) this.scroller.scrollTop = target.el.offsetTop - 8;
    this.updateWanted();
    this.render();
  }

  // ======================================================================
  // 探す
  // ======================================================================

  private async search(query: string): Promise<void> {
    const token = ++this.searchToken;
    this.query = query;
    this.matches = [];
    this.matchIndex = -1;
    for (const slot of this.pages) this.paintMatches(slot);
    const needle = query.trim().toLowerCase();
    if (!needle || !this.doc) {
      this.searching = false;
      this.render();
      return;
    }
    this.searching = true;
    this.render();
    try {
      for (let n = 1; n <= this.pages.length; n++) {
        const content = await this.text(n);
        if (token !== this.searchToken) return;
        this.matches.push(...findInPage(n, content, needle));
        // 最初に当たったところへすぐ飛ぶ（全部のページを読み終えるまで待たせない）
        if (this.matchIndex < 0 && this.matches.length > 0) this.select(0);
        else this.render();
      }
    } catch (err) {
      this.note = `探せませんでした：${errorMessage(err)}`;
      this.noteError = true;
    }
    if (token !== this.searchToken) return;
    this.searching = false;
    this.render();
  }

  private step(direction: 1 | -1): void {
    if (this.matches.length === 0) return;
    this.select((this.matchIndex + direction + this.matches.length) % this.matches.length);
  }

  private select(index: number): void {
    const previous = this.matches[this.matchIndex];
    this.matchIndex = index;
    const match = this.matches[index];
    if (previous) this.paintMatches(this.pages[previous.page - 1]);
    if (match) {
      const slot = this.pages[match.page - 1];
      if (slot) {
        this.paintMatches(slot);
        const span = slot.el.querySelector<HTMLElement>(".textLayer .highlight.selected");
        if (span) this.scrollToCenter(span);
        else this.scroller.scrollTop = slot.el.offsetTop - 8;
      }
    }
    this.render();
  }

  /** そのページの文字の層に、当たったところの印を付け直す（まだ描いていなければ、描いたときに付く） */
  private paintMatches(slot: PageSlot | undefined): void {
    if (!slot?.textLayer) return;
    const divs = slot.textLayer.textDivs;
    for (const div of divs) div.classList.remove("highlight", "selected");
    this.matches.forEach((m, i) => {
      if (m.page !== slot.index) return;
      for (const item of m.items) {
        const div = divs[item];
        if (!div) continue;
        div.classList.add("highlight");
        if (i === this.matchIndex) div.classList.add("selected");
      }
    });
    if (this.matchIndex >= 0 && this.matches[this.matchIndex]?.page === slot.index) {
      const span = slot.el.querySelector<HTMLElement>(".textLayer .highlight.selected");
      if (span) this.scrollToCenter(span);
    }
  }

  /**
   * その要素がこの画面のスクロールの真ん中に来るように動かす。`scrollIntoView` は使わない——会話の中のカードでは
   * 外側（会話）まで動かしてしまう
   */
  private scrollToCenter(el: HTMLElement): void {
    const box = this.scroller.getBoundingClientRect();
    const target = el.getBoundingClientRect();
    this.scroller.scrollTop += target.top - box.top - (this.scroller.clientHeight - target.height) / 2;
  }

  // ======================================================================
  // コメント（`comments.ts`）
  // ======================================================================

  private toggleComments(): void {
    this.commentsOpen = !this.commentsOpen;
    this.comments.el.hidden = !this.commentsOpen;
    this.commentsBtn.setAttribute("aria-pressed", String(this.commentsOpen));
    if (this.commentsOpen) void this.comments.reload();
    else this.comments.cancelRegion();
    this.onCommentsChange();
  }

  private onCommentsChange(): void {
    this.commentsCount.textContent = this.comments.count > 0 ? String(this.comments.count) : "";
    if (this.displayMode === "inline") reportSize();
  }

  /** 人がいまページの中で選んでいる文と、そのページ。ページの外（ツールバー等）の選択は数えない */
  private selectedText(): Extract<CommentAnchor, { kind: "text" }> | undefined {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined;
    const range = selection.getRangeAt(0);
    const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    const pageEl = start?.closest<HTMLElement>(".pdf-page");
    if (!pageEl || !this.pagesEl.contains(pageEl)) return undefined;
    const quote = selection.toString().replace(/\s+/g, " ").trim();
    if (!quote) return undefined;
    return { kind: "text", quote: quote.slice(0, 2000), page: Number(pageEl.dataset.page) };
  }

  /** ドラッグで範囲を囲ませる。返り値で取りやめる */
  private startRegion(done: (anchor: Extract<CommentAnchor, { kind: "region" }>) => void): () => void {
    this.drawing = done;
    this.scroller.classList.add("drawing");
    return () => {
      if (this.drawing !== done) return;
      this.drawing = undefined;
      this.scroller.classList.remove("drawing");
    };
  }

  private onRegionPointerDown(e: PointerEvent): void {
    const done = this.drawing;
    if (!done || e.button !== 0) return;
    const pageEl = (e.target as Element | null)?.closest<HTMLElement>(".pdf-page");
    if (!pageEl) return;
    e.preventDefault();
    const box = pageEl.getBoundingClientRect();
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    const at = (ev: PointerEvent) => ({ x: clamp((ev.clientX - box.left) / box.width), y: clamp((ev.clientY - box.top) / box.height) });
    const from = at(e);
    const frame = h("div", { class: "comment-region drawing-box" });
    pageEl.appendChild(frame);
    let rect: CommentRect = { x: from.x, y: from.y, w: 0, h: 0 };
    const place = (r: CommentRect) => {
      frame.style.left = `${r.x * 100}%`;
      frame.style.top = `${r.y * 100}%`;
      frame.style.width = `${r.w * 100}%`;
      frame.style.height = `${r.h * 100}%`;
    };
    const move = (ev: PointerEvent) => {
      const to = at(ev);
      rect = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y) };
      place(rect);
    };
    const up = (ev: PointerEvent) => {
      move(ev);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      frame.remove();
      // 押しただけ（ほとんど動かしていない）は囲んだことにしない——もう一度ドラッグできる
      if (rect.w < 0.01 || rect.h < 0.01 || this.drawing !== done) return;
      this.drawing = undefined;
      this.scroller.classList.remove("drawing");
      const round = (v: number) => Math.round(v * 10000) / 10000;
      done({ kind: "region", page: Number(pageEl.dataset.page), rect: { x: round(rect.x), y: round(rect.y), w: round(rect.w), h: round(rect.h) } });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /** コメントの場所へ飛ぶ。そのページを描いたら、文には印・範囲には枠を出す */
  private jumpTo(anchor: CommentAnchor): void {
    if (anchor.kind === "cell" || this.state.kind !== "ready") return;
    const page = anchor.page;
    const slot = page !== undefined ? this.pages[page - 1] : undefined;
    if (!slot) return;
    const previous = this.focused;
    this.focused = anchor;
    const prevSlot = previous && previous.kind !== "cell" && previous.page !== undefined ? this.pages[previous.page - 1] : undefined;
    if (prevSlot && prevSlot !== slot) void this.paintFocus(prevSlot);
    this.scroller.scrollTop = slot.el.offsetTop - 8;
    void this.paintFocus(slot);
  }

  private async paintFocus(slot: PageSlot | undefined): Promise<void> {
    if (!slot) return;
    slot.el.querySelectorAll(".comment-region.focus").forEach((el) => el.remove());
    slot.textLayer?.textDivs.forEach((div) => div.classList.remove("comment-focus"));
    const anchor = this.focused;
    if (!anchor || anchor.kind === "cell" || anchor.page !== slot.index) return;
    if (anchor.kind === "region") {
      const frame = h("div", { class: "comment-region focus", data: { testid: "comment-region-focus" } });
      frame.style.left = `${anchor.rect.x * 100}%`;
      frame.style.top = `${anchor.rect.y * 100}%`;
      frame.style.width = `${anchor.rect.w * 100}%`;
      frame.style.height = `${anchor.rect.h * 100}%`;
      slot.el.appendChild(frame);
    } else if (anchor.kind === "text" && slot.textLayer) {
      const divs = slot.textLayer.textDivs;
      const content = await this.text(slot.index);
      if (this.focused !== anchor) return;
      for (const item of findLoosely(content, anchor.quote)) divs[item]?.classList.add("comment-focus");
      const first = slot.el.querySelector<HTMLElement>(".textLayer .comment-focus");
      if (first) this.scrollToCenter(first);
    }
  }

  // ======================================================================
  // 大きく開く・描く
  // ======================================================================

  private async askFullscreen(): Promise<void> {
    try {
      const mode = await requestDisplayMode("fullscreen");
      if (mode !== "fullscreen") {
        this.note = `大きく表示できませんでした（いまは ${mode ?? "不明"}）`;
        this.noteError = true;
        this.render();
      }
    } catch (err) {
      this.note = errorMessage(err);
      this.noteError = true;
      this.render();
    }
  }

  private render(): void {
    const state = this.state;
    this.root.dataset.mode = this.displayMode;
    this.fullscreenBtn.hidden = this.displayMode !== "inline";
    this.status.hidden = state.kind === "ready";
    this.status.className = state.kind === "error" ? "state error" : "state";
    if (state.kind === "waiting") replaceChildren(this.status, icon("Loader2", "icon spin"), "ファイルを待っています…");
    else if (state.kind === "loading") replaceChildren(this.status, icon("Loader2", "icon spin"), `${formatSize(this.size)} の PDF を開いています…`);
    else if (state.kind === "error") replaceChildren(this.status, icon("TriangleAlert"), h("span", { text: `PDF を開けませんでした：${state.message}`, data: { testid: "pdf-error" } }));
    this.status.dataset.testid = state.kind === "error" ? "pdf-error-state" : "pdf-status";
    this.zoomLabel.textContent = state.kind === "ready" ? `${Math.round(this.scale * 100)}%` : "";
    if (state.kind === "ready") this.updateCurrentPage();
    else this.pageLabel.textContent = "";
    this.searchCount.textContent = !this.query.trim()
      ? ""
      : this.matches.length === 0
        ? this.searching
          ? "探しています…"
          : "見つかりません"
        : `${this.matchIndex + 1} / ${this.matches.length} 件${this.searching ? "…" : ""}`;
    this.noteEl.textContent = this.note;
    this.noteEl.className = this.noteError ? "note error" : "note";
    this.noteEl.hidden = !this.note;
    if (this.displayMode === "inline") reportSize();
  }
}

/**
 * そのページの文字の中から、探す語の当たりを拾う。文字の層の要素（items）をつないだ1本の文字列で探し、
 * 当たった範囲に掛かる items の番号を返す（語が要素の境目をまたいでもよい）。大文字と小文字は区別しない
 */
export function findInPage(page: number, content: PdfTextContent, needle: string): Match[] {
  const starts: number[] = [];
  let joined = "";
  // 文字の層の要素は str を持つ items だけから作られる（印の区切りの items は要素にならない）——番号をそろえる
  for (const item of content.items) {
    if (typeof item.str !== "string") continue;
    starts.push(joined.length);
    joined += item.str.toLowerCase();
  }
  const out: Match[] = [];
  if (!needle) return out;
  let at = joined.indexOf(needle);
  while (at >= 0) {
    const end = at + needle.length;
    const items: number[] = [];
    for (let i = 0; i < starts.length; i++) {
      const s = starts[i]!;
      const e = i + 1 < starts.length ? starts[i + 1]! : joined.length;
      if (e > at && s < end) items.push(i);
    }
    out.push({ page, items });
    at = joined.indexOf(needle, end);
  }
  return out;
}

/**
 * コメントの引用が、そのページの文字の層のどの要素に掛かるか。選んだ文は要素の境目に空白や改行が入るので、
 * **空白を無視して**探す（最初に当たったところ）
 */
export function findLoosely(content: PdfTextContent, quote: string): number[] {
  const needle = quote.replace(/\s+/g, "").toLowerCase();
  if (!needle) return [];
  let joined = "";
  const owner: number[] = [];
  let index = 0;
  for (const item of content.items) {
    if (typeof item.str !== "string") continue;
    for (const ch of item.str.replace(/\s+/g, "").toLowerCase()) {
      joined += ch;
      for (let k = 0; k < ch.length; k++) owner.push(index);
    }
    index++;
  }
  const at = joined.indexOf(needle);
  if (at < 0) return [];
  return [...new Set(owner.slice(at, at + needle.length))];
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
