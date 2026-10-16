// **PDF・Office の画面のコメント**（v4-modules.md §2.2「PDF・Office のファイルを読んでコメントを返す」の「コメント」と
// 「画面の形（改訂・2026-10-16）」、Backlog #307・#340）。
//
// 描いている側（PDF・Word・表の面）とこの部品の分け方：
//   - 描いている側：ページ・文・範囲・セルを**指させる**（選び終えたら `offer` で「コメント」を出させる）、指した所の位置
//     （`boxOf`）、付けたものの印（`paintMarks`——`marks()` を読む）、その場所へ飛ぶ（`jumpTo`）
//   - この部品：ツールバーの「コメント（件数）」（コメントモードの切り替え）・「一覧」・「AI に返す（件数）」、選んだ横の
//     「コメント」、書く欄、余白の一覧（広いとき、指した所の高さに並べる）、下から出す一覧（狭いとき）、置き場との読み書き
//
// **コメントモード**：オフなら読むだけ——「コメント」・印・余白・ページの行の「コメント」は出さない（付けたものは消えない。
// 「AI に返す」は押せる）。既定は大きく開いた画面ではオン、会話の中のカードではオフ。画面ごとに覚えない（開くたび既定）。
//
// 置き場は FileSystem（`getComments`／`saveComments`、Project ごと、鍵はパス）——会話の中のカードと大きく開いた画面は
// 同じものを見る。
//
// **「AI に返す」**：コメントを1つの文にまとめ、MCP Apps の標準 `ui/message` で host に渡す。banto は**その画面を開いた
// 会話の入力欄に「添付」の塊として置くだけ**で、送るのは人（v4-frontend.md §6.2「画面から会話の入力欄へ文を渡す」）。
// 受ける host（`hostCapabilities.message`）でだけ出し、受けない host（会話の外で開いた画面）では「コピー」にする。
// 渡したら一覧は空にし、前の一覧は「元に戻す」で1回だけ戻せる。

import { h, replaceChildren } from "./dom.js";
import { icon } from "./icons.js";
import { callTool, errorMessage, request, textOf, type DisplayMode } from "./protocol.js";
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

/** 中身の箱（`content`）の中での位置（px） */
export interface AnchorBox {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** 描いている側が引き受けること */
export interface CommentTarget {
  /** 指した所の、中身の箱の中での位置。いま描いていない（別のシート等）なら undefined */
  boxOf(anchor: CommentAnchor): AnchorBox | undefined;
  /** そのコメントの場所へ飛ぶ */
  jumpTo(anchor: CommentAnchor): void;
  /** 印を描き直す（`marks()` を読む） */
  paintMarks(): void;
}

/** 画面に出す印1つ。`state`：付けたもの・書いている対象・囲んで「コメント」を待っているもの */
export interface CommentMark {
  anchor: CommentAnchor;
  id?: string;
  state: "saved" | "draft" | "pending";
  focused: boolean;
}

/** 広いとき（これ以上の幅で、大きく開いた画面）だけ右に余白を取る */
export const WIDE_MIN_PX = 820;
/** 余白の幅 */
export const MARGIN_PX = 292;
/** 余白を出すとき、ページの幅から引く分（余白・ページとの隙間 24px・右の端との隙間 16px。styles.ts の .comment-margin と合わせる） */
export const MARGIN_ROOM_PX = MARGIN_PX + 24 + 16;


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

/** 選んだ横の「コメント」の置き場所（中身の箱の中、px）。`align: "right"` なら x は右の端 */
export interface OfferAt {
  x: number;
  y: number;
  align?: "left" | "right";
}

export class CommentReview {
  // --- ツールバーに描いている側が置くもの ---
  readonly modeButton: HTMLButtonElement;
  readonly listButton: HTMLButtonElement;
  readonly undoButton: HTMLButtonElement;
  readonly returnButton: HTMLButtonElement;
  /** 広いときの右の余白（描いている側が中身の箱の中、ページの右に置く） */
  readonly margin: HTMLElement;

