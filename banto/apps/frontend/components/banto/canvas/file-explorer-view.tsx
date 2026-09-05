"use client";

// FileSystem Module の launcher（§6.2「人が、AI を介さずに面を開く」）が開く
// 面——banto.fs:browser。VSCode のエクスプローラを参考にした2ペイン構成
// （左：フォルダツリー、右：選択中のファイルの中身）。ダウンロード・
// アップロードは Module 自身の tool（v4-modules.md §2.2）が持つ機能の
// UI 側の再現で、実データの読み書きはしない（モック段の目的はUIを固めること、
// `mock/README.md`）。
import { useMemo, useRef, useState, type ChangeEvent, type DragEvent, type MouseEvent } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ChevronDown,
  ChevronRight,
  Download,
  File,
  FileCode2,
  FileImage,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FoldVertical,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  UploadCloud,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { FileContentViewer, getFileSource } from "./file-preview";

interface FsFileNode {
  kind: "file";
  name: string;
  path: string;
  size: string;
}
interface FsDirNode {
  kind: "dir";
  name: string;
  path: string;
  children: FsNode[];
}
type FsNode = FsFileNode | FsDirNode;

const INITIAL_TREE: readonly FsNode[] = [
  {
    kind: "dir",
    name: "lib",
    path: "lib",
    children: [
      {
        kind: "dir",
        name: "mock",
        path: "lib/mock",
        children: [
          { kind: "file", name: "thread-panel.tsx", path: "lib/mock/thread-panel.tsx", size: "4.1 KB" },
          { kind: "file", name: "adapter.ts", path: "lib/mock/adapter.ts", size: "6.8 KB" },
          { kind: "file", name: "settings.ts", path: "lib/mock/settings.ts", size: "5.2 KB" },
        ],
      },
    ],
  },
  {
    kind: "dir",
    name: "docs",
    path: "docs",
    children: [
      { kind: "file", name: "README.md", path: "docs/README.md", size: "1.8 KB" },
      { kind: "file", name: "spec.pdf", path: "docs/spec.pdf", size: "412 KB" },
      { kind: "file", name: "budget.csv", path: "docs/budget.csv", size: "0.1 KB" },
      {
        kind: "dir",
        name: "notes",
        path: "docs/notes",
        children: [
          { kind: "file", name: "2026-08-30-poc.md", path: "docs/notes/2026-08-30-poc.md", size: "0.9 KB" },
        ],
      },
    ],
  },
  {
    kind: "dir",
    name: "public",
    path: "public",
    children: [
      { kind: "file", name: "index.html", path: "public/index.html", size: "0.6 KB" },
      { kind: "file", name: "logo.png", path: "public/logo.png", size: "128 KB" },
    ],
  },
];

// 対応表を増やすときはここに1行足すだけでよい（v4-modules.md §2.2 と同じ考え方）
const FILE_ICON_BY_EXT: Readonly<Record<string, "code" | "text" | "image">> = {
  ts: "code",
  tsx: "code",
  js: "code",
  jsx: "code",
  html: "code",
  htm: "code",
  md: "text",
  pdf: "text",
  csv: "text",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
};

