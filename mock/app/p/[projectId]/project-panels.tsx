"use client";

import { useState, type ReactNode } from "react";
import { ArrowLeft, Clock, GitFork, GitMerge, Maximize2, Minimize2, Settings, X } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { CanvasContent } from "@/components/banto/canvas/canvas-content";
import { PanelStack } from "@/components/banto/shell/panel-stack";
import { usePanelStack } from "@/components/banto/shell/use-panel-stack";
import { ProjectSettingsOverlay } from "@/components/banto/settings/project-settings-overlay";
import { ClosedForksPanel } from "@/components/banto/thread/closed-forks-panel";
import { ContextUsageMeter } from "@/components/banto/thread/context-usage-meter";
import { ThreadActionsMenu } from "@/components/banto/thread/thread-actions-menu";
import { ThreadPanel, type ThreadMarker } from "@/components/banto/thread/thread-panel";
import { getProject } from "@/lib/mock/projects";
import { closeThread, getThread } from "@/lib/mock/threads";

function PanelHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-3">
      <p className="truncate text-sm font-medium text-foreground">{title}</p>
      <div className="flex shrink-0 gap-1.5">{children}</div>
    </div>
  );
}

// Fork Thread・Canvas 用。閉じる操作のアイコンを左端に置く
// （Escape での同じ操作は panel-stack.tsx に1箇所だけ持つ——前面の層だけを閉じる）
function ClosablePanelHeader({
  icon: Icon,
  onClose,
  closeLabel,
  title,
  trailing,
}: {
  icon: typeof ArrowLeft;
  onClose: () => void;
  closeLabel: string;
  title: string;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-2">
      <button
        type="button"
        onClick={onClose}
        aria-label={closeLabel}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-accent"
      >
        <Icon className="size-4" />
      </button>
      <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</p>
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
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-accent"
    >
      <Icon className="size-4" />
    </button>
  );
}

export function ProjectPanels({ projectId }: { projectId: string }) {
  const stack = usePanelStack(projectId);
  const project = getProject(projectId);
  // モバイルはすでに MobileTopBar 以外の全画面を使っているので、
  // 全画面トグルは無意味（押しても見た目が変わらない）——desktop だけに出す
  const isMobile = useIsMobile();
  const [showClosedForks, setShowClosedForks] = useState(false);
  const [markersByThread, setMarkersByThread] = useState<Record<string, ThreadMarker[]>>({});

  function addMarker(threadId: string, kind: ThreadMarker["kind"]) {
    setMarkersByThread((prev) => ({
      ...prev,
      [threadId]: [...(prev[threadId] ?? []), { id: `${kind}-${(prev[threadId]?.length ?? 0) + 1}`, kind }],
    }));
  }

  return (
    <>
    <PanelStack
      projectId={projectId}
      renderBase={() => (
        <div className="flex h-full min-h-0 flex-col">
          <PanelHeader title={`Base Thread — ${project.name}`}>
            <ContextUsageMeter threadId={project.baseThreadId} />
            <IconHeaderButton icon={GitFork} label="Fork を開く" onClick={() => stack.open({ fork: "ui" })} />
            <IconHeaderButton
              icon={Clock}
              label="閉じた Fork Thread"
              onClick={() => setShowClosedForks(true)}
            />
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
              title={`Fork Thread — ${thread?.title ?? threadId}`}
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
              isMobile ? undefined : (
                <IconHeaderButton
                  icon={stack.canvasFullscreen ? Minimize2 : Maximize2}
                  label={stack.canvasFullscreen ? "全画面を解除" : "全画面で表示"}
                  onClick={() => stack.open({ canvasFullscreen: !stack.canvasFullscreen })}
                />
              )
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
    <ClosedForksPanel
      projectId={projectId}
      open={showClosedForks}
      onOpenChange={setShowClosedForks}
      onReopen={(threadId) => stack.open({ fork: threadId })}
    />
    </>
  );
}
