// FileSystem Module の **PDF・Office の文書の画面**の入口（`ui://banto-filesystem/document`、v4-modules.md §2.2「PDF・Office…」）。
//
// テキストの画面（`app.ts`）とは束を分ける——こちらは pdf.js・docx-preview を読み込んだ HTML に入る（`ui-app.ts`）。
// banto を知らない。MCP Apps の約束（`protocol.ts`）だけで親と話す。
// どちらで描くかは見せるファイルの拡張子で決める（host がこの画面を選んだのと同じ物差し）。パスは tool の引数で
// 先に届くが、届かないこともある（記録から開き直したとき等）ので、そのときは結果のパスで決める。
//
// - pdf：PDF の面（pdf.js）
// - docx：Word の面（docx-preview）。「元に近い見た目で見る」・描けなかったときは、変換役で PDF にした PDF の面に切り替える
//   （「Word の描き方で見る」で戻る）。面は作ったら捨てずに隠す——戻ったときに読み直さない
// - pptx・doc・ppt・odt・odp：変換役で PDF にした PDF の面（Backlog #305）

import { DocxDocumentView } from "./docx-viewer.js";
import { h } from "./dom.js";
import { icon } from "./icons.js";
import { PdfDocumentView } from "./pdf-viewer.js";
import { onNotification, notify, request, errorMessage, reportSize, textOf, type CallToolResult, type DisplayMode, type HostContext, type InitializeResult } from "./protocol.js";
import { applyHostStyles, applyTheme, installStyles } from "./styles.js";

type DocumentView = PdfDocumentView | DocxDocumentView;

/** 拡張子で描き方を選ぶ。パスが無い・知らない拡張子のときも PDF の面（そちらが誤りを出す） */
function kindOf(path: string): "pdf" | "docx" | "converted" {
  const ext = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
  if (ext === "docx") return "docx";
  return ["pptx", "doc", "ppt", "odt", "odp"].includes(ext) ? "converted" : "pdf";
}

/**
 * 1つのファイルを見せる面たち。docx は Word の面と PDF にした面の2つを持ちうるので、それぞれ自分の枠に描かせ、
 * 見ていない方は隠す。届いた通知はどの面にも渡す
 */
class DocumentScreen {
  private readonly docx?: DocxDocumentView;
  private readonly docxHost?: HTMLElement;
  private pdf?: PdfDocumentView;
  private pdfHost?: HTMLElement;
  /** 後から作る面に渡す（引数は path だけ——displayMode を渡し直すと、また大きく開くことを頼んでしまう） */
  private path = "";
  private result?: CallToolResult;
  private cancelled = false;

  constructor(
    private readonly root: HTMLElement,
    private displayMode: DisplayMode,
    private readonly canReturnComments: boolean,
    path: string,
  ) {
    root.replaceChildren();
    const kind = kindOf(path);
    if (kind === "docx") {
      this.docxHost = h("div");
      root.append(this.docxHost);
      this.docx = new DocxDocumentView(this.docxHost, { displayMode, onConvert: (reason) => this.showConverted(reason) });
    } else {
      this.makePdf(kind === "converted", []);
    }
  }

  private views(): DocumentView[] {
    return [this.docx, this.pdf].filter((v): v is DocumentView => v !== undefined);
  }

  private makePdf(converted: boolean, actions: HTMLElement[]): PdfDocumentView {
    this.pdfHost = h("div");
    this.root.append(this.pdfHost);
    this.pdf = new PdfDocumentView(this.pdfHost, { displayMode: this.displayMode, canReturnComments: this.canReturnComments, converted, actions });
    return this.pdf;
  }

  /** docx を変換役で PDF にした面に切り替える（初めてなら作り、届いているものを渡す） */
  private showConverted(reason?: string): void {
    if (!this.docxHost) return;
    let pdf = this.pdf;
    if (!pdf) {
      const back = h(
        "button",
        {
          class: "btn",
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
}

/** showFile の結果に入っているパス（読めなければ空） */
function resultPath(result: CallToolResult): string {
  try {
    const path = (JSON.parse(textOf(result)) as { path?: unknown }).path;
    return typeof path === "string" ? path : "";
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  installStyles();
  const root = document.getElementById("app") ?? document.body;

  // 通知は initialize の返事より先に届きうる。面は initialize が済み、見せるファイルのパスが分かってから作るので、それまで溜めておく
  let displayMode: "inline" | "fullscreen" | undefined;
  let canReturnComments: boolean | undefined;
  let path: string | undefined;
  let view: DocumentScreen | undefined;
  const early: Array<(v: DocumentScreen) => void> = [];
  const deliver = (fn: (v: DocumentScreen) => void) => (view ? fn(view) : early.push(fn));
  const choose = () => {
    if (view || !displayMode || canReturnComments === undefined || path === undefined) return;
    view = new DocumentScreen(root, displayMode, canReturnComments, path);
    for (const fn of early.splice(0)) fn(view);
  };

  onNotification("ui/notifications/tool-input", (params) => {
    const args = ((params as { arguments?: Record<string, unknown> }).arguments ?? {}) as Record<string, unknown>;
    deliver((v) => v.setToolInput(args));
    if (typeof args.path === "string" && args.path) path ??= args.path;
    choose();
  });
  onNotification("ui/notifications/tool-result", (params) => {
    const result = params as CallToolResult;
    deliver((v) => v.setToolResult(result));
    // 引数が届かなかったときは結果のパスで選ぶ
    path ??= resultPath(result);
    choose();
  });
  onNotification("ui/notifications/tool-cancelled", () => {
    deliver((v) => v.setCancelled());
    path ??= "";
    choose();
  });
  onNotification("ui/notifications/host-context-changed", (params) => {
    const ctx = params as HostContext;
    applyTheme(ctx.theme);
    applyHostStyles(ctx.styles?.variables);
    if (ctx.displayMode) view?.setDisplayMode(ctx.displayMode);
    if (!view && displayMode && (ctx.displayMode === "inline" || ctx.displayMode === "fullscreen")) {
      displayMode = ctx.displayMode;
      document.body.dataset.mode = displayMode;
    }
  });

  let init: InitializeResult;
  try {
    init = await request<InitializeResult>("ui/initialize", {
      protocolVersion: "2026-01-26",
      appInfo: { name: "banto-filesystem-document", version: "0.1.0" },
      appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    });
  } catch (err) {
    root.textContent = `画面を初期化できませんでした：${errorMessage(err)}`;
    return;
  }
  const ctx = init.hostContext ?? {};
  applyTheme(ctx.theme);
  applyHostStyles(ctx.styles?.variables);
  displayMode = ctx.displayMode === "fullscreen" ? "fullscreen" : "inline";
  document.body.dataset.mode = displayMode;
  // **「AI に返す」は、host が `ui/message` を受けると名乗ったときだけ**（banto は会話の中で開いた画面にだけ名乗る）。
  // 受けない host（会話の外）では、コメントは「コピー」で持ち出す
  canReturnComments = init.hostCapabilities?.message?.text !== undefined;
  root.textContent = "ファイルを待っています…";
  choose();
  notify("ui/notifications/initialized");
}

void main();
