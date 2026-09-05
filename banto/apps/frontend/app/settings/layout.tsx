import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/banto/shell/app-shell";
import { CONNECTED_FEATURES } from "@/lib/feature-flags";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  // instance設定（Module/Vault/Role/Credential/Runtime既定）はmock/settings.ts
  // 丸ごとで実bantoホストに繋がっていない（規則13）——繋ぐまでは入口自体を出さない
  if (!CONNECTED_FEATURES.settings) redirect("/");
  return <AppShell projectId={null}>{children}</AppShell>;
}
