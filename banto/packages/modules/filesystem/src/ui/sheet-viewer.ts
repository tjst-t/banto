// **表（xlsx・xlsm・xls・ods）を、計算し直した値で読む画面**（`ui://banto-filesystem/document`、v4-modules.md §2.2
// 「PDF・Office…」の xlsx、Backlog #306、2026-10-15）。
//
// showFile が表を見せるとき、host が PDF と同じ `document` の画面を選び、画面が拡張子でこれを選ぶ。
//   - **値は変換役（LibreOffice）で計算し直した写しから読む**——AI が openpyxl 等で作った xlsx には式の値が入っていない。
//     `convertDocument`（既定で表は計算し直し）→ `readFileRange` の `converted` で写しを読む。変換役を入れている途中なら
//     その知らせを出して待ち、少ししてから頼み直す。画面には「LibreOffice で計算した値」と出す（Excel と違うことがある）
//   - 読むのは **SheetJS**（cdn.sheetjs.com の 0.20.3、mini）。npm の xlsx は 0.18.5 で止まっていて古い。束に入れず HTML に
//     普通の script で置く（`globalThis.XLSX`）。eval・Worker は使わない（Canvas の CSP は緩めない）
//   - シートのタブ・結合したセル・列の幅・数の書式（SheetJS が書式で書いた文字）。**描くのは見えている範囲のセルだけ**
//     ——大きなシートを全部 DOM にすると重い。列見出し・行番号はスクロールしても残す（sticky）
//   - **コメント**（`comments.ts`、#340）：コメントモードのとき、セルを押す・ドラッグで範囲を選ぶと、選んだセルのすぐ上
//     （右端に揃える）に「<番地> にコメント」。付けたセルは塗って右上に三角。広いときは右の余白に、そのセルの高さに並ぶ。
//     一覧から押すとそのシートのそのセルへ飛ぶ

import { CommentReview, type AnchorBox, type CommentAnchor, type CommentTarget } from "./comments.js";
import { h, replaceChildren } from "./dom.js";
import { icon } from "./icons.js";
import { PREPARING_RETRY_MS, formatSize, readRange } from "./pdf-viewer.js";
import { callTool, errorMessage, reportSize, requestDisplayMode, textOf, type CallToolResult, type DisplayMode } from "./protocol.js";
import {
  columnName,
  expandToMerges,
  indexAt,
  parseRange,
  rangeName,
  rangeValue,
  sheetView,
  visibleSheetNames,
  type SheetView,
  type XlsxRange,
  type XlsxWorkbook,
} from "../view/sheet.js";

/** SheetJS の、この画面が使うところだけ */
interface XlsxLib {
  read(data: Uint8Array, options: { type: "array"; dense: boolean; cellStyles: boolean; cellFormula: boolean; cellHTML: boolean }): XlsxWorkbook;
}

/** SheetJS 本体。読み込まれていなければ止まる（黙って描けないふりをしない、規則2） */
function xlsxLib(): XlsxLib {
  const lib = (globalThis as { XLSX?: XlsxLib }).XLSX;
  if (!lib?.read) throw new Error("SheetJS が読み込まれていません（画面の組み立てを確かめてください）");
  return lib;
}

/** 列見出しの高さ・行番号の幅（px） */
const HEAD_H = 22;
const HEAD_W = 44;
/** 見えている範囲の外に余分に描く行・列（スクロールで端が白くならないように） */
const OVERSCAN_PX = 200;

type LoadState =
  | { kind: "waiting" }
  | { kind: "converting" }
  | { kind: "preparing"; message: string }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready" };

interface ConvertResult {
  status?: unknown;
  bytes?: unknown;
  message?: unknown;
}

export class SheetDocumentView {
  private displayMode: DisplayMode;
  private path = "";
  private size = 0;
  private state: LoadState = { kind: "waiting" };
  /** 開く世代——前のファイルの読み込みが、後から開いたファイルの上に描かないように */
  private generation = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private readonly resize: ResizeObserver;
  private book?: XlsxWorkbook;
  private sheetNames: string[] = [];
  private sheet?: SheetView;
  private selection?: XlsxRange;
  /** ドラッグで範囲を選んでいる途中の起点 */
  private dragFrom?: { r: number; c: number };
  /** いま描いている窓（同じなら描き直さない） */
  private drawn = "";
  private frame = 0;
  private note = "";
  private noteError = false;

