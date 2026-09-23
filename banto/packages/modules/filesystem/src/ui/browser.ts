// ファイルブラウザ（モック `mock/components/banto/canvas/file-explorer-view.tsx` の本実装）。
//
// **大きく開いたとき（fullscreen）**：VSCode のエクスプローラと同じ2ペイン
// ——左にフォルダツリー（新しいファイル・新しいフォルダ・更新・すべて折りたたむ、
// 畳める）、右に選んだファイルの中身。ツリーの下にアップロードとダウンロード
// （Ctrl/Cmd+クリックで複数選ぶと ZIP）。
// **会話の中（inline）**：listDirectory の結果の一覧だけ。「大きく表示」で上に移る。
//
// 中身はすべて自分の Module の tool で取りに行く（§6.2「自分で取りに行く Canvas」）。
// 状態（開いたフォルダ・選んだファイル）はこの画面の中だけに持つ——人が画面を
// 閉じれば消える。

import { h, replaceChildren } from "./dom.js";
import { icon, type IconName } from "./icons.js";
import {
  bytesToBase64,
  callTool,
  downloadViaHost,
  errorMessage,
  reportSize,
  requestDisplayMode,
  textOf,
  type CallToolResult,
  type DisplayMode,
} from "./protocol.js";
import { toast } from "./toast.js";
import { FileViewer } from "./viewer.js";
import { openUploadDialog } from "./upload-dialog.js";
import { formatBytes, iconKindFor } from "../view/preview-kind.js";

interface Entry {
  name: string;
  type: "file" | "directory";
}

interface DirState {
  status: "loading" | "ready" | "error";
  entries: Entry[];
  error?: string;
}

type TreeRow =
  | { kind: "entry"; entry: Entry; path: string; depth: number }
  | { kind: "note"; depth: number; text: string; error?: boolean }
  | { kind: "draft"; depth: number };

const FILE_ICON: Readonly<Record<ReturnType<typeof iconKindFor>, IconName>> = {
  code: "FileCode2",
  text: "FileText",
  image: "FileImage",
  sheet: "FileSpreadsheet",
  file: "File",
};

function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

function dirnameOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** "a/b/c" → ["a", "a/b"]（展開すべき祖先） */
function ancestorsOf(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  return parts.slice(0, -1).map((_p, i) => parts.slice(0, i + 1).join("/"));
}

/** tool に渡すパス（根は "."）。 */
function toolPath(key: string): string {
  return key || ".";
}

function sortEntries(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, "ja", { numeric: true });
  });
}

function parseEntries(result: CallToolResult): Entry[] {
  const parsed: unknown = JSON.parse(textOf(result));
  if (!Array.isArray(parsed)) throw new Error("一覧の形が読めませんでした");
  return parsed.filter(
    (e): e is Entry =>
      typeof e === "object" && e !== null && typeof (e as Entry).name === "string" && ((e as Entry).type === "file" || (e as Entry).type === "directory"),
  );
}

export interface BrowserOptions {
  displayMode: DisplayMode;
  /** host が `ui/download-file` を受けるか。受けないならダウンロードの口を出さない（規則13） */
  canDownload: boolean;
  /** 人が入口から開いたか（true なら tool の結果を待たずに自分で取りに行く） */
  openedByHuman: boolean;
}

export class FileBrowser {
  private displayMode: DisplayMode;
  private readonly canDownload: boolean;
  private readonly root: HTMLElement;

  // --- 大きく開いたときの状態 ---
  private readonly dirs = new Map<string, DirState>();
  private readonly expanded = new Set<string>();
  private activeDir = "";
  private openFile: string | null = null;
  private multi: Set<string> | null = null;
  private anchor: string | null = null;
  private draft: { parent: string; kind: "file" | "dir"; name: string; committing: boolean } | null = null;
  private treeCollapsed = false;
  private refreshing = false;
  private rootLabel = "";
  private rootAbsolute = "";
  private viewer: FileViewer | null = null;
  private readonly sizes = new Map<string, number | "error">();

