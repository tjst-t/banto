"use client";

// MCP Apps の display mode "inline"（§6.2）——tool 呼び出しの結果を、会話の
// カードの中に埋め込んで見せる。fullscreen（Canvas）とは独立した、別の
// 描画先というだけ——同じ Module の Canvas コンテンツをそのまま小さく再利用する
// （banto は「どこに出すか」しか決めない。中身は Module 発、§6.2）。
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { CanvasContent } from "@/components/banto/canvas/canvas-content";

export function InlineModuleView({
  moduleId,
  viewId,
  props,
}: {
  moduleId: string;
  viewId: string;
  props: ToolCallMessagePartProps;
}) {
  return (
    <div className="my-1.5 flex flex-col overflow-hidden rounded-lg border border-border">
      <div className="flex items-center justify-between border-b border-border bg-surface-2 px-3 py-1.5">
        <span className="text-xs text-ink-3">
          {props.toolName} <span aria-hidden>·</span> inline（{moduleId}:{viewId}）
        </span>
      </div>
      <div className="h-56 min-h-0">
        <CanvasContent moduleId={moduleId} viewId={viewId} />
      </div>
    </div>
  );
}
