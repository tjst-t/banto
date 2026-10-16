// **Word（docx）を元の見た目で読む画面**（`ui://banto-filesystem/document`、v4-modules.md §2.2「PDF・Office…」、
// Backlog #303、2026-10-15）。
//
// showFile が docx を見せるとき、host がこの画面（PDF と同じ `document`）を選ぶ。描くのは **docx-preview**
// ——ブラウザだけで docx の XML を HTML にする。eval・Worker・iframe は使わない（Canvas の CSP は緩めない）：
//   - docx-preview と、それが使う JSZip は束に入れず HTML に別の script で置く（`ui-app.ts`）。読み込まれると
//     `globalThis.docx`・`globalThis.JSZip` に置かれる
//   - 中身は PDF と同じ `readFileRange` で全部読む（docx は zip なので範囲では描けない）
//   - 画像・埋め込みフォントは data: の URL にする（`useBase64URL`）。blob: のフォントは CSP の `font-src` に入っていない
//   - 別の文書を埋め込んだもの（altChunk）は iframe で描かれるので描かない（`frame-src` は塞いでいる）
//
// **描けなかったときと「元に近い見た目で見る」は、変換役（LibreOffice）で PDF にして PDF の画面に切り替える**
// （Backlog #305）。切り替えは画面の入口（`document-app.ts`）がする——ここはボタンを出し、頼むだけ。
// zip として読めないもの（docx ではない）は切り替えない：LibreOffice は中身で形を当てて、別の物として PDF にしてしまう
//
// **コメント**（`comments.ts`、#340）：コメントモードのとき、文を選び終えると選んだ横に「コメント」。指すのは選んだ文と、
// その上の一番近い見出し（v4-modules.md §2.2「コメント」——docx-preview で見ているときはページを数えない）

import { CommentReview, MARGIN_ROOM_PX, type AnchorBox, type CommentAnchor, type CommentTarget } from "./comments.js";
import { h, replaceChildren } from "./dom.js";
import { icon } from "./icons.js";
import { formatSize, readRange } from "./pdf-viewer.js";
import { quoteRange, rangeRects } from "./quote-range.js";
import { errorMessage, reportSize, requestDisplayMode, textOf, type CallToolResult, type DisplayMode } from "./protocol.js";

/** docx-preview（0.4）の、この画面が使うところだけの型（`docx-preview.d.ts` から写す） */
interface DocxPreviewOptions {
  className: string;
  inWrapper: boolean;
  breakPages: boolean;
  ignoreLastRenderedPageBreak: boolean;
  useBase64URL: boolean;
  renderAltChunks: boolean;
  renderHeaders: boolean;
  renderFooters: boolean;
  renderFootnotes: boolean;
  renderEndnotes: boolean;
  renderComments: boolean;
  renderChanges: boolean;
}

interface DocxPreview {
  renderAsync(data: Blob | ArrayBuffer | Uint8Array, bodyContainer: HTMLElement, styleContainer?: HTMLElement, options?: Partial<DocxPreviewOptions>): Promise<unknown>;
}

/** docx-preview 本体。読み込まれていなければ止まる（黙って描けないふりをしない、規則2） */
function docxPreview(): DocxPreview {
  const g = globalThis as { docx?: DocxPreview; JSZip?: unknown };
  if (!g.JSZip) throw new Error("JSZip が読み込まれていません（画面の組み立てを確かめてください）");
  if (!g.docx?.renderAsync) throw new Error("docx-preview が読み込まれていません（画面の組み立てを確かめてください）");
  return g.docx;
}

/** docx-preview が書くクラス名の頭（`.docx-wrapper`・`.docx` の見た目はこの名前で付く） */
const DOCX_CLASS = "docx";