  // --- 会話の中（inline）の状態 ---
  private inlinePath = ".";
  private inlineEntries: Entry[] | null = null;
  private inlineNote = "";
  private inlineError = false;

  private started = false;

  constructor(root: HTMLElement, options: BrowserOptions) {
    this.root = root;
    this.displayMode = options.displayMode;
    this.canDownload = options.canDownload;
    if (!options.openedByHuman) this.inlineNote = "一覧を待っています…";
    if (options.openedByHuman) this.start();
    else this.render();
  }

  /** tool の入力（どの場所を、どう見せるか）。 */
  setToolInput(args: Record<string, unknown>): void {
    const path = typeof args.path === "string" && args.path ? args.path : ".";
    this.inlinePath = path;
    const key = this.keyFromToolPath(path);
    if (key !== undefined) {
      this.activeDir = key;
      for (const a of [...ancestorsOf(key), key]) if (a) this.expanded.add(a);
    }
    // **呼んだ人が fullscreen を頼んでいたら、開いた直後にそう頼む**
    // （仕様には「最初からこの mode」を宣言する場所が無い、決定・2026-09-07）
    if (args.displayMode === "fullscreen" && this.displayMode === "inline") void this.askFullscreen();
    if (this.displayMode === "fullscreen") this.start();
    else this.render();
  }

  /** tool の結果（inline は、これをそのまま一覧にする）。 */
  setToolResult(result: CallToolResult): void {
    if (this.displayMode !== "inline") return;
    try {
      if (result.isError) throw new Error(textOf(result) || "一覧を取れませんでした");
      this.inlineEntries = sortEntries(parseEntries(result));
      this.inlineNote = `${this.inlineEntries.length} 件`;
      this.inlineError = false;
    } catch (err) {
      // **中身が読めないなら、読めたふりをしない**
      this.inlineEntries = null;
      this.inlineNote = `一覧を読み取れませんでした：${errorMessage(err)}`;
      this.inlineError = true;
    }
    this.render();
  }

  setDisplayMode(mode: DisplayMode): void {
    if (mode === this.displayMode) return;
    this.displayMode = mode;
    document.body.dataset.mode = mode;
    if (mode === "fullscreen") this.start();
    else this.render();
  }

  /** tool の path（"."・"./a"・"a/"・根の中の絶対パス）を、ツリーの鍵（根は ""）にする。 */
  private keyFromToolPath(path: string): string | undefined {
    let p = path.trim();
    if (p.startsWith("/")) {
      if (!this.rootAbsolute || !(p === this.rootAbsolute || p.startsWith(`${this.rootAbsolute}/`))) return undefined;
      p = p.slice(this.rootAbsolute.length);
    }
    const parts = p.split("/").filter((s) => s && s !== ".");
    if (parts.includes("..")) return undefined;
    return parts.join("/");
  }

  // ======================================================================
  // 大きく開いたとき
  // ======================================================================

  private start(): void {
    if (this.displayMode !== "fullscreen") {
      this.render();
      return;
    }
    if (this.started) {
      this.render();
      return;
    }
    this.started = true;
    this.render();
    void this.loadRoot();
  }

  private async loadRoot(): Promise<void> {
    try {
      const info = JSON.parse(textOf(await callTool("getRoot"))) as { path: string; absolute?: string };
      this.rootLabel = info.path;
      this.rootAbsolute = info.absolute ?? "";
    } catch (err) {
      this.rootLabel = `（根を読めませんでした：${errorMessage(err)}）`;
    }
    this.render();
    // 絶対パスで頼まれていた場所は、根が分かってから決め直す
    const key = this.keyFromToolPath(this.inlinePath);
    if (key !== undefined && key !== this.activeDir) {
      this.activeDir = key;
      for (const a of [...ancestorsOf(key), key]) if (a) this.expanded.add(a);
    }
    await Promise.all(["", ...this.expanded].map((k) => this.loadDir(k)));
  }