// react-hooks/static-components——コンポーネントの型そのものを変数に入れて
// `<Icon />` の形でレンダーすると「レンダー中にコンポーネントを作っている」と
// 誤検知されるので、要素を直接分岐で返す（型を変数に持ち回さない）
function FileIcon({ name, className }: { name: string; className: string }) {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  switch (FILE_ICON_BY_EXT[ext]) {
    case "code":
      return <FileCode2 className={className} />;
    case "text":
      return <FileText className={className} />;
    case "image":
      return <FileImage className={className} />;
    default:
      return <File className={className} />;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface FlatRow {
  node: FsNode;
  depth: number;
}

function flattenVisible(nodes: readonly FsNode[], depth: number, expanded: ReadonlySet<string>): FlatRow[] {
  const out: FlatRow[] = [];
  for (const node of nodes) {
    out.push({ node, depth });
    if (node.kind === "dir" && expanded.has(node.path)) {
      out.push(...flattenVisible(node.children, depth + 1, expanded));
    }
  }
  return out;
}

function collectFiles(nodes: readonly FsNode[], out: Map<string, FsFileNode>): Map<string, FsFileNode> {
  for (const node of nodes) {
    if (node.kind === "file") out.set(node.path, node);
    else collectFiles(node.children, out);
  }
  return out;
}

/** "docs/notes/a.md" → ["docs", "docs/notes"]——展開すべき祖先フォルダの一覧 */
function ancestorsOf(path: string): string[] {
  const parts = path.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

const BASE_EXPANDED: readonly string[] = ["lib", "lib/mock", "docs", "public"];

/** 不変更新——targetPath 直下（""はルート）に newNodes を追加する */
function insertNodes(nodes: readonly FsNode[], targetPath: string, newNodes: readonly FsNode[]): FsNode[] {
  if (targetPath === "") return [...nodes, ...newNodes];
  return nodes.map((node) => {
    if (node.kind !== "dir") return node;
    if (node.path === targetPath) return { ...node, children: [...node.children, ...newNodes] };
    if (targetPath === node.path || targetPath.startsWith(`${node.path}/`)) {
      return { ...node, children: insertNodes(node.children, targetPath, newNodes) };
    }
    return node;
  });
}

function TreeRow({
  node,
  depth,
  expanded,
  selected,
  active,
  onClick,
}: {
  node: FsNode;
  depth: number;
  expanded: boolean;
  selected: boolean;
  active: boolean;
  onClick: (e: MouseEvent) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      className={cn(
        "flex select-none items-center gap-1 rounded-md px-1.5 py-1 text-sm",
        selected ? "bg-accent text-accent-ink" : active ? "bg-surface-2" : "hover:bg-accent",
      )}
      style={{ paddingLeft: 6 + depth * 14 }}
    >
      {node.kind === "dir" ? (
        expanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-ink-3" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-ink-3" />
        )
      ) : (
        <span className="size-3.5 shrink-0" />
      )}
      {node.kind === "dir" ? (
        expanded ? (
          <FolderOpen className="size-3.5 shrink-0 text-ink-3" />
        ) : (
          <Folder className="size-3.5 shrink-0 text-ink-3" />
        )
      ) : (
        <FileIcon name={node.name} className="size-3.5 shrink-0 text-ink-3" />
      )}
      <span className={cn("truncate", node.kind === "dir" && "text-foreground")}>{node.name}</span>
    </div>
  );
}

/** VSCode の「新規ファイル/フォルダ」と同じ、その場に出るインライン入力行 */
function DraftRow({
  depth,
  kind,
  name,
  onNameChange,
  onCommit,
  onCancel,
}: {
  depth: number;
  kind: "file" | "dir";
  name: string;
  onNameChange: (name: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="flex items-center gap-1 rounded-md px-1.5 py-1 text-sm"
      style={{ paddingLeft: 6 + depth * 14 }}
    >
      <span className="size-3.5 shrink-0" />
      {kind === "dir" ? (
        <Folder className="size-3.5 shrink-0 text-ink-3" />
      ) : (
        <File className="size-3.5 shrink-0 text-ink-3" />
      )}
      <input
        autoFocus
        value={name}
        placeholder={kind === "dir" ? "フォルダ名" : "ファイル名"}
        onChange={(e) => onNameChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit();
          if (e.key === "Escape") onCancel();
        }}
        onBlur={onCommit}
        className="min-w-0 flex-1 rounded-sm border border-accent-ink bg-surface px-1 text-sm text-foreground outline-none"
      />
    </div>
  );
}

function EmptyContentState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 text-ink-3">
      <File className="size-8" />
      <p className="text-sm">ファイルを選択すると、ここに内容が表示されます</p>
    </div>
  );
}

