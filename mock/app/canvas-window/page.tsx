"use client";

// 「MCP App を別タブで開く」（§6.2 fullscreen、project-panels.tsx）の遷移先。
// banto 自身のクロム（ProjectRail・ヘッダ・Command Palette 等）を一切持たない
// ——本当にその Canvas（＝実装では ui:// の iframe）だけを表示する。
// AppShell は各セクションの layout.tsx が個別に被せているので、ここは
// それらの外（app/canvas-window/）に置くだけで自然にクロム無しになる。
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { CanvasContent } from "@/components/banto/canvas/canvas-content";
import { parseCanvasParam } from "@/components/banto/shell/use-panel-stack";

function CanvasWindowInner() {
  const searchParams = useSearchParams();
  const canvas = parseCanvasParam(searchParams.get("canvas"));

  if (!canvas) {
    return (
      <div className="flex h-dvh items-center justify-center text-sm text-ink-3">
        Canvas が指定されていません
      </div>
    );
  }

  return (
    <div className="flex h-dvh min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center border-b border-border px-3">
        <p className="truncate text-sm font-medium text-foreground">
          {canvas.moduleId}:{canvas.viewId}
        </p>
      </div>
      <div className="min-h-0 flex-1">
        <CanvasContent moduleId={canvas.moduleId} viewId={canvas.viewId} />
      </div>
    </div>
  );
}

export default function CanvasWindowPage() {
  return (
    <Suspense fallback={null}>
      <CanvasWindowInner />
    </Suspense>
  );
}
