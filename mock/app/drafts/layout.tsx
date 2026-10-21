import type { ReactNode } from "react";
import { AppShell } from "@/components/banto/shell/app-shell";

export default function DraftsLayout({ children }: { children: ReactNode }) {
  return <AppShell projectId={null}>{children}</AppShell>;
}
