// **PDF を元の見た目で読む画面**（`ui://banto-filesystem/document`、v4-modules.md §2.2「PDF・Office…」、2026-10-15）。
//
// showFile が PDF を見せるとき、host がこの画面を選ぶ（`dev.banto/ui-by-extension`）。会話の中では
// 高さを決めたカード（大きくするのは banto の枠の「大きく開く」）、大きく開くと画面いっぱい。どちらも同じ描き方：
//   - **中身はバイトの範囲で受ける**（`readFileRange`、1回 4MiB まで）——pdf.js は末尾の xref から読むので
//     ページでは切り出せない。小さなファイルは1回で全部読み、大きなものは `PDFDataRangeTransport` で要る範囲だけ
//   - **ページごとに canvas＋文字の層**（選べる・探せる）。**描くのは見えているページとその前後だけ**。
//     見えなくなったら `renderTask.cancel()` で止め、絵も捨てる（100 ページを全部描くとメモリが持たない）
//   - CMap・標準フォントは pdf.js が fetch したがるが、Canvas の CSP は fetch を塞いでいる（緩めない）ので
//     `readPdfAsset` で受ける
//   - **コメント**（`comments.ts`、Backlog #307・#340）：コメントモードのとき、文を選び終えると選んだ横に「コメント」、
//     文字の無い所をドラッグするとそのまま範囲（「コメント」を押すまで点線の枠で残す）、各ページの上の行に「この
//     ページにコメント」。付けたものは文に蛍光ペン・範囲に枠・ページに左の縁の線。広いときは右の余白に、指した所の高さに並ぶ
//   - **Office の文書（pptx・doc・ppt・odt・odp、docx の「元に近い見た目」）も同じ画面で描く**（Backlog #305）：
//     `convertDocument` で変換役（LibreOffice）に PDF にしてもらい、写しを `readFileRange` の `converted` で読む。
//     変換役を入れている途中（初回だけ、数分）は、そう出して待ち、頼み直す。コメントの鍵は元のファイルのパス

import { bindTextLayer } from "./text-selection.js";
import { CommentReview, MARGIN_ROOM_PX, type AnchorBox, type CommentAnchor, type CommentRect, type CommentTarget } from "./comments.js";
import { quoteRange, rangeRects } from "./quote-range.js";
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

/** 変換役を入れている途中のとき、頼み直すまでの間 */
export const PREPARING_RETRY_MS = 5_000;

/**
 * 画面のファイルのバイトを読む（範囲が 4MiB を超えるときは分けて頼む）。`converted` なら、そのファイルを変換した写し
 * ——`"pdf"` は PDF にしたもの、`"spreadsheet"` は表を計算し直したもの（写しはパスで指さない——元のパスで FileSystem が
 * 置き場から引く）
 */