  private path = "";
  private comments: DocumentComment[] = [];
  private hash = "";
  private loaded = false;
  private error = "";
  private busy = false;
  /** 保存するたびに進む——保存より前に頼んだ読み直しの結果で、保存したものを上書きしない */
  private version = 0;
  private draft?: { anchor: CommentAnchor };
  private editing?: string;
  private focusedId?: string;
  /** 「AI に返す」の前の一覧（1回だけ戻せる） */
  private undo?: DocumentComment[];
  /** 選んだ横に出している「コメント」の対象 */
  private offered?: CommentAnchor;
  private mode: boolean;
  private wide = false;
  private listOpen = false;
  private displayMode: DisplayMode;
  /** document・window に付けた聞き手（destroy で外す） */
  private readonly listeners = new AbortController();
  private readonly resize: ResizeObserver;

  private readonly modeCount: HTMLSpanElement;
  private readonly returnCount: HTMLSpanElement;
  private readonly chip: HTMLButtonElement;
  private readonly chipLabel: HTMLSpanElement;
  private readonly chipKey: HTMLElement;
  private readonly overlay: HTMLDivElement;
  private readonly sheet: HTMLElement;
  private readonly draftInput: HTMLTextAreaElement;
  private readonly draftCard: HTMLElement;
  private readonly draftAnchor: HTMLElement;
  private readonly draftAdd: HTMLButtonElement;

  constructor(
    private readonly target: CommentTarget,
    private readonly options: {
      /** 画面の枠（狭いときの一覧を下から出す。`data-comment-mode` を付ける） */
      root: HTMLElement;
      /** 狭いときの一覧を下から出す枠（position: relative。既定は root。表はシートのタブを覆わないよう表の枠） */
      listHost?: HTMLElement;
      /** 中身の箱（position: relative。ページと余白を並べ、スクロールで一緒に動く）。「コメント」と狭いときの書く欄を置く */
      content: HTMLElement;
      displayMode: DisplayMode;
      /** host が `ui/message` を受けるか（会話の中で開いたときだけ）。受けなければ「コピー」 */
      canReturn: boolean;
      /** 何も無いときの案内（「文を選ぶか、図をドラッグで囲むと…」） */
      emptyHint: string;
      /** 広い・狭い、モードが変わった（描いている側が幅を合わせ直す） */
      onLayoutChange?: () => void;
      /** 件数・中身が変わった（会話の中のカードの高さを合わせる） */
      onChange?: () => void;
    },
  ) {
    this.displayMode = options.displayMode;
    this.mode = options.displayMode === "fullscreen";
    this.modeCount = h("span", { class: "count", data: { testid: "comments-toggle-count" } });
    this.modeButton = h(
      "button",
      { class: "btn ghost", attrs: { type: "button" }, data: { testid: "comments-toggle" }, on: { click: () => this.setMode(!this.mode) } },
      icon("MessageSquare"),
      "コメント",
      this.modeCount,
    );
    this.listButton = h(
      "button",
      {
        class: "btn ghost",
        title: "コメントの一覧を下に出す",
        attrs: { type: "button", "aria-pressed": "false" },
        data: { testid: "comments-list-toggle" },
        on: { click: () => this.toggleList() },
      },
      icon("List"),
      "一覧",
    );
    this.undoButton = h(
      "button",
      { class: "btn ghost", title: "返す前の一覧に戻す（1回だけ）", attrs: { type: "button" }, data: { testid: "comments-undo" }, on: { click: () => void this.restore() } },
      icon("Undo2"),
      "元に戻す",
    );
    this.returnCount = h("span", { class: "count on-primary" });
    this.returnButton = options.canReturn
      ? h(
          "button",
          {
            class: "btn btn-primary",
            title: "コメントをまとめて会話の入力欄に入れる（送るのはあなた）",
            attrs: { type: "button" },
            data: { testid: "comments-return" },
            on: { click: () => void this.returnToAi() },
          },
          icon("SendHorizontal"),
          "AI に返す",
          this.returnCount,
        )
      : h(
          "button",
          {
            class: "btn btn-primary",
            title: "コメントをまとめた文をコピーする（ここは会話の外なので、AI に直接は返せません）",
            attrs: { type: "button" },
            data: { testid: "comments-copy" },
            on: { click: () => void this.copy() },
          },
          icon("Copy"),
          "コピー",
          this.returnCount,
        );

    this.margin = h("aside", { class: "comment-margin", attrs: { "aria-label": "コメント" }, data: { testid: "comment-margin" } });
    this.margin.style.width = `${MARGIN_PX}px`;
    this.sheet = h("section", { class: "comment-sheet", attrs: { "aria-label": "コメントの一覧" }, data: { testid: "comments-panel" } });
    this.overlay = h("div", { class: "comment-overlay" });
    this.chipLabel = h("span", { text: "コメント" });
    this.chipKey = h("kbd", { text: "C" });
    this.chip = h(
      "button",
      {
        class: "comment-chip",
        attrs: { type: "button" },
        data: { testid: "comment-chip" },
        on: {
          // 押しても選んだ文を手放さない
          mousedown: (e) => e.preventDefault(),
          pointerdown: (e) => e.stopPropagation(),
          click: () => this.offered && this.beginDraft(this.offered),
        },
      },
      icon("MessageSquarePlus"),
      this.chipLabel,
      this.chipKey,
    );
    this.chip.hidden = true;
    this.overlay.hidden = true;
    options.content.append(this.chip, this.overlay);
    (options.listHost ?? options.root).append(this.sheet);

    this.draftInput = h("textarea", {
      class: "comment-input",
      attrs: { rows: "3", placeholder: "コメントを書く", "aria-label": "コメント" },
      data: { testid: "comment-input" },
      on: {
        input: () => this.syncDraftButton(),
        keydown: (e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void this.addDraft();
          } else if (e.key === "Escape") {
            e.stopPropagation();
            this.cancelDraft();
          }
        },
      },
    });
    this.draftAnchor = h("div", { class: "comment-anchor", data: { testid: "comment-draft-anchor" } });
    this.draftAdd = h("button", { class: "btn btn-primary btn-sm", text: "追加", attrs: { type: "button" }, data: { testid: "comment-add" }, on: { click: () => void this.addDraft() } });
    this.draftCard = h(
      "div",
      { class: "comment-card comment-draft", data: { testid: "comment-draft" }, on: { pointerdown: (e) => e.stopPropagation() } },
      this.draftAnchor,
      this.draftInput,
      h(
        "div",
        { class: "comment-actions" },
        h("span", { class: "comment-hint", text: "Ctrl+Enter で追加" }),
        h("span", { class: "spacer-fill" }),
        h("button", { class: "btn ghost btn-sm", text: "やめる", attrs: { type: "button" }, data: { testid: "comment-cancel" }, on: { click: () => this.cancelDraft() } }),
        this.draftAdd,
      ),
    );

