// **ファイルブラウザの右側で PDF・Office をそのまま読む**（#341、v4-modules.md §2.2「画面の形」の「ファイルブラウザの右側で読む」）。
//
// showFile の `document` の画面と同じ描き方（`document-screen.ts`——ツールバー・ページ・余白のコメント）を、ファイルブラウザの
// 中身の欄に出す。別の画面に分けない。描く道具（pdf.js・docx-preview・SheetJS）はファイルブラウザの束に入っていないので、
// 選んだときに読み込む（`libraries.ts`）。
// テキストの中身（`viewer.ts` の FileViewer）と同じ口（`el`・`path`・`isDirty`・`reload`）を持ち、ブラウザはどちらかを置く。
// 「AI に返す」は host が `ui/message` を受けると名乗ったときだけ——人が入口から開いたファイルブラウザ（会話の外）では「コピー」

import { DocumentScreen } from "./document-screen.js";
import { h, replaceChildren } from "./dom.js";
import { icon } from "./icons.js";
import { ensureLibrary, type ViewerLibrary } from "./libraries.js";
import { callTool, errorMessage, textOf, type DisplayMode } from "./protocol.js";
import { documentKindFor } from "../view/preview-kind.js";

interface FileInfo {
  size: number;
  mtime: string;
}

export class DocumentPane {
  readonly el: HTMLElement;
  private screen?: DocumentScreen;
  private displayMode: DisplayMode;
  /** いま描いている中身（読み直したときに、変わっていなければ描き直さない——書きかけのコメントが消える） */
  private shown?: FileInfo;
  /** 開く世代——前の読み込みが、後から開いたものの上に描かないように */
  private generation = 0;

  constructor(
    readonly path: string,
    private readonly options: { displayMode: DisplayMode; canReturnComments: boolean },
  ) {
    this.displayMode = options.displayMode;
    this.el = h("div", { class: "doc-pane", data: { testid: "document-pane", path } });
    void this.open();
  }

  /** 書き換えはしない（コメントは付けたときに置き場へ残る） */
  isDirty(): boolean {
    return false;
  }

  /** 読み直す（外で変わったかもしれないとき）。中身が変わっていなければ何もしない */
  reload(): void {
    void this.open(true);
  }

  setDisplayMode(mode: DisplayMode): void {
    if (mode === this.displayMode) return;
    this.displayMode = mode;
    this.screen?.setDisplayMode(mode);
  }

  /** ブラウザから外す（別のファイルを選んだ） */
  destroy(): void {
    this.generation += 1;
    this.screen?.destroy();
    this.screen = undefined;
  }

  private async open(onlyIfChanged = false): Promise<void> {
    const generation = ++this.generation;
    const kind = documentKindFor(this.path) ?? "pdf";
    const library: ViewerLibrary = kind === "docx" ? "docx" : kind === "sheet" ? "sheet" : "pdf";
    if (!onlyIfChanged) this.status("読み込んでいます…");
    try {
      const [info] = await Promise.all([
        callTool("getFileInfo", { path: this.path }).then((r) => JSON.parse(textOf(r)) as FileInfo),
        ensureLibrary(library),
      ]);
      if (generation !== this.generation) return;
      if (onlyIfChanged && this.screen && this.shown?.size === info.size && this.shown.mtime === info.mtime) return;
      this.screen?.destroy();
      this.shown = info;
      const host = h("div", { class: "doc-pane-body" });
      replaceChildren(this.el, host);
      this.screen = new DocumentScreen(host, this.displayMode, this.options.canReturnComments, this.path, () => ensureLibrary("pdf"));
      // showFile の `document` の画面に届くのと同じ形で渡す（引数のパスと、確かめたパス・大きさ）
      this.screen.setToolInput({ path: this.path });
      this.screen.setToolResult({ content: [{ type: "text", text: JSON.stringify({ path: this.path, size: info.size }) }] });
    } catch (err) {
      if (generation !== this.generation) return;
      this.screen?.destroy();
      this.screen = undefined;
      this.shown = undefined;
      replaceChildren(
        this.el,
        h("div", { class: "state error", data: { testid: "document-pane-error" } }, icon("TriangleAlert"), `開けませんでした：${errorMessage(err)}`),
      );
    }
  }

  private status(text: string): void {
    this.screen?.destroy();
    this.screen = undefined;
    replaceChildren(this.el, h("div", { class: "state", data: { testid: "document-pane-loading" } }, icon("Loader2", "icon spin"), text));
  }
}
