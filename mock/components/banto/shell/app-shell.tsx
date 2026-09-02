"use client";

// prototype の `.shell`（.rail + .rooms）に対応する外枠。
// ≥md: ProjectRail（58px 縦レール）+ PanelStack
// <md: MobileTopBar（上部バー）+ PanelStack
import { Suspense, useEffect, type ReactNode } from "react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { ArchiveDialog } from "@/components/banto/archive/archive-dialog";
import { InboxOverlay } from "@/components/banto/inbox/inbox-overlay";
import { CommandPalette } from "@/components/banto/palette/command-palette";
import { usePanelStack } from "./use-panel-stack";
import { ProjectRail } from "./project-rail";
import { MobileTopBar } from "./mobile-top-bar";

// usePanelStack が useSearchParams を使う（searchParams 駆動、§3.1）ので、
// AppShell 自身の中に Suspense 境界を持つ——呼び出し側（各 layout.tsx）に
// 「Suspense で包む」を覚えさせない。これが無いと `/settings` のような
// 静的にプリレンダーされるルートで build が失敗する
// （"useSearchParams() should be wrapped in a suspense boundary"、実測で踏んだ）
export function AppShell(props: {
  /** null＝Project の外（instance 設定 `/settings` 等）。ProjectRail のアクティブ表示だけに使う */
  projectId: string | null;
  children: ReactNode;
}) {
  return (
    <Suspense fallback={null}>
      <AppShellInner {...props} />
    </Suspense>
  );
}

function AppShellInner({
  projectId,
  children,
}: {
  projectId: string | null;
  children: ReactNode;
}) {
  // 受信箱は Project 単位の MCP 接続の外側にある入れ物（§2.4.1）——
  // どの Project を見ていても、同じ overlay 状態（searchParams）で開ける
  const stack = usePanelStack(projectId ?? "");

  // Ctrl-K / Cmd-K でどこからでも開く（§6.3「探すときの入口も1つ」）。
  // ブラウザ既定のショートカット（住所バーへのフォーカス等）を上書きする
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        stack.open({ overlay: "palette" });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [stack]);

  return (
    <SidebarProvider
      defaultOpen={false}
      style={
        {
          "--sidebar-width-icon": "58px",
        } as React.CSSProperties
      }
      className="h-svh flex-col overflow-hidden md:flex-row"
    >
      <ProjectRail
        activeProjectId={projectId}
        onOpenInbox={() => stack.open({ overlay: "inbox" })}
        onOpenPalette={() => stack.open({ overlay: "palette" })}
        onOpenArchive={() => stack.open({ overlay: "archive" })}
      />
      <MobileTopBar
        activeProjectId={projectId}
        onOpenInbox={() => stack.open({ overlay: "inbox" })}
        onOpenPalette={() => stack.open({ overlay: "palette" })}
        onOpenArchive={() => stack.open({ overlay: "archive" })}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
      <InboxOverlay
        open={stack.overlay === "inbox"}
        onOpenChange={(open) => (open ? stack.open({ overlay: "inbox" }) : stack.close("overlay"))}
      />
      <CommandPalette
        projectId={projectId}
        stack={stack}
        open={stack.overlay === "palette"}
        onOpenChange={(open) => (open ? stack.open({ overlay: "palette" }) : stack.close("overlay"))}
      />
      <ArchiveDialog
        projectId={projectId}
        open={stack.overlay === "archive"}
        onOpenChange={(open) => (open ? stack.open({ overlay: "archive" }) : stack.close("overlay"))}
        onReopenFork={(threadId) => stack.open({ fork: threadId, overlay: null })}
      />
    </SidebarProvider>
  );
}
