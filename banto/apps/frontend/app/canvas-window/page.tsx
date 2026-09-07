"use client";

// 「MCP App を別タブで開く」（§6.2 fullscreen、project-panels.tsx）の遷移先。
// banto 自身のクロム（ProjectRail・ヘッダ・Command Palette 等）を一切持たない
// ——本当にその Canvas（＝実装では ui:// の iframe）だけを表示する。
// AppShell は各セクションの layout.tsx が個別に被せているので、ここは
// それらの外（app/canvas-window/）に置くだけで自然にクロム無しになる。
//
// **別タブは手元の記憶を持たない**（決定・2026-09-07、ユーザー報告）。
// 元のタブが覚えている「どの Module のどの画面を、どんな引数で呼んで何が
// 返ったか」は、この新しいタブには無い——**host の記録から取り直す**
// （真実は host、規則3）。以前はモックの固定データを描いていて、
// 実 Module の画面を別タブで開くと中身が出なかった。

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CanvasContent } from "@/components/banto/canvas/canvas-content";
import { ModuleCanvas } from "@/components/banto/canvas/module-canvas";
import { parseCanvasParam } from "@/components/banto/shell/use-panel-stack";
import { fetchRealUiToolCall, type RealUiToolCall } from "@/lib/backend/client";

function CanvasWindowInner() {
  const searchParams = useSearchParams();
  const canvas = parseCanvasParam(searchParams.get("canvas"));
  const threadId = searchParams.get("thread");
  const toolCallId = searchParams.get("canvasTool");
  const projectId = searchParams.get("project");

  if (!canvas) {
    return (
      <div className="flex h-dvh items-center justify-center text-sm text-ink-3">
        Canvas が指定されていません
      </div>
    );
  }

  // 実 Module の画面（記録から引ける）か、モックの面か
  if (threadId && toolCallId) {
    return <RealCanvasWindow threadId={threadId} toolCallId={toolCallId} />;
  }
  // **入口（launcher）から開いた面**——tool 呼び出しが無いので記録も引かない。
  // どの Module のどの画面かは URL がそのまま持っている（決定・2026-09-07）
  if (projectId && canvas.viewId.startsWith("ui://")) {
    return (
      <CanvasWindowFrame title={canvas.moduleId}>
        <div className="h-full" data-testid="canvas-window-module" data-module={canvas.moduleId}>
          <ModuleCanvas
            owner={{ kind: "project", id: projectId }}
            server={canvas.moduleId}
            resourceUri={canvas.viewId}
            displayMode="fullscreen"
          />
        </div>
      </CanvasWindowFrame>
    );
  }

  return (
    <CanvasWindowFrame title={`${canvas.moduleId}:${canvas.viewId}`}>
      <CanvasContent moduleId={canvas.moduleId} viewId={canvas.viewId} />
    </CanvasWindowFrame>
  );
}

function CanvasWindowFrame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex h-dvh min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center border-b border-border px-3">
        <p className="truncate text-sm font-medium text-foreground">{title}</p>
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

type State =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; call: RealUiToolCall };

function RealCanvasWindow({ threadId, toolCallId }: { threadId: string; toolCallId: string }) {
  const [state, setState] = useState<State>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const call = await fetchRealUiToolCall(threadId, toolCallId);
        if (cancelled) return;
        if (!call) {
          // **無いものを描かない**（規則2）——記録に無ければそう言う
          setState({ phase: "error", message: "この画面の記録が見つかりませんでした" });
          return;
        }
        setState({ phase: "ready", call });
      } catch (err) {
        if (!cancelled) setState({ phase: "error", message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [threadId, toolCallId]);

  if (state.phase === "loading") {
    return (
      <CanvasWindowFrame title="読み込んでいます…">
        <div className="p-3 text-xs text-ink-3">画面を読み込んでいます…</div>
      </CanvasWindowFrame>
    );
  }
  if (state.phase === "error") {
    return (
      <CanvasWindowFrame title="開けませんでした">
        <div className="p-3 text-xs text-stop" data-testid="canvas-window-error">
          画面を出せませんでした：{state.message}
        </div>
      </CanvasWindowFrame>
    );
  }

  const { call } = state;
  return (
    <CanvasWindowFrame title={call.server}>
      <div className="h-full" data-testid="canvas-window-module" data-module={call.server}>
        <ModuleCanvas
          owner={{ kind: "thread", id: threadId }}
          server={call.server}
          resourceUri={call.resourceUri}
          toolName={call.toolName}
          toolArgs={
            typeof call.args === "object" && call.args !== null && !Array.isArray(call.args)
              ? (call.args as Record<string, unknown>)
              : undefined
          }
          toolResult={call.result}
          displayMode="fullscreen"
        />
      </div>
    </CanvasWindowFrame>
  );
}

export default function CanvasWindowPage() {
  return (
    <Suspense fallback={null}>
      <CanvasWindowInner />
    </Suspense>
  );
}
