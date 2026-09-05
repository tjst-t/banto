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
import { ComposerPermissionModeMenu } from "@/components/banto/thread/composer-permission-mode-menu";
import { HumanAwareToolGroup, HumanToolCard } from "@/components/banto/thread/human-tool-card";
import { APPROVAL_TOOL_NAMES, createMockChatModelAdapter, HUMAN_TOOL_NAME } from "@/lib/mock/adapter";
import { realMessagesToInitial } from "@/lib/backend/adapter";
import { getProject } from "@/lib/mock/projects";
import { mockRuntimeDefaults } from "@/lib/mock/settings";
import { seedToInitialMessages } from "@/lib/mock/seed";
import { getThread } from "@/lib/mock/threads";
import { CONNECTED_FEATURES } from "@/lib/feature-flags";

export interface ThreadMarker {
  id: string;
  kind: "clear" | "compact";
}

/** Clear／Compaction が起きたことを示す横線。実際に起きた場所（transcript中）に
 *  差し込む——composerHintに置くと常に入力欄の直上に固定され、リロード後に
 *  どこでClearしたか分からなくなる（指摘・2026-09-04で訂正）。 */
function MarkerDivider({ kind }: { kind: ThreadMarker["kind"] }) {
  return (
    <div className="flex items-center gap-2 text-xs text-ink-3">
      <div className="h-px flex-1 bg-border" />
      <span>{kind === "clear" ? "Clear" : "Compaction"}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

/** 未永続化（compact等、ローカルのみ）のマーカーをComposer直上にまとめて出す
 *  ——「起きた場所」が分かる情報（seq）を持たないものだけがここに残る。 */
function ThreadMarkers({ markers }: { markers: readonly ThreadMarker[] }) {
  if (markers.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {markers.map((m) => (
        <MarkerDivider key={m.id} kind={m.kind} />
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
  const initialMessages = useMemo(() => {
    if (!thread) return [];
    return thread.real ? realMessagesToInitial(thread.realMessages) : seedToInitialMessages(thread.script.seed);
  }, [thread]);
  // リロード時のマーカー表示復元（決定・2026-09-04）——永続化済みのClearマーカーを、
  // 実際に起きた場所（直前のmessageのid）に紐づけて transcript 中へ差し込む。
  // messageのidは realMessagesToInitial が振る `real-${seq}` と同じ規則を使うので、
  // seq比較だけで「どのmessageの直後か」が求まる（真実は一箇所——handleClear側で
  // 別途ローカルにも記録したりしない、サーバから返るmarkers/messagesだけを見る）。
  const transcriptMarkers = useMemo(() => {
    if (!thread?.real) return undefined;
    const msgs = thread.realMessages ?? [];
    const map = new Map<string | null, ReactNode>();
    for (const marker of thread.realMarkers ?? []) {
      let anchor: string | null = null;
      for (const m of msgs) {
        if (m.seq < marker.seq) anchor = `real-${m.seq}`;
        else break;
      }
      const node = <MarkerDivider key={`marker-${marker.seq}`} kind={marker.kind} />;
      const existing = map.get(anchor);
      map.set(anchor, existing ? <>{existing}{node}</> : node);
    }
    return map;
  }, [thread]);

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
      threadId={thread.id}
      projectId={thread.projectId}
      onOpenCanvas={onOpenCanvas}
      markers={markers ?? []}
      transcriptMarkers={transcriptMarkers}
    />
  );
}

function ThreadRuntime({
  adapter,
  initialMessages,
  placeholder,
  threadId,
  projectId,
  onOpenCanvas,
  markers,
  transcriptMarkers,
}: {
  adapter: ReturnType<typeof createMockChatModelAdapter>;
  initialMessages: ReturnType<typeof seedToInitialMessages>;
  placeholder: string;
  threadId: string;
  projectId: string;
  onOpenCanvas?: (moduleId: string, viewId: string) => void;
  markers: readonly ThreadMarker[];
  transcriptMarkers?: ReadonlyMap<string | null, ReactNode>;
}) {
  const runtime = useLocalRuntime(adapter, {
    initialMessages,
    unstable_humanToolNames: [HUMAN_TOOL_NAME, ...APPROVAL_TOOL_NAMES],
  });

  const hint: ReactNode = <ThreadMarkers markers={markers} />;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {onOpenCanvas ? <CanvasAutoOpen onOpenCanvas={onOpenCanvas} /> : null}
      <Thread
        placeholder={placeholder}
        composerActionSlot={
          <>
            {CONNECTED_FEATURES.composerModelEffort ? (
              <ComposerModelEffortMenu
                defaultModel={mockRuntimeDefaults.model}
                defaultEffort={mockRuntimeDefaults.effort}
              />
            ) : null}
            <ComposerPermissionModeMenu threadId={threadId} projectId={projectId} />
          </>
        }
        components={{ ToolFallback: HumanToolCard, ToolGroup: HumanAwareToolGroup }}
        composerHint={markers.length > 0 ? hint : undefined}
        transcriptMarkers={transcriptMarkers}
      />
    </AssistantRuntimeProvider>
  );
}
