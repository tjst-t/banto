"use client";

import { Bell, Globe, Puzzle, SlidersHorizontal, Sparkles } from "lucide-react";
import { CredentialsPanel } from "@/components/banto/settings/credentials-panel";
import { GlobalMemoryPanel } from "@/components/banto/settings/global-memory-panel";
import { ModuleConfigPane } from "@/components/banto/settings/module-config-pane";
import { NotificationSettingsPanel } from "@/components/banto/settings/notification-settings-panel";
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
  getRoles,
} from "@/lib/mock/settings";
import { useEscapeNavigateBack } from "@/hooks/use-escape-navigate-back";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import { CONNECTED_FEATURES } from "@/lib/feature-flags";
import {
  ModuleSettingsPanel,
  useModuleSettingsCanvases,
  type SettingsCanvas,
} from "@/components/banto/settings/module-settings-panel";

// mockのまま（Module/Role/Credential/Runtime既定/通知）——`settings`が
// falseの間はnavから外す。繋がっていない入口を画面に残さない（規則13）。
const MOCK_CATEGORIES: readonly SettingsNavItem[] = [
  { section: "roles", label: "役割と Module", icon: Puzzle },
  { section: "defaults", label: "既定値", icon: SlidersHorizontal },
  { section: "credentials", label: "資格情報", icon: Sparkles },
  { section: "notifications", label: "通知", icon: Bell },
];

// 実bantoホストに繋がっているセクション（§2.2、決定・2026-09-05）。
const GLOBAL_MEMORY_CATEGORY: SettingsNavItem = {
  section: "global-memory",
  label: "Global Memory",
  icon: Globe,
};

const CATEGORIES: readonly SettingsNavItem[] = [
  ...(CONNECTED_FEATURES.settings ? MOCK_CATEGORIES : []),
  ...(CONNECTED_FEATURES.globalMemory ? [GLOBAL_MEMORY_CATEGORY] : []),
];

/** banto 全体に1本ある Module（Vault 等）。**Project ごとに立つ Module の設定は
 *  Project 設定に出る**——置き場はその Module の scope が決める（決定・2026-09-07）。 */
const INSTANCE_OWNER = { kind: "instance" } as const;

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
  { label: "既定の permissionMode", anchorId: "anchor-default-permission-mode" },
];

const NOTIFICATION_ENTRIES = [{ label: "デスクトップ通知", anchorId: "anchor-notifications-permission" }];

function buildSearchEntries(): readonly SearchEntry[] {
  const roleEntries = getRoles().flatMap((role) => [
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

  const notificationEntries = NOTIFICATION_ENTRIES.map((e) => ({
    section: "notifications" as const,
    label: e.label,
    anchorId: e.anchorId,
  }));

  const moduleConfigEntries = getConfigurableImplementations().flatMap((impl) =>
    (mockModuleConfigFields[impl.id] ?? []).map((field, i) => ({
      section: `module:${impl.id}` as const,
      label: field.label,
      anchorId: `anchor-module-config-${impl.id}-${i}`,
    })),
  );

  // 索引もnavと同じ基準で絞る——検索から、繋がっていない画面へ飛べてしまわない
  if (!CONNECTED_FEATURES.settings) return [];
  return [
    ...roleEntries,
    ...defaultEntries,
    ...credentialEntries,
    ...notificationEntries,
    ...moduleConfigEntries,
  ];
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-4">
      <h1 className="text-lg font-semibold text-foreground">{title}</h1>
      <p className="mt-0.5 text-xs text-ink-3">{description}</p>
    </div>
  );
}

function renderSection(section: SettingsSection, canvases: readonly SettingsCanvas[]) {
  if (section === "global-memory") {
    return <GlobalMemoryPanel />;
  }
  if (section === "roles") {
    return (
      <div>
        <SectionHeading
          title="役割と Module"
          description="役割ごとに、満たす実装・プロセス境界・無ければ何が断るかを表示する。同じ役割を複数の実装が名乗ってよい。"
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
          description="新規 Project・新規 Thread の初期値。Project は個別に上書きできる。"
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
          description="複数登録して使い分ける。鍵そのものは Vault が持ち、ここには出さない。"
        />
        <CredentialsPanel />
      </div>
    );
  }
  if (section === "notifications") {
    return (
      <div>
        <SectionHeading
          title="通知"
          description="判断待ち・レビュー待ちが新着したとき、受信箱のバッジ以外にも気づけるようにする。"
        />
        <NotificationSettingsPanel />
      </div>
    );
  }

  const implementationId = section.slice("module:".length);
  // **実 Module の設定面が先**（決定・2026-09-07）——同じ枠に、本物があれば本物を出す
  const canvas = canvases.find((c) => c.server === implementationId);
  if (canvas) {
    return <ModuleSettingsPanel owner={INSTANCE_OWNER} canvas={canvas} />;
  }

  const impl = getImplementation(implementationId);
  return (
    <div>
      <SectionHeading
        title={impl?.name ?? implementationId}
        description="この Module 自身が持ち込む設定。"
      />
      <ModuleConfigPane implementationId={implementationId} />
    </div>
  );
}

export function SettingsContent() {
  useEscapeNavigateBack();
  // item14でModuleが増減しうるので、索引は静的定数にせずバージョンが
  // 変わるたびに組み直す（規則3——導出できる値を保存しない）
  useMockStoreVersion();
  // **実 Module の設定面**（MCP Apps の設定 Canvas）。左メニューにも右側にも
  // 同じ一覧を使う（規則3）
  const { canvases } = useModuleSettingsCanvases(INSTANCE_OWNER);
  const moduleItems = [
    ...canvases.map((c) => ({ id: c.server, name: c.name ?? c.server })),
    ...(CONNECTED_FEATURES.settings ? getConfigurableImplementations() : []),
  ];
  return (
    <div className="min-h-0 flex-1">
      <SettingsShell
        categories={CATEGORIES}
        moduleImplementations={moduleItems}
        renderContent={(section) => renderSection(section, canvases)}
        extraSearchEntries={buildSearchEntries()}
      />
    </div>
  );
}
