import type { ReactNode } from "react";
import { AppShell } from "@/components/banto/shell/app-shell";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return <AppShell projectId={null}>{children}</AppShell>;
}