  // --- コメント ---
  private readonly review: CommentReview;

  // --- 固定の要素 ---
  private readonly pathEl: HTMLSpanElement;
  private readonly addressEl: HTMLSpanElement;
  private readonly valueEl: HTMLSpanElement;
  private readonly status: HTMLDivElement;
  private readonly scroller: HTMLDivElement;
  /** 中身の箱：表と右の余白を並べる（コメントの位置はこの中で数える） */
  private readonly content: HTMLDivElement;
  private readonly grid: HTMLDivElement;
  private readonly colHead: HTMLDivElement;
  private readonly colHeadCells: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly rowHead: HTMLDivElement;
  private readonly cells: HTMLDivElement;
  private readonly selectionEl: HTMLDivElement;
  private readonly tabs: HTMLDivElement;
  private readonly recalcNote: HTMLSpanElement;
  private readonly noteEl: HTMLParagraphElement;

  constructor(
    private readonly root: HTMLElement,
    options: {
      displayMode: DisplayMode;
      /** host が `ui/message` を受けるか（会話の中で開いた画面）。受けなければコメントは「コピー」で持ち出す */
      canReturnComments: boolean;
    },
  ) {
    this.displayMode = options.displayMode;
    this.pathEl = h("span", { class: "doc-name truncate", text: "（表）", data: { testid: "open-path" } });
    // 選んでいるセルの番地と、その値（式があれば式も）——Excel の名前ボックスと数式バー
    this.addressEl = h("span", { class: "sheet-address", data: { testid: "sheet-address" } });
    this.valueEl = h("span", { class: "sheet-value truncate", data: { testid: "sheet-value" } });

    this.status = h("div", { class: "state" });
    this.colHeadCells = h("div", { class: "sheet-col-cells" });
    this.colHead = h("div", { class: "sheet-col-head" }, h("div", { class: "sheet-corner" }), this.colHeadCells);
    this.rowHead = h("div", { class: "sheet-row-head" });
    this.selectionEl = h("div", { class: "sheet-selection", data: { testid: "sheet-selection" } });
    this.cells = h("div", { class: "sheet-cells", data: { testid: "sheet-cells" } });
    this.body = h("div", { class: "sheet-grid-body" }, this.rowHead, this.cells);
    this.grid = h("div", { class: "sheet-grid", data: { testid: "sheet-grid" } }, this.colHead, this.body);
    this.content = h("div", { class: "review-content sheet-content" }, this.grid);
    this.scroller = h("div", { class: "pdf-scroller sheet-scroller", data: { testid: "sheet-scroller" } }, this.status, this.content);
    this.scroller.addEventListener("scroll", () => this.schedule(), { passive: true });
    this.cells.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.cells.addEventListener("pointermove", (e) => this.onPointerMove(e));
    this.cells.addEventListener("pointerup", () => this.endDrag());
    this.cells.addEventListener("pointercancel", () => this.endDrag());

    this.tabs = h("div", { class: "sheet-tabs", attrs: { role: "tablist", "aria-label": "シート" }, data: { testid: "sheet-tabs" } });
    this.recalcNote = h("span", {
      class: "sheet-recalc-note",
      text: "LibreOffice で計算し直した値です（Excel と違うことがあります）",
      data: { testid: "sheet-recalc-note" },
    });
    this.noteEl = h("p", { class: "note" });
    const toolbar = h("div", { class: "pdf-toolbar" });
    // 表の枠：狭いときのコメントの一覧はここの下から出す（シートのタブを覆わない）
    const main = h("div", { class: "sheet-main" }, this.scroller);
    const view = h("div", { class: "pdf-view sheet-view", data: { testid: "sheet-view" } }, toolbar, main, h("div", { class: "sheet-foot" }, this.tabs, this.recalcNote), this.noteEl);
    const target: CommentTarget = {
      boxOf: (anchor) => this.boxOf(anchor),
      jumpTo: (anchor) => this.jumpTo(anchor),
      paintMarks: () => this.paintMarks(),
    };
    this.review = new CommentReview(target, {
      root: view,
      listHost: main,
      content: this.content,
      displayMode: this.displayMode,
      canReturn: options.canReturnComments,
      emptyHint: "セルを選ぶか、ドラッグで範囲を選ぶと、そこにコメントを付けられます。",
      onLayoutChange: () => this.offerCell(),
      onChange: () => this.displayMode === "inline" && reportSize(),
    });
    this.content.append(this.review.margin);
    toolbar.append(
      icon("FileSpreadsheet", "icon muted"),
      this.pathEl,
      this.addressEl,
      this.valueEl,
      h("span", { class: "spacer-fill" }),
      this.review.modeButton,
      this.review.listButton,
      this.review.undoButton,
      this.review.returnButton,
    );
    replaceChildren(this.root, view);
    this.resize = new ResizeObserver(() => this.schedule());
    this.resize.observe(this.scroller);
    this.render();
  }

