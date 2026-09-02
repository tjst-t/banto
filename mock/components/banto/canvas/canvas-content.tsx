"use client";

// Canvas の中身は Module が描く（§6.2「Module は『どんな面か』を宣言する。
// banto が『どこに出すか』を決める」）。本実装では MCP Apps の ui:// を
// 二重iframeでサンドボックスして埋め込むが、モック段はレイアウト・UI の
// 決定が目的なので、実際の iframe/postMessage ハンドシェイクは作らず、
// 各 Module の面を模した静的なコンポーネントで差し替える（規則7の範囲——
// プロトコルの実装は本実装の仕事）。
import { CheckCircle2, CircleDashed, Sparkles, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { FileExplorerView } from "./file-explorer-view";
import { VaultManageView } from "./vault-manage-view";

const DIFF_LINES: readonly { kind: "context" | "add" | "remove"; text: string }[] = [
  { kind: "context", text: "  export function ThreadPanel({ threadId }: { threadId: string }) {" },
  { kind: "remove", text: "-   const thread = getThread(threadId);" },
  { kind: "add", text: "+   const thread = useMemo(() => getThread(threadId), [threadId]);" },
  { kind: "context", text: "    const adapter = useMemo(() => (thread ? createMockChatModelAdapter(thread) : null), [thread]);" },
  { kind: "remove", text: "-   if (!thread) return null;" },
  { kind: "add", text: "+   if (!thread || !adapter) {" },
  { kind: "add", text: "+     return <ThreadNotFound threadId={threadId} />;" },
  { kind: "add", text: "+   }" },
];

function RepoDiffView() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        <Badge variant="outline" className="font-mono text-xs">
          lib/mock/thread-panel.tsx
        </Badge>
        <span className="text-xs text-ink-3">+4 -2</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed">
        {DIFF_LINES.map((line, i) => (
          <div
            key={i}
            className={cn(
              "whitespace-pre rounded-sm px-2",
              line.kind === "add" && "bg-ok-soft text-ok",
              line.kind === "remove" && "bg-stop-soft text-stop",
              line.kind === "context" && "text-ink-2",
            )}
          >
            {line.text}
          </div>
        ))}
      </div>
      <div className="shrink-0 border-t border-border px-4 py-2.5 text-xs text-ink-3">
        Repo Module が描く差分ビュー
      </div>
    </div>
  );
}

const WORKER_FINDINGS: readonly { level: "info" | "warn"; text: string }[] = [
  { level: "info", text: "views.css を 3 ファイルに分割しました（layout / theme / components）" },
  { level: "info", text: "既存のクラス名は変更していません——参照側の修正は不要です" },
  { level: "warn", text: "`components.css` に未使用セレクタが2件残っています（削除は次の作業者へ）" },
];

function WorkerReportView() {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto p-4">
      <div className="mb-3 flex items-center gap-2">
        <Sparkles className="size-4 text-accent-ink" />
        <p className="text-sm font-medium text-foreground">診断レポート——views.css の分割</p>
      </div>
      <div className="flex flex-col gap-2">
        {WORKER_FINDINGS.map((f, i) => (
          <div key={i} className="flex items-start gap-2 rounded-md border border-border bg-surface p-2.5 text-sm">
            {f.level === "warn" ? (
              <CircleDashed className="mt-0.5 size-4 shrink-0 text-warn" />
            ) : (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" />
            )}
            <span className="text-ink-2">{f.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const TEST_ROWS: readonly { name: string; ms: number; ok: boolean }[] = [
  { name: "記憶の検索（完全一致）", ms: 42, ok: true },
  { name: "記憶の検索（類似検索）", ms: 138, ok: true },
  { name: "記憶の検索（大量データ、1万件）", ms: 180, ok: true },
  { name: "記憶の書き込み競合", ms: 61, ok: true },
];

function TestResultView() {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-medium text-foreground">テスト結果——記憶の検索</p>
        <Badge className="bg-ok-soft text-ok">4 / 4 成功</Badge>
      </div>
      <div className="flex flex-col divide-y divide-border rounded-md border border-border bg-surface">
        {TEST_ROWS.map((row) => (
          <div key={row.name} className="flex items-center gap-2 px-3 py-2 text-sm">
            {row.ok ? (
              <CheckCircle2 className="size-3.5 shrink-0 text-ok" />
            ) : (
              <XCircle className="size-3.5 shrink-0 text-stop" />
            )}
            <span className="min-w-0 flex-1 truncate text-ink-2">{row.name}</span>
            <span className="shrink-0 font-mono text-xs text-ink-3">{row.ms}ms</span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-ink-3">目標 500ms に対し最大 180ms——達成</p>
    </div>
  );
}

const FS_DIFF_LINES: readonly { kind: "context" | "add" | "remove"; text: string }[] = [
  { kind: "context", text: "  ## まず読む" },
  { kind: "context", text: "" },
  { kind: "remove", text: "- 1. docs/vision.md" },
  { kind: "add", text: "+ 1. docs/vision.md — 何のためのものか" },
  { kind: "context", text: "  2. docs/requirements.md — 要件（出所つき）" },
];

function FsEditDiffView() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        <Badge variant="outline" className="font-mono text-xs">
          docs/README.md
        </Badge>
        <span className="text-xs text-ink-3">+2 -1</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed">
        {FS_DIFF_LINES.map((line, i) => (
          <div
            key={i}
            className={cn(
              "whitespace-pre rounded-sm px-2",
              line.kind === "add" && "bg-ok-soft text-ok",
              line.kind === "remove" && "bg-stop-soft text-stop",
              line.kind === "context" && "text-ink-2",
            )}
          >
            {line.text}
          </div>
        ))}
      </div>
      <div className="shrink-0 border-t border-border px-4 py-2.5 text-xs text-ink-3">
        FileSystem Module が描く差分——editFile の結果をその場に埋め込む
      </div>
    </div>
  );
}

function UnknownCanvasView({ moduleId, viewId }: { moduleId: string; viewId: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto bg-surface-2 p-4">
      <p className="text-sm font-medium text-foreground">{moduleId}:{viewId}</p>
      <p className="text-xs text-ink-3">このモックにはまだこの Canvas の中身を用意していません</p>
    </div>
  );
}

/** moduleId:viewId ごとの Canvas の中身。実装では ui:// を iframe で埋め込む（§6.2）。 */
export function CanvasContent({ moduleId, viewId }: { moduleId: string; viewId: string }) {
  // banto.fs:preview:<path> ——tool 呼び出し（fullscreenView、threads.ts）は
  // moduleId/viewId の組しか持ち回せないので、パスは viewId に焼き込まれてくる。
  // Command Palette 経由（palette.ts）は fsFile クエリパラメータを使うので
  // 素の "browser" のまま——FileExplorerView 側で両方を受けられるようにしてある
  if (moduleId === "banto.fs" && viewId.startsWith("preview:")) {
    return <FileExplorerView initialPath={viewId.slice("preview:".length)} initialCollapsed />;
  }

  const key = `${moduleId}:${viewId}`;
  switch (key) {
    case "banto.repo:diff":
      return <RepoDiffView />;
    case "banto.fs:browser":
      return <FileExplorerView />;
    case "banto.fs:diff":
      return <FsEditDiffView />;
    case "banto.worker:report":
      return <WorkerReportView />;
    case "hermes.test:result":
      return <TestResultView />;
    case "banto.vault-ui:manage":
      return <VaultManageView />;
    default:
      return <UnknownCanvasView moduleId={moduleId} viewId={viewId} />;
  }
}
