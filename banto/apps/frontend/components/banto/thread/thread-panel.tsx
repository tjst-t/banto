"use client";

// 1つの Thread（Base か Fork）を表示する。各パネルが独立した useLocalRuntime を持つ
// ——banto は複数の Thread を同時に画面へ並べる（Base Thread・Fork Thread・Canvas）ので、
// 「1つの RuntimeProvider が1つのアクティブスレッドを持つ」という assistant-ui の
// RemoteThreadListRuntime の前提とは相性が悪い。Thread ごとに Runtime を分けることで、
// 複数パネルの同時表示をそのまま実現する（Command Palette 等での Thread 一覧操作は
// 別の場所で Event Store 相当のストアから作る——ここでは会話の表示・送信だけを担う）。
import { useEffect, useMemo, type ReactNode } from "react";
import { AssistantRuntimeProvider, useLocalRuntime } from "@assistant-ui/react";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { CanvasAutoOpen } from "@/components/banto/thread/canvas-auto-open";
import { ComposerModelEffortMenu } from "@/components/banto/thread/composer-model-effort-menu";
import { ComposerPermissionModeMenu } from "@/components/banto/thread/composer-permission-mode-menu";
import { HumanAwareToolGroup, HumanToolCard } from "@/components/banto/thread/human-tool-card";
import { APPROVAL_TOOL_NAMES, createMockChatModelAdapter, HUMAN_TOOL_NAME } from "@/lib/mock/adapter";
import {
  hasLiveRealRun,
  releaseRealRun,
  realMessagesToInitial,
  restoredJudgmentMessages,
  restoredSyncVersion,
} from "@/lib/backend/adapter";
import { getRealJudgments, useRealInboxVersion } from "@/lib/backend/real-inbox";
import { CanvasOpenerProvider, type CanvasOpener } from "@/components/banto/canvas/canvas-opener";
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
  onOpenCanvas?: CanvasOpener;
  markers?: readonly ThreadMarker[];
}) {
  const thread = getThread(threadId);

  const adapter = useMemo(() => (thread ? createMockChatModelAdapter(thread) : null), [thread]);
  // リロード後に生き残っている判断待ちを復元する（決定・2026-09-06）。
  // ターンのSSEはPOSTの応答の中にしか無いので、読み直すとその走行はUIから切れる
  // ——hostは止まったままなので、ここで描き直さないと誰も答えられない
  // （e2e/specs/judgment-after-reload.spec.ts）。
  // **このブラウザでターンが生きている間は復元しない**——生きたカードが既に
  // 出ているので、二重に出さない（規則3）。
  useRealInboxVersion();
  const restored =
    thread?.real && !hasLiveRealRun(thread.id)
      ? restoredJudgmentMessages(thread.id, getRealJudgments())
      : [];
  const restoredKey = restored.map((m) => m.id).join(",");
  const initialMessages = useMemo(() => {
    if (!thread) return [];
    if (!thread.real) return seedToInitialMessages(thread.script.seed);
    return [...realMessagesToInitial(thread.realMessages, thread.id), ...restored];
    // restoredは毎レンダー新しい配列になるので、中身（id）で見る
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread, restoredKey]);
  // リロード時のマーカー表示復元（決定・2026-09-04）——永続化済みのClearマーカーを、
  // 実際に起きた場所（直前のmessageのid）に紐づけて transcript 中へ差し込む。
  // messageのidは realMessagesToInitial が振る `real-${seq}` と同じ規則を使うので、
  // seq比較だけで「どのmessageの直後か」が求まる（真実は一箇所——handleClear側で
  // 別途ローカルにも記録したりしない、サーバから返るmarkers/messagesだけを見る）。
  // パネルが解体されたら「このブラウザはもう読んでいない」を伝える
  // （決定・2026-09-06）。伝えないと、判断待ちで中断しているジェネレータが
  // 掃除されず、その Thread は復元も新しいターンもできなくなる
  // ——docs/notes/2026-09-06-tool-approval-review.md
  const realThreadId = thread?.real ? thread.id : null;
  useEffect(() => {
    if (!realThreadId) return;
    return () => releaseRealRun(realThreadId);
  }, [realThreadId]);

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
      // useLocalRuntime は initialMessages を作るときにしか読まない——復元した
      // 判断待ちが増減したとき、およびそれに答えた後にhostの記録を取り直した
      // ときに作り直す。走行中は restored が空・syncも走らないので、ターンの
      // 最中にここで作り直されることは無い（＝流れている表示を壊さない）
      key={`${thread.id}:${restoredKey}:${restoredSyncVersion(thread.id)}`}
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
  onOpenCanvas?: CanvasOpener;
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
      {/* 会話の奥（inline の Canvas）から「大きく出して」を伝える通り道（§6.2） */}
      <CanvasOpenerProvider value={onOpenCanvas ?? null}>
      {CONNECTED_FEATURES.canvas && onOpenCanvas ? <CanvasAutoOpen onOpenCanvas={onOpenCanvas} /> : null}
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
      </CanvasOpenerProvider>
    </AssistantRuntimeProvider>
  );
}
