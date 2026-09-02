"use client";

// FileSystem Module のプレビュー描画（v4-modules.md §2.2）。単体開き・
// file-explorer-view.tsx の右ペイン、どちらも FileContentViewer を共有する
// ——同じレンダリングを2箇所で持たない（規則3）。
import { useMemo, useState } from "react";
import { FileImage, FileText, Pencil, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// v4-modules.md §2.2「Canvas のプレビューは拡張子/MIME→レンダラーの内部対応表を
// 持つ」——対応形式を増やすときはこの表に1行足すだけでよく、tool/resource の
// 契約には現れない（Module 実装の内部詳細）。
export type FilePreviewKind = "markdown" | "html" | "image" | "pdf" | "spreadsheet" | "source";

const FILE_PREVIEW_KIND_BY_EXT: Readonly<Record<string, FilePreviewKind>> = {
  md: "markdown",
  html: "html",
  htm: "html",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  pdf: "pdf",
  csv: "spreadsheet",
};

export function previewKindFor(path: string): FilePreviewKind {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return FILE_PREVIEW_KIND_BY_EXT[ext] ?? "source";
}

/** モックのファイル本体。実装では readFile の結果（規則3：ここが唯一の写し）。 */
export const FILE_PREVIEW_SOURCES: Readonly<Record<string, string>> = {
  "docs/README.md": [
    "# banto",
    "",
    "人に伴走し、人の助けとなるソフトウェア。",
    "",
    "## まず読む",
    "",
    "1. docs/vision.md — 何のためのものか",
    "2. docs/requirements.md — 要件（出所つき）",
    "3. docs/specs/v4-architecture.md — v4 の仕様",
  ].join("\n"),
  "docs/notes/2026-08-30-poc.md": [
    "# PoC メモ",
    "",
    "## Event Store",
    "",
    "cold start 1M件で 27ms（snapshot 無しでは 3.5〜4.5秒）",
  ].join("\n"),
  "docs/budget.csv": [
    "項目,予算,実績",
    "Vault,120000,98000",
    "Repo,80000,81000",
    "Shell,50000,47000",
  ].join("\n"),
  "public/index.html": [
    "<!doctype html>",
    "<html>",
    "  <head><title>banto</title></head>",
    "  <body>",
    "    <h1>banto</h1>",
    "    <p>人に伴走し、人の助けとなるソフトウェア。</p>",
    "  </body>",
    "</html>",
  ].join("\n"),
  "lib/mock/thread-panel.tsx": [
    "export function ThreadPanel({ threadId }: { threadId: string }) {",
    "  const thread = useMemo(() => getThread(threadId), [threadId]);",
    "  // ...",
    "}",
  ].join("\n"),
  "lib/mock/adapter.ts": [
    "export function createMockChatModelAdapter(thread: MockThread) {",
    "  // 台本（threads.ts）を再生するダミー応答",
    "}",
  ].join("\n"),
  "lib/mock/settings.ts": [
    "export const mockRuntimeDefaults: MockRuntimeDefaults = {",
    '  model: "claude-sonnet-5",',
    '  effort: "medium",',
    "};",
  ].join("\n"),
};

// 保存した編集の置き場（規則3：writeFile の結果はここが唯一の写し）。
// 通知の仕組み（notifyMockStoreChange）は要らない——編集しているコンポーネント
// 自身が自分の再描画のトリガーを持っているので、他の購読者はいない
const sourceOverrides = new Map<string, string>();

export function getFileSource(path: string): string | undefined {
  return sourceOverrides.get(path) ?? FILE_PREVIEW_SOURCES[path];
}

export function setFileSource(path: string, content: string): void {
  sourceOverrides.set(path, content);
}

export function MarkdownPreview({ source }: { source: string }) {
  return (
    <div className="flex flex-col gap-1.5 p-4 text-sm">
      {source.split("\n").map((line, i) => {
        if (line.startsWith("## ")) {
          return (
            <h2 key={i} className="mt-2 text-sm font-semibold text-foreground">
              {line.slice(3)}
            </h2>
          );
        }
        if (line.startsWith("# ")) {
          return (
            <h1 key={i} className="text-lg font-bold text-foreground">
              {line.slice(2)}
            </h1>
          );
        }
        if (/^\d+\. /.test(line)) {
          return (
            <p key={i} className="pl-3 text-ink-2">
              {line}
            </p>
          );
        }
        if (line.trim() === "") return <div key={i} className="h-1" />;
        return (
          <p key={i} className="text-ink-2">
            {line}
          </p>
        );
      })}
    </div>
  );
}

export function HtmlPreview({ source }: { source: string }) {
  return (
    <iframe
      title="HTML プレビュー"
      srcDoc={source}
      sandbox=""
      className="h-full min-h-56 w-full border-0 bg-white"
    />
  );
}

export function BinaryPreviewPlaceholder({
  kind,
  name,
  meta,
}: {
  kind: "image" | "pdf";
  name: string;
  meta: string;
}) {
  return (
    <div className="flex h-full min-h-56 flex-col items-center justify-center gap-2 bg-surface-2 text-ink-3">
      {kind === "image" ? <FileImage className="size-10" /> : <FileText className="size-10" />}
      <p className="text-sm text-ink-2">{name}</p>
      <p className="text-xs">{meta}</p>
      <p className="text-xs">バイナリなのでソース表示はありません</p>
    </div>
  );
}

// CSV の簡易パーサ——引用符やエスケープ付きカンマは扱わない（モックの表示用途
// には十分。ちゃんとした CSV 解釈は本実装の仕事）
function parseCsv(source: string): string[][] {
  return source
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split(","));
}

