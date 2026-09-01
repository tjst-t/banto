"use client";

import { Puzzle, SlidersHorizontal, Sparkles } from "lucide-react";
import { CredentialsPanel } from "@/components/banto/settings/credentials-panel";
import { ModuleConfigPane } from "@/components/banto/settings/module-config-pane";
import { RoleList } from "@/components/banto/settings/role-list";
import { RuntimeDefaultsPanel } from "@/components/banto/settings/runtime-defaults-panel";
import {
  SettingsShell,
  type SearchEntry,
  type SettingsNavItem,
  type SettingsSection,
} from "@/components/banto/settings/settings-shell";
import {
  getConfigurableImplementations,
  getImplementation,
  mockCredentials,
  mockModuleConfigFields,
  mockRoles,
} from "@/lib/mock/settings";

const CATEGORIES: readonly SettingsNavItem[] = [
  { section: "roles", label: "役割と Module", icon: Puzzle },
  { section: "defaults", label: "既定値", icon: SlidersHorizontal },
  { section: "credentials", label: "資格情報", icon: Sparkles },
];

// 検索が右側の中身も対象にするための索引（レビュー指摘、2026-09-01）。
// ラベルはここで作らず、実際に描画している値をそのまま引く——真実は
// RoleList・RuntimeDefaultsPanel・CredentialsPanel・ModuleConfigPane 側の
// データにあり、ここはそれを検索用に並べ直すだけ（規則3）。
// `anchorId` は各コンポーネントに実際に付けた DOM id と一致させる——
// クリックしたら該当箇所までスクロール＋ハイライトする（レビュー指摘）
const RUNTIME_DEFAULT_ENTRIES = [
  { label: "既定モデル", anchorId: "anchor-default-model" },
  { label: "既定 reasoning effort", anchorId: "anchor-default-effort" },
  { label: "Memory 上限文字数", anchorId: "anchor-default-memory" },
];

function buildSearchEntries(): readonly SearchEntry[] {
  const roleEntries = mockRoles.flatMap((role) => [
    { section: "roles" as const, label: role.name, anchorId: `anchor-role-${role.id}` },
    ...role.implementations.map((impl) => ({
      section: "roles" as const,
      label: impl.name,
      anchorId: `anchor-impl-${impl.id}`,
    })),
  ]);

  const defaultEntries = RUNTIME_DEFAULT_ENTRIES.map((e) => ({
    section: "defaults" as const,
    label: e.label,
    anchorId: e.anchorId,
  }));

  const credentialEntries = mockCredentials.map((c) => ({
    section: "credentials" as const,
    label: c.label,
    anchorId: `anchor-credential-${c.id}`,
  }));

  const moduleConfigEntries = getConfigurableImplementations().flatMap((impl) =>
    (mockModuleConfigFields[impl.id] ?? []).map((field, i) => ({
      section: `module:${impl.id}` as const,
      label: field.label,
      anchorId: `anchor-module-config-${impl.id}-${i}`,
    })),
  );

  return [...roleEntries, ...defaultEntries, ...credentialEntries, ...moduleConfigEntries];
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-4">
      <h1 className="text-lg font-semibold text-foreground">{title}</h1>
      <p className="mt-0.5 text-xs text-ink-3">{description}</p>
    </div>
  );
}

function renderSection(section: SettingsSection) {
  if (section === "roles") {
    return (
      <div>
        <SectionHeading
          title="役割と Module"
          description="役割ごとに、満たす実装・プロセス境界・無ければ何が断るかを表示する（§6.1）。中心は Module 一覧ではなく役割一覧——同じ役割を複数の実装が名乗ってよい。"
        />
        <RoleList />
      </div>
    );
  }
  if (section === "defaults") {
    return (
      <div>
        <SectionHeading
          title="既定値（runtime config）"
          description="新規 Project・新規 Thread の初期値（§2.6）。Project は個別に上書きできる。"
        />
        <RuntimeDefaultsPanel />
      </div>
    );
  }
  if (section === "credentials") {
    return (
      <div>
        <SectionHeading
          title="資格情報"
          description="複数登録して使い分ける。鍵そのものは Vault が持ち、ここには出さない（§2.8）。"
        />
        <CredentialsPanel />
      </div>
    );
  }

  const implementationId = section.slice("module:".length);
  const impl = getImplementation(implementationId);
  return (
    <div>
      <SectionHeading
        title={impl?.name ?? implementationId}
        description="この Module 自身が持ち込む設定。banto の Configuration ではない（§6.2）。"
      />
      <ModuleConfigPane implementationId={implementationId} />
    </div>
  );
}

const SEARCH_ENTRIES = buildSearchEntries();

export function SettingsContent() {
  return (
    <div className="min-h-0 flex-1">
      <SettingsShell
        categories={CATEGORIES}
        moduleImplementations={getConfigurableImplementations()}
        renderContent={renderSection}
        extraSearchEntries={SEARCH_ENTRIES}
      />
    </div>
  );
}