type LoadState = { kind: "waiting" } | { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready" };

export class DocxDocumentView {
  private displayMode: DisplayMode;
  private path = "";
  private size = 0;
  private state: LoadState = { kind: "waiting" };
  /** 開く世代——前のファイルの読み込みが、後から開いたファイルの上に描かないように */
  private generation = 0;
  private note = "";
  private noteError = false;
  private readonly onConvert: (reason?: string) => void;

  private readonly review: CommentReview;
  private readonly pathEl: HTMLSpanElement;
  private readonly status: HTMLDivElement;
  private readonly styleEl: HTMLDivElement;
  private readonly bodyEl: HTMLDivElement;
  /** 中身の箱：本文と右の余白を並べる（コメントの位置はこの中で数える） */
  private readonly content: HTMLDivElement;
  /** 文の印の層（本文は縮めて描くことがあるので、印は縮めない中身の箱に置く） */
  private readonly marksEl: HTMLDivElement;
  private readonly scroller: HTMLDivElement;
  private offeredAt = 0;
  private readonly noteEl: HTMLParagraphElement;

  constructor(
    private readonly root: HTMLElement,
    options: {
      displayMode: DisplayMode;
      /** host が `ui/message` を受けるか（会話の中で開いた画面）。受けなければコメントは「コピー」で持ち出す */
      canReturnComments: boolean;
      /** 変換役で PDF にした画面に切り替える（`reason` は docx-preview で描けなかった理由。人が押したときは無し） */
      onConvert: (reason?: string) => void;
    },
  ) {
    this.displayMode = options.displayMode;
    this.onConvert = options.onConvert;
    this.pathEl = h("span", { class: "doc-name truncate", text: "（Word）", data: { testid: "open-path" } });
    const convertBtn = h(
      "button",
      {
        class: "btn ghost",
        title: "LibreOffice で PDF にして見る（ブラウザでは崩れる書式も、元に近く出る）",
        attrs: { type: "button" },
        data: { testid: "docx-as-pdf" },
        on: { click: () => this.onConvert() },
      },
      icon("FileText"),
      "元に近い見た目で見る",
    );
    this.status = h("div", { class: "state" });
    // docx-preview は文書の <style> を styleContainer に、本文を bodyContainer に書く。どちらも開き直すたびに空にする
    this.styleEl = h("div", { class: "docx-styles" });
    this.bodyEl = h("div", { class: "docx-body", data: { testid: "docx-body" } });
    this.marksEl = h("div", { class: "comment-marks" });
    this.content = h("div", { class: "review-content docx-content" }, this.bodyEl, this.marksEl);
    this.scroller = h("div", { class: "pdf-scroller docx-scroller", data: { testid: "docx-scroller" } }, this.status, this.styleEl, this.content);
    this.noteEl = h("p", { class: "note" });
    const toolbar = h("div", { class: "pdf-toolbar" });
    const view = h("div", { class: "pdf-view docx-view", data: { testid: "docx-view" } }, toolbar, this.scroller, this.noteEl);
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
      emptyHint: "文を選ぶと、そこにコメントを付けられます。",
      onLayoutChange: () => this.fitWidth(),
      onChange: () => this.displayMode === "inline" && reportSize(),
    });
    this.content.append(this.review.margin);
    toolbar.append(icon("FileText", "icon muted"), this.pathEl, h("span", { class: "spacer-fill" }), convertBtn, this.review.modeButton, this.review.listButton, this.review.undoButton, this.review.returnButton);
    this.scroller.addEventListener(
      "scroll",
      () => {
        if (this.review.offeredAnchor && Math.abs(this.scroller.scrollTop - this.offeredAt) > 4) this.review.clearOffer();
      },
      { passive: true },
    );
    this.bodyEl.addEventListener("mouseup", (e) => this.onMouseUp(e));
    document.addEventListener("selectionchange", () => {
      if (this.review.offeredAnchor?.kind === "text" && !this.selectedText()) this.review.clearOffer();
    });
    replaceChildren(this.root, view);
    new ResizeObserver(() => this.fitWidth()).observe(this.scroller);
    this.render();
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
    this.fitWidth();
  }

  /** ツールバーにはファイル名だけ（パスは title） */
  private showName(path: string): void {
    this.pathEl.textContent = path.split("/").pop() || path;
    this.pathEl.title = path;
    this.pathEl.dataset.path = path;
  }

  private async open(path: string, size: number): Promise<void> {
    const generation = ++this.generation;
    this.path = path;
    this.size = size;
    this.showName(path);
    void this.review.load(path);
    this.styleEl.replaceChildren();
    this.bodyEl.replaceChildren();
    this.state = { kind: "loading" };
    this.render();
    try {
      const lib = docxPreview();
      const bytes = await readRange(path, 0, size);
      if (generation !== this.generation) return;
      await lib.renderAsync(bytes, this.bodyEl, this.styleEl, {
        className: DOCX_CLASS,
        inWrapper: true,
        breakPages: true,
        ignoreLastRenderedPageBreak: true,
        // blob: の URL は CSP の font-src に入っていない（緩めない）——data: にする
        useBase64URL: true,
        // altChunk は iframe で描かれる。Canvas は frame を塞いでいる
        renderAltChunks: false,
        renderHeaders: true,
        renderFooters: true,
        renderFootnotes: true,
        renderEndnotes: true,
        renderComments: false,
        renderChanges: false,
      });
      if (generation !== this.generation) return;
      this.state = { kind: "ready" };
      this.render();
      this.fitWidth();
    } catch (err) {
      if (generation !== this.generation) return;
      this.styleEl.replaceChildren();
      this.bodyEl.replaceChildren();
      const message = errorMessage(err);
      // JSZip の「zip の終わりが見つからない」は、人には「docx ではない」と言う。変換役にも渡さない
      const notZip = /end of central directory/i.test(message);
      this.state = { kind: "error", message: notZip ? "docx として読めませんでした（壊れているか、docx ではありません）" : message };
      this.render();
      if (!notZip) this.onConvert(message);
    }
  }

  /**
   * **ページの幅を画面に合わせる**（狭いときだけ縮める。広げはしない）。docx-preview はページを紙の幅（pt）で描くので、
   * 会話の中のカードでは横にはみ出す。`zoom` は描いた後の大きさで場所を取るので、スクロールの長さも合う。
   * 元の幅は**一番広いページ＋wrapper の左右の余白**で測る——`.docx-wrapper` は flex の中央寄せで、ページが広いと
   * 左右両側にはみ出す。`scrollWidth` には右側しか載らず、縮め足りずに左端が切れる（負の位置はスクロールで届かない）
   */
  private fitWidth(): void {
    const wrapper = this.bodyEl.querySelector<HTMLElement>(`.${DOCX_CLASS}-wrapper`);
    if (!wrapper) return;
    const pages = [...wrapper.querySelectorAll<HTMLElement>(`section.${DOCX_CLASS}`)];
    if (pages.length === 0) return;
    wrapper.style.zoom = "";
    const style = getComputedStyle(wrapper);
    const natural = Math.max(...pages.map((p) => p.offsetWidth)) + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    // 広いときは右の余白（と隙間）を引いた幅に収める
    const available = this.scroller.clientWidth - (this.review.marginShown ? MARGIN_ROOM_PX : 0);
    if (available > 0 && natural > available) wrapper.style.zoom = String(available / natural);
    this.paintMarks();
    this.review.layout();
  }

  // ---- コメント -------------------------------------------------------------------

  /** 人がいま本文の中で選んでいる文と、その上の一番近い見出し */
  private selectedText(): Extract<CommentAnchor, { kind: "text" }> | undefined {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined;
    const range = selection.getRangeAt(0);
    if (!this.bodyEl.contains(range.startContainer)) return undefined;
    const quote = selection.toString().replace(/\s+/g, " ").trim();
    if (!quote) return undefined;
    const heading = this.headingBefore(range.startContainer);
    return { kind: "text", quote: quote.slice(0, 2000), ...(heading ? { heading } : {}) };
  }

  /**
   * その位置より上の一番近い見出し。docx-preview は段落に書式の名前をクラスで付ける（`docx_heading1` 等）。
   * 見出しの書式を英語の名前で持たない文書（日本語の Word の「見出し 1」の id は数字）では見つからない
   */
  private headingBefore(node: Node): string | undefined {
    const headings = [...this.bodyEl.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6, p[class*='heading' i], p[class*='title' i]")];
    let found: HTMLElement | undefined;
    for (const el of headings) {
      if (el.contains(node) || el.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) found = el;
      else break;
    }
    const text = found?.textContent?.replace(/\s+/g, " ").trim();
    return text || undefined;
  }

  private local(rect: { top: number; bottom: number; left: number; right: number }): AnchorBox {
    const c = this.content.getBoundingClientRect();
    return { top: rect.top - c.top, bottom: rect.bottom - c.top, left: rect.left - c.left, right: rect.right - c.left };
  }

  private textRects(anchor: CommentAnchor): AnchorBox[] {
    if (anchor.kind !== "text" || this.state.kind !== "ready") return [];
    const range = quoteRange(this.bodyEl, anchor.quote);
    return range ? rangeRects(range).map((r) => this.local(r)) : [];
  }

  private boxOf(anchor: CommentAnchor): AnchorBox | undefined {
    const rects = this.textRects(anchor);
    if (rects.length === 0) return undefined;
    return {
      top: Math.min(...rects.map((r) => r.top)),
      bottom: Math.max(...rects.map((r) => r.bottom)),
      left: Math.min(...rects.map((r) => r.left)),
      right: Math.max(...rects.map((r) => r.right)),
    };
  }

  /** 文の印（蛍光ペン）。コメントモードのときだけ */
  private paintMarks(): void {
    const review = this.review as CommentReview | undefined;
    const out: HTMLElement[] = [];
    for (const m of review?.marks() ?? []) {
      for (const r of this.textRects(m.anchor)) {
        const el = h("div", {
          class: `comment-mark text ${m.state}${m.focused ? " focused" : ""}`,
          data: { testid: "comment-mark", kind: "text", state: m.state, ...(m.id ? { commentId: m.id } : {}) },
        });
        el.style.left = `${r.left}px`;
        el.style.top = `${r.top}px`;
        el.style.width = `${r.right - r.left}px`;
        el.style.height = `${r.bottom - r.top}px`;
        out.push(el);
      }
    }
    this.marksEl.replaceChildren(...out);
  }

  /** 文を選び終えた——選んだ所の右上に「コメント」。押しただけなら、そこの印のコメントを強調する */
  private onMouseUp(e: MouseEvent): void {
    if (e.button !== 0 || !this.review.commentMode) return;
    requestAnimationFrame(() => {
      const anchor = this.selectedText();
      if (!anchor) {
        for (const mark of this.marksEl.querySelectorAll<HTMLElement>(".comment-mark.saved")) {
          const r = mark.getBoundingClientRect();
          if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom && mark.dataset.commentId) {
            this.review.focusComment(mark.dataset.commentId);
            return;
          }
        }
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

  /** コメントの文へ飛ぶ（見えていなければ） */
  private jumpTo(anchor: CommentAnchor): void {
    const box = this.boxOf(anchor);
    if (!box) return;
    const sc = this.scroller.getBoundingClientRect();
    const c = this.content.getBoundingClientRect();
    const top = box.top + c.top;
    const bottom = box.bottom + c.top;
    if (top < sc.top + 8 || bottom > sc.bottom - 8) this.scroller.scrollTop += top - sc.top - Math.max(36, (sc.height - (bottom - top)) / 3);
  }

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
    else if (state.kind === "loading") replaceChildren(this.status, icon("Loader2", "icon spin"), `${formatSize(this.size)} の Word 文書を開いています…`);
    else if (state.kind === "error")
      replaceChildren(this.status, icon("TriangleAlert"), h("span", { text: `Word 文書を描けませんでした：${state.message}`, data: { testid: "docx-error" } }));
    this.status.dataset.testid = state.kind === "error" ? "docx-error-state" : "docx-status";
    this.noteEl.textContent = this.note;
    this.noteEl.className = this.noteError ? "note error" : "note";
    this.noteEl.hidden = !this.note;
    if (this.displayMode === "inline") reportSize();
  }
}
