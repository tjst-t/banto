"use client";

import type { ReactNode } from "react";
import { ArrowLeft, GitFork, Maximize2, Minimize2, X } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { PanelStack } from "@/components/banto/shell/panel-stack";
import { usePanelStack } from "@/components/banto/shell/use-panel-stack";
import { ThreadPanel } from "@/components/banto/thread/thread-panel";
import { getProject } from "@/lib/mock/projects";
import { getThread } from "@/lib/mock/threads";

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

function HeaderButton({
  onClick,
  icon: Icon,
  children,
}: {
  onClick: () => void;
  icon?: typeof ArrowLeft;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs text-ink-2 hover:bg-accent"
    >
      {Icon ? <Icon className="size-3.5" /> : null}
      {children}
    </button>
  );
}

function PlaceholderPanel({ label, tint }: { label: string; tint: string }) {
  return (
    <div className={`flex h-full min-h-0 flex-col gap-3 overflow-auto p-4 ${tint}`}>
      <p className="text-sm font-medium text-foreground">{label}</p>
      <p className="text-xs text-ink-3">Step 5 でここに Module の面が入る</p>
    </div>
  );
}

export function ProjectPanels({ projectId }: { projectId: string }) {
  const stack = usePanelStack(projectId);
  const project = getProject(projectId);
  // モバイルはすでに MobileTopBar 以外の全画面を使っているので、
  // 全画面トグルは無意味（押しても見た目が変わらない）——desktop だけに出す
  const isMobile = useIsMobile();

  return (
    <PanelStack
      projectId={projectId}
      renderBase={() => (
        <div className="flex h-full min-h-0 flex-col">
          <PanelHeader title={`Base Thread — ${project.name}`}>
            <HeaderButton icon={GitFork} onClick={() => stack.open({ fork: "ui" })}>
              Fork を開く
            </HeaderButton>
            <HeaderButton
              onClick={() => stack.open({ canvas: { moduleId: "banto.repo", viewId: "diff" } })}
            >
              Canvas を開く
            </HeaderButton>
          </PanelHeader>
          <div className="min-h-0 flex-1">
            <ThreadPanel threadId={project.baseThreadId} />
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
            />
            <div className="min-h-0 flex-1">
              <ThreadPanel threadId={threadId} />
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
            <PlaceholderPanel label={`${moduleId}:${viewId}`} tint="bg-surface-2" />
          </div>
        </div>
      )}
    />
  );
}
