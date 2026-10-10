"use client";

import { ArrowUpCircle, Bell, Gauge, Puzzle, Server, SlidersHorizontal, Sparkles } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { MobileNavDrawer } from "@/components/banto/shell/mobile-nav-drawer";
import { CredentialsPanel } from "@/components/banto/settings/credentials-panel";
import { ModuleConfigPane } from "@/components/banto/settings/module-config-pane";
import { NotificationSettingsPanel } from "@/components/banto/settings/notification-settings-panel";
import { RoleList } from "@/components/banto/settings/role-list";
import { RuntimeDefaultsPanel } from "@/components/banto/settings/runtime-defaults-panel";
import { UpdatePanel } from "@/components/banto/settings/update-panel";
import { ResourcesPanel } from "@/components/banto/settings/resources-panel";
import { RuntimesPanel } from "@/components/banto/settings/runtimes-panel";
import {
  SettingsShell,
  type SearchEntry,
  type SettingsNavGroup,
  type SettingsNavItem,
  type SettingsSection,
} from "@/components/banto/settings/settings-shell";
import {
  PROJECT_CATEGORIES,
  ProjectSettingsContent,
  projectConfigurableModules,
  projectSearchEntries,
} from "@/components/banto/settings/project-settings-content";
import {
  getConfigurableImplementations,
  getImplementation,
  mockCredentials,
  mockModuleConfigFields,
  getRoles,
} from "@/lib/mock/settings";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { getProject } from "@/lib/mock/projects";
import { ProjectInitial } from "@/components/banto/shell/nav-panel";
import { useEscapeNavigateBack } from "@/hooks/use-escape-navigate-back";
import { useMockStoreVersion } from "@/lib/mock/store-events";

const CATEGORIES: readonly SettingsNavItem[] = [
  { section: "roles", label: "役割と Module", icon: Puzzle },
  { section: "defaults", label: "既定値", icon: SlidersHorizontal },
  { section: "credentials", label: "資格情報", icon: Sparkles },
  { section: "notifications", label: "通知", icon: Bell },
  { section: "resources", label: "資源", icon: Gauge },
  { section: "runtimes", label: "実行場所", icon: Server },
  { section: "update", label: "更新", icon: ArrowUpCircle },
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
  { label: "既定の permissionMode", anchorId: "anchor-default-permission-mode" },
];

const NOTIFICATION_ENTRIES = [{ label: "デスクトップ通知", anchorId: "anchor-notifications-permission" }];

const UPDATE_ENTRIES = [{ label: "今の版" }, { label: "新しいコミット" }];

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

  const updateEntries = UPDATE_ENTRIES.map((e) => ({ section: "update" as const, label: e.label }));

  const moduleConfigEntries = getConfigurableImplementations().flatMap((impl) =>
    (mockModuleConfigFields[impl.id] ?? []).map((field, i) => ({
      section: `module:${impl.id}` as const,
      label: field.label,
      anchorId: `anchor-module-config-${impl.id}-${i}`,
    })),
  );

  return [
    ...roleEntries,
    ...defaultEntries,
    ...credentialEntries,
    ...notificationEntries,
    ...updateEntries,
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

function renderInstanceSection(section: SettingsSection) {
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
  if (section === "resources") {
    return (
      <div>
        <SectionHeading
          title="資源"
          description="この機械と Project のコンテナが、いま何にどれだけ使っているか。混んでいるときは、何が使っているかを開いて見られます。"
        />
        <ResourcesPanel />
      </div>
    );
  }
  if (section === "runtimes") {
    return (
      <div>
        <SectionHeading
          title="実行場所"
          description="Project をどこで動かすか。既定はこの機械のコンテナです。別のサーバを登録すると、新しい Project を作るときに選べます。"
        />
        <RuntimesPanel />
      </div>
    );
  }
  if (section === "update") {
    return (
      <div>
        <SectionHeading
          title="更新"
          description="banto を GitHub の新しい版にします。押す前に、何が入るかを読めます。"
        />
        <UpdatePanel />
      </div>
    );
  }

  const implementationId = section.slice("module:".length);
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

/**
 * **設定画面は1つ**（決定・2026-09-11、ユーザー要望——「全体設定と Project 設定が
 * 全然ちがうところに表示される」）。左メニューを見出しで層に分ける：
 * **banto 全体**と**この Project ＜名前＞**。VSCode の User / Workspace と同じ考え方
 * （規則12）——どちらの層を触っているかが常に見えている（§6.1 の2階層）。
 *
 * どの Project の設定かは `?project=<id>`。会話のヘッダの歯車はここへ
 * `?section=project-modules` 付きで来るので、押した場所に応じた節が開く。
 */
export function SettingsContent() {
  useEscapeNavigateBack();
  // item14でModuleが増減しうるので、索引は静的定数にせずバージョンが
  // 変わるたびに組み直す（規則3——導出できる値を保存しない）
  useMockStoreVersion();
  const isMobile = useIsMobile();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const projectId = searchParams.get("project");
  const project = projectId ? getProject(projectId) : undefined;
  // **いま開いている節は URL が持つ**（決定・2026-09-11）——サイドバーで別の
  // Project を選んだときに、外から節を変えられるようにするため（規則3）
  const section = searchParams.get("section");

  function goToSection(next: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (next) params.set("section", next);
    else params.delete("section");
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  const instanceModules = getConfigurableImplementations();
  const projectModules = projectId ? projectConfigurableModules(projectId) : [];

  const groups: SettingsNavGroup[] = [
    { label: "banto 全体", startsLayer: true, items: CATEGORIES },
    {
      label: instanceModules.length > 0 ? "全体の Module 設定" : undefined,
      items: instanceModules.map((impl) => ({
        section: `module:${impl.id}`,
        label: impl.name,
        icon: Puzzle,
      })),
    },
  ];
  if (projectId && project) {
    // **層の変わり目**——ここで線を引く。見出しの左に頭文字を出して、
    // サイドバーの Project と同じものだと分かるようにする
    groups.push({
      label: project.name,
      labelBadge: <ProjectInitial project={project} active={false} />,
      startsLayer: true,
      items: PROJECT_CATEGORIES,
    });
    groups.push({
      label: projectModules.length > 0 ? "この Project の Module 設定" : undefined,
      items: projectModules.map((impl) => ({
        section: `project-module:${impl.id}`,
        label: impl.name,
        icon: Puzzle,
      })),
    });
  }

  function renderContent(section: SettingsSection) {
    if (projectId && (section.startsWith("project-") || section.startsWith("project-module:"))) {
      if (section.startsWith("project-module:")) {
        const implementationId = section.slice("project-module:".length);
        const impl = getImplementation(implementationId);
        return (
          <div>
            <SectionHeading
              title={impl?.name ?? implementationId}
              description="この Module 自身が持ち込む設定（この Project の文脈）。"
            />
            <ModuleConfigPane implementationId={implementationId} projectId={projectId} />
          </div>
        );
      }
      return <ProjectSettingsContent projectId={projectId} section={section} />;
    }
    return renderInstanceSection(section);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* モバイルはサイドバーが無いので、ここにも同じナビの入口を置く
          ——設定に入ったら Project へ戻れない、をなくす */}
      {isMobile ? (
        <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border px-2">
          <MobileNavDrawer projectId={projectId} />
          <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">設定</p>
        </div>
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
