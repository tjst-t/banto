"use client";

// **置き場は tool コールの折りたたみの外**（決定・2026-09-07）。きっかけは
// tool 呼び出しでも、これは人が見て操作する面であって AI の作業ログではない
// ——畳める領域に入れると、人が畳んだ瞬間に「出したはずの画面」が消える。
//
// MCP Apps の display mode "inline"（§6.2）——tool 呼び出しの結果を、会話の
// カードの中に埋め込んで見せる。fullscreen（Canvas）とは独立した、別の
// 描画先というだけ——同じ Module の Canvas コンテンツをそのまま小さく再利用する
// （banto は「どこに出すか」しか決めない。中身は Module 発、§6.2）。
import { CanvasContent } from "@/components/banto/canvas/canvas-content";

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
