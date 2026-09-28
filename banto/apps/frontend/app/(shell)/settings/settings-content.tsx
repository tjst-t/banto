"use client";

import { Bell, Globe, Puzzle, ScrollText, SlidersHorizontal, Sparkles, SquareTerminal } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { MobileNavDrawer } from "@/components/banto/shell/mobile-nav-drawer";
import { CredentialsPanel } from "@/components/banto/settings/credentials-panel";
import { GlobalMemoryPanel } from "@/components/banto/settings/global-memory-panel";
import { ModuleConfigPane } from "@/components/banto/settings/module-config-pane";
import { NotificationSettingsPanel } from "@/components/banto/settings/notification-settings-panel";
import { RoleList } from "@/components/banto/settings/role-list";
import { InstanceModulesPanel } from "@/components/banto/settings/instance-modules-panel";
import { RuntimeDefaultsPanel } from "@/components/banto/settings/runtime-defaults-panel";
import { SkillsPanel } from "@/components/banto/settings/skills-panel";
import { ShellHomePanel } from "@/components/banto/settings/shell-home-panel";
import { useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { getProject } from "@/lib/mock/projects";
import { ProjectInitial } from "@/components/banto/shell/nav-panel";
import {
  ProjectSettingsContent,
  projectSearchEntries,
  useProjectCategories,
  useProjectModuleItems,
} from "@/components/banto/settings/project-settings-content";
import {
  SettingsShell,
  type SearchEntry,
  type SettingsNavGroup,
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
import { useEscapeLeaveSettings } from "@/hooks/use-escape-leave-settings";
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
  { section: "roles", label: "Module", icon: Puzzle },
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

/** 実 banto に繋がった Module の一覧（2026-09-15）。 */
const INSTANCE_MODULES_CATEGORY: SettingsNavItem = {
  section: "roles",
  label: "Module",
  icon: Puzzle,
};

/** Shell 専用のホームに写すもの（2026-09-23）。 */
const SHELL_HOME_CATEGORY: SettingsNavItem = { section: "shell-home", label: "Shell のホーム", icon: SquareTerminal };

/** どの Skill を既定で効かせるか（2026-09-23、アーキ仕様 §5.7）。 */
const SKILLS_CATEGORY: SettingsNavItem = { section: "skills", label: "Skill", icon: ScrollText };

const CATEGORIES: readonly SettingsNavItem[] = [
  ...(CONNECTED_FEATURES.settings
    ? MOCK_CATEGORIES
    : CONNECTED_FEATURES.instanceModules
      ? [INSTANCE_MODULES_CATEGORY]
      : []),
  ...(CONNECTED_FEATURES.skills ? [SKILLS_CATEGORY] : []),
  ...(CONNECTED_FEATURES.shellHome ? [SHELL_HOME_CATEGORY] : []),
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
  if (section === "skills") {
    return <SkillsPanel />;
  }
  if (section === "shell-home") {
    return <ShellHomePanel />;
  }
  if (section === "roles") {
    return (
      <div>
        <SectionHeading
          title="Module"
          description="banto 全体で使う Module の一覧。同じ役割を複数の Module が提供できます。"
        />
        {/* **繋がっているほうを出す**（2026-09-15）。モックの `RoleList` は
            `lib/mock/settings.ts` の固定データなので、繋がった今は出さない（規則13） */}
        {CONNECTED_FEATURES.settings ? <RoleList /> : <InstanceModulesPanel />}
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
  // item14でModuleが増減しうるので、索引は静的定数にせずバージョンが
  // 変わるたびに組み直す（規則3——導出できる値を保存しない）
  useMockStoreVersion();
  // **実 Module の設定面**（MCP Apps の設定 Canvas）。左メニューにも右側にも
  // 同じ一覧を使う（規則3）
  const { canvases } = useModuleSettingsCanvases(INSTANCE_OWNER);
  const isMobile = useIsMobile();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // **設定画面は1つ**（§6.16）。どの Project の層を出すかは URL、開いている節も URL
  // ——画面が自分の中に覚えていると、外（サイドバー）から節を変えられない（規則3）
  const projectId = searchParams.get("project");
  const project = projectId ? getProject(projectId) : undefined;
  // Escape は**一発で設定から抜ける**（改訂・2026-09-28、ユーザー要望）——節をいくつ移っていても
  useEscapeLeaveSettings(projectId);
  const section = searchParams.get("section");
  const projectCategories = useProjectCategories(projectId ?? "");
  const projectModuleItems = useProjectModuleItems(projectId ?? "");

  /**
   * 節の行き来を**履歴に残す**（改訂・2026-09-11、ユーザー要望）。
   *
   * 以前は `replace` で URL だけ書き換えていたので、**戻るが効かなかった**
   * ——狭い画面では節を開くと左メニューが消えるので、戻れないのは特に不便
   * （§6.16 の「開いている節は URL が持つ」の帰結を、履歴にも通す）。
   *
   * **一覧へ戻るのは `back()`。** 新しい履歴を積むと「戻る」で節に戻ってしまう
   * ——ただし積んだ覚えが無いとき（直接その節を開いたとき）は、戻る先が
   * banto の外なので、代わりに書き換える（規則2——行き場を失わせない）。
   */
  const pushedSections = useRef(0);
  function goToSection(next: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (next) params.set("section", next);
    else params.delete("section");
    const query = params.toString();
    const href = query ? `${pathname}?${query}` : pathname;
    if (next) {
      pushedSections.current += 1;
      router.push(href, { scroll: false });
      return;
    }
    if (pushedSections.current > 0) {
      pushedSections.current -= 1;
      router.back();
      return;
    }
    router.replace(href, { scroll: false });
  }

  const instanceModuleItems = [
    ...canvases.map((c) => ({ id: c.server, name: c.name ?? c.server })),
    ...(CONNECTED_FEATURES.settings ? getConfigurableImplementations() : []),
  ];

  const groups: SettingsNavGroup[] = [
    { label: "banto 全体", startsLayer: true, items: CATEGORIES },
    {
      label: instanceModuleItems.length > 0 ? "Module ごとの設定" : undefined,
      items: instanceModuleItems.map((impl) => ({
        section: `module:${impl.id}`,
        label: impl.name,
        icon: Puzzle,
      })),
    },
  ];
  if (projectId && project) {
    // **層の変わり目**——見出しの左に頭文字を出して、サイドバーの Project と繋げる
    groups.push({
      label: project.name,
      labelBadge: <ProjectInitial project={project} active={false} />,
      startsLayer: true,
      items: projectCategories,
    });
    groups.push({
      label: projectModuleItems.length > 0 ? "この Project の Module 設定" : undefined,
      items: projectModuleItems.map((impl) => ({
        section: `project-module:${impl.id}`,
        label: impl.name,
        icon: Puzzle,
      })),
    });
  }

  function renderContent(target: SettingsSection) {
    if (projectId && target.startsWith("project-")) {
      return <ProjectSettingsContent projectId={projectId} section={target} />;
    }
    return renderSection(target, canvases);
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* モバイルはサイドバーが無いので、ここにも同じナビの入口を置く
          ——設定に入ったら Project へ戻れない、をなくす */}
      {isMobile ? (
        <header className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border px-2">
          <MobileNavDrawer projectId={projectId} />
          <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">設定</p>
        </header>
      ) : null}
      <div className="min-h-0 flex-1">
        <SettingsShell
          groups={groups}
          renderContent={renderContent}
          extraSearchEntries={[
            ...buildSearchEntries(),
            ...(projectId ? projectSearchEntries(projectId) : []),
          ]}
          section={section}
          onSectionChange={goToSection}
        />
      </div>
    </div>
  );
}