export async function readRange(path: string, begin: number, end: number, converted?: "pdf" | "spreadsheet"): Promise<Uint8Array> {
  const out = new Uint8Array(end - begin);
  let at = begin;
  while (at < end) {
    const length = Math.min(RANGE_MAX, end - at);
    const result = JSON.parse(textOf(await callTool("readFileRange", { path, offset: at, length, ...(converted ? { converted: true, to: converted } : {}) }))) as {
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
  /** ページの上の細い行とページを包む枠 */
  wrap: HTMLDivElement;
  el: HTMLDivElement;
  /** コメントの印の層（描き直しても捨てない） */
  marks: HTMLDivElement;
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

type LoadState =
  | { kind: "waiting" }
  | { kind: "converting"; message?: string }
  | { kind: "loading"; path: string }
  | { kind: "error"; message: string }
  | { kind: "ready" };

/** 拡張子ごとの呼び名（ツールバーの見出しと、ページの数え方） */
const KIND_LABELS: Record<string, { name: string; unit: string }> = {
  pdf: { name: "PDF", unit: "ページ" },
  docx: { name: "Word", unit: "ページ" },
  doc: { name: "Word", unit: "ページ" },
  odt: { name: "文書", unit: "ページ" },
  pptx: { name: "PowerPoint", unit: "スライド" },
  ppt: { name: "PowerPoint", unit: "スライド" },
  odp: { name: "プレゼンテーション", unit: "スライド" },
};

function kindLabel(path: string): { name: string; unit: string } {
  return KIND_LABELS[/\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? ""] ?? { name: "文書", unit: "ページ" };
}

export class PdfDocumentView {
  private displayMode: DisplayMode;
  private readonly converted: boolean;
  private path = "";
  private size = 0;
  /** ページの数え方（pptx はスライド） */
  private unit = "ページ";
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
  private readonly review: CommentReview;
  /** 一覧から飛んだ文（そのページを描いたときに、真ん中へ動かす） */
  private jumpPending?: CommentAnchor;
  /** 「コメント」を出したときのスクロールの位置（動かしたら引っ込める） */
  private offeredAt = 0;

  // --- 固定の要素（描き直しで作り直さない——作り直すとスクロールと入力が飛ぶ）---
  private readonly scroller: HTMLDivElement;
  /** 中身の箱：ページの列と右の余白を並べる（コメントの位置はこの中で数える） */
  private readonly content: HTMLDivElement;
  private readonly pagesEl: HTMLDivElement;
  private readonly pageLabel: HTMLSpanElement;
  private readonly zoomLabel: HTMLSpanElement;
  private readonly searchInput: HTMLInputElement;
  private readonly searchCount: HTMLSpanElement;
  private readonly searchBox: HTMLDivElement;
  private readonly searchOpen: HTMLButtonElement;
  private readonly status: HTMLDivElement;
  private readonly noteEl: HTMLParagraphElement;
  private readonly kindIcon: HTMLSpanElement;
  private readonly pathEl: HTMLSpanElement;

  constructor(
    private readonly root: HTMLElement,
    options: {
      displayMode: DisplayMode;
      /** host が `ui/message` を受けるか（会話の中で開いた画面）。受けなければコメントは「コピー」で持ち出す */
      canReturnComments: boolean;
      /** Office の文書を変換役で PDF にして描く（pptx 等・docx の「元に近い見た目」） */
      converted?: boolean;
      /** ツールバーの「コメント」の前に置くボタン（docx の「Word の描き方で見る」） */
      actions?: HTMLElement[];
    },
  ) {
    this.displayMode = options.displayMode;
    this.converted = options.converted ?? false;
    this.kindIcon = h("span", { class: "kind-icon" }, icon("FileText", "icon muted"));
    this.pathEl = h("span", { class: "doc-name truncate", text: "（PDF）", data: { testid: "open-path" } });
    this.pageLabel = h("span", { class: "pdf-page-label", data: { testid: "pdf-page-label" } });
    this.zoomLabel = h("span", { class: "pdf-zoom-label", data: { testid: "pdf-zoom" } });
    this.searchInput = h("input", {
      class: "pdf-search-input",
      attrs: { type: "search", placeholder: "中を探す", "aria-label": "文書の中を探す" },
      data: { testid: "pdf-search" },
      on: {
        keydown: (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (this.searchInput.value !== this.query) void this.search(this.searchInput.value);
            else this.step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            this.closeSearch();
          }
        },
      },
    });
    this.searchCount = h("span", { class: "pdf-search-count", data: { testid: "pdf-search-count" } });
    const iconButton = (label: string, name: Parameters<typeof icon>[0], onClick: () => void, testid?: string) =>
      h("button", { class: "icon-btn strong", title: label, attrs: { type: "button", "aria-label": label }, ...(testid ? { data: { testid } } : {}), on: { click: onClick } }, icon(name));
    // 探すのは虫眼鏡を押すと欄が開く（ツールバーを1段に収める）
    this.searchOpen = iconButton("中を探す", "Search", () => this.openSearch(), "pdf-search-open");
    this.searchBox = h(
      "div",
      { class: "pdf-search" },
      icon("Search", "icon muted"),
      this.searchInput,
      this.searchCount,
      iconButton("前の一致", "ChevronUp", () => this.step(-1)),
      iconButton("次の一致", "ChevronDown", () => this.step(1)),
      iconButton("探すのを閉じる", "X", () => this.closeSearch(), "pdf-search-close"),
    );
    this.searchBox.hidden = true;
    this.status = h("div", { class: "state" });
    this.pagesEl = h("div", { class: "pdf-pages" });
    this.content = h("div", { class: "review-content" }, this.pagesEl);
    this.scroller = h("div", { class: "pdf-scroller", data: { testid: "pdf-scroller" } }, this.status, this.content);
    this.noteEl = h("p", { class: "note" });
    const toolbar = h("div", { class: "pdf-toolbar" });
    const view = h("div", { class: "pdf-view", data: { testid: "pdf-view" } }, toolbar, this.scroller, this.noteEl);
    const target: CommentTarget = {
      boxOf: (anchor) => this.boxOf(anchor),
      jumpTo: (anchor) => this.jumpTo(anchor),
      paintMarks: () => this.paintMarks(),
    };
    this.review = new CommentReview(target, {
      root: view,
      content: this.content,
      displayMode: this.displayMode,
      canReturn: options.canReturnComments,
      emptyHint: "文を選ぶか、図をドラッグで囲むと、そこにコメントを付けられます。ページの上の行からページにも付けられます。",
      onLayoutChange: () => this.onResize(),
      onChange: () => this.displayMode === "inline" && reportSize(),
    });
    this.content.append(this.review.margin);
    toolbar.append(
      this.kindIcon,
      this.pathEl,
      this.pageLabel,
      h("span", { class: "spacer-fill" }),
      this.searchOpen,
      this.searchBox,
      h("span", { class: "pdf-zoom" }, iconButton("縮小", "ZoomOut", () => this.changeZoom(-1)), this.zoomLabel, iconButton("拡大", "ZoomIn", () => this.changeZoom(1))),
      ...(options.actions ?? []),
      this.review.modeButton,
      this.review.listButton,
      this.review.undoButton,
      this.review.returnButton,
    );
    this.scroller.addEventListener("scroll", () => this.onScroll(), { passive: true });
    this.pagesEl.addEventListener("pointerdown", (e) => this.onPagePointerDown(e));
    this.pagesEl.addEventListener("mouseup", (e) => this.onPageMouseUp(e));
    document.addEventListener("selectionchange", () => {
      // 選ぶのをやめたら（ほかを押した）、選んだ文の「コメント」も引っ込める
      if (this.review.offeredAnchor?.kind === "text" && !this.selectedText()) this.review.clearOffer();
    });
    replaceChildren(this.root, view);
    new ResizeObserver(() => this.onResize()).observe(this.scroller);
    this.render();
  }

  setToolInput(args: Record<string, unknown>): void {
    if (typeof args.path === "string" && args.path && !this.path) this.showName(args.path);
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

  /** 画面の下に添える一言（docx を描けずに PDF にしたとき、その理由） */
  showNote(text: string): void {
    this.note = text;
    this.noteError = false;
    this.render();
  }

  setDisplayMode(mode: DisplayMode): void {
    if (mode === this.displayMode) return;
    this.displayMode = mode;
    document.body.dataset.mode = mode;
    this.review.setDisplayMode(mode);
    this.render();
  }

  /** ツールバーにはファイル名だけ（パスは title）。スライドは種類のアイコンも変える */
  private showName(path: string): void {
    this.pathEl.textContent = path.split("/").pop() || path;
    this.pathEl.title = path;
    this.pathEl.dataset.path = path;
    this.kindIcon.replaceChildren(icon(kindLabel(path).unit === "スライド" ? "Presentation" : "FileText", "icon muted"));
  }

  // ======================================================================
  // 読み込み
  // ======================================================================

  private async open(path: string, size: number): Promise<void> {
    await this.close();
    this.path = path;
    this.size = size;
    this.unit = kindLabel(path).unit;
    this.showName(path);
    this.state = this.converted ? { kind: "converting" } : { kind: "loading", path };
    this.render();
    void this.review.load(path);
    const converted = this.converted ? "pdf" : undefined;
    try {
      if (converted) {
        // 変換したものの大きさで読む（元のファイルの大きさではない）
        const bytes = await this.convert(path);
        if (bytes === undefined) return;
        size = bytes;
        this.size = bytes;
        this.state = { kind: "loading", path };
        this.render();
      }
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
        task = lib.getDocument({ ...common, data: await readRange(path, 0, size, converted) });
      } else {
        // 大きなファイルは要る範囲だけ運ぶ。先読み（autoFetch）はしない——見ないページのために 50MB を運ばない
        const transport = new lib.PDFDataRangeTransport(size, null);
        transport.requestDataRange = (begin: number, end: number) => {
          readRange(path, begin, end, converted).then(
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

  /**
   * **変換役に PDF にしてもらう**（同じ中身なら置き場のものが返る）。変換役を入れている途中なら、そう出して
   * 間をおいて頼み直す。変換したものの大きさを返す（その間に別のファイルを開いたら undefined）
   */
  private async convert(path: string): Promise<number | undefined> {
    for (;;) {
      const result = await callTool("convertDocument", { path, to: "pdf" });
      if (this.path !== path) return undefined;
      if (result.isError) throw new Error(textOf(result) || "変換できませんでした");
      const outcome = JSON.parse(textOf(result)) as { status?: unknown; message?: unknown; bytes?: unknown };
      if (outcome.status === "converted" && typeof outcome.bytes === "number") return outcome.bytes;
      if (outcome.status !== "preparing") throw new Error(`変換役の返事が読めません：${textOf(result)}`);
      this.state = { kind: "converting", message: typeof outcome.message === "string" ? outcome.message : undefined };
      this.render();
      await new Promise((r) => setTimeout(r, PREPARING_RETRY_MS));
      if (this.path !== path) return undefined;
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
    // 広いときは右の余白（と隙間）を引いた幅に収める
    const width = this.scroller.clientWidth - 32 - (this.review.marginShown ? MARGIN_ROOM_PX : 0);
    if (width <= 0) return 1;
    const fit = width / this.baseWidth;
    return Math.max(0.25, Math.min(fit, this.displayMode === "fullscreen" ? 1.75 : 1.5));
  }

  private buildPages(count: number): void {
    this.fitScale = this.computeFitScale();
    this.observer = new IntersectionObserver((entries) => this.onIntersect(entries), { root: this.scroller });
    const slides = this.unit === "スライド";
    for (let i = 1; i <= count; i++) {
      const marks = h("div", { class: "comment-marks" });
      const el = h("div", { class: "pdf-page", attrs: { "aria-label": `${i} ${this.unit}` }, data: { page: String(i), testid: "pdf-page" } }, marks);
      // ページの上の細い行：何枚目か、コメントモードなら「このページにコメント」（左の外に置いたアイコンは、マウスが
      // 隙間を通ると消えた——ユーザー、2026-10-16）
      const head = h(
        "div",
        { class: "pdf-page-head" },
        h("span", { text: slides ? `${i} 枚目` : `${i} ページ` }),
        h(
          "button",
          {
            class: "page-comment-btn",
            attrs: { type: "button" },
            data: { testid: "comment-for-page", page: String(i) },
            on: { click: () => this.review.beginDraft({ kind: "page", page: i }) },
          },
          icon("MessageSquarePlus"),
          slides ? "このスライドにコメント" : "このページにコメント",
        ),
      );
      const wrap = h("div", { class: "pdf-page-wrap" }, head, el);
      const slot: PageSlot = { index: i, wrap, el, marks, generation: 0 };
      this.pages.push(slot);
      this.sizeSlot(slot);
      this.pagesEl.appendChild(wrap);
      this.observer.observe(el);
    }
    this.paintMarks();
  }

  private sizeSlot(slot: PageSlot): void {
    const size = this.pageSizes.get(slot.index) ?? { width: this.baseWidth, height: this.baseHeight };
    slot.el.style.width = `${Math.floor(size.width * this.scale)}px`;
    slot.el.style.height = `${Math.floor(size.height * this.scale)}px`;
    slot.wrap.style.width = slot.el.style.width;
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
    slot.el.replaceChildren(slot.marks);
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
      slot.el.replaceChildren(canvas, slot.marks, textEl);
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
      bindTextLayer(textEl);
      slot.el.classList.add("rendered");
      this.paintMatches(slot);
      // 文の印は文字の層が要る——描けたら付け直し、余白のコメントをその高さに並べ直す
      this.paintSlotMarks(slot);
      this.review.layout();
      const pending = this.jumpPending;
      if (pending?.kind === "text" && pending.page === slot.index) {
        this.jumpPending = undefined;
        const first = slot.marks.querySelector<HTMLElement>(".comment-mark.text.focused");
        if (first) this.scrollToCenter(first);
      }
    } catch (err) {
      if (isRenderingCancelled(err) || stale()) return;
      slot.renderedScale = undefined;
      slot.el.replaceChildren(slot.marks, h("div", { class: "state error" }, icon("TriangleAlert"), `${slot.index} ${this.unit}を描けませんでした：${errorMessage(err)}`));
    }
  }

  private updateCurrentPage(): void {
    if (this.pages.length === 0) return;
    // 見えている真ん中の線が掛かっているページ（探した文字は真ん中に出すので、その文字のページになる）
    const middle = this.scroller.scrollTop + this.scroller.clientHeight / 2;
    let current = 1;
    for (const slot of this.pages) {
      if (this.topOf(slot.el) <= middle) current = slot.index;
      else break;
    }
    if (current !== this.currentPage || !this.pageLabel.textContent) {
      this.currentPage = current;
      this.pageLabel.textContent = `${current} / ${this.pages.length} ${this.unit}`;
    }
  }

  /** スクロールの中での要素の頭の位置（ページは中身の箱の中にあるので offsetTop では数えられない） */
  private topOf(el: HTMLElement): number {
    return el.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top + this.scroller.scrollTop;
  }

  private onScroll(): void {
    this.updateCurrentPage();
    // スクロールしたら「コメント」と囲んだ範囲は引っ込める（指した所から離れる）
    if (this.review.offeredAnchor && Math.abs(this.scroller.scrollTop - this.offeredAt) > 4) this.review.clearOffer();
  }

  private onResize(): void {
    if (this.state.kind !== "ready") {
      this.review.layout();
      return;
    }
    const next = this.computeFitScale();
    if (Math.abs(next - this.fitScale) < 0.01) {
      this.review.layout();
      return;
    }
    this.fitScale = next;
    if (this.zoom === 0) this.relayout();
    else this.review.layout();
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
    if (target) this.scroller.scrollTop = this.topOf(target.wrap) - 8;
    this.updateWanted();
    this.render();
    this.review.layout();
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
        else this.scroller.scrollTop = this.topOf(slot.wrap) - 8;
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
  // 探す欄
  // ======================================================================

  private openSearch(): void {
    this.searchOpen.hidden = true;
    this.searchBox.hidden = false;
    this.searchInput.focus();
    this.searchInput.select();
  }

  private closeSearch(): void {
    this.searchBox.hidden = true;
    this.searchOpen.hidden = false;
    this.searchInput.value = "";
    if (this.query) void this.search("");
  }

  // ======================================================================
  // コメント（`comments.ts`）
  // ======================================================================

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

  /** 中身の箱の中での位置（px）に直す */
  private local(rect: { top: number; bottom: number; left: number; right: number }): AnchorBox {
    const c = this.content.getBoundingClientRect();
    return { top: rect.top - c.top, bottom: rect.bottom - c.top, left: rect.left - c.left, right: rect.right - c.left };
  }

  /** その文が、描いたページの文字の層のどこにあるか（ページの中の割合の矩形） */
  private quoteRects(slot: PageSlot, quote: string): CommentRect[] {
    const layer = slot.textLayer ? slot.el.querySelector<HTMLElement>(".textLayer") : null;
    const range = layer ? quoteRange(layer, quote) : undefined;
    if (!range) return [];
    const pb = slot.el.getBoundingClientRect();
    if (pb.width === 0 || pb.height === 0) return [];
    return rangeRects(range).map((r) => ({ x: (r.left - pb.left) / pb.width, y: (r.top - pb.top) / pb.height, w: r.width / pb.width, h: r.height / pb.height }));
  }

  private boxOf(anchor: CommentAnchor): AnchorBox | undefined {
    if (anchor.kind === "cell" || anchor.page === undefined) return undefined;
    const slot = this.pages[anchor.page - 1];
    if (!slot) return undefined;
    const pb = slot.el.getBoundingClientRect();
    const part = (r: CommentRect) => ({ top: pb.top + r.y * pb.height, bottom: pb.top + (r.y + r.h) * pb.height, left: pb.left + r.x * pb.width, right: pb.left + (r.x + r.w) * pb.width });
    if (anchor.kind === "region") return this.local(part(anchor.rect));
    if (anchor.kind === "text") {
      const rects = this.quoteRects(slot, anchor.quote).map(part);
      if (rects.length > 0)
        return this.local({
          top: Math.min(...rects.map((r) => r.top)),
          bottom: Math.max(...rects.map((r) => r.bottom)),
          left: Math.min(...rects.map((r) => r.left)),
          right: Math.max(...rects.map((r) => r.right)),
        });
    }
    // ページ（と、まだ描いていないページの文）はページの頭
    return this.local({ top: pb.top, bottom: pb.top + 8, left: pb.left, right: pb.right });
  }

  private paintMarks(): void {
    for (const slot of this.pages) this.paintSlotMarks(slot);
  }

  /** そのページの印：文は蛍光ペン、範囲は枠、ページは左の縁の線（コメントモードのときだけ） */
  private paintSlotMarks(slot: PageSlot): void {
    const review = this.review as CommentReview | undefined;
    const marks = review?.marks() ?? [];
    const out: HTMLElement[] = [];
    const place = (el: HTMLElement, r: CommentRect) => {
      el.style.left = `${r.x * 100}%`;
      el.style.top = `${r.y * 100}%`;
      el.style.width = `${r.w * 100}%`;
      el.style.height = `${r.h * 100}%`;
      return el;
    };
    for (const m of marks) {
      const a = m.anchor;
      if (a.kind === "cell" || a.page !== slot.index) continue;
      const cls = `comment-mark ${a.kind} ${m.state}${m.focused ? " focused" : ""}`;
      const data = { testid: "comment-mark", kind: a.kind, state: m.state, ...(m.id ? { commentId: m.id } : {}) };
      if (a.kind === "page") out.push(h("div", { class: cls, data }));
      else if (a.kind === "region") out.push(place(h("div", { class: cls, data }), a.rect));
      else for (const r of this.quoteRects(slot, a.quote)) out.push(place(h("div", { class: cls, data }), r));
    }
    slot.marks.replaceChildren(...out);
  }

  /** その点にある印のコメントを強調する（印は押せる要素にしない——上から文字を選べるように） */
  private focusMarkAt(pageEl: HTMLElement, x: number, y: number): void {
    for (const mark of [...pageEl.querySelectorAll<HTMLElement>(".comment-mark.saved")].reverse()) {
      const r = mark.getBoundingClientRect();
      const page = mark.dataset.kind === "page";
      if (x >= r.left - (page ? 0 : 2) && x <= r.right + (page ? 12 : 2) && y >= r.top - 2 && y <= r.bottom + 2 && mark.dataset.commentId) {
        this.review.focusComment(mark.dataset.commentId);
        return;
      }
    }
  }

  /**
   * ページを押した。**文字の上なら文を選ぶ**（離したら「コメント」を出す）。**文字の無い所ならドラッグでそのまま範囲**
   * ——囲み終えたら右上に「コメント」、押すまで点線の枠で残す。ほとんど動かさなければ押しただけ（印なら強調）
   */
  private onPagePointerDown(e: PointerEvent): void {
    if (e.button !== 0 || !this.review.commentMode) return;
    const target = e.target as Element | null;
    const pageEl = target?.closest<HTMLElement>(".pdf-page");
    if (!pageEl || !pageEl.classList.contains("rendered")) return;
    if (target?.closest(".textLayer span, .textLayer br")) {
      if (this.review.offeredAnchor?.kind === "region") this.review.clearOffer();
      return;
    }
    // 文字を選び始めないように止める（pointerdown を止めると mousedown も来ない）
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    this.review.clearOffer();
    const box = pageEl.getBoundingClientRect();
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    const at = (ev: PointerEvent) => ({ x: clamp((ev.clientX - box.left) / box.width), y: clamp((ev.clientY - box.top) / box.height) });
    const from = at(e);
    const frame = h("div", { class: "comment-mark region pending drawing", data: { testid: "comment-region-drawing" } });
    let rect: CommentRect = { x: from.x, y: from.y, w: 0, h: 0 };
    const move = (ev: PointerEvent) => {
      const to = at(ev);
      rect = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y) };
      if (!frame.isConnected) pageEl.appendChild(frame);
      frame.style.left = `${rect.x * 100}%`;
      frame.style.top = `${rect.y * 100}%`;
      frame.style.width = `${rect.w * 100}%`;
      frame.style.height = `${rect.h * 100}%`;
    };
    const up = (ev: PointerEvent) => {
      move(ev);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      frame.remove();
      if (rect.w * box.width < 14 || rect.h * box.height < 14) {
        this.focusMarkAt(pageEl, ev.clientX, ev.clientY);
        return;
      }
      const round = (v: number) => Math.round(v * 10000) / 10000;
      const anchor: CommentAnchor = { kind: "region", page: Number(pageEl.dataset.page), rect: { x: round(rect.x), y: round(rect.y), w: round(rect.w), h: round(rect.h) } };
      const local = this.local({ top: box.top + rect.y * box.height, bottom: 0, left: 0, right: box.left + (rect.x + rect.w) * box.width });
      this.offeredAt = this.scroller.scrollTop;
      this.review.offer(anchor, { x: local.right + 6, y: local.top - 34 });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /** 文を選び終えた——選んだ所の右上に「コメント」。選んでいなければ（押しただけ）、そこの印を強調する */
  private onPageMouseUp(e: MouseEvent): void {
    if (e.button !== 0 || !this.review.commentMode) return;
    const pageEl = (e.target as Element | null)?.closest<HTMLElement>(".pdf-page");
    // 選択は離した直後に確定する——次の描画の前に読む
    requestAnimationFrame(() => {
      const anchor = this.selectedText();
      if (!anchor) {
        if (pageEl && this.review.offeredAnchor?.kind !== "region") this.focusMarkAt(pageEl, e.clientX, e.clientY);
        return;
      }
      const rects = [...window.getSelection()!.getRangeAt(0).getClientRects()].filter((r) => r.width > 1);
      const last = rects.at(-1);
      if (!last) return;
      const local = this.local(last);
      this.offeredAt = this.scroller.scrollTop;
      this.review.offer(anchor, { x: local.right + 6, y: local.top - 34 });
    });
  }

  /** コメントの場所へ飛ぶ（見えていなければ）。まだ描いていないページの文は、描けたら真ん中へ */
  private jumpTo(anchor: CommentAnchor): void {
    if (anchor.kind === "cell" || anchor.page === undefined || this.state.kind !== "ready") return;
    const slot = this.pages[anchor.page - 1];
    if (!slot) return;
    const box = this.boxOf(anchor);
    const sc = this.scroller.getBoundingClientRect();
    const c = this.content.getBoundingClientRect();
    if (box) {
      const top = box.top + c.top;
      const bottom = box.bottom + c.top;
      if (top < sc.top + 8 || bottom > sc.bottom - 8) this.scroller.scrollTop += top - sc.top - Math.max(36, (sc.height - (bottom - top)) / 3);
    }
    this.jumpPending = anchor.kind === "text" && !slot.textLayer ? anchor : undefined;
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
    this.status.hidden = state.kind === "ready";
    this.status.className = state.kind === "error" ? "state error" : "state";
    if (state.kind === "waiting") replaceChildren(this.status, icon("Loader2", "icon spin"), "ファイルを待っています…");
    else if (state.kind === "converting")
      replaceChildren(
        this.status,
        icon("Loader2", "icon spin"),
        h("span", { text: state.message ?? "LibreOffice で PDF にしています…", data: { testid: "pdf-converting" } }),
      );
    else if (state.kind === "loading")
      replaceChildren(this.status, icon("Loader2", "icon spin"), `${formatSize(this.size)} の ${this.converted ? "PDF（変換したもの）" : "PDF"} を開いています…`);
    else if (state.kind === "error")
      replaceChildren(
        this.status,
        icon("TriangleAlert"),
        h("span", { text: `${kindLabel(this.path).name} を開けませんでした：${state.message}`, data: { testid: "pdf-error" } }),
      );
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

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