  private async loadDir(key: string): Promise<void> {
    const prev = this.dirs.get(key);
    this.dirs.set(key, { status: "loading", entries: prev?.entries ?? [] });
    this.renderTree();
    try {
      const entries = sortEntries(parseEntries(await callTool("listDirectory", { path: toolPath(key) })));
      this.dirs.set(key, { status: "ready", entries });
    } catch (err) {
      this.dirs.set(key, { status: "error", entries: [], error: errorMessage(err) });
    }
    this.renderTree();
  }

  private visibleRows(): TreeRow[] {
    const rows: TreeRow[] = [];
    const walk = (key: string, depth: number) => {
      if (this.draft && this.draft.parent === key) rows.push({ kind: "draft", depth });
      const state = this.dirs.get(key);
      if (!state || (state.status === "loading" && state.entries.length === 0)) {
        rows.push({ kind: "note", depth, text: "読み込んでいます…" });
        return;
      }
      if (state.status === "error") {
        rows.push({ kind: "note", depth, text: `読み込めませんでした：${state.error ?? ""}`, error: true });
        return;
      }
      if (state.entries.length === 0 && !(this.draft && this.draft.parent === key)) {
        rows.push({ kind: "note", depth, text: "（空のフォルダ）" });
      }
      for (const entry of state.entries) {
        const path = joinPath(key, entry.name);
        rows.push({ kind: "entry", entry, path, depth });
        if (entry.type === "directory" && this.expanded.has(path)) walk(path, depth + 1);
      }
    };
    walk("", 0);
    return rows;
  }

  private selectedPaths(): string[] {
    if (this.multi) return [...this.multi];
    return this.openFile ? [this.openFile] : [];
  }

  /** 編集中のファイルを黙って閉じない。**移る前に止めて、理由を出す**。 */
  private guardUnsaved(): boolean {
    if (this.viewer?.isDirty()) {
      toast("編集中のファイルがあります", { description: "保存するか、キャンセルしてから移ってください", error: true });
      return false;
    }
    return true;
  }

