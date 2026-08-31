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
import { createMockChatModelAdapter } from "@/lib/mock/adapter";
import { getProject } from "@/lib/mock/projects";
import { seedToInitialMessages } from "@/lib/mock/seed";
import { getThread } from "@/lib/mock/threads";

// モックなので応答モデルは固定表示（実装では Configuration から読む値になる）
const MOCK_MODEL_LABEL = "claude-opus-5";

export function ThreadPanel({ threadId }: { threadId: string }) {
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
    <ThreadRuntime adapter={adapter} initialMessages={initialMessages} placeholder={placeholder} />
  );
}

function ThreadRuntime({
  adapter,
  initialMessages,
  placeholder,
}: {
  adapter: ReturnType<typeof createMockChatModelAdapter>;
  initialMessages: ReturnType<typeof seedToInitialMessages>;
  placeholder: string;
}) {
  const runtime = useLocalRuntime(adapter, {
    initialMessages,
    unstable_humanToolNames: ["banto_ask"],
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread placeholder={placeholder} modelLabel={MOCK_MODEL_LABEL} />
    </AssistantRuntimeProvider>
  );
}
