"use client";

// 1つの Thread（Base か Fork）を表示する。各パネルが独立した useLocalRuntime を持つ
// ——banto は複数の Thread を同時に画面へ並べる（Base Thread・Fork Thread・Canvas）ので、
// 「1つの RuntimeProvider が1つのアクティブスレッドを持つ」という assistant-ui の
// RemoteThreadListRuntime の前提とは相性が悪い。Thread ごとに Runtime を分けることで、
// 複数パネルの同時表示をそのまま実現する（Command Palette 等での Thread 一覧操作は
// 別の場所で Event Store 相当のストアから作る——ここでは会話の表示・送信だけを担う）。
import { useMemo } from "react";
import { AssistantRuntimeProvider, useLocalRuntime } from "@assistant-ui/react";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { CanvasAutoOpen } from "@/components/banto/thread/canvas-auto-open";
import { DemoHints } from "@/components/banto/thread/demo-hints";
import { HumanAwareToolGroup, HumanToolCard } from "@/components/banto/thread/human-tool-card";
import { APPROVAL_TOOL_NAME, createMockChatModelAdapter, HUMAN_TOOL_NAME } from "@/lib/mock/adapter";
import { getProject } from "@/lib/mock/projects";
import { seedToInitialMessages } from "@/lib/mock/seed";
import { getThread } from "@/lib/mock/threads";

// モックなので応答モデルは固定表示（実装では Configuration から読む値になる）
const MOCK_MODEL_LABEL = "claude-opus-5";

export function ThreadPanel({
  threadId,
  onOpenCanvas,
}: {
  threadId: string;
  /** MCP Apps の display mode "fullscreen"——tool 呼び出し自身が要求したら呼ばれる（§6.2） */
  onOpenCanvas?: (moduleId: string, viewId: string) => void;
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
    />
  );
}

function ThreadRuntime({
  adapter,
  initialMessages,
  placeholder,
  showDemoHints,
  onOpenCanvas,
}: {
  adapter: ReturnType<typeof createMockChatModelAdapter>;
  initialMessages: ReturnType<typeof seedToInitialMessages>;
  placeholder: string;
  showDemoHints: boolean;
  onOpenCanvas?: (moduleId: string, viewId: string) => void;
}) {
  const runtime = useLocalRuntime(adapter, {
    initialMessages,
    unstable_humanToolNames: [HUMAN_TOOL_NAME, APPROVAL_TOOL_NAME],
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {onOpenCanvas ? <CanvasAutoOpen onOpenCanvas={onOpenCanvas} /> : null}
      <Thread
        placeholder={placeholder}
        modelLabel={MOCK_MODEL_LABEL}
        components={{ ToolFallback: HumanToolCard, ToolGroup: HumanAwareToolGroup }}
        composerHint={showDemoHints ? <DemoHints /> : undefined}
      />
    </AssistantRuntimeProvider>
  );
}
