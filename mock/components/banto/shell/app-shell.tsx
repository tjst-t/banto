"use client";

// prototype の `.shell`（.rail + .rooms）に対応する外枠。
// ≥md: ProjectRail（58px 縦レール）+ PanelStack
// <md: MobileTopBar（上部バー）+ PanelStack
import type { ReactNode } from "react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { InboxOverlay } from "@/components/banto/inbox/inbox-overlay";
import { usePanelStack } from "./use-panel-stack";
import { ProjectRail } from "./project-rail";
import { MobileTopBar } from "./mobile-top-bar";

export function AppShell({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  // 受信箱は Project 単位の MCP 接続の外側にある入れ物（§2.4.1）——
  // どの Project を見ていても、同じ overlay 状態（searchParams）で開ける
  const stack = usePanelStack(projectId);

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
      <ProjectRail activeProjectId={projectId} onOpenInbox={() => stack.open({ overlay: "inbox" })} />
      <MobileTopBar activeProjectId={projectId} onOpenInbox={() => stack.open({ overlay: "inbox" })} />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
      <InboxOverlay
        open={stack.overlay === "inbox"}
        onOpenChange={(open) => (open ? stack.open({ overlay: "inbox" }) : stack.close("overlay"))}
      />
    </SidebarProvider>
  );
}