  /** 画面から外す（ファイルブラウザで別のファイルを選んだ）。聞き手を外し、変換役を待つのもやめる */
  destroy(): void {
    this.resize.disconnect();
    this.review.destroy();
    this.generation += 1;
    clearTimeout(this.retryTimer);
  }

  setToolInput(args: Record<string, unknown>): void {
    if (typeof args.path === "string" && args.path && !this.path) this.showName(args.path);
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
    this.review.setDisplayMode(mode);
    this.render();
    this.schedule();
  }

  /** ツールバーにはファイル名だけ（パスは title） */
  private showName(path: string): void {
    this.pathEl.textContent = path.split("/").pop() || path;
    this.pathEl.title = path;
    this.pathEl.dataset.path = path;
  }

  // ---- 開く ---------------------------------------------------------------------

  private async open(path: string, size: number): Promise<void> {
    const generation = ++this.generation;
    clearTimeout(this.retryTimer);
    this.path = path;
    this.size = size;
    this.showName(path);
    this.book = undefined;
    this.sheet = undefined;
    this.sheetNames = [];
    this.selection = undefined;
    void this.review.load(path);
    await this.convertAndRead(generation);
  }

  /**
   * 変換役に計算し直させ、写しを読む。**変換役を入れている途中**（初めて使うときは数分）なら、その知らせを出して
   * 少ししてから頼み直す——入れ終わったら読み直す（v4-modules.md §2.2「変換役」）
   */
  private async convertAndRead(generation: number): Promise<void> {
    this.state = { kind: "converting" };
    this.render();
    try {
      const converted = JSON.parse(textOf(await callTool("convertDocument", { path: this.path }))) as ConvertResult;
      if (generation !== this.generation) return;
      if (converted.status === "preparing") {
        this.state = { kind: "preparing", message: typeof converted.message === "string" ? converted.message : "変換役を用意しています" };
        this.render();
        this.retryTimer = setTimeout(() => void this.convertAndRead(generation), PREPARING_RETRY_MS);
        return;
      }
      if (converted.status !== "converted" || typeof converted.bytes !== "number") throw new Error("計算し直した結果の形が読めません");
      this.state = { kind: "loading" };
      this.render();
      const bytes = await readRange(this.path, 0, converted.bytes, "spreadsheet");
      if (generation !== this.generation) return;
      const book = xlsxLib().read(bytes, { type: "array", dense: true, cellStyles: true, cellFormula: true, cellHTML: false });
      const names = visibleSheetNames(book);
      if (names.length === 0) throw new Error("見えるシートがありません");
      this.book = book;
      this.sheetNames = names;
      this.state = { kind: "ready" };
      this.showSheet(names[0]!);
    } catch (err) {
      if (generation !== this.generation) return;
      this.state = { kind: "error", message: errorMessage(err) };
      this.render();
    }
  }

  private showSheet(name: string): void {
    if (!this.book) return;
    this.sheet = sheetView(this.book, name);
    this.selection = undefined;
    this.review.clearOffer();
    this.drawn = "";
    this.grid.style.width = `${HEAD_W + this.sheet.colX[this.sheet.cols]!}px`;
    this.grid.style.height = `${HEAD_H + this.sheet.rowY[this.sheet.rows]!}px`;
    this.body.style.height = `${this.sheet.rowY[this.sheet.rows]!}px`;
    this.scroller.scrollTo({ top: 0, left: 0 });
    this.render();
    this.draw();
    // 余白のコメントは、このシートのものだけがセルの高さに並ぶ
    (this.review as CommentReview | undefined)?.layout();
  }

