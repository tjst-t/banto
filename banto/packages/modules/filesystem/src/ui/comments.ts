// **PDF・Office の画面のコメント**（v4-modules.md §2.2「PDF・Office のファイルを読んでコメントを返す」の「コメント」、
// Backlog #307、2026-10-15）。
//
// ページ・選んだ文・ドラッグした範囲・表のセルを指してコメントを付け、画面の右（狭いとき・会話の中では下）の一覧に溜める。
// 押すとその場所へ飛び、直す・消すができる。置き場は FileSystem（`getComments`／`saveComments`、Project ごと、鍵はパス）
// ——会話の中のカードと大きく開いた画面は同じものを見る。
//
// **「AI に返す」**：コメントを1つの文にまとめ、MCP Apps の標準 `ui/message` で host に渡す。banto は**その画面を開いた
// 会話の入力欄に「添付」の塊として置くだけ**で、送るのは人（v4-frontend.md §6.2「画面から会話の入力欄へ文を渡す」）。
// 受ける host（`hostCapabilities.message`）でだけ出し、受けない host（会話の外で開いた画面）では「コピー」にする。
// 渡したら一覧は空にし、前の一覧は「元に戻す」で1回だけ戻せる。
//
// 何を指しているかは画面の種類ごとに違うので、指す・飛ぶは描いている側（`CommentTarget`）に任せる。

import { h, replaceChildren } from "./dom.js";
import { icon } from "./icons.js";
import { callTool, errorMessage, request, textOf } from "./protocol.js";
import { toast } from "./toast.js";

/** 範囲。ページに対する割合（0〜1）——倍率が変わっても同じ場所を指す */
export interface CommentRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 何を指しているか（形は FileSystem の `comments.ts` と同じ。確かめるのは向こう） */
export type CommentAnchor =
  | { kind: "page"; page: number }
  | { kind: "text"; quote: string; page?: number; heading?: string }
  | { kind: "region"; page: number; rect: CommentRect }
  | { kind: "cell"; sheet: string; range: string; value?: string };

