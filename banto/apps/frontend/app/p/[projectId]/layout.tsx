import type { ReactNode } from "react";
import { AppShell } from "@/components/banto/shell/app-shell";

export default async function ProjectLayout({
  params,
  children,
}: {
  params: Promise<{ projectId: string }>;
  children: ReactNode;
}) {
  const { projectId } = await params;
  return <AppShell projectId={projectId}>{children}</AppShell>;
}