  // ---- 描く（見えている範囲だけ）-----------------------------------------------

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  /** 見えている行・列（前後に少し余分）のセル・見出しだけを描く */
  private draw(): void {
    const view = this.sheet;
    if (!view || this.state.kind !== "ready") return;
    const top = Math.max(0, this.scroller.scrollTop - OVERSCAN_PX);
    const bottom = this.scroller.scrollTop + this.scroller.clientHeight + OVERSCAN_PX;
    const left = Math.max(0, this.scroller.scrollLeft - OVERSCAN_PX);
    const right = this.scroller.scrollLeft + this.scroller.clientWidth + OVERSCAN_PX;
    const empty = view.rows === 0 || view.cols === 0;
    const r0 = empty ? 0 : indexAt(view.rowY, top);
    const r1 = empty ? -1 : indexAt(view.rowY, bottom);
    const c0 = empty ? 0 : indexAt(view.colX, left);
    const c1 = empty ? -1 : indexAt(view.colX, right);
    const windowKey = `${view.name}:${r0}:${r1}:${c0}:${c1}`;
    if (windowKey !== this.drawn) {
      this.drawn = windowKey;
      const place = (el: HTMLElement, x: number, y: number, w: number, hgt: number) => {
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        el.style.width = `${w}px`;
        el.style.height = `${hgt}px`;
        return el;
      };
      const colHeads: HTMLElement[] = [];
      for (let c = c0; c <= c1; c++) {
        const w = view.colX[c + 1]! - view.colX[c]!;
        if (w > 0) colHeads.push(place(h("div", { class: "sheet-head-cell", text: columnName(c) }), view.colX[c]!, 0, w, HEAD_H));
      }
      this.colHeadCells.replaceChildren(...colHeads);
      const rowHeads: HTMLElement[] = [];
      for (let r = r0; r <= r1; r++) {
        const hgt = view.rowY[r + 1]! - view.rowY[r]!;
        if (hgt > 0) rowHeads.push(place(h("div", { class: "sheet-head-cell", text: String(r + 1) }), 0, view.rowY[r]!, HEAD_W, hgt));
      }
      this.rowHead.replaceChildren(...rowHeads);

      const cells: HTMLElement[] = [];
      const drawnMerges = new Set<XlsxRange>();
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          // 結合したセルは左上のセルが全体を描く（左上が窓の外でも、掛かっていれば描く）
          const merge = view.mergeAt(r, c);
          if (merge && drawnMerges.has(merge)) continue;
          if (merge) drawnMerges.add(merge);
          const s = merge ? merge.s : { r, c };
          const e = merge ? merge.e : { r, c };
          const w = view.colX[e.c + 1]! - view.colX[s.c]!;
          const hgt = view.rowY[e.r + 1]! - view.rowY[s.r]!;
          if (w <= 0 || hgt <= 0) continue;
          const cell = view.cell(s.r, s.c);
          const el = place(
            h("div", {
              class: `sheet-cell${cell ? ` ${cell.kind}` : ""}${merge ? " merged" : ""}`,
              text: cell?.text ?? "",
              data: { cell: rangeName({ s, e: s }), ...(merge ? { merge: rangeName(merge) } : {}) },
            }),
            view.colX[s.c]!,
            view.rowY[s.r]!,
            w,
            hgt,
          );
          if (cell?.text) el.title = cell.text;
          cells.push(el);
        }
      }
      this.cells.replaceChildren(...cells, ...this.commentMarks(), this.selectionEl);
    }
    this.drawSelection();
  }

  /** 付けたコメントのセルの印（塗りと右上の三角）。コメントモードのときだけ */
  private commentMarks(): HTMLElement[] {
    const view = this.sheet;
    const review = this.review as CommentReview | undefined;
    if (!view || !review) return [];
    const out: HTMLElement[] = [];
    for (const m of review.marks()) {
      if (m.anchor.kind !== "cell" || m.anchor.sheet !== view.name || m.state !== "saved") continue;
      const range = parseRange(m.anchor.range);
      if (!range) continue;
      const s = { r: Math.min(range.s.r, view.rows), c: Math.min(range.s.c, view.cols) };
      const e = { r: Math.min(range.e.r, view.rows - 1), c: Math.min(range.e.c, view.cols - 1) };
      const x = view.colX[s.c]!;
      const y = view.rowY[s.r]!;
      const el = h("div", {
        class: m.focused ? "comment-mark cell saved focused" : "comment-mark cell saved",
        data: { testid: "comment-mark", kind: "cell", range: m.anchor.range, ...(m.id ? { commentId: m.id } : {}) },
      });
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.width = `${Math.max(0, view.colX[e.c + 1]! - x)}px`;
      el.style.height = `${Math.max(0, view.rowY[e.r + 1]! - y)}px`;
      out.push(el);
    }
    return out;
  }

  private paintMarks(): void {
    // 窓が同じでも描き直す（印だけ変わった）
    this.drawn = "";
    this.draw();
  }

  private boxOf(anchor: CommentAnchor): AnchorBox | undefined {
    const view = this.sheet;
    if (anchor.kind !== "cell" || !view || anchor.sheet !== view.name) return undefined;
    const range = parseRange(anchor.range);
    if (!range) return undefined;
    const r0 = Math.min(range.s.r, view.rows);
    const r1 = Math.min(range.e.r + 1, view.rows);
    const c0 = Math.min(range.s.c, view.cols);
    const c1 = Math.min(range.e.c + 1, view.cols);
    // 表は中身の箱の左上にある。セルは列見出しと行番号の分ずれる
    return { top: HEAD_H + view.rowY[r0]!, bottom: HEAD_H + view.rowY[r1]!, left: HEAD_W + view.colX[c0]!, right: HEAD_W + view.colX[c1]! };
  }

  /** 選んだセルのすぐ上（右端に揃える）に「<番地> にコメント」。上に場所が無ければ（表の頭の行）すぐ下に——選んだセルを覆わない */
  private offerCell(): void {
    const review = this.review as CommentReview | undefined;
    const view = this.sheet;
    const sel = this.selection;
    if (!review) return;
    if (!view || !sel || this.dragFrom) {
      review.clearOffer();
      return;
    }
    const anchor = this.selectedCell();
    if (!anchor) return;
    const above = HEAD_H + view.rowY[sel.s.r]! - 32;
    const y = above >= HEAD_H + 2 ? above : HEAD_H + view.rowY[sel.e.r + 1]! + 4;
    review.offer(anchor, { x: HEAD_W + view.colX[sel.e.c + 1]!, y, align: "right" });
  }

  private drawSelection(): void {
    const view = this.sheet;
    const sel = this.selection;
    this.selectionEl.hidden = !view || !sel;
    if (!view || !sel) {
      this.addressEl.textContent = "";
      this.valueEl.textContent = "";
      return;
    }
    const x = view.colX[sel.s.c]!;
    const y = view.rowY[sel.s.r]!;
    this.selectionEl.style.left = `${x}px`;
    this.selectionEl.style.top = `${y}px`;
    this.selectionEl.style.width = `${view.colX[sel.e.c + 1]! - x}px`;
    this.selectionEl.style.height = `${view.rowY[sel.e.r + 1]! - y}px`;
    this.selectionEl.dataset.range = rangeName(sel);
    this.addressEl.textContent = rangeName(sel);
    const cell = view.cell(sel.s.r, sel.s.c);
    const single = rangeName(sel) === rangeName(expandToMerges(view, { s: sel.s, e: sel.s }));
    this.valueEl.textContent = single && cell ? (cell.formula ? `${cell.text}　${cell.formula}` : cell.text) : "";
  }

  // ---- 選ぶ ---------------------------------------------------------------------

  private cellAt(e: PointerEvent): { r: number; c: number } | undefined {
    const view = this.sheet;
    if (!view || view.rows === 0 || view.cols === 0) return undefined;
    const rect = this.cells.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < 0 || y < 0 || x >= view.colX[view.cols]! || y >= view.rowY[view.rows]!) return undefined;
    return { r: indexAt(view.rowY, y), c: indexAt(view.colX, x) };
  }

  private select(a: { r: number; c: number }, b: { r: number; c: number }): void {
    if (!this.sheet) return;
    const range = { s: { r: Math.min(a.r, b.r), c: Math.min(a.c, b.c) }, e: { r: Math.max(a.r, b.r), c: Math.max(a.c, b.c) } };
    this.selection = expandToMerges(this.sheet, range);
    this.drawSelection();
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const at = this.cellAt(e);
    if (!at) return;
    e.preventDefault();
    const from = e.shiftKey && this.selection ? this.selection.s : at;
    this.dragFrom = from;
    this.cells.setPointerCapture?.(e.pointerId);
    this.select(from, at);
    this.review.clearOffer();
    // 印の付いたセルを押したら、そのコメントを強調する
    const view = this.sheet!;
    for (const m of this.review.marks()) {
      const range = m.anchor.kind === "cell" && m.anchor.sheet === view.name ? parseRange(m.anchor.range) : undefined;
      if (m.id && range && at.r >= range.s.r && at.r <= range.e.r && at.c >= range.s.c && at.c <= range.e.c) {
        this.review.focusComment(m.id);
        break;
      }
    }
  }

  private endDrag(): void {
    if (!this.dragFrom) return;
    this.dragFrom = undefined;
    this.offerCell();
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.dragFrom) return;
    const at = this.cellAt(e);
    if (at) this.select(this.dragFrom, at);
  }

  private selectedCell(): Extract<CommentAnchor, { kind: "cell" }> | undefined {
    const view = this.sheet;
    const sel = this.selection;
    if (!view || !sel) return undefined;
    const value = rangeValue(view, sel);
    return { kind: "cell", sheet: view.name, range: rangeName(sel), ...(value !== undefined ? { value } : {}) };
  }

  /** コメントの場所へ飛ぶ：そのシートを開き、セルを選んで見える所までスクロールする */
  private jumpTo(anchor: CommentAnchor): void {
    if (anchor.kind !== "cell" || !this.book) return;
    if (!this.sheetNames.includes(anchor.sheet)) {
      this.note = `シート「${anchor.sheet}」がありません（名前が変わったか、消されました）`;
      this.noteError = true;
      this.render();
      return;
    }
    const range = parseRange(anchor.range);
    if (!range) return;
    if (this.sheet?.name !== anchor.sheet) this.showSheet(anchor.sheet);
    const view = this.sheet!;
    this.review.clearOffer();
    this.selection = expandToMerges(view, range);
    const x = view.colX[Math.min(range.s.c, view.cols)] ?? 0;
    const y = view.rowY[Math.min(range.s.r, view.rows)] ?? 0;
    this.scroller.scrollTo({ left: Math.max(0, x - 40), top: Math.max(0, y - 40) });
    this.draw();
  }

  // ---- 大きく開く ---------------------------------------------------------------

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
    const ready = state.kind === "ready";
    this.status.hidden = ready;
    this.grid.hidden = !ready;
    this.status.className = state.kind === "error" ? "state error" : "state";
    if (state.kind === "waiting") replaceChildren(this.status, icon("Loader2", "icon spin"), "ファイルを待っています…");
    else if (state.kind === "converting")
      replaceChildren(this.status, icon("Loader2", "icon spin"), `${formatSize(this.size)} の表を LibreOffice で計算し直しています…`);
    else if (state.kind === "preparing")
      replaceChildren(this.status, icon("Loader2", "icon spin"), h("span", { text: state.message, data: { testid: "sheet-preparing" } }));
    else if (state.kind === "loading") replaceChildren(this.status, icon("Loader2", "icon spin"), "計算し直した表を読んでいます…");
    else if (state.kind === "error")
      replaceChildren(this.status, icon("TriangleAlert"), h("span", { text: `表を開けませんでした：${state.message}`, data: { testid: "sheet-error" } }));
    this.status.dataset.testid = state.kind === "error" ? "sheet-error-state" : "sheet-status";

    // シートのタブ（2枚以上でも1枚でも出す——どのシートを見ているかが分かるように）
    this.tabs.hidden = !ready;
    this.recalcNote.hidden = !ready;
    replaceChildren(
      this.tabs,
      ...this.sheetNames.map((name) =>
        h("button", {
          class: "sheet-tab",
          text: name,
          attrs: { type: "button", role: "tab", "aria-selected": String(this.sheet?.name === name) },
          data: { testid: "sheet-tab" },
          on: { click: () => this.sheet?.name !== name && this.showSheet(name) },
        }),
      ),
    );
    const sheetEmpty = ready && this.sheet && (this.sheet.rows === 0 || this.sheet.cols === 0);
    this.noteEl.textContent = sheetEmpty ? "このシートは空です" : this.note;
    this.noteEl.className = this.noteError && !sheetEmpty ? "note error" : "note";
    this.noteEl.hidden = !sheetEmpty && !this.note;
    if (this.displayMode === "inline") reportSize();
  }
}