function csvFromRows(rows: readonly (readonly string[])[]): string {
  return rows.map((r) => r.join(",")).join("\n");
}

export function SpreadsheetView({ source }: { source: string }) {
  const [header, ...body] = parseCsv(source);
  return (
    <div className="overflow-auto p-3">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            {header?.map((cell, ci) => (
              <th
                key={ci}
                className="border border-border bg-surface-2 px-2 py-1 text-left font-medium text-foreground"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td key={ci} className="border border-border px-2 py-1 text-ink-2">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SpreadsheetEditor({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const rows = useMemo(() => parseCsv(value), [value]);

  function updateCell(rowIndex: number, cellIndex: number, text: string) {
    const next = rows.map((row) => [...row]);
    next[rowIndex][cellIndex] = text;
    onChange(csvFromRows(next));
  }

  const [header, ...body] = rows;
  return (
    <div className="overflow-auto p-3">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            {header?.map((cell, ci) => (
              <th key={ci} className="border border-border bg-surface-2 p-0">
                <input
                  value={cell}
                  onChange={(e) => updateCell(0, ci, e.target.value)}
                  className="w-full bg-transparent px-2 py-1 font-medium text-foreground outline-none"
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, ri) => (
            <tr key={ri + 1}>
              {row.map((cell, ci) => (
                <td key={ci} className="border border-border p-0">
                  <input
                    value={cell}
                    onChange={(e) => updateCell(ri + 1, ci, e.target.value)}
                    className="w-full bg-transparent px-2 py-1 text-ink-2 outline-none"
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * ヘッダ・フッタを持たない中身だけ。file-explorer-view.tsx の右ペインと
 * FilePreviewView（単体開き）が直接使う。呼び出し側は `key={path}` を渡して
 * ファイルが変わるたびに編集状態がリセットされるようにする（規則——エフェクトで
 * 追従させるのではなく、React のマウント単位で状態の寿命を切る）。
 */
export function FileContentViewer({ path }: { path: string }) {
  const kind = previewKindFor(path);
  const name = path.split("/").pop() ?? path;
  // 画像・PDF はバイナリなので編集できない。それ以外（Markdown・HTML・
  // ソースコード・CSV）はすべて「テキストファイルの編集」の対象
  const editable = kind !== "image" && kind !== "pdf";

  const [mode, setMode] = useState<"view" | "edit">("view");
  const [draft, setDraft] = useState(() => getFileSource(path) ?? "");
  const source = getFileSource(path);

  function startEdit() {
    setDraft(getFileSource(path) ?? "");
    setMode("edit");
  }
  function handleCancel() {
    setMode("view");
  }
  function handleSave() {
    setFileSource(path, draft);
    setMode("view");
    toast(`${name} を保存しました`);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {editable ? (
        <div className="flex shrink-0 items-center justify-end gap-1.5 border-b border-border px-3 py-1.5">
          {mode === "edit" ? (
            <>
              <Button size="sm" variant="outline" onClick={handleCancel}>
                キャンセル
              </Button>
              <Button size="sm" onClick={handleSave}>
                <Save className="size-3.5" />
                保存
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={startEdit}>
              <Pencil className="size-3.5" />
              編集
            </Button>
          )}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        {mode === "edit" ? (
          kind === "spreadsheet" ? (
            <SpreadsheetEditor value={draft} onChange={setDraft} />
          ) : (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              className="h-full w-full resize-none bg-surface p-3 font-mono text-xs text-foreground outline-none"
            />
          )
        ) : kind === "markdown" || kind === "html" ? (
          <Tabs defaultValue="preview" className="flex h-full min-h-0 flex-col">
            <TabsList className="mx-4 mt-2 w-fit self-start">
              <TabsTrigger value="preview">プレビュー</TabsTrigger>
              <TabsTrigger value="source">ソース</TabsTrigger>
            </TabsList>
            <TabsContent value="preview" className="min-h-0 flex-1 overflow-auto">
              {kind === "markdown" ? (
                <MarkdownPreview source={source ?? ""} />
              ) : (
                <HtmlPreview source={source ?? ""} />
              )}
            </TabsContent>
            <TabsContent value="source" className="min-h-0 flex-1 overflow-auto p-3">
              <pre className="whitespace-pre-wrap font-mono text-xs text-ink-2">{source}</pre>
            </TabsContent>
          </Tabs>
        ) : kind === "image" ? (
          <BinaryPreviewPlaceholder kind="image" name={name} meta="1024×768・PNG・128KB" />
        ) : kind === "pdf" ? (
          <BinaryPreviewPlaceholder kind="pdf" name={name} meta="3ページ・PDF・412KB" />
        ) : kind === "spreadsheet" ? (
          <SpreadsheetView source={source ?? ""} />
        ) : (
          <pre className="whitespace-pre-wrap p-3 font-mono text-xs text-ink-2">
            {source ?? "（このモックにはソースを用意していません）"}
          </pre>
        )}
      </div>
    </div>
  );
}
