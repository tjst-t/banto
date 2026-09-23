// ファイルの中身を描く（モック `file-preview.tsx` の FileContentViewer と同じ役）。
//
// 描き方は拡張子で決める（`view/preview-kind.ts` の対応表）。テキストのものは
// 「編集」→ 書き換え →「保存」ができる（CSV は表のまま編集する）。
// 画像は画像のまま、PDF などのバイナリは名前と大きさだけを出す
// ——この画面の中では PDF を埋め込めない（Canvas の CSP が frame・object を塞いでいる）。

import { h, replaceChildren } from "./dom.js";
import { icon } from "./icons.js";
import { callTool, errorMessage, textOf, type ContentBlock } from "./protocol.js";
import { toast } from "./toast.js";
import { renderMarkdown } from "../view/markdown.js";
import { columnCount, parseCsv, serializeCsv, type CsvDocument } from "../view/csv.js";
import { delimiterFor, extOf, formatBytes, previewKindFor, type PreviewKind } from "../view/preview-kind.js";

/** これより大きいものは中身を取りに行かない（画面が固まる）。ダウンロードはできる。 */
const MAX_PREVIEW_BYTES: Readonly<Record<"text" | "image", number>> = {
  text: 2 * 1024 * 1024,
  image: 16 * 1024 * 1024,
};

type Loaded =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "too-large"; size: number }
  | { status: "text"; text: string; size: number }
  | { status: "image"; data: string; mimeType: string; size: number }
  | { status: "binary"; size: number; mimeType?: string };

export class FileViewer {
  readonly el: HTMLElement;
  private readonly kind: PreviewKind;
  private readonly name: string;
  private loaded: Loaded = { status: "loading" };
  private mode: "view" | "edit" = "view";
  private tab: "preview" | "source" = "preview";
  private draft = "";
  private csvDraft: CsvDocument | null = null;
  private saving = false;

  constructor(readonly path: string) {
    this.kind = previewKindFor(path);
    this.name = path.split("/").pop() ?? path;
    this.el = h("div", { class: "viewer", data: { testid: "file-viewer", path } });
    this.render();
    void this.load();
  }

  /** 編集していて、保存していない変更があるか（別のファイルへ移る前に確かめる）。 */
  isDirty(): boolean {
    if (this.mode !== "edit" || this.loaded.status !== "text") return false;
    return this.currentDraftText() !== this.loaded.text;
  }

  /** 読み直す（外で変わったかもしれないとき）。編集中なら読み直さない。 */
  reload(): void {
    if (this.mode === "edit") return;
    void this.load();
  }

  private async load(): Promise<void> {
    this.loaded = { status: "loading" };
    this.render();
    try {
      const info = JSON.parse(textOf(await callTool("getFileInfo", { path: this.path }))) as { size: number };
      const size = info.size;
      // 画像以外のバイナリ（PDF 等）は中身を描かないので、取りに行かない
      if (this.kind === "pdf") {
        this.loaded = { status: "binary", size, mimeType: "application/pdf" };
        this.render();
        return;
      }
      const limit = this.kind === "image" ? MAX_PREVIEW_BYTES.image : MAX_PREVIEW_BYTES.text;
      if (size > limit) {
        this.loaded = { status: "too-large", size };
        this.render();
        return;
      }
      const block: ContentBlock | undefined = (await callTool("readFile", { path: this.path })).content?.[0];
      if (block?.type === "text") this.loaded = { status: "text", text: block.text ?? "", size };
      else if (block?.type === "image" && block.data) {
        this.loaded = { status: "image", data: block.data, mimeType: block.mimeType ?? "image/png", size };
      } else if (block?.type === "resource") this.loaded = { status: "binary", size, mimeType: block.resource?.mimeType };
      else throw new Error("中身を読み取れませんでした（知らない形の結果）");
    } catch (err) {
      this.loaded = { status: "error", message: errorMessage(err) };
    }
    this.render();
  }

  private editable(): boolean {
    return this.loaded.status === "text" && this.kind !== "image" && this.kind !== "pdf";
  }

  private currentDraftText(): string {
    if (this.csvDraft) return serializeCsv(this.csvDraft, delimiterFor(this.path));
    return this.draft;
  }

  private startEdit(): void {
    if (this.loaded.status !== "text") return;
    this.draft = this.loaded.text;
    this.csvDraft = this.kind === "spreadsheet" ? parseCsv(this.loaded.text, delimiterFor(this.path)) : null;
    this.mode = "edit";
    this.render();
  }