  private onEntryClick(row: Extract<TreeRow, { kind: "entry" }>, event: MouseEvent | KeyboardEvent): void {
    const { entry, path } = row;
    if (entry.type === "directory") {
      if (this.expanded.has(path)) {
        this.expanded.delete(path);
      } else {
        this.expanded.add(path);
        if (!this.dirs.has(path)) void this.loadDir(path);
      }
      this.activeDir = path;
      if (this.multi) {
        this.multi = null;
        this.render();
      } else {
        this.renderTree();
      }
      return;
    }
    if (event.shiftKey && (this.anchor ?? this.openFile)) {
      const anchor = (this.anchor ?? this.openFile)!;
      const files = this.visibleRows().flatMap((r) => (r.kind === "entry" && r.entry.type === "file" ? [r.path] : []));
      const a = files.indexOf(anchor);
      const b = files.indexOf(path);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        this.multi = new Set(files.slice(lo, hi + 1));
        this.render();
        return;
      }
    }
    if (event.metaKey || event.ctrlKey) {
      // 複数選択は、まとめてダウンロードするための一時的な状態
      const next = new Set(this.multi ?? this.selectedPaths());
      if (next.has(path)) next.delete(path);
      else next.add(path);
      this.multi = next;
      this.anchor = path;
      this.render();
      return;
    }
    if (this.openFile !== path && !this.guardUnsaved()) return;
    this.multi = null;
    this.anchor = path;
    this.openFile = path;
    this.activeDir = dirnameOf(path);
    // 狭い画面では、開いたら中身に場所を譲る
    if (window.innerWidth < 600) this.treeCollapsed = true;
    this.render();
  }

  private startCreate(kind: "file" | "dir"): void {
    if (this.activeDir) {
      this.expanded.add(this.activeDir);
      if (!this.dirs.has(this.activeDir)) void this.loadDir(this.activeDir);
    }
    this.draft = { parent: this.activeDir, kind, name: "", committing: false };
    this.renderTree();
  }

  private async commitDraft(name: string): Promise<void> {
    const draft = this.draft;
    if (!draft || draft.committing) return;
    const trimmed = name.trim();
    if (!trimmed) {
      this.draft = null;
      this.renderTree();
      return;
    }
    if (trimmed.includes("/") || trimmed === "." || trimmed === "..") {
      toast("その名前は使えません", { description: "「/」を含まない名前にしてください", error: true });
      return;
    }
    const siblings = this.dirs.get(draft.parent)?.entries ?? [];
    if (siblings.some((e) => e.name === trimmed)) {
      toast("同じ名前があります", { description: `${joinPath(draft.parent, trimmed)} はもうあります`, error: true });
      return;
    }
    draft.committing = true;
    const path = joinPath(draft.parent, trimmed);
    try {
      if (draft.kind === "file") await callTool("writeFile", { path, content: "" });
      else await callTool("createDirectory", { path });
    } catch (err) {
      draft.committing = false;
      toast(draft.kind === "file" ? "ファイルを作れませんでした" : "フォルダを作れませんでした", {
        description: errorMessage(err),
        error: true,
      });
      return;
    }
    this.draft = null;
    await this.loadDir(draft.parent);
    if (draft.kind === "file") {
      if (!this.guardUnsaved()) return;
      this.multi = null;
      this.openFile = path;
      this.anchor = path;
      this.activeDir = draft.parent;
      this.render();
    } else {
      this.expanded.add(path);
      this.activeDir = path;
      await this.loadDir(path);
    }
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    this.renderTree();
    const keys = [...this.dirs.keys()].filter((k) => k === "" || this.expanded.has(k));
    await Promise.all(keys.map((k) => this.loadDir(k)));
    this.viewer?.reload();
    this.sizes.clear();
    this.refreshing = false;
    this.render();
    toast("最新の状態に更新しました");
  }

  private upload(): void {
    const target = this.activeDir;
    const existing = new Set((this.dirs.get(target)?.entries ?? []).filter((e) => e.type === "file").map((e) => e.name));
    openUploadDialog({
      targetLabel: target || "（ルート）",
      existingNames: existing,
      upload: async (files) => {
        let done = 0;
        try {
          for (const file of files) {
            const data = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
            await callTool("uploadFile", { path: joinPath(target, file.name), data });
            done++;
          }
        } catch (err) {
          throw new Error(`${files[done]?.name ?? ""}：${errorMessage(err)}（${done} 件は置けました）`);
        } finally {
          if (target) this.expanded.add(target);
          await this.loadDir(target);
          if (this.openFile && files.some((f) => joinPath(target, f.name) === this.openFile)) this.viewer?.reload();
        }
        toast(`${files.length} 件のファイルをアップロードしました`, {
          description: target ? `${target}/ に追加しました` : "ルートに追加しました",
        });
      },
    });
  }

  private async download(): Promise<void> {
    const paths = this.selectedPaths();
    if (paths.length === 0) return;
    try {
      if (paths.length === 1) {
        const path = paths[0]!;
        const block = (await callTool("readFile", { path })).content?.[0];
        if (block?.type === "text") {
          await downloadViaHost(`file:///${path}`, "text/plain;charset=utf-8", bytesToBase64(new TextEncoder().encode(block.text ?? "")));
        } else if (block?.type === "image" && block.data) {
          await downloadViaHost(`file:///${path}`, block.mimeType ?? "application/octet-stream", block.data);
        } else if (block?.type === "resource" && block.resource?.blob) {
          await downloadViaHost(`file:///${path}`, block.resource.mimeType ?? "application/octet-stream", block.resource.blob);
        } else {
          throw new Error("中身を読み取れませんでした");
        }
        toast(`${path} をダウンロードしました`);
        return;
      }
      const zip = (await callTool("downloadFiles", { paths })).content?.[0];
      if (zip?.type !== "resource" || !zip.resource?.blob) throw new Error("ZIP を作れませんでした");
      await downloadViaHost(zip.resource.uri, "application/zip", zip.resource.blob);
      toast(`${paths.length} 件を ${zip.resource.uri.split("/").pop() ?? "ZIP"} としてまとめてダウンロードしました`);
    } catch (err) {
      toast("ダウンロードできませんでした", { description: errorMessage(err), error: true });
    }
  }

  // ======================================================================
  // 描画
  // ======================================================================

  private treeBody: HTMLElement | null = null;
  private treeFoot: HTMLElement | null = null;
  private refreshButton: HTMLElement | null = null;

  render(): void {
    document.body.dataset.mode = this.displayMode;
    if (this.displayMode !== "fullscreen") {
      this.renderInline();
      return;
    }
    const content = h("main", { class: "content" });
    this.renderContent(content);
    replaceChildren(
      this.root,
      h(
        "div",
        { class: "browser", data: { testid: "file-browser" } },
        h("div", { class: "panes" }, this.treeCollapsed ? this.renderRail() : this.renderTreePane(), content),
        h("footer", { class: "hint", text: "Ctrl/Cmd+クリックで複数選択、Shift+クリックで範囲選択" }),
      ),
    );
  }

  private renderRail(): HTMLElement {
    this.treeBody = null;
    this.treeFoot = null;
    return h(
      "aside",
      { class: "tree-rail" },
      h(
        "button",
        {
          class: "icon-btn",
          title: "フォルダツリーを開く",
          attrs: { type: "button", "aria-label": "フォルダツリーを開く" },
          on: {
            click: () => {
              this.treeCollapsed = false;
              this.render();
            },
          },
        },
        icon("PanelLeftOpen", "icon-md"),
      ),
    );
  }

  private toolButton(name: IconName, label: string, onClick: () => void, spin = false): HTMLElement {
    return h(
      "button",
      { class: "icon-btn", title: label, attrs: { type: "button", "aria-label": label }, on: { click: onClick } },
      icon(name, spin ? "icon spin" : "icon"),
    );
  }

  private renderTreePane(): HTMLElement {
    this.treeBody = h("div", { class: "tree-body", attrs: { role: "tree", "aria-label": "フォルダツリー" } });
    this.treeFoot = h("div", { class: "tree-foot" });
    this.refreshButton = h("span", {});
    const pane = h(
      "aside",
      { class: "tree" },
      h(
        "div",
        { class: "tree-head" },
        h(
          "button",
          {
            class: "icon-btn strong",
            title: "フォルダツリーを畳む",
            attrs: { type: "button", "aria-label": "フォルダツリーを畳む" },
            on: {
              click: () => {
                this.treeCollapsed = true;
                this.render();
              },
            },
          },
          icon("PanelLeftClose"),
        ),
        // 省略は左から——「どのフォルダにいるか」（末尾側）が大事。枠は右から左（rtl）に
        // 並べて左端を切り、**中の文字は左から右に固定する**——そうしないと先頭の `~/` が
        // 向きを持たない文字として右端へ回り、`worktrees/banto/~` と読めてしまう（実機で発覚）
        h(
          "span",
          { class: "root-path truncate", title: this.rootLabel, data: { testid: "root-path" } },
          h("bdi", { text: this.rootLabel, attrs: { dir: "ltr" } }),
        ),
        h(
          "div",
          { class: "tree-tools" },
          this.toolButton("FilePlus2", "新しいファイル", () => this.startCreate("file")),
          this.toolButton("FolderPlus", "新しいフォルダ", () => this.startCreate("dir")),
          this.refreshButton,
          this.toolButton("FoldVertical", "すべて折りたたむ", () => {
            this.expanded.clear();
            this.renderTree();
          }),
        ),
      ),
      this.treeBody,
      this.treeFoot,
    );
    this.renderTree();
    return pane;
  }

  /** ツリーだけを描き直す（中身のペインは触らない——編集中の内容を失わない）。 */
  private renderTree(): void {
    if (!this.treeBody || !this.treeFoot) return;
    if (this.refreshButton) {
      const button = this.toolButton("RefreshCw", "更新", () => void this.refresh(), this.refreshing);
      this.refreshButton.replaceWith(button);
      this.refreshButton = button;
    }
    const selected = new Set(this.selectedPaths());
    const rows = this.visibleRows().map((row) => this.renderRow(row, selected));
    replaceChildren(this.treeBody, ...rows);
    const focusDraft = this.treeBody.querySelector<HTMLInputElement>("input.draft-input");
    focusDraft?.focus();

    const count = selected.size;
    replaceChildren(
      this.treeFoot,
      h(
        "div",
        { class: this.canDownload ? "foot-grid" : "foot-grid single" },
        h(
          "button",
          { class: "btn foot-btn", attrs: { type: "button" }, data: { testid: "upload-open" }, on: { click: () => this.upload() } },
          icon("UploadCloud", "icon-md"),
          h("span", { text: "アップロード" }),
        ),
        // host がダウンロードを受けないなら、押せるように見せない（規則13）
        this.canDownload
          ? h(
              "button",
              {
                class: "btn foot-btn",
                attrs: { type: "button", ...(count === 0 ? { disabled: "" } : {}) },
                data: { testid: "download" },
                on: { click: () => void this.download() },
              },
              icon("Download", "icon-md"),
              h("span", { text: count > 1 ? `ZIP（${count}）` : "ダウンロード" }),
            )
          : null,
      ),
    );
  }

  private renderRow(row: TreeRow, selected: ReadonlySet<string>): HTMLElement {
    const indent = `${6 + row.depth * 14}px`;
    if (row.kind === "note") {
      const note = h("div", { class: row.error ? "row-note error" : "row-note", text: row.text });
      note.style.paddingLeft = `${6 + row.depth * 14 + 18}px`;
      return note;
    }
    if (row.kind === "draft") {
      const kind = this.draft?.kind ?? "file";
      const input = h("input", {
        class: "draft-input",
        attrs: { placeholder: kind === "dir" ? "フォルダ名" : "ファイル名", "aria-label": kind === "dir" ? "新しいフォルダの名前" : "新しいファイルの名前" },
        data: { testid: "draft-input" },
      });
      input.value = this.draft?.name ?? "";
      // 描き直しで入れ物が替わっても、打った名前は残す
      input.addEventListener("input", () => {
        if (this.draft) this.draft.name = input.value;
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") void this.commitDraft(input.value);
        if (event.key === "Escape") {
          this.draft = null;
          this.renderTree();
        }
      });
      input.addEventListener("blur", () => {
        // **描き直しで外されたときの blur では決めない**——打ちかけの名前で作ってしまう。
        // 人が別の場所を押して離れたときだけ、VSCode と同じく確定する
        if (!input.isConnected) return;
        if (this.draft && !this.draft.committing) void this.commitDraft(input.value);
      });
      const el = h("div", { class: "row" }, h("span", { class: "spacer" }), icon(kind === "dir" ? "Folder" : "File", "icon kind"), input);
      el.style.paddingLeft = indent;
      return el;
    }
    const { entry, path } = row;
    const isDir = entry.type === "directory";
    const open = isDir && this.expanded.has(path);
    const classes = ["row", isDir ? "dir" : "file"];
    if (!isDir && selected.has(path)) classes.push("selected");
    if (isDir && this.activeDir === path) classes.push("active");
    const el = h(
      "div",
      {
        class: classes.join(" "),
        title: path,
        attrs: {
          role: "treeitem",
          tabindex: "0",
          ...(isDir ? { "aria-expanded": String(open) } : { "aria-selected": String(selected.has(path)) }),
        },
        data: { path, kind: isDir ? "directory" : "file" },
        on: {
          click: (event) => this.onEntryClick(row, event),
          keydown: (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              this.onEntryClick(row, event);
            }
          },
        },
      },
      isDir ? icon(open ? "ChevronDown" : "ChevronRight", "chev") : h("span", { class: "spacer" }),
      isDir ? icon(open ? "FolderOpen" : "Folder", "icon kind") : icon(FILE_ICON[iconKindFor(entry.name)], "icon kind"),
      h("span", { class: "name truncate", text: entry.name }),
    );
    el.style.paddingLeft = indent;
    return el;
  }

  private renderContent(content: HTMLElement): void {
    const selected = this.selectedPaths();
    if (selected.length !== 1) this.viewer = null;
    if (selected.length === 0) {
      replaceChildren(
        content,
        h("div", { class: "empty" }, icon("File", "icon-xl"), h("p", { text: "ファイルを選択すると、ここに内容が表示されます" })),
      );
      return;
    }
    if (selected.length === 1) {
      const path = selected[0]!;
      if (!this.viewer || this.viewer.path !== path) this.viewer = new FileViewer(path);
      replaceChildren(
        content,
        h("div", { class: "content-head" }, h("span", { class: "badge truncate", text: path, data: { testid: "open-path" } })),
        h("div", { class: "content-body" }, this.viewer.el),
      );
      return;
    }
    // 複数選択——並べて、大きさを添える（ZIP にする前に何が入るか分かるように）
    for (const path of selected) {
      if (!this.sizes.has(path)) {
        this.sizes.set(path, -1);
        void callTool("getFileInfo", { path })
          .then((r) => this.sizes.set(path, (JSON.parse(textOf(r)) as { size: number }).size))
          .catch(() => this.sizes.set(path, "error"))
          .then(() => this.render());
      }
    }
    const sizeText = (path: string) => {
      const s = this.sizes.get(path);
      return s === undefined || s === -1 ? "…" : s === "error" ? "読めません" : formatBytes(s);
    };
    replaceChildren(
      content,
      h(
        "div",
        { class: "summary", data: { testid: "multi-summary" } },
        h("p", { class: "summary-title", text: `${selected.length} 件を選択中` }),
        h(
          "div",
          { class: "summary-list" },
          ...selected.map((path) =>
            h(
              "div",
              { class: "summary-row" },
              icon("File", "icon muted"),
              h("span", { class: "path truncate", text: path }),
              h("span", { class: "size", text: sizeText(path) }),
            ),
          ),
        ),
        this.canDownload ? h("p", { class: "summary-note", text: "左下の「ZIP」でまとめてダウンロードできます" }) : null,
      ),
    );
  }

  // ======================================================================
  // 会話の中（inline）
  // ======================================================================

  private async askFullscreen(): Promise<void> {
    try {
      const mode = await requestDisplayMode("fullscreen");
      if (mode !== "fullscreen") {
        this.inlineNote = `大きく表示できませんでした（いまは ${mode ?? "不明"}）`;
        this.inlineError = true;
        this.render();
      }
    } catch (err) {
      this.inlineNote = errorMessage(err);
      this.inlineError = true;
      this.render();
    }
  }

  private async reloadInline(): Promise<void> {
    this.inlineNote = "読み込んでいます…";
    this.inlineError = false;
    this.render();
    try {
      this.setToolResult(await callTool("listDirectory", { path: this.inlinePath }));
    } catch (err) {
      this.inlineNote = errorMessage(err);
      this.inlineError = true;
      this.render();
    }
  }

  private renderInline(): void {
    const entries = this.inlineEntries;
    replaceChildren(
      this.root,
      h(
        "div",
        { class: "inline-card", data: { testid: "file-list-inline" } },
        h("p", { class: "inline-head" }, icon("FolderOpen", "icon muted"), h("span", { class: "truncate", text: `ディレクトリ: ${this.inlinePath}` })),
        entries
          ? h(
              "ul",
              { class: "inline-list" },
              ...entries.map((e) =>
                h(
                  "li",
                  { class: e.type === "directory" ? "dir" : "file" },
                  icon(e.type === "directory" ? "Folder" : FILE_ICON[iconKindFor(e.name)]),
                  h("span", { class: "truncate", text: e.name }),
                ),
              ),
            )
          : null,
        h(
          "div",
          { class: "inline-actions" },
          h("button", { class: "btn", attrs: { type: "button" }, on: { click: () => void this.reloadInline() } }, icon("RefreshCw"), "この場所を読み直す"),
          h("button", { class: "btn", attrs: { type: "button" }, on: { click: () => void this.askFullscreen() } }, icon("Maximize2"), "大きく表示"),
        ),
        this.inlineNote ? h("p", { class: this.inlineError ? "note error" : "note", text: this.inlineNote }) : null,
      ),
    );
    reportSize();
  }
}
