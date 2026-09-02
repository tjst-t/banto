"use client";

// 1つの Thread（Base か Fork）を表示する。各パネルが独立した useLocalRuntime を持つ
// ——banto は複数の Thread を同時に画面へ並べる（Base Thread・Fork Thread・Canvas）ので、
// 「1つの RuntimeProvider が1つのアクティブスレッドを持つ」という assistant-ui の
// RemoteThreadListRuntime の前提とは相性が悪い。Thread ごとに Runtime を分けることで、
// 複数パネルの同時表示をそのまま実現する（Command Palette 等での Thread 一覧操作は
// 別の場所で Event Store 相当のストアから作る——ここでは会話の表示・送信だけを担う）。
import { useMemo, type ReactNode } from "react";
import { AssistantRuntimeProvider, useLocalRuntime } from "@assistant-ui/react";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { CanvasAutoOpen } from "@/components/banto/thread/canvas-auto-open";
import { ComposerModelEffortMenu } from "@/components/banto/thread/composer-model-effort-menu";
import { DemoHints } from "@/components/banto/thread/demo-hints";
import { HumanAwareToolGroup, HumanToolCard } from "@/components/banto/thread/human-tool-card";
import { APPROVAL_TOOL_NAME, createMockChatModelAdapter, HUMAN_TOOL_NAME } from "@/lib/mock/adapter";
import { getProject } from "@/lib/mock/projects";
import { mockRuntimeDefaults } from "@/lib/mock/settings";
import { seedToInitialMessages } from "@/lib/mock/seed";
import { getThread } from "@/lib/mock/threads";

export interface ThreadMarker {
  id: string;
  kind: "clear" | "compact";
}

/**
 * Clear／Compaction が起きたことを、ヘッダーの通知ではなくチャット欄に横線
 * として残す（レビュー指摘 2026-09-01——ヘッダーに出るのは変）。composerHint
 * は Composer のすぐ上に常駐する枠（Thread 本体、ThreadPrimitive.ViewportFooter）
 * ——本来なら実際の transcript の途中に挿し込みたいが、vendored な Thread
 * コンポーネントの中までは踏み込まない。「起きた時点でその場に現れ、次の
 * 発言からはその下に続く」という位置づけは composerHint でも成立する
 */
function ThreadMarkers({ markers }: { markers: readonly ThreadMarker[] }) {
  if (markers.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {markers.map((m) => (
        <div key={m.id} className="flex items-center gap-2 text-xs text-ink-3">
          <div className="h-px flex-1 bg-border" />
          <span>{m.kind === "clear" ? "Clear" : "Compaction"}</span>
          <div className="h-px flex-1 bg-border" />
        </div>
      ))}
    </div>
  );
}

export function ThreadPanel({
  threadId,
  onOpenCanvas,
  markers,
}: {
  threadId: string;
  /** MCP Apps の display mode "fullscreen"——tool 呼び出し自身が要求したら呼ばれる（§6.2） */
  onOpenCanvas?: (moduleId: string, viewId: string) => void;
  markers?: readonly ThreadMarker[];
}) {
  const thread = getThread(threadId);

  const adapter = useMemo(() => (thread ? createMockChatModelAdapter(thread) : null), [thread]);
  const initialMessages = useMemo(
    () => (thread ? seedToInitialMessages(thread.script.seed) : []),
    [thread],
  );

  if (!thread || !adapter) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-ink-3">
        Thread が見つかりません（{threadId}）
      </div>
    );
  }

  const placeholder =
    thread.kind === "fork"
      ? "この Fork Thread に送る"
      : `${getProject(thread.projectId).name} の Base Thread に送る`;

  return (
    <ThreadRuntime
      adapter={adapter}
      initialMessages={initialMessages}
      placeholder={placeholder}
      // デモの台本（threads.ts）は banto Project の Base Thread にしか無い
      showDemoHints={threadId === "banto-base"}
      onOpenCanvas={onOpenCanvas}
      markers={markers ?? []}
    />
  );
}

function ThreadRuntime({
  adapter,
  initialMessages,
  placeholder,
  showDemoHints,
  onOpenCanvas,
  markers,
}: {
  adapter: ReturnType<typeof createMockChatModelAdapter>;
  initialMessages: ReturnType<typeof seedToInitialMessages>;
  placeholder: string;
  showDemoHints: boolean;
  onOpenCanvas?: (moduleId: string, viewId: string) => void;
  markers: readonly ThreadMarker[];
}) {
  const runtime = useLocalRuntime(adapter, {
    initialMessages,
    unstable_humanToolNames: [HUMAN_TOOL_NAME, APPROVAL_TOOL_NAME],
  });

  const hint: ReactNode = (
    <>
      {showDemoHints ? <DemoHints /> : null}
      <ThreadMarkers markers={markers} />
    </>
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {onOpenCanvas ? <CanvasAutoOpen onOpenCanvas={onOpenCanvas} /> : null}
      <Thread
        placeholder={placeholder}
        composerActionSlot={
          <ComposerModelEffortMenu
            defaultModel={mockRuntimeDefaults.model}
            defaultEffort={mockRuntimeDefaults.effort}
          />
        }
        components={{ ToolFallback: HumanToolCard, ToolGroup: HumanAwareToolGroup }}
        composerHint={showDemoHints || markers.length > 0 ? hint : undefined}
      />
    </AssistantRuntimeProvider>
  );
}