  private cancelEdit(): void {
    this.mode = "view";
    this.csvDraft = null;
    this.render();
  }

  private async save(): Promise<void> {
    if (this.saving || this.loaded.status !== "text") return;
    const content = this.currentDraftText();
    this.saving = true;
    this.render();
    try {
      await callTool("writeFile", { path: this.path, content });
      this.loaded = { status: "text", text: content, size: new TextEncoder().encode(content).length };
      this.mode = "view";
      this.csvDraft = null;
      toast(`${this.name} を保存しました`);
    } catch (err) {
      toast(`${this.name} を保存できませんでした`, { description: errorMessage(err), error: true });
    } finally {
      this.saving = false;
      this.render();
    }
  }

  /** 「プレビュー／ソース」を切り替えられる種類か（描いたものと元の文字の両方に意味がある）。 */
  private hasTabs(): boolean {
    return this.loaded.status === "text" && (this.kind === "markdown" || this.kind === "html" || this.kind === "svg");
  }

  private render(): void {
    const tabs = this.mode === "view" && this.hasTabs() ? this.renderTabList() : null;
    const actions = this.editable() ? this.renderActions() : null;
    // **切り替えと編集は同じ1行に置く**（改訂・2026-09-23、ユーザー要望）——縦に2段
    // 重ねると、中身に使える高さがその分だけ減る
    const bar =
      tabs || actions
        ? h("div", { class: "viewer-bar" }, tabs, h("span", { class: "spacer-fill" }), actions)
        : null;
    replaceChildren(this.el, bar, h("div", { class: "viewer-body" }, this.renderBody()));
  }

  private renderTabList(): HTMLElement {
    const tabButton = (value: "preview" | "source", label: string) =>
      h("button", {
        class: "tab",
        text: label,
        attrs: { type: "button", role: "tab", "aria-selected": String(this.tab === value) },
        on: {
          click: () => {
            this.tab = value;
            this.render();
          },
        },
      });
    return h("div", { class: "tab-list", attrs: { role: "tablist" } }, tabButton("preview", "プレビュー"), tabButton("source", "ソース"));
  }

  private renderActions(): HTMLElement {
    if (this.mode === "edit") {
      return h(
        "div",
        { class: "viewer-actions" },
        h("button", {
          class: "btn",
          text: "キャンセル",
          attrs: { type: "button", ...(this.saving ? { disabled: "" } : {}) },
          on: { click: () => this.cancelEdit() },
        }),
        h(
          "button",
          {
            class: "btn btn-primary",
            attrs: { type: "button", ...(this.saving ? { disabled: "" } : {}) },
            data: { testid: "viewer-save" },
            on: { click: () => void this.save() },
          },
          this.saving ? icon("Loader2", "icon spin") : icon("Save"),
          "保存",
        ),
      );
    }
    return h(
      "div",
      { class: "viewer-actions" },
      h(
        "button",
        { class: "btn", attrs: { type: "button" }, data: { testid: "viewer-edit" }, on: { click: () => this.startEdit() } },
        icon("Pencil"),
        "編集",
      ),
    );
  }

  private renderBody(): Node {
    const loaded = this.loaded;
    switch (loaded.status) {
      case "loading":
        return h("div", { class: "state" }, icon("Loader2", "icon spin"), "読み込んでいます…");
      case "error":
        return h("div", { class: "state error" }, icon("TriangleAlert"), `開けませんでした：${loaded.message}`);
      case "too-large":
        return this.placeholder(
          "FileText",
          `${this.typeLabel()}・${formatBytes(loaded.size)}`,
          "大きいので中身は表示しません。ダウンロードして開いてください",
        );
      case "binary":
        return this.placeholder(
          "FileText",
          `${this.typeLabel()}・${formatBytes(loaded.size)}`,
          "バイナリなのでソース表示はありません",
        );
      case "image":
        return this.renderImage(`data:${loaded.mimeType};base64,${loaded.data}`, loaded.size);
      case "text":
        return this.mode === "edit" ? this.renderEditor() : this.renderText(loaded.text);
    }
  }

  private typeLabel(): string {
    return extOf(this.path).toUpperCase() || "ファイル";
  }

  private placeholder(iconName: "FileText" | "FileImage", meta: string, note: string): HTMLElement {
    return h(
      "div",
      { class: "placeholder", data: { testid: "viewer-placeholder" } },
      icon(iconName, "icon-2xl"),
      h("p", { class: "name", text: this.name }),
      h("p", { class: "meta", text: meta }),
      h("p", { class: "meta", text: note }),
    );
  }

