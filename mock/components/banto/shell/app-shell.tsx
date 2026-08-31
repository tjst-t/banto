"use client";

// prototype の `.shell`（.rail + .rooms）に対応する外枠。
// ≥md: ProjectRail（58px 縦レール）+ PanelStack
// <md: MobileTopBar（上部バー）+ PanelStack
import type { ReactNode } from "react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { ProjectRail } from "./project-rail";
import { MobileTopBar } from "./mobile-top-bar";

export function AppShell({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
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
      <ProjectRail activeProjectId={projectId} />
      <MobileTopBar activeProjectId={projectId} />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
    </SidebarProvider>
  );
}
