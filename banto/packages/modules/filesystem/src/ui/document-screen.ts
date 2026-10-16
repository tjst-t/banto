// **PDF・Office の文書と表を描く面たち**（v4-modules.md §2.2「PDF・Office…」）。showFile の `document` の画面（`document-app.ts`）と、
// ファイルブラウザの右側（`document-pane.ts`、#341）が同じものを使う。
// どれで描くかは見せるファイルの拡張子で決める（`view/preview-kind.ts` の `documentKindFor`。host が `document` の画面を選ぶのと同じ物差し）。
//
// - pdf：PDF の面（pdf.js）
// - docx：Word の面（docx-preview）。「元に近い見た目で見る」・描けなかったときは、変換役で PDF にした PDF の面に切り替える
//   （「Word の描き方で見る」で戻る）。面は作ったら捨てずに隠す——戻ったときに読み直さない
// - converted（pptx・doc・ppt・odt・odp）：変換役で PDF にした PDF の面（Backlog #305）
// - sheet（xlsx・xlsm・xls・ods）：変換役で計算し直した値の表の面（SheetJS、Backlog #306）

import { DocxDocumentView } from "./docx-viewer.js";
import { h } from "./dom.js";
import { icon } from "./icons.js";
import { PdfDocumentView } from "./pdf-viewer.js";
import { SheetDocumentView } from "./sheet-viewer.js";
import { errorMessage, reportSize, type CallToolResult, type DisplayMode } from "./protocol.js";
import { documentKindFor } from "../view/preview-kind.js";

type DocumentView = PdfDocumentView | DocxDocumentView | SheetDocumentView;

/**
 * 1つのファイルを見せる面たち。docx は Word の面と PDF にした面の2つを持ちうるので、それぞれ自分の枠に描かせ、
 * 見ていない方は隠す。届いた通知はどの面にも渡す
 */
export class DocumentScreen {
  private readonly docx?: DocxDocumentView;
  private readonly docxHost?: HTMLElement;
  private pdf?: PdfDocumentView;
  private pdfHost?: HTMLElement;
  private readonly sheet?: SheetDocumentView;
  /** 後から作る面に渡す（引数は path だけ——displayMode を渡し直すと、また大きく開くことを頼んでしまう） */
  private path = "";
  private result?: CallToolResult;
  private cancelled = false;
  private destroyed = false;

  constructor(
    private readonly root: HTMLElement,
    private displayMode: DisplayMode,
    private readonly canReturnComments: boolean,
    path: string,
    /**
     * PDF の面を作る前に pdf.js を読み込む（ファイルブラウザは道具を要るときに読み込む、`libraries.ts`）。docx を PDF にした面へ
     * 切り替えるときに使う。`document` の画面は最初から入っているので渡さない
     */
    private readonly preparePdf?: () => Promise<void>,
  ) {
    root.replaceChildren();
    // パスが無い・知らない拡張子のときも PDF の面（そちらが誤りを出す）
    const kind = documentKindFor(path) ?? "pdf";
    if (kind === "docx") {
      this.docxHost = h("div");
      root.append(this.docxHost);
      this.docx = new DocxDocumentView(this.docxHost, { displayMode, canReturnComments, onConvert: (reason) => void this.showConverted(reason) });
    } else if (kind === "sheet") {
      this.sheet = new SheetDocumentView(root, { displayMode, canReturnComments });
    } else {
      this.makePdf(kind === "converted", []);
    }
  }

  private views(): DocumentView[] {
    return [this.docx, this.pdf, this.sheet].filter((v): v is DocumentView => v !== undefined);
  }

  private makePdf(converted: boolean, actions: HTMLElement[]): PdfDocumentView {
    this.pdfHost = h("div");
    this.root.append(this.pdfHost);
    this.pdf = new PdfDocumentView(this.pdfHost, { displayMode: this.displayMode, canReturnComments: this.canReturnComments, converted, actions });
    return this.pdf;
  }

  /** docx を変換役で PDF にした面に切り替える（初めてなら作り、届いているものを渡す） */
  private async showConverted(reason?: string): Promise<void> {
    if (!this.docxHost) return;
    if (!this.pdf && this.preparePdf) {
      try {
        await this.preparePdf();
      } catch (err) {
        this.docx?.showNote(`PDF の描き手（pdf.js）を読み込めませんでした：${errorMessage(err)}`, true);
        return;
      }
      if (this.destroyed) return;
    }
    let pdf = this.pdf;
    if (!pdf) {
      const back = h(
        "button",
        {
          class: "btn ghost",
          title: "ブラウザで Word の書式を描く（docx-preview）",
          attrs: { type: "button" },
          data: { testid: "docx-as-html" },
          on: { click: () => this.showDocx() },
        },
        icon("FileText"),
        "Word の描き方で見る",
      );
      pdf = this.makePdf(true, [back]);
      if (this.path) pdf.setToolInput({ path: this.path });
      if (this.result) pdf.setToolResult(this.result);
      else if (this.cancelled) pdf.setCancelled();
    }
    if (reason) pdf.showNote(`ブラウザでは描けなかったので、LibreOffice で PDF にしました（${reason}）`);
    this.docxHost.hidden = true;
    this.pdfHost!.hidden = false;
    if (this.displayMode === "inline") reportSize();
  }

  private showDocx(): void {
    if (!this.docxHost || !this.pdfHost) return;
    this.pdfHost.hidden = true;
    this.docxHost.hidden = false;
    if (this.displayMode === "inline") reportSize();
  }

  setToolInput(args: Record<string, unknown>): void {
    if (typeof args.path === "string") this.path ||= args.path;
    for (const v of this.views()) v.setToolInput(args);
  }

  setToolResult(result: CallToolResult): void {
    this.result = result;
    for (const v of this.views()) v.setToolResult(result);
  }

  setCancelled(): void {
    this.cancelled = true;
    for (const v of this.views()) v.setCancelled();
  }

  setDisplayMode(mode: DisplayMode): void {
    this.displayMode = mode;
    for (const v of this.views()) v.setDisplayMode(mode);
  }

  /** 画面から外す（ファイルブラウザで別のファイルを選んだ）。どの面も聞き手を外し、読み込んだものを捨てる */
  destroy(): void {
    this.destroyed = true;
    for (const v of this.views()) v.destroy();
  }
}