  private renderImage(src: string, size: number): HTMLElement {
    const meta = h("p", { class: "meta muted", text: `${this.typeLabel()}・${formatBytes(size)}` });
    const img = h("img", { attrs: { src, alt: this.name } });
    img.addEventListener("load", () => {
      meta.textContent = `${img.naturalWidth}×${img.naturalHeight}・${this.typeLabel()}・${formatBytes(size)}`;
    });
    img.addEventListener("error", () => {
      meta.textContent = "画像として読めませんでした";
    });
    return h("div", { class: "image-view", data: { testid: "viewer-image" } }, img, meta);
  }

  private renderText(text: string): Node {
    switch (this.kind) {
      case "markdown": {
        const md = h("div", { class: "md", data: { testid: "viewer-markdown" } });
        // renderMarkdown は**すべてエスケープしてから決まった要素だけを足す**（view/markdown.ts）
        md.innerHTML = renderMarkdown(text);
        return this.tabs(md, text);
      }
      case "html": {
        // **scripts も同一オリジンも与えない**（sandbox=""）——中身の JS は走らない
        const frame = h("iframe", {
          class: "html-preview",
          attrs: { sandbox: "", title: "HTML プレビュー" },
          data: { testid: "viewer-html" },
        });
        frame.srcdoc = text;
        return this.tabs(frame, text);
      }
      case "svg": {
        // SVG は <img> で描く——<img> の中の SVG はスクリプトを走らせない
        const img = this.renderImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`, new TextEncoder().encode(text).length);
        return this.tabs(img, text);
      }
      case "spreadsheet":
        return this.renderSheet(parseCsv(text, delimiterFor(this.path)).rows);
      default:
        return this.source(text);
    }
  }

  private source(text: string): HTMLElement {
    return h("pre", { class: "source", text, data: { testid: "viewer-source" } });
  }

  /** 「プレビュー」か「ソース」のどちらか（切り替えは上の1行、`renderTabList`）。 */
  private tabs(preview: Node, text: string): HTMLElement {
    return h("div", { class: "tab-panel", attrs: { role: "tabpanel" } }, this.tab === "preview" ? preview : this.source(text));
  }

  private renderSheet(rows: readonly (readonly string[])[]): HTMLElement {
    const cols = columnCount(rows);
    const [header, ...body] = rows;
    const cell = (tag: "th" | "td", value: string | undefined) => h(tag, { text: value ?? "" });
    return h(
      "div",
      { class: "sheet-wrap" },
      h(
        "table",
        { class: "sheet", data: { testid: "viewer-sheet" } },
        h("thead", {}, h("tr", {}, ...Array.from({ length: cols }, (_v, c) => cell("th", header?.[c])))),
        h("tbody", {}, ...body.map((row) => h("tr", {}, ...Array.from({ length: cols }, (_v, c) => cell("td", row[c]))))),
      ),
    );
  }

  private renderEditor(): HTMLElement {
    if (this.csvDraft) {
      const doc = this.csvDraft;
      const cols = columnCount(doc.rows);
      const input = (r: number, c: number) =>
        h("input", {
          attrs: { value: doc.rows[r]?.[c] ?? "", "aria-label": `${r + 1}行${c + 1}列` },
          on: {
            input: (event) => {
              const row = doc.rows[r]!;
              while (row.length < cols) row.push("");
              row[c] = (event.target as HTMLInputElement).value;
            },
          },
        });
      const [, ...body] = doc.rows;
      return h(
        "div",
        { class: "sheet-wrap" },
        h(
          "table",
          { class: "sheet", data: { testid: "viewer-sheet-editor" } },
          h("thead", {}, h("tr", {}, ...Array.from({ length: cols }, (_v, c) => h("th", { class: "cell" }, input(0, c))))),
          h(
            "tbody",
            {},
            ...body.map((_row, i) => h("tr", {}, ...Array.from({ length: cols }, (_v, c) => h("td", { class: "cell" }, input(i + 1, c))))),
          ),
        ),
      );
    }
    const area = h("textarea", {
      class: "editor",
      attrs: { spellcheck: "false", "aria-label": `${this.name} の中身` },
      data: { testid: "viewer-editor" },
      on: {
        input: (event) => {
          this.draft = (event.target as HTMLTextAreaElement).value;
        },
      },
    });
    area.value = this.draft;
    return area;
  }
}
