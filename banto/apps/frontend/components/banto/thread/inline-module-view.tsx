"use client";

// MCP Apps の display mode "inline"（§6.2）——tool 呼び出しの結果を、会話の
// カードの中に埋め込んで見せる。fullscreen（Canvas）とは独立した、別の
// 描画先というだけ——同じ Module の Canvas コンテンツをそのまま小さく再利用する
// （banto は「どこに出すか」しか決めない。中身は Module 発、§6.2）。
//
// **置き場は tool コールの折りたたみの外**（決定・2026-09-07）。
// きっかけは tool 呼び出しでも、これは**人が見て操作する面**であって
// AI の作業ログではない。畳める領域の中に入れると、人が畳んだ瞬間に
// 「出したはずの画面」が消える。
import { CanvasContent } from "@/components/banto/canvas/canvas-content";
import { ModuleCanvas } from "@/components/banto/canvas/module-canvas";
import type { RealInlineView } from "@/lib/backend/adapter";
import { useCanvasOpener } from "@/components/banto/canvas/canvas-opener";

/**
 * 実 Module の画面を inline で埋める（決定・2026-09-06）。
 * **枠はモックが決めた形のまま**——中身だけが、固定データから
 * 本物の Module の画面に変わる（規則13：見えているものは繋がっている）。
 */
export function RealInlineModuleView({
  view,
  toolCallId,
  toolName,
  result,
}: {
  view: RealInlineView;
  toolCallId: string;
  toolName: string;
  result?: unknown;
}) {
  const openCanvas = useCanvasOpener();
  return (
    <div
      className="my-1.5 flex flex-col overflow-hidden rounded-lg border border-border"
      data-testid="inline-module-view"
      data-module={view.server}
    >
      <div className="flex items-center justify-between border-b border-border bg-surface-2 px-3 py-1.5">
        <span className="text-xs text-ink-3">
          {toolName} <span aria-hidden>·</span> inline（{view.server}）
        </span>
      </div>
      <div className="min-h-0">
        <ModuleCanvas
          owner={{ kind: "thread", id: view.threadId }}
          server={view.server}
          resourceUri={view.resourceUri}
          toolName={view.toolName}
          toolArgs={view.toolArgs}
          toolResult={result}
          displayMode="inline"
          onRequestFullscreen={
            openCanvas ? () => openCanvas(view.server, view.resourceUri, toolCallId) : undefined
          }
        />
      </div>
    </div>
  );
}

export function InlineModuleView({
  moduleId,
  viewId,
  toolName,
}: {
  moduleId: string;
  viewId: string;
  toolName: string;
}) {
  return (
    <div className="my-1.5 flex flex-col overflow-hidden rounded-lg border border-border">
      <div className="flex items-center justify-between border-b border-border bg-surface-2 px-3 py-1.5">
        <span className="text-xs text-ink-3">
          {toolName} <span aria-hidden>·</span> inline（{moduleId}:{viewId}）
        </span>
      </div>
      <div className="h-56 min-h-0">
        <CanvasContent moduleId={moduleId} viewId={viewId} />
      </div>
    </div>
  );
}
