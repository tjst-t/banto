"use client";

import { useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, Bell, Clock, ExternalLink, GitFork, GitMerge, Maximize2, Minimize2, Settings, X } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { CanvasContent } from "@/components/banto/canvas/canvas-content";
import { MobileNavDrawer } from "@/components/banto/shell/mobile-nav-drawer";
import { getJudgmentCount } from "@/components/banto/shell/nav-panel";
import { PanelStack } from "@/components/banto/shell/panel-stack";
import { usePanelStack } from "@/components/banto/shell/use-panel-stack";
import { ProjectSettingsOverlay } from "@/components/banto/settings/project-settings-overlay";
import { ContextUsageMeter } from "@/components/banto/thread/context-usage-meter";
import { ThreadActionsMenu } from "@/components/banto/thread/thread-actions-menu";
import { ThreadPanel, type ThreadMarker } from "@/components/banto/thread/thread-panel";
import { getProject } from "@/lib/mock/projects";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import { closeThread, getThread } from "@/lib/mock/threads";

function PanelHeader({
  leading,
  title,
  children,
}: {
  /** ヘッダの左端に置くもの（モバイルのナビの入口） */
  leading?: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border px-2 md:h-11 md:px-3">
      {leading}
      <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</p>
      <div className="flex shrink-0 items-center gap-1.5">{children}</div>
    </div>
  );
}

// Fork Thread・Canvas 用。閉じる操作のアイコンを左端に置く
// （Escape での同じ操作は panel-stack.tsx に1箇所だけ持つ——前面の層だけを閉じる）
function ClosablePanelHeader({
  icon: Icon,
  onClose,
  closeLabel,
  titleIcon: TitleIcon,
  title,
  trailing,
}: {
  icon: typeof ArrowLeft;
  onClose: () => void;
  closeLabel: string;
  /** 何の面か（Fork Thread・Canvas）はアイコンで示す——狭い幅では文字の接頭辞が
      題そのものを押し出してしまう（3層のときフォーク名が「会話UIを一か…」で切れていた） */
  titleIcon?: typeof ArrowLeft;
  title: string;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-2 md:h-11">
      <button
        type="button"
        onClick={onClose}
        aria-label={closeLabel}
        className="flex size-9 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-accent md:size-7"
      >
        <Icon className="size-4" />
      </button>
      {TitleIcon ? <TitleIcon className="size-4 shrink-0 text-ink-3" /> : null}
      <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground" title={title}>
        {title}
      </p>
      {trailing}
    </div>
  );
}

function IconHeaderButton({
  onClick,
  label,
  icon: Icon,
}: {
  onClick: () => void;
  label: string;
  icon: typeof ArrowLeft;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex size-9 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-accent md:size-7"
    >
      <Icon className="size-4" />
    </button>
  );
}

/** 受信箱の入口（モバイルのヘッダ用）。判断待ちの件数をバッジで出す */
function InboxHeaderButton({ onClick }: { onClick: () => void }) {
  useMockStoreVersion();
  const judgmentCount = getJudgmentCount();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={judgmentCount > 0 ? `受信箱（判断待ち ${judgmentCount}件）` : "受信箱"}
      className="relative flex size-9 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-accent md:size-7"
    >
      <Bell className="size-4" />
      {judgmentCount > 0 ? (
        <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-turn text-xs leading-none font-semibold text-on-color">
          {judgmentCount}
        </span>
      ) : null}
    </button>
  );
}