    // 選んだ横の「コメント」は C キーでも（書いている途中・入力欄の中では効かない。表のセルには使わない）
    document.addEventListener(
      "keydown",
      (e) => {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) return;
        if (e.key === "Escape") {
          if (this.draft) this.cancelDraft();
          else this.clearOffer();
        } else if (this.offered && this.offered.kind !== "cell" && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "c") {
          e.preventDefault();
          this.beginDraft(this.offered);
        }
      },
      { signal: this.listeners.signal },
    );
    this.resize = new ResizeObserver(() => this.updateWide());
    this.resize.observe(options.root);
    // ほかの面（会話の中のカード・大きく開いた画面）で付けたものを、戻ってきたときに読み直す
    window.addEventListener("focus", () => void this.reload(), { signal: this.listeners.signal });
    this.render();
  }

  /** 画面から外す（ファイルブラウザで別のファイルを選んだ）。document・window に付けた聞き手を外す */
  destroy(): void {
    this.listeners.abort();
    this.resize.disconnect();
  }

  get count(): number {
    return this.comments.length;
  }

  get commentMode(): boolean {
    return this.mode;
  }

  /** 右に余白を取っているか（広い・コメントモード）——描いている側はページを余白を引いた幅に収める */
  get marginShown(): boolean {
    return this.wide && this.mode;
  }

  /** 画面に出す印（コメントモードを切っていれば無い） */
  marks(): CommentMark[] {
    if (!this.mode) return [];
    const out: CommentMark[] = this.comments.map((c) => ({ anchor: c.anchor, id: c.id, state: "saved", focused: c.id !== undefined && c.id === this.focusedId }));
    if (this.draft) out.push({ anchor: this.draft.anchor, state: "draft", focused: true });
    else if (this.offered && this.offered.kind === "region") out.push({ anchor: this.offered, state: "pending", focused: true });
    return out;
  }

  /** 印が押された——対応する余白のコメントを強調する（逆も：余白のコメントを押すと印が強調される） */
  focusComment(id: string): void {
    if (!this.comments.some((c) => c.id === id)) return;
    this.focus(id);
  }

  setDisplayMode(mode: DisplayMode): void {
    if (mode === this.displayMode) return;
    this.displayMode = mode;
    // 切り替えは覚えない——大きく開いたらオン、会話の中に戻ったらオフ
    this.mode = mode === "fullscreen";
    this.draft = undefined;
    this.offered = undefined;
    this.listOpen = false;
    this.updateWide(true);
  }

  private updateWide(force = false): void {
    const wide = this.displayMode === "fullscreen" && this.options.root.clientWidth >= WIDE_MIN_PX;
    if (wide === this.wide && !force) {
      this.layout();
      return;
    }
    this.wide = wide;
    if (wide) this.listOpen = false;
    this.render();
    this.options.onLayoutChange?.();
  }

  setMode(on: boolean): void {
    if (on === this.mode) return;
    this.mode = on;
    this.draft = undefined;
    this.offered = undefined;
    this.listOpen = false;
    this.render();
    this.options.onLayoutChange?.();
  }

  private toggleList(): void {
    this.listOpen = !this.listOpen;
    if (this.listOpen) void this.reload();
    this.render();
  }

  // ---- 読む・残す -----------------------------------------------------------------

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
    if (!this.path || this.busy || this.editing || this.draft) return;
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

  // ---- 指す・付ける ---------------------------------------------------------------

  /** 選び終えた所の横に「コメント」を出す（コメントモードのときだけ） */
  offer(anchor: CommentAnchor, at: OfferAt): void {
    if (!this.mode || this.draft) return;
    this.offered = anchor;
    this.chipLabel.textContent = anchor.kind === "cell" ? `${anchor.range} にコメント` : "コメント";
    // 表のセルには C キーを使わない（キーの印も置かない）
    if (anchor.kind === "cell") this.chipKey.remove();
    else this.chip.append(this.chipKey);
    this.chip.hidden = false;
    const width = this.chip.offsetWidth;
    const max = this.options.content.clientWidth - width - 4;
    const left = at.align === "right" ? at.x - width : at.x;
    this.chip.style.left = `${Math.max(4, Math.min(left, max))}px`;
    this.chip.style.top = `${Math.max(4, at.y)}px`;
    this.target.paintMarks();
  }

  /** 「コメント」を引っ込める（ページの別の所を押した・スクロールした・選ぶのをやめた） */
  clearOffer(): void {
    if (!this.offered) return;
    this.offered = undefined;
    this.chip.hidden = true;
    this.target.paintMarks();
  }

  get offeredAnchor(): CommentAnchor | undefined {
    return this.offered;
  }

  /** 書く欄を開く（「コメント」・C キー・ページの行の「このページにコメント」） */
  beginDraft(anchor: CommentAnchor): void {
    if (!this.mode) return;
    this.offered = undefined;
    this.draft = { anchor };
    this.draftInput.value = "";
    this.focusedId = undefined;
    this.render();
    this.draftInput.focus({ preventScroll: true });
  }

  private cancelDraft(): void {
    if (!this.draft) return;
    this.draft = undefined;
    this.render();
  }

  private syncDraftButton(): void {
    if (this.busy || !this.draftInput.value.trim()) this.draftAdd.setAttribute("disabled", "");
    else this.draftAdd.removeAttribute("disabled");
  }

  private async addDraft(): Promise<void> {
    const draft = this.draft;
    const body = this.draftInput.value.trim();
    if (!draft || !body || this.busy) return;
    const before = new Set(this.comments.map((c) => c.id));
    if (await this.save([...this.comments, { anchor: draft.anchor, body }])) {
      this.draft = undefined;
      this.draftInput.value = "";
      this.undo = undefined;
      this.focusedId = this.comments.find((c) => !before.has(c.id))?.id;
      window.getSelection()?.removeAllRanges();
      this.render();
    }
  }

  // ---- 直す・消す・強調 -----------------------------------------------------------------

  private focus(id: string): void {
    this.focusedId = id;
    this.render();
  }

  private async edit(id: string, body: string): Promise<void> {
    if (!body.trim()) return;
    const ok = await this.save(this.comments.map((c) => (c.id === id ? { ...c, body: body.trim() } : c)));
    if (ok) {
      this.editing = undefined;
      this.render();
    }
  }

  private async remove(id: string): Promise<void> {
    if (this.focusedId === id) this.focusedId = undefined;
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
      this.listOpen = false;
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

  private card(c: DocumentComment): HTMLElement {
    const id = c.id ?? "";
    const changed = Boolean(c.fileHash && this.hash && c.fileHash !== this.hash);
    const editing = this.editing === id;
    const editor = editing
      ? h("textarea", { class: "comment-input", attrs: { rows: "3", "aria-label": "コメントを直す" }, data: { testid: "comment-edit-input" } })
      : undefined;
    if (editor) {
      editor.value = c.body;
      queueMicrotask(() => editor.focus({ preventScroll: true }));
    }
    const open = () => {
      this.focus(id);
      this.target.jumpTo(c.anchor);
    };
    const stop = (e: Event) => e.stopPropagation();
    return h(
      "li",
      {
        class: this.focusedId === id ? "comment-card comment-item focused" : "comment-card comment-item",
        data: { testid: "comment-item", commentId: id },
        on: { click: () => !editing && open(), pointerdown: stop },
      },
      h(
        "div",
        { class: "comment-item-head" },
        h("span", { class: "comment-bar", attrs: { "aria-hidden": "true" } }),
        h("button", {
          class: "comment-anchor link truncate",
          text: describeAnchor(c.anchor),
          title: "この場所へ飛ぶ",
          attrs: { type: "button" },
          data: { testid: "comment-anchor" },
          on: {
            click: (e) => {
              e.stopPropagation();
              open();
            },
          },
        }),
        editing
          ? null
          : h(
              "span",
              { class: "comment-tools" },
              h(
                "button",
                {
                  class: "icon-btn",
                  title: "直す",
                  attrs: { type: "button", "aria-label": "直す" },
                  data: { testid: "comment-edit" },
                  on: {
                    click: (e) => {
                      e.stopPropagation();
                      this.editing = id;
                      this.render();
                    },
                  },
                },
                icon("Pencil"),
              ),
              h(
                "button",
                {
                  class: "icon-btn",
                  title: "消す",
                  attrs: { type: "button", "aria-label": "消す" },
                  data: { testid: "comment-delete" },
                  on: {
                    click: (e) => {
                      e.stopPropagation();
                      void this.remove(id);
                    },
                  },
                },
                icon("Trash2"),
              ),
            ),
      ),
      changed ? h("div", { class: "comment-changed", text: "付けたあとでファイルが変わりました", data: { testid: "comment-changed" } }) : null,
      editor ?? h("p", { class: "comment-body", text: c.body, data: { testid: "comment-body" } }),
      editing && editor
        ? h(
            "div",
            { class: "comment-actions" },
            h("span", { class: "spacer-fill" }),
            h(
              "button",
              {
                class: "btn ghost btn-sm",
                text: "やめる",
                attrs: { type: "button" },
                on: {
                  click: (e) => {
                    stop(e);
                    this.editing = undefined;
                    this.render();
                  },
                },
              },
            ),
            h(
              "button",
              {
                class: "btn btn-primary btn-sm",
                text: "保存",
                attrs: { type: "button" },
                data: { testid: "comment-edit-save" },
                on: {
                  click: (e) => {
                    stop(e);
                    void this.edit(id, editor.value);
                  },
                },
              },
            ),
          )
        : null,
    );
  }

  private emptyNote(): HTMLElement {
    return h("p", { class: "comment-empty", text: !this.loaded && !this.error ? "コメントを読んでいます…" : this.options.emptyHint, data: { testid: "comments-empty" } });
  }

  render(): void {
    const n = this.comments.length;
    const root = this.options.root;
    root.dataset.commentMode = this.mode ? "on" : "off";
    root.dataset.commentWide = this.wide ? "on" : "off";

    // ---- ツールバー ----
    this.modeButton.setAttribute("aria-pressed", String(this.mode));
    this.modeButton.title = this.mode ? "コメントモードを切る（読むだけに）" : "コメントモードに入る";
    this.modeButton.classList.toggle("active", this.mode);
    this.modeCount.textContent = n > 0 ? String(n) : "";
    this.listButton.hidden = this.wide || !this.mode;
    this.listButton.setAttribute("aria-pressed", String(this.listOpen));
    this.listButton.classList.toggle("active", this.listOpen);
    this.undoButton.hidden = !this.undo;
    this.returnButton.hidden = n === 0;
    this.returnCount.textContent = String(n);
    if (this.busy) this.returnButton.setAttribute("disabled", "");
    else this.returnButton.removeAttribute("disabled");

    // ---- 書く欄 ----
    if (this.draft) this.draftAnchor.textContent = describeAnchor(this.draft.anchor);
    this.syncDraftButton();
    if (!this.mode) this.offered = undefined;
    this.chip.hidden = !this.offered;

    const errorEl = this.error ? h("p", { class: "comment-empty error", text: this.error, data: { testid: "comments-error" } }) : null;

    // ---- 広いとき：右の余白 ----
    this.margin.hidden = !this.marginShown;
    if (this.marginShown) {
      const list = h("ol", { class: "comment-list", data: { testid: "comment-list" } }, ...this.comments.map((c) => this.card(c)));
      if (this.draft) list.append(h("li", { class: "comment-slot-draft" }, this.draftCard));
      replaceChildren(this.margin, errorEl, n === 0 && !this.draft ? this.emptyNote() : null, list);
    } else {
      this.margin.replaceChildren();
    }

    // ---- 狭いとき：書く欄は選んだ所の下に重ね、一覧は下から ----
    const narrowDraft = !this.wide && this.mode && this.draft;
    this.overlay.hidden = !narrowDraft;
    if (narrowDraft) replaceChildren(this.overlay, this.draftCard);
    else this.overlay.replaceChildren();
    const sheetOpen = !this.wide && this.mode && this.listOpen;
    this.sheet.hidden = !sheetOpen;
    if (sheetOpen) {
      replaceChildren(
        this.sheet,
        h(
          "div",
          { class: "comment-sheet-head" },
          h("span", { class: "comments-title", text: `コメント ${n} 件`, data: { testid: "comments-count" } }),
          h("span", { class: "spacer-fill" }),
          h("button", { class: "icon-btn", title: "閉じる", attrs: { type: "button", "aria-label": "閉じる" }, on: { click: () => this.toggleList() } }, icon("X")),
        ),
        errorEl,
        n === 0 ? this.emptyNote() : h("ol", { class: "comment-list", data: { testid: "comment-list" } }, ...this.comments.map((c) => this.card(c))),
      );
    } else {
      this.sheet.replaceChildren();
    }

    this.target.paintMarks();
    this.layout();
    this.options.onChange?.();
  }

  /**
   * **余白のコメントを、指した所の高さに並べる**（重なれば下へずらす）。狭いときは書く欄を選んだ所のすぐ下に置く。
   * 描いている側は、ページを描いた・倍率を変えた・幅が変わったときにも呼ぶ
   */
  layout(): void {
    if (this.marginShown) {
      const marginTop = this.margin.offsetTop;
      const items: Array<{ el: HTMLElement; want: number; order: number }> = [];
      const cards = [...this.margin.querySelectorAll<HTMLElement>(":scope > .comment-list > li")];
      const anchors = [...this.comments.map((c) => c.anchor), ...(this.draft ? [this.draft.anchor] : [])];
      cards.forEach((el, i) => {
        const anchor = anchors[i];
        const box = anchor ? this.target.boxOf(anchor) : undefined;
        // 描いていない所を指すもの（別のシート等）は頭に寄せる
        items.push({ el, want: box ? Math.max(0, box.top - marginTop - 6) : 0, order: i });
      });
      items.sort((a, b) => a.want - b.want || a.order - b.order);
      let floor = 0;
      for (const it of items) {
        const top = Math.max(it.want, floor);
        it.el.style.top = `${top}px`;
        floor = top + it.el.offsetHeight + 10;
      }
      this.margin.style.minHeight = `${floor}px`;
    } else {
      this.margin.style.minHeight = "";
    }
    if (!this.overlay.hidden && this.draft) {
      const content = this.options.content;
      const box = this.target.boxOf(this.draft.anchor);
      const width = Math.min(320, content.clientWidth - 24);
      this.overlay.style.width = `${width}px`;
      const left = box ? Math.max(12, Math.min(box.left, content.clientWidth - width - 12)) : 12;
      this.overlay.style.left = `${left}px`;
      this.overlay.style.top = `${(box ? box.bottom : 0) + 8}px`;
    }
  }
}