function MultiSelectSummary({ files }: { files: readonly FsFileNode[] }) {
  return (
    <div className="flex h-full flex-col overflow-auto p-4">
      <p className="mb-3 text-sm font-medium text-foreground">{files.length} 件を選択中</p>
      <div className="flex flex-col divide-y divide-border rounded-md border border-border bg-surface">
        {files.map((f) => (
          <div key={f.path} className="flex items-center gap-2 px-3 py-2 text-sm">
            <File className="size-3.5 shrink-0 text-ink-3" />
            <span className="min-w-0 flex-1 truncate text-ink-2">{f.path}</span>
            <span className="shrink-0 text-xs text-ink-3">{f.size}</span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-ink-3">上のツールバーの「ZIPでダウンロード」でまとめて取得できます</p>
    </div>
  );
}

function UploadDialog({
  open,
  onOpenChange,
  targetLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetLabel: string;
  onConfirm: (files: File[]) => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    setFiles((prev) => {
      const names = new Set(prev.map((f) => f.name));
      return [...prev, ...Array.from(list).filter((f) => !names.has(f.name))];
    });
  }

  function handleConfirm() {
    if (files.length === 0 || uploading) return;
    setUploading(true);
    // 実バックエンドが無いモックなので、アップロード中の見た目だけ再現する
    setTimeout(() => {
      onConfirm(files);
      setUploading(false);
      setFiles([]);
    }, 500);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (uploading) return;
        onOpenChange(next);
        if (!next) setFiles([]);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>ファイルをアップロード</DialogTitle>
          <DialogDescription>アップロード先：{targetLabel}</DialogDescription>
        </DialogHeader>
        <div
          role="button"
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e: DragEvent) => e.preventDefault()}
          onDrop={(e: DragEvent) => {
            e.preventDefault();
            addFiles(e.dataTransfer.files);
          }}
          className="flex flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-border bg-surface-2 px-4 py-8 text-center text-sm text-ink-3 hover:bg-accent"
        >
          <UploadCloud className="size-6" />
          <span>ここにファイルをドラッグ、またはクリックして選択</span>
          <span className="text-xs">複数ファイルをまとめて選べます</span>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e: ChangeEvent<HTMLInputElement>) => addFiles(e.target.files)}
        />
        {files.length > 0 ? (
          <div className="flex max-h-40 flex-col divide-y divide-border overflow-auto rounded-md border border-border">
            {files.map((f, i) => (
              <div key={`${f.name}:${i}`} className="flex items-center gap-2 px-2.5 py-1.5 text-sm">
                <File className="size-3.5 shrink-0 text-ink-3" />
                <span className="min-w-0 flex-1 truncate text-ink-2">{f.name}</span>
                <span className="shrink-0 text-xs text-ink-3">{formatBytes(f.size)}</span>
                <button
                  type="button"
                  onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                  className="shrink-0 text-ink-3 hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={uploading}>
            キャンセル
          </Button>
          <Button onClick={handleConfirm} disabled={files.length === 0 || uploading}>
            {uploading ? <Loader2 className="size-3.5 animate-spin" /> : null}
            アップロード{files.length > 0 ? `（${files.length}件）` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function FileExplorerView({
  initialPath,
  initialCollapsed = false,
}: {
  /** tool 呼び出し（fullscreenView）経由——viewId に焼き込まれたパス。Command
   * Palette 経由は fsFile クエリパラメータを使うので、こちらは無くてもよい */
  initialPath?: string;
  initialCollapsed?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const urlFile = searchParams.get("fsFile") ?? initialPath ?? null;
  const urlDir = searchParams.get("fsDir");
  // 「フォルダツリーを畳んだ状態で開く」は初期値だけの話（レイアウトの好みで
  // あって、ナビゲーションではない）——以後トグルしても URL には残さない
  const [treeCollapsed, setTreeCollapsed] = useState(
    () => searchParams.get("fsCollapsed") === "1" || initialCollapsed,
  );

  const [tree, setTree] = useState<readonly FsNode[]>(INITIAL_TREE);
  // 手動で開閉したフォルダ。「いま選ばれているファイル/フォルダの祖先」は
  // これとは別に毎レンダー合成する（下記 expanded）——ブラウザの戻る/進むで
  // fsFile・fsDir が変わったときも、useEffect でstateを追いかけ直すのではなく
  // 描画のたびに導出するだけで自然に追従する（react-hooks/set-state-in-effect）
  const [manualExpanded, setManualExpanded] = useState<Set<string>>(new Set(BASE_EXPANDED));
  // ctrl/shift による複数選択の一時状態。null のときは urlFile 側（＝いま
  // 開いているファイル1件）が選択そのものになる
  const [multiSelected, setMultiSelected] = useState<Set<string> | null>(null);
  const [anchorPath, setAnchorPath] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [draft, setDraft] = useState<{ parentPath: string; kind: "file" | "dir" } | null>(null);
  const [draftName, setDraftName] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const activeDirPath = urlDir ?? (urlFile ? dirnameOf(urlFile) : "");
  const effectiveAnchor = anchorPath ?? urlFile;

  const expanded = useMemo(() => {
    const next = new Set(manualExpanded);
    for (const a of ancestorsOf(urlFile ?? urlDir ?? "")) next.add(a);
    return next;
  }, [manualExpanded, urlFile, urlDir]);

  const selected = useMemo(
    () => multiSelected ?? new Set(urlFile ? [urlFile] : []),
    [multiSelected, urlFile],
  );

  const flat = useMemo(() => flattenVisible(tree, 0, expanded), [tree, expanded]);
  const filesByPath = useMemo(() => collectFiles(tree, new Map()), [tree]);
  const selectedFiles = useMemo(
    () => [...selected].map((p) => filesByPath.get(p)).filter((f): f is FsFileNode => f !== undefined),
    [selected, filesByPath],
  );

  // 新規作成中の行を、対象フォルダの直後（ルートなら先頭）に差し込む
  type TreeRowEntry = { kind: "node"; node: FsNode; depth: number } | { kind: "draft"; depth: number };
  const treeRows = useMemo<TreeRowEntry[]>(() => {
    if (!draft) return flat.map((r) => ({ kind: "node", node: r.node, depth: r.depth }));
    const depthByPath = new Map(flat.map((r) => [r.node.path, r.depth]));
    const draftDepth = draft.parentPath === "" ? 0 : (depthByPath.get(draft.parentPath) ?? 0) + 1;
    const rows: TreeRowEntry[] = [];
    if (draft.parentPath === "") rows.push({ kind: "draft", depth: draftDepth });
    for (const r of flat) {
      rows.push({ kind: "node", node: r.node, depth: r.depth });
      if (draft.parentPath !== "" && r.node.path === draft.parentPath) {
        rows.push({ kind: "draft", depth: draftDepth });
      }
    }
    return rows;
  }, [flat, draft]);

  function toggleExpand(path: string) {
    setManualExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  /** 実際の画面遷移——router.push なので履歴に残り、戻る/進むが効く */
  function navigate(next: { file?: string; dir?: string }) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("canvas", "banto.fs:browser");
    params.set("fullscreen", "1");
    // 一度でも自分でナビゲートしたら「直接開いたときだけ畳む」既定は役目を終える
    params.delete("fsCollapsed");
    if (next.file) {
      params.set("fsFile", next.file);
      params.delete("fsDir");
    } else {
      params.delete("fsFile");
      if (next.dir) params.set("fsDir", next.dir);
      else params.delete("fsDir");
    }
    router.push(`${pathname}?${params.toString()}`);
  }

  function handleRowClick(node: FsNode, e: MouseEvent) {
    if (node.kind === "dir") {
      toggleExpand(node.path);
      setMultiSelected(null);
      navigate({ dir: node.path });
      return;
    }
    if (e.shiftKey && effectiveAnchor) {
      const files = flat.filter((r) => r.node.kind === "file");
      const idxA = files.findIndex((r) => r.node.path === effectiveAnchor);
      const idxB = files.findIndex((r) => r.node.path === node.path);
      if (idxA !== -1 && idxB !== -1) {
        const [lo, hi] = idxA < idxB ? [idxA, idxB] : [idxB, idxA];
        setMultiSelected(new Set(files.slice(lo, hi + 1).map((r) => r.node.path)));
        return;
      }
    }
    if (e.metaKey || e.ctrlKey) {
      // 複数選択はまとめてダウンロードするための一時的な状態——1件ずつの
      // 「開く」操作ではないので、これ自体は履歴に積まない
      setMultiSelected((prev) => {
        const next = new Set(prev ?? selected);
        if (next.has(node.path)) next.delete(node.path);
        else next.add(node.path);
        return next;
      });
      setAnchorPath(node.path);
      return;
    }
    setMultiSelected(null);
    navigate({ file: node.path });
  }

  function startCreate(kind: "file" | "dir") {
    if (activeDirPath) setManualExpanded((prev) => new Set(prev).add(activeDirPath));
    setDraft({ parentPath: activeDirPath, kind });
    setDraftName("");
  }

  function cancelDraft() {
    setDraft(null);
    setDraftName("");
  }

  function commitDraft() {
    if (!draft) return;
    const name = draftName.trim();
    if (!name) {
      cancelDraft();
      return;
    }
    const path = draft.parentPath ? `${draft.parentPath}/${name}` : name;
    const newNode: FsNode =
      draft.kind === "file"
        ? { kind: "file", name, path, size: "0 B" }
        : { kind: "dir", name, path, children: [] };
    setTree((prev) => insertNodes(prev, draft.parentPath, [newNode]));
    cancelDraft();
    if (draft.kind === "file") {
      navigate({ file: path });
    } else {
      setManualExpanded((prev) => new Set(prev).add(path));
      navigate({ dir: path });
    }
  }

  function handleRefresh() {
    setRefreshing(true);
    // 実バックエンドが無いモックなので、更新中の見た目だけ再現する
    setTimeout(() => {
      setRefreshing(false);
      toast("最新の状態に更新しました");
    }, 500);
  }

  function handleCollapseAll() {
    setManualExpanded(new Set());
  }

  function handleUploadConfirm(files: File[]) {
    const prefix = activeDirPath ? `${activeDirPath}/` : "";
    const newFiles: FsFileNode[] = files.map((f) => ({
      kind: "file",
      name: f.name,
      path: `${prefix}${f.name}`,
      size: formatBytes(f.size),
    }));
    setTree((prev) => insertNodes(prev, activeDirPath, newFiles));
    if (activeDirPath) setManualExpanded((prev) => new Set(prev).add(activeDirPath));
    setUploadOpen(false);
    toast(`${files.length} 件のファイルをアップロードしました`, {
      description: activeDirPath ? `${activeDirPath}/ に追加しました` : "ルートに追加しました",
    });
  }

  function handleDownload() {
    const paths = [...selected];
    if (paths.length === 0) return;
    if (paths.length === 1) {
      const path = paths[0];
      const source = getFileSource(path);
      if (source) {
        const blob = new Blob([source], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = path.split("/").pop() ?? "download.txt";
        a.click();
        URL.revokeObjectURL(url);
        toast(`${path} をダウンロードしました`);
      } else {
        toast(`${path} をダウンロードしました`, { description: "モックのため実データはありません" });
      }
      return;
    }
    toast(`${paths.length} 件を banto-files.zip としてまとめてダウンロードします`, {
      description: "モックのため実際の ZIP 生成は行っていません",
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1">
        {treeCollapsed ? (
          <div className="flex w-10 shrink-0 flex-col items-center gap-2 border-r border-border bg-surface-2 py-2">
            <button
              type="button"
              onClick={() => setTreeCollapsed(false)}
              title="フォルダツリーを開く"
              aria-label="フォルダツリーを開く"
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-accent"
            >
              <PanelLeftOpen className="size-4" />
            </button>
          </div>
        ) : (
          <div className="flex w-72 shrink-0 flex-col border-r border-border">
            <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-2">
              <button
                type="button"
                onClick={() => setTreeCollapsed(true)}
                title="フォルダツリーを畳む"
                aria-label="フォルダツリーを畳む"
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-accent"
              >
                <PanelLeftClose className="size-3.5" />
              </button>
              {/* 省略は右からではなく左から——「どのフォルダにいるか」（末尾側）が
                  優先。dir="rtl" は見た目の省略位置を反転させるための定型技で、
                  中身の文字順は変えない（パス区切りの向きに影響しない） */}
              <span
                dir="rtl"
                className="min-w-0 flex-1 truncate text-left font-mono text-xs text-ink-2"
              >
                ~/worktrees/banto-v4/mock
              </span>
              {/* VSCode のエクスプローラ右上と同じ並び：新規ファイル・新規フォルダ・
                  更新・すべて折りたたむ */}
              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => startCreate("file")}
                  title="新しいファイル"
                  aria-label="新しいファイル"
                  className="flex size-6 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-accent hover:text-foreground"
                >
                  <FilePlus2 className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => startCreate("dir")}
                  title="新しいフォルダ"
                  aria-label="新しいフォルダ"
                  className="flex size-6 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-accent hover:text-foreground"
                >
                  <FolderPlus className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={handleRefresh}
                  title="更新"
                  aria-label="更新"
                  className="flex size-6 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-accent hover:text-foreground"
                >
                  <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
                </button>
                <button
                  type="button"
                  onClick={handleCollapseAll}
                  title="すべて折りたたむ"
                  aria-label="すべて折りたたむ"
                  className="flex size-6 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-accent hover:text-foreground"
                >
                  <FoldVertical className="size-3.5" />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-1.5">
              {treeRows.map((row, i) =>
                row.kind === "draft" ? (
                  <DraftRow
                    key={`draft-${i}`}
                    depth={row.depth}
                    kind={draft!.kind}
                    name={draftName}
                    onNameChange={setDraftName}
                    onCommit={commitDraft}
                    onCancel={cancelDraft}
                  />
                ) : (
                  <TreeRow
                    key={row.node.path}
                    node={row.node}
                    depth={row.depth}
                    expanded={row.node.kind === "dir" && expanded.has(row.node.path)}
                    selected={row.node.kind === "file" && selected.has(row.node.path)}
                    active={row.node.kind === "dir" && activeDirPath === row.node.path}
                    onClick={(e) => handleRowClick(row.node, e)}
                  />
                ),
              )}
            </div>
            {/* ダウンロード/アップロードはツリーの一番下——1・2ペインどちらでも
                同じ場所にあるほうが手が覚える（VSCode のステータスバー相当の置き場） */}
            <div className="shrink-0 border-t border-border bg-gradient-to-b from-surface to-surface-2 p-2">
              <div className="grid grid-cols-2 gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-auto flex-col gap-1 py-2"
                  onClick={() => setUploadOpen(true)}
                >
                  <UploadCloud className="size-4" />
                  <span className="text-xs">アップロード</span>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-auto flex-col gap-1 py-2"
                  disabled={selected.size === 0}
                  onClick={handleDownload}
                >
                  <Download className="size-4" />
                  <span className="text-xs">{selected.size > 1 ? `ZIP（${selected.size}）` : "ダウンロード"}</span>
                </Button>
              </div>
            </div>
          </div>
        )}
        <div className="min-h-0 min-w-0 flex-1">
          {selectedFiles.length === 0 ? (
            <EmptyContentState />
          ) : selectedFiles.length === 1 ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
                <Badge variant="outline" className="font-mono text-xs">
                  {selectedFiles[0].path}
                </Badge>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                <FileContentViewer key={selectedFiles[0].path} path={selectedFiles[0].path} />
              </div>
            </div>
          ) : (
            <MultiSelectSummary files={selectedFiles} />
          )}
        </div>
      </div>
      <div className="shrink-0 border-t border-border px-4 py-2.5 text-xs text-ink-3">
        FileSystem Module が描くファイルブラウザ——Ctrl/Cmd+クリックで複数選択、Shift+クリックで範囲選択
      </div>
      <UploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        targetLabel={activeDirPath || "（ルート）"}
        onConfirm={handleUploadConfirm}
      />
    </div>
  );
}
