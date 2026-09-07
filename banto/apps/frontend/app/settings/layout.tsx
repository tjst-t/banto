import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/banto/shell/app-shell";
import { SHOW_INSTANCE_SETTINGS } from "@/lib/feature-flags";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  // instance設定のうち実bantoホストに繋がっているのはGlobal Memoryだけ
  // （Module/Vault/Role/Credential/Runtime既定はmock/settings.ts丸ごと）。
  // 繋がっているものが1つも無ければ、入口自体を出さない（規則13）——
  // 中のnavはsettings-content.tsx側でさらにセクション単位に絞る
  if (!SHOW_INSTANCE_SETTINGS) redirect("/");
  return <AppShell projectId={null}>{children}</AppShell>;
}