export function ProjectPanels({ projectId }: { projectId: string }) {
  const stack = usePanelStack(projectId);
  const project = getProject(projectId);
  const searchParams = useSearchParams();
  // モバイルの Canvas はすでにヘッダ以外の全画面を使っているので、
  // 全画面トグルは無意味（押しても見た目が変わらない）——desktop だけに出す
  const isMobile = useIsMobile();
  const [markersByThread, setMarkersByThread] = useState<Record<string, ThreadMarker[]>>({});

  function addMarker(threadId: string, kind: ThreadMarker["kind"]) {
    setMarkersByThread((prev) => ({
      ...prev,
      [threadId]: [...(prev[threadId] ?? []), { id: `${kind}-${(prev[threadId]?.length ?? 0) + 1}`, kind }],
    }));
  }

  // 「別タブで開く」——banto のクロム（ProjectRail・ヘッダ等）を持たない
  // /canvas-window へ、その Canvas に要る状態（canvas・fsFile 等）だけを運ぶ。
  // fork/overlay/fullscreen は banto 側のパネル状態なので運ばない
  function openCanvasInNewTab() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("fork");
    params.delete("overlay");
    params.delete("fullscreen");
    window.open(`/canvas-window?${params.toString()}`, "_blank", "noopener,noreferrer");
    // 別タブへ切り出したら、元の banto 側では畳む——同じものが2箇所に開いた
    // ままだと紛らわしい
    stack.close("canvas");
  }

  return (
    <>
    <PanelStack
      projectId={projectId}
      renderBase={() => (
        <div className="flex h-full min-h-0 flex-col">
          <PanelHeader
            // モバイルはここが唯一のナビの入口（上部バーを廃止した分、段が1つ減る）
            leading={isMobile ? <MobileNavDrawer projectId={projectId} /> : undefined}
            title={isMobile ? project.name : `Base Thread — ${project.name}`}
          >
            <ContextUsageMeter threadId={project.baseThreadId} />
            {/* 「Fork を開く」（固定の Fork へ飛ぶデモ用ボタン）は置かない——
                開いている Fork はサイドバーの目次に常に出ているので、ヘッダから
                同じ場所へ行く二重の口を持たない（規則3） */}
            {isMobile ? (
              // 判断待ちは「止まっている」ので、目次を開かなくても件数が見える
              // 位置に置く。履歴は急がないので Drawer に譲る（段を1つに保つ）
              <InboxHeaderButton onClick={() => stack.open({ overlay: "inbox" })} />
            ) : (
              <IconHeaderButton
                icon={Clock}
                label="履歴"
                onClick={() => stack.open({ overlay: "archive" })}
              />
            )}
            <IconHeaderButton
              icon={Settings}
              label="Project 設定"
              onClick={() => stack.open({ overlay: "settings-project" })}
            />
            <ThreadActionsMenu
              onClear={() => addMarker(project.baseThreadId, "clear")}
              onCompact={() => addMarker(project.baseThreadId, "compact")}
            />
          </PanelHeader>
          <div className="min-h-0 flex-1">
            <ThreadPanel
              threadId={project.baseThreadId}
              onOpenCanvas={(moduleId, viewId) => stack.open({ canvas: { moduleId, viewId } })}
              markers={markersByThread[project.baseThreadId]}
            />
          </div>
        </div>
      )}
      renderFork={(threadId) => {
        const thread = getThread(threadId);
        return (
          <div className="flex h-full min-h-0 flex-col">
            <ClosablePanelHeader
              icon={ArrowLeft}
              onClose={() => stack.close("fork")}
              closeLabel={`${project.name} の Base Thread に戻る`}
              titleIcon={GitFork}
              title={thread?.title ?? threadId}
              trailing={
                <div className="flex items-center gap-1.5">
                  <ContextUsageMeter threadId={threadId} />
                  <ThreadActionsMenu
                    onClear={() => addMarker(threadId, "clear")}
                    onCompact={() => addMarker(threadId, "compact")}
                  />
                  <IconHeaderButton
                    icon={GitMerge}
                    label="この Fork Thread を畳む"
                    onClick={() => {
                      closeThread(threadId);
                      stack.close("fork");
                    }}
                  />
                </div>
              }
            />
            <div className="min-h-0 flex-1">
              <ThreadPanel threadId={threadId} markers={markersByThread[threadId]} />
            </div>
          </div>
        );
      }}
      renderCanvas={(moduleId, viewId) => (
        <div className="flex h-full min-h-0 flex-col">
          <ClosablePanelHeader
            icon={X}
            onClose={() => stack.close("canvas")}
            closeLabel="Canvas を閉じる"
            title={`Canvas — ${moduleId}:${viewId}`}
            trailing={
              <div className="flex items-center gap-1.5">
                {stack.canvasFullscreen ? (
                  // MCP Apps の fullscreen は「その面だけの独立した画面」という
                  // 扱い（§6.2）——別タブでも banto のクロム無しでその Canvas
                  // だけを表示し、元のタブ側は畳む
                  <IconHeaderButton icon={ExternalLink} label="別タブで開く" onClick={openCanvasInNewTab} />
                ) : null}
                {isMobile ? null : (
                  <IconHeaderButton
                    icon={stack.canvasFullscreen ? Minimize2 : Maximize2}
                    label={stack.canvasFullscreen ? "全画面を解除" : "全画面で表示"}
                    onClick={() => stack.open({ canvasFullscreen: !stack.canvasFullscreen })}
                  />
                )}
              </div>
            }
          />
          <div className="min-h-0 flex-1">
            <CanvasContent moduleId={moduleId} viewId={viewId} />
          </div>
        </div>
      )}
    />
    <ProjectSettingsOverlay
      projectId={projectId}
      open={stack.overlay === "settings-project"}
      onOpenChange={(open) => (open ? stack.open({ overlay: "settings-project" }) : stack.close("overlay"))}
    />
    </>
  );
}
