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
import { LayoutPanelLeft } from "lucide-react";
import { CanvasContent } from "@/components/banto/canvas/canvas-content";
import { ModuleCanvas } from "@/components/banto/canvas/module-canvas";
import { useState } from "react";
import { markInlineViewDisplayMode, type RealInlineView } from "@/lib/backend/adapter";
import { recordRealUiDisplayMode } from "@/lib/backend/client";
import { useCanvasOpener } from "@/components/banto/canvas/canvas-opener";
import { OpenableCard } from "@/components/banto/thread/openable-card";

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
  const open = openCanvas ? () => openCanvas(view.server, view.resourceUri, toolCallId) : undefined;
  // **「大きく出した」呼び出しは、会話には入口だけを残す**（決定・2026-09-07、
  // ユーザー要望）。会話の中に画面を埋め直すと、その画面がまた
  // `ui/request-display-mode` を投げ、**リロードのたびに Canvas が勝手に開く**
  // ——自動で開いてよいのは、tool が呼んだその一度だけ。
  const [asEntryOnly, setAsEntryOnly] = useState(view.displayMode === "fullscreen");

  if (asEntryOnly) {
    return (
      <OpenableCard
        icon={LayoutPanelLeft}
        title={`${view.server} の画面`}
        description={summarizeArgs(view.toolArgs) ?? toolName}
        onOpen={open}
        testId="canvas-reopen-card"
        moduleName={view.server}
      />
    );
  }

  return (
    <OpenableCard
      icon={LayoutPanelLeft}
      title={`${toolName}（${view.server}）`}
      description="inline"
      onOpen={open}
      actionLabel="大きく開く"
      testId="inline-module-view"
      moduleName={view.server}
    >
      <ModuleCanvas
        owner={{ kind: "thread", id: view.threadId }}
        server={view.server}
        resourceUri={view.resourceUri}
        toolName={view.toolName}
        toolArgs={view.toolArgs}
        toolResult={result}
        displayMode="inline"
        onRequestFullscreen={
          // 画面が「大きく出して」と言ってきたら開く。**そのとき、この呼び出しは
          // 会話から入口だけに畳む**——同じ画面が会話と Canvas に二重に出ない。
          // 記録にも残すので、次に開いたときは埋め直さない（＝勝手に開かない）
          open
            ? () => {
                open();
                setAsEntryOnly(true);
                markInlineViewDisplayMode(toolCallId, "fullscreen");
                // どう出したかを記録に残す（次に開いたとき、入口だけを出すため）
                void recordRealUiDisplayMode(view.threadId, toolCallId, "fullscreen").catch(() => {
                  // 記録できなくても、いま開くことは妨げない——次回また埋め直すだけ
                });
              }
            : undefined
        }
      />
    </OpenableCard>
  );
}

/** カードに出す「何を呼んだか」の手がかり。長い引数は畳む。 */
function summarizeArgs(args?: Record<string, unknown>): string | undefined {
  if (!args) return undefined;
  const parts = Object.entries(args)
    .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .map(([k, v]) => `${k}: ${String(v)}`);
  if (parts.length === 0) return undefined;
  const text = parts.join(" / ");
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
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