export interface DocumentComment {
  id?: string;
  anchor: CommentAnchor;
  body: string;
  /** 付けたときのファイルのハッシュ（FileSystem が付ける） */
  fileHash?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** 描いている側が引き受けること。指せないものは持たない（その口のボタンを出さない） */
export interface CommentTarget {
  /** 人がいまこの画面の中で選んでいる文。無ければ undefined */
  selectedText?(): Extract<CommentAnchor, { kind: "text" }> | undefined;
  /** いま見ているページ */
  currentPage?(): number | undefined;
  /** 表で選んでいるセル・範囲（`シート名!B4:D6` とそこの値）。選んでいなければ undefined */
  selectedCell?(): Extract<CommentAnchor, { kind: "cell" }> | undefined;
  /** ドラッグで範囲を囲ませる。囲み終えたら `done`。返り値で取りやめる */
  startRegion?(done: (anchor: Extract<CommentAnchor, { kind: "region" }>) => void): () => void;
  /** そのコメントの場所へ飛ぶ */
  jumpTo(anchor: CommentAnchor): void;
}

/** `ui/message` で1回に渡せる長さ（v4-frontend.md §6.2 の上限と同じ。正は host） */
export const MESSAGE_MAX_CHARS = 20_000;
/** 文の中の引用は 200 字で切る */
const QUOTE_MAX_CHARS = 200;

function cut(text: string, max = QUOTE_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 範囲がページのどのあたりか（「左上」など）。AI と人が場所の見当を付けられるように */
export function describeRect(rect: CommentRect): string {
  if (rect.w >= 0.8 && rect.h >= 0.8) return "ほぼ全体";
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const col = cx < 1 / 3 ? 0 : cx > 2 / 3 ? 2 : 1;
  const row = cy < 1 / 3 ? 0 : cy > 2 / 3 ? 2 : 1;
  return [
    ["左上", "上", "右上"],
    ["左", "真ん中", "右"],
    ["左下", "下", "右下"],
  ][row]![col]!;
}

/** 指している場所を1行で（一覧の見出しと、AI に返す文の両方に使う）。**引用は「」でくくる**——人のコメントと分ける */
export function describeAnchor(anchor: CommentAnchor): string {
  switch (anchor.kind) {
    case "page":
      return `${anchor.page}ページ`;
    case "text": {
      const where = [anchor.page !== undefined ? `${anchor.page}ページ` : "", anchor.heading ? `見出し「${cut(anchor.heading, 60)}」の下` : ""]
        .filter(Boolean)
        .join("・");
      return `${where}「${cut(anchor.quote)}」`;
    }
    case "region":
      return `${anchor.page}ページの範囲（${describeRect(anchor.rect)}）`;
    case "cell":
      return `\`${anchor.sheet}!${anchor.range}\`${anchor.value !== undefined && anchor.value !== "" ? `（値 ${cut(anchor.value, 60)}）` : ""}`;
  }
}

/**
 * **AI に返す文**。例：「`docs/plan.pdf` へのコメント（2件）\n1. 3ページ「受信箱の見直しについて…」：ここは結論を先に\n
 * 2. 5ページの範囲（左上）：凡例が読めない」。付けたあとでファイルが変わったものはそう添える
 */
export function formatCommentsMessage(path: string, comments: readonly DocumentComment[], currentHash: string): string {
  const lines = comments.map((c, i) => {
    const changed = c.fileHash && currentHash && c.fileHash !== currentHash ? "（付けたあとでファイルが変わっています）" : "";
    return `${i + 1}. ${describeAnchor(c.anchor)}${changed}：${c.body.trim().replace(/\n/g, "\n   ")}`;
  });
  return [`\`${path}\` へのコメント（${comments.length}件）`, ...lines].join("\n");
}

interface SavedComments {
  path: string;
  hash: string;
  comments: DocumentComment[];
}

function parseSaved(result: Parameters<typeof textOf>[0]): SavedComments {
  const parsed = JSON.parse(textOf(result)) as Partial<SavedComments>;
  if (!Array.isArray(parsed.comments) || typeof parsed.hash !== "string") throw new Error("コメントの結果の形が読めません");
  return { path: String(parsed.path ?? ""), hash: parsed.hash, comments: parsed.comments };
}

type Draft = { anchor: CommentAnchor };

export class CommentsPanel {
  readonly el: HTMLElement;
  private path = "";
  private comments: DocumentComment[] = [];
  private hash = "";
  private loaded = false;
  private error = "";
  private busy = false;
  /** 保存するたびに進む——保存より前に頼んだ読み直しの結果で、保存したものを上書きしない */
  private version = 0;
  private draft?: Draft;
  private editing?: string;
  /** 「AI に返す」の前の一覧（1回だけ戻せる） */
  private undo?: DocumentComment[];
  private stopRegion?: () => void;
  private readonly draftInput: HTMLTextAreaElement;

  constructor(
    private readonly target: CommentTarget,
    private readonly options: {
      /** host が `ui/message` を受けるか（会話の中で開いたときだけ）。受けなければ「コピー」 */
      canReturn: boolean;
      /** 件数や中身が変わった（ツールバーの数・カードの高さを合わせる） */
      onChange?: () => void;
    },
  ) {
    this.el = h("aside", { class: "comments", attrs: { "aria-label": "コメント" }, data: { testid: "comments-panel" } });
    this.draftInput = h("textarea", {
      class: "comment-input",
      attrs: { rows: "3", placeholder: "コメント（Ctrl+Enter で追加）", "aria-label": "コメント" },
      data: { testid: "comment-input" },
      on: {
        keydown: (e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void this.addDraft();
          } else if (e.key === "Escape") {
            this.draft = undefined;
            this.render();
          }
        },
      },
    });
    // ほかの面（会話の中のカード・大きく開いた画面）で付けたものを、戻ってきたときに読み直す
    window.addEventListener("focus", () => void this.reload());
    this.render();
  }

  get count(): number {
    return this.comments.length;
  }

  /** そのファイルのコメントを読む */
  async load(path: string): Promise<void> {
    this.path = path;
    this.loaded = false;
    this.error = "";
    this.comments = [];
    this.undo = undefined;
    this.render();
    await this.reload();
  }

  /** 置き場から読み直す（書いている途中・直している途中は読み直さない——書きかけを消さない） */
  async reload(): Promise<void> {
    if (!this.path || this.busy || this.editing) return;
    const path = this.path;
    const version = this.version;
    try {
      const got = parseSaved(await callTool("getComments", { path }));
      if (path !== this.path || version !== this.version) return;
      this.comments = got.comments;
      this.hash = got.hash;
      this.loaded = true;
      this.error = "";
    } catch (err) {
      this.error = `コメントを読めませんでした：${errorMessage(err)}`;
    }
    this.render();
  }

  private async save(next: DocumentComment[]): Promise<boolean> {
    this.version++;
    this.busy = true;
    this.render();
    try {
      const saved = parseSaved(await callTool("saveComments", { path: this.path, comments: next }));
      this.comments = saved.comments;
      this.hash = saved.hash;
      this.error = "";
      return true;
    } catch (err) {
      // **残せなかったら、そう出す**（規則2）——一覧は残せたものだけ（書いた文は入力欄に残る）
      toast("コメントを残せませんでした", { description: errorMessage(err), error: true });
      return false;
    } finally {
      this.busy = false;
      this.render();
    }
  }

  // ---- 付ける ----------------------------------------------------------------

  private beginDraft(anchor: CommentAnchor): void {
    this.stopRegion?.();
    this.stopRegion = undefined;
    this.draft = { anchor };
    this.render();
    this.draftInput.focus();
  }

  private fromSelection(): void {
    const anchor = this.target.selectedText?.();
    if (!anchor) {
      toast("先に文字を選んでください", { description: "ページの文字をドラッグして選んでから押します", error: true });
      return;
    }
    this.beginDraft(anchor);
  }

  private fromCell(): void {
    const anchor = this.target.selectedCell?.();
    if (!anchor) {
      toast("先にセルを選んでください", { description: "表のセルを押すか、ドラッグして範囲を選んでから押します", error: true });
      return;
    }
    this.beginDraft(anchor);
  }

  private forPage(): void {
    const page = this.target.currentPage?.();
    if (page === undefined) return;
    this.beginDraft({ kind: "page", page });
  }

  private toggleRegion(): void {
    if (this.stopRegion) {
      this.stopRegion();
      this.stopRegion = undefined;
      this.render();
      return;
    }
    const start = this.target.startRegion;
    if (!start) return;
    this.stopRegion = start.call(this.target, (anchor) => {
      this.stopRegion = undefined;
      this.beginDraft(anchor);
    });
    this.render();
  }

  private async addDraft(): Promise<void> {
    const draft = this.draft;
    const body = this.draftInput.value.trim();
    if (!draft || !body || this.busy) return;
    if (await this.save([...this.comments, { anchor: draft.anchor, body }])) {
      this.draft = undefined;
      this.draftInput.value = "";
      this.undo = undefined;
      this.render();
    }
  }

  // ---- 直す・消す ---------------------------------------------------------------

  private async edit(id: string, body: string): Promise<void> {
    if (!body.trim()) return;
    const ok = await this.save(this.comments.map((c) => (c.id === id ? { ...c, body: body.trim() } : c)));
    if (ok) {
      this.editing = undefined;
      this.render();
    }
  }

  private async remove(id: string): Promise<void> {
    await this.save(this.comments.filter((c) => c.id !== id));
  }

  // ---- 返す ---------------------------------------------------------------------

  private message(): string {
    return formatCommentsMessage(this.path, this.comments, this.hash);
  }

  /** **AI に返す**：会話の入力欄に置いてもらうだけ。送るのは人 */
  private async returnToAi(): Promise<void> {
    if (this.comments.length === 0 || this.busy) return;
    const text = this.message();
    if (text.length > MESSAGE_MAX_CHARS) {
      toast("コメントが長すぎて返せません", { description: `${MESSAGE_MAX_CHARS.toLocaleString()} 字までです（いまは ${text.length.toLocaleString()} 字）`, error: true });
      return;
    }
    // **押した直後に頼む**——host は人の操作の直後でなければ受けない（画面が勝手に入れることはできない）。先に何かを待たない
    let result: { isError?: boolean } | undefined;
    try {
      result = await request<{ isError?: boolean }>("ui/message", { role: "user", content: [{ type: "text", text }] });
    } catch (err) {
      toast("会話の入力欄に入れられませんでした", { description: errorMessage(err), error: true });
      return;
    }
    if (result?.isError) {
      toast("会話の入力欄に入れられませんでした", { description: "画面の中のボタンを押した直後だけ入れられます。もう一度押してください", error: true });
      return;
    }
    const before = this.comments;
    if (await this.save([])) {
      this.undo = before;
      this.render();
      toast("会話の入力欄に入れました", { description: "見直して、送信してください（まだ送っていません）" });
    }
  }

  private async copy(): Promise<void> {
    if (this.comments.length === 0) return;
    try {
      await navigator.clipboard.writeText(this.message());
      toast("コメントをコピーしました");
    } catch (err) {
      toast("コピーできませんでした", { description: errorMessage(err), error: true });
    }
  }

  private async restore(): Promise<void> {
    const undo = this.undo;
    if (!undo) return;
    // 1回だけ。戻したものは新しく付けたものとして残る（id とハッシュは置き場が付け直す）
    if (await this.save([...undo.map(({ anchor, body }) => ({ anchor, body })), ...this.comments])) {
      this.undo = undefined;
      this.render();
    }
  }

  // ---- 描く ---------------------------------------------------------------------

  render(): void {
    const t = this.target;
    const head = h(
      "div",
      { class: "comments-head" },
      h("span", { class: "comments-title", text: `コメント（${this.comments.length}件）`, data: { testid: "comments-count" } }),
      h("span", { class: "spacer-fill" }),
      t.selectedText
        ? h(
            "button",
            {
              class: "btn",
              title: "ページの中で選んだ文にコメントを付ける",
              attrs: { type: "button" },
              data: { testid: "comment-from-selection" },
              // 押しても選んだ文を手放さない
              on: { mousedown: (e) => e.preventDefault(), click: () => this.fromSelection() },
            },
            "選んだ文",
          )
        : null,
      t.selectedCell
        ? h(
            "button",
            { class: "btn", title: "表で選んだセル・範囲にコメントを付ける", attrs: { type: "button" }, data: { testid: "comment-for-cell" }, on: { click: () => this.fromCell() } },
            "選んだセル",
          )
        : null,
      t.currentPage ? h("button", { class: "btn", attrs: { type: "button" }, data: { testid: "comment-for-page" }, on: { click: () => this.forPage() } }, "このページ") : null,
      t.startRegion
        ? h(
            "button",
            {
              class: this.stopRegion ? "btn active" : "btn",
              title: "ページの上をドラッグして範囲を囲む（図・絵など文字の無いところ）",
              attrs: { type: "button", "aria-pressed": this.stopRegion ? "true" : "false" },
              data: { testid: "comment-region" },
              on: { click: () => this.toggleRegion() },
            },
            icon("SquareDashed"),
            this.stopRegion ? "囲むのをやめる" : "範囲を囲む",
          )
        : null,
    );

    const draft = this.draft
      ? h(
          "div",
          { class: "comment-draft", data: { testid: "comment-draft" } },
          h("div", { class: "comment-anchor", text: describeAnchor(this.draft.anchor), data: { testid: "comment-draft-anchor" } }),
          this.draftInput,
          h(
            "div",
            { class: "comment-actions" },
            h("button", { class: "btn", attrs: { type: "button" }, on: { click: () => { this.draft = undefined; this.render(); } } }, "やめる"),
            h("button", { class: "btn btn-primary", attrs: { type: "button" }, data: { testid: "comment-add" }, on: { click: () => void this.addDraft() } }, "追加"),
          ),
        )
      : this.stopRegion
        ? h("p", { class: "note", text: "ページの上をドラッグして囲んでください（Esc でやめる）" })
        : null;

    const list = h("ol", { class: "comment-list", data: { testid: "comment-list" } });
    for (const c of this.comments) {
      const id = c.id ?? "";
      const changed = Boolean(c.fileHash && this.hash && c.fileHash !== this.hash);
      const editing = this.editing === id;
      const editor = editing
        ? h("textarea", { class: "comment-input", attrs: { rows: "3", "aria-label": "コメントを直す" }, data: { testid: "comment-edit-input" } })
        : undefined;
      if (editor) editor.value = c.body;
      list.appendChild(
        h(
          "li",
          { class: "comment-item", data: { testid: "comment-item", commentId: id } },
          h("button", {
            class: "comment-anchor link",
            text: describeAnchor(c.anchor),
            title: "この場所へ飛ぶ",
            attrs: { type: "button" },
            data: { testid: "comment-anchor" },
            on: { click: () => this.target.jumpTo(c.anchor) },
          }),
          changed ? h("div", { class: "comment-changed", text: "付けたあとでファイルが変わりました", data: { testid: "comment-changed" } }) : null,
          editor ?? h("p", { class: "comment-body", text: c.body, data: { testid: "comment-body" } }),
          h(
            "div",
            { class: "comment-actions" },
            editing
              ? h("button", { class: "btn", attrs: { type: "button" }, on: { click: () => { this.editing = undefined; this.render(); } } }, "やめる")
              : h("button", { class: "icon-btn", title: "直す", attrs: { type: "button", "aria-label": "直す" }, data: { testid: "comment-edit" }, on: { click: () => { this.editing = id; this.render(); } } }, icon("Pencil")),
            editing
              ? h("button", { class: "btn btn-primary", attrs: { type: "button" }, data: { testid: "comment-edit-save" }, on: { click: () => void this.edit(id, editor?.value ?? "") } }, "保存")
              : h("button", { class: "icon-btn", title: "消す", attrs: { type: "button", "aria-label": "消す" }, data: { testid: "comment-delete" }, on: { click: () => void this.remove(id) } }, icon("Trash2")),
          ),
        ),
      );
      if (editor) queueMicrotask(() => editor.focus());
    }

    const empty =
      this.comments.length === 0 && !this.draft
        ? h("p", {
            class: "note",
            text: !this.loaded && !this.error ? "コメントを読んでいます…" : t.selectedCell ? "まだコメントはありません。セルを選んで付けます" : "まだコメントはありません。文字を選ぶ・範囲を囲む・ページを指して付けます",
          })
        : null;

    const foot = h(
      "div",
      { class: "comments-foot" },
      this.undo
        ? h("button", { class: "btn", attrs: { type: "button" }, data: { testid: "comments-undo" }, on: { click: () => void this.restore() } }, icon("Undo2"), "元に戻す")
        : null,
      h("span", { class: "spacer-fill" }),
      this.options.canReturn
        ? h(
            "button",
            {
              class: "btn btn-primary",
              title: "コメントをまとめて会話の入力欄に入れる（送るのはあなた）",
              attrs: { type: "button", ...(this.comments.length === 0 || this.busy ? { disabled: "" } : {}) },
              data: { testid: "comments-return" },
              on: { click: () => void this.returnToAi() },
            },
            icon("Send"),
            "AI に返す",
          )
        : h(
            "button",
            {
              class: "btn",
              title: "コメントをまとめた文をコピーする（ここは会話の外なので、AI に直接は返せません）",
              attrs: { type: "button", ...(this.comments.length === 0 ? { disabled: "" } : {}) },
              data: { testid: "comments-copy" },
              on: { click: () => void this.copy() },
            },
            icon("Copy"),
            "コピー",
          ),
    );

    replaceChildren(
      this.el,
      head,
      this.error ? h("p", { class: "note error", text: this.error, data: { testid: "comments-error" } }) : null,
      draft,
      empty,
      list,
      foot,
    );
    this.options.onChange?.();
  }

  /** 範囲を囲んでいる途中なら取りやめる（Esc） */
  cancelRegion(): void {
    if (!this.stopRegion) return;
    this.stopRegion();
    this.stopRegion = undefined;
    this.render();
  }
}
