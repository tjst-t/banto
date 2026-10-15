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
// ——変換役はまだ無い（別のタスク）。それまでボタンは出さず、描けなかったら理由を出して止まる（規則13・規則2）

import { h, replaceChildren } from "./dom.js";
import { icon } from "./icons.js";
import { formatSize, readRange } from "./pdf-viewer.js";
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

  private readonly pathEl: HTMLSpanElement;
  private readonly fullscreenBtn: HTMLButtonElement;
  private readonly status: HTMLDivElement;
  private readonly styleEl: HTMLDivElement;
  private readonly bodyEl: HTMLDivElement;
  private readonly scroller: HTMLDivElement;
  private readonly noteEl: HTMLParagraphElement;

  constructor(
    private readonly root: HTMLElement,
    options: { displayMode: DisplayMode },
  ) {
    this.displayMode = options.displayMode;
    this.pathEl = h("span", { class: "badge truncate", text: "（Word）", data: { testid: "open-path" } });
    this.fullscreenBtn = h(
      "button",
      { class: "btn", attrs: { type: "button" }, on: { click: () => void this.askFullscreen() } },
      icon("Maximize2"),
      "大きく表示",
    );
    const toolbar = h("div", { class: "pdf-toolbar" }, icon("FileText", "icon muted"), this.pathEl, h("span", { class: "spacer-fill" }), this.fullscreenBtn);
    this.status = h("div", { class: "state" });
    // docx-preview は文書の <style> を styleContainer に、本文を bodyContainer に書く。どちらも開き直すたびに空にする
    this.styleEl = h("div", { class: "docx-styles" });
    this.bodyEl = h("div", { class: "docx-body", data: { testid: "docx-body" } });
    this.scroller = h("div", { class: "pdf-scroller docx-scroller", data: { testid: "docx-scroller" } }, this.status, this.styleEl, this.bodyEl);
    this.noteEl = h("p", { class: "note" });
    replaceChildren(this.root, h("div", { class: "pdf-view docx-view", data: { testid: "docx-view" } }, toolbar, this.scroller, this.noteEl));
    new ResizeObserver(() => this.fitWidth()).observe(this.scroller);
    this.render();
  }

  setToolInput(args: Record<string, unknown>): void {
    if (typeof args.path === "string" && args.path && !this.path) this.pathEl.textContent = args.path;
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
    this.fitWidth();
  }

  private async open(path: string, size: number): Promise<void> {
    const generation = ++this.generation;
    this.path = path;
    this.size = size;
    this.pathEl.textContent = path;
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
      // JSZip の「zip の終わりが見つからない」は、人には「docx ではない」と言う
      this.state = { kind: "error", message: /end of central directory/i.test(message) ? "docx として読めませんでした（壊れているか、docx ではありません）" : message };
      this.render();
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
    const available = this.scroller.clientWidth;
    if (available > 0 && natural > available) wrapper.style.zoom = String(available / natural);
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
    this.fullscreenBtn.hidden = this.displayMode !== "inline";
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
