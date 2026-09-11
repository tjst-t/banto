"use client";

// 階層2：この Project（§6.1）。階層1（`/settings`、instance level）と
// 同じ SettingsShell（左メニュー＋右詳細、決定・2026-09-02）を使う——
// Project 側にも「role→実装の一覧」と「Module 自身の設定面」という同じ形が
// 出てくると分かった以上、専用の狭い Sheet に押し込める理由が無い（レビュー
// 指摘：「Project 単位で Module の設定画面を出せるとなると、右から出てくる
// メニューでは足りない」）。Module 自身の設定面には `projectId` を渡す
// （§6.2「設定面への Project の文脈」）——instance 側の同じ Module の設定と
// 見比べると、Project 単位の中身（Vault の alias 等）が増えているのが分かる
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { BookMarked, Plus, Puzzle, ShieldAlert, SlidersHorizontal, Trash2, TriangleAlert, Wrench } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ModuleConfigPane } from "@/components/banto/settings/module-config-pane";
import { ProjectModulesPanel } from "@/components/banto/settings/project-modules-panel";
import { ProjectGeneralPanel } from "@/components/banto/settings/project-general-panel";
import { ProjectMemoryPanel } from "@/components/banto/settings/project-memory-panel";
import {
  SettingsShell,
  type SearchEntry,
  type SettingsNavItem,
  type SettingsSection,
} from "@/components/banto/settings/settings-shell";
import { CascadeRow } from "@/components/banto/settings/cascade-row";
import { DisableImpactDialog } from "@/components/banto/settings/disable-impact-dialog";
import { reportFailure } from "@/lib/report-failure";
import { closeProject, getActiveProjects, getProject } from "@/lib/mock/projects";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import {
  getBreaksIfDisabled,
  getImplementation,
  getProjectModuleLinks,
  getProjectOverrides,
  mockCredentials,
  getRoles,
  MOCK_PERMISSION_MODES,
  mockRuntimeDefaults,
} from "@/lib/mock/settings";
import { CONNECTED_FEATURES } from "@/lib/feature-flags";
import { ModuleSettingsPanel, useModuleSettingsCanvases } from "@/components/banto/settings/module-settings-panel";
import type { MockModuleImplementation, MockProjectOverrides } from "@/lib/mock/types";

// project-modules/overrides/securityは実バックエンドに繋がっていない
// （Module紐付け・カスケード上書き・セキュリティ境界の変更を実際に反映する
// 経路が無い、規則13）——CONNECTED_FEATURES.settings（instance設定と同じ、
// mock/settings.ts丸ごと）で隠す。project-danger（Project終了）は
// Stage 1で実API接続済み、project-memoryはStage 3で新設
const MOCK_CATEGORIES: readonly SettingsNavItem[] = [
  { section: "project-overrides", label: "既定値の上書き", icon: SlidersHorizontal },
  { section: "project-security", label: "セキュリティ境界", icon: ShieldAlert },
];

/** この Project で使う Module を選ぶ（実データに繋がっている、2026-09-11） */
const MODULES_CATEGORY: SettingsNavItem = {
  section: "project-modules",
  label: "この Project の Module",
  icon: Puzzle,
};

/** **この Project そのもの**（名前・根・危険な操作）。層のいちばん上（2026-09-11） */
const GENERAL_CATEGORY: SettingsNavItem = { section: "project-general", label: "一般", icon: Wrench };
const MEMORY_CATEGORY: SettingsNavItem = { section: "project-memory", label: "Memory", icon: BookMarked };

export function projectSearchEntries(projectId: string): readonly SearchEntry[] {
  const links = getProjectModuleLinks(projectId);
  const moduleEntries = getRoles().flatMap((role) =>
    role.implementations
      .filter((impl) => links.some((l) => l.id === impl.id))
      .map((impl) => ({
        section: "project-modules" as const,
        label: impl.name,
        anchorId: `anchor-project-impl-${impl.id}`,
      })),
  );
  return moduleEntries;
}

/**
 * **Project の層の、節1つぶん**（改訂・2026-09-11、モックで確認——§6.16
 * 「設定画面は1つ」）。骨格（SettingsShell）は `/settings` が1つだけ持つ。
 */
export function ProjectSettingsContent({
  projectId,
  section,
}: {
  projectId: string;
  section: SettingsSection;
}) {
  useMockStoreVersion();
  const project = getProject(projectId);
  const baseline = getProjectOverrides(projectId);
  const [overrides, setOverrides] = useState<MockProjectOverrides>(baseline);
  const links = getProjectModuleLinks(projectId);
  const [removeTarget, setRemoveTarget] = useState<MockModuleImplementation | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const router = useRouter();

  function patch(next: Partial<MockProjectOverrides>) {
    setOverrides((prev) => ({ ...prev, ...next }));
  }

  async function handleClose() {
    try {
      await closeProject(projectId);
    } catch (err) {
      // **閉じられなかったのに、閉じた先へ飛ばさない**（改訂・2026-09-10）
      reportFailure("Project を Close できませんでした", err);
      return;
    }
    setConfirmClose(false);
    const next = getActiveProjects().find((p) => p.id !== projectId);
    router.push(next ? `/p/${next.id}` : "/settings");
  }

  // **実 Module の設定面**（MCP Apps の設定 Canvas）。左メニューにも右側にも
  // 同じ一覧を使う（規則3）。mock Project には対応する Module が無いので出ない
  const { canvases: settingsCanvases } = useModuleSettingsCanvases(
    useMemo(() => ({ kind: "project" as const, id: projectId }), [projectId]),
  );
  const moduleImplementations = [
    ...(project?.real ? settingsCanvases.map((c) => ({ id: c.server, name: c.name ?? c.server })) : []),
    ...links.filter((i) => i.hasConfigSurface && i.enabled),
  ];
  // Memoryは実bantoホストのProjectに紐づく（決定・2026-09-05）——mock Projectには
  // 対応するProjectが無い（規則13、繋がっていないものは見せない）
  const showMemory = CONNECTED_FEATURES.memory && project?.real;

  function renderSection(section: SettingsSection) {
    if (section === "project-general") {
      // 名前・根・危険な操作（Close）は1つの面に——移したのは配置だけ（2026-09-11）
      return <ProjectGeneralPanel projectId={projectId} />;
    }
    if (section === "project-memory" && project) {
      return <ProjectMemoryPanel projectId={project.id} />;
    }
    if (section === "project-modules") {
      // 実データに繋がっている（`phase1-project-modules-ui`、2026-09-11）
      return <ProjectModulesPanel projectId={projectId} />;
    }

    if (section === "project-overrides") {
      return (
        <div>
          <h1 className="mb-0.5 text-lg font-semibold text-foreground">既定値の上書き</h1>
          <p className="mb-4 text-xs text-ink-3">
            instance 既定（<a href="/settings" className="underline">/settings</a>）を、この
            Project だけ上書きする。
          </p>
          <div className="rounded-md border border-border px-3">
            <CascadeRow
              id="override-model"
              label="既定モデル"
              inheritedLabel={mockRuntimeDefaults.model}
              overridden={overrides.model !== undefined}
              onToggle={(on) => patch({ model: on ? mockRuntimeDefaults.model : undefined })}
            >
              <Select value={overrides.model} onValueChange={(v) => patch({ model: v })}>
                <SelectTrigger className="h-8 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="claude-opus-5">claude-opus-5</SelectItem>
                  <SelectItem value="claude-sonnet-5">claude-sonnet-5</SelectItem>
                  <SelectItem value="claude-haiku-4-5-20251001">claude-haiku-4-5-20251001</SelectItem>
                </SelectContent>
              </Select>
            </CascadeRow>

            <CascadeRow
              id="override-effort"
              label="既定 reasoning effort"
              inheritedLabel={mockRuntimeDefaults.effort}
              overridden={overrides.effort !== undefined}
              onToggle={(on) => patch({ effort: on ? mockRuntimeDefaults.effort : undefined })}
            >
              <Select
                value={overrides.effort}
                onValueChange={(v) => patch({ effort: v as MockProjectOverrides["effort"] })}
              >
                <SelectTrigger className="h-8 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">low</SelectItem>
                  <SelectItem value="medium">medium</SelectItem>
                  <SelectItem value="high">high</SelectItem>
                </SelectContent>
              </Select>
            </CascadeRow>

            <CascadeRow
              id="override-memory"
              label="Memory 上限文字数"
              inheritedLabel={`${mockRuntimeDefaults.memoryLimitChars.toLocaleString()} 文字`}
              overridden={overrides.memoryLimitChars !== undefined}
              onToggle={(on) =>
                patch({ memoryLimitChars: on ? mockRuntimeDefaults.memoryLimitChars : undefined })
              }
            >
              <Input
                type="number"
                className="h-8"
                value={overrides.memoryLimitChars ?? mockRuntimeDefaults.memoryLimitChars}
                onChange={(e) => patch({ memoryLimitChars: Number(e.target.value) })}
              />
            </CascadeRow>

            <CascadeRow
              id="override-permission-mode"
              label="既定の permissionMode"
              inheritedLabel={mockRuntimeDefaults.defaultPermissionMode}
              overridden={overrides.defaultPermissionMode !== undefined}
              onToggle={(on) =>
                patch({
                  defaultPermissionMode: on ? mockRuntimeDefaults.defaultPermissionMode : undefined,
                })
              }
            >
              <Select
                value={overrides.defaultPermissionMode}
                onValueChange={(v) =>
                  patch({ defaultPermissionMode: v as MockProjectOverrides["defaultPermissionMode"] })
                }
              >
                <SelectTrigger className="h-8 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MOCK_PERMISSION_MODES.map((m) => (
                    <SelectItem key={m.value} value={m.value} className={m.danger ? "text-warn" : undefined}>
                      {m.label} — {m.description}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CascadeRow>

            <CascadeRow
              id="override-credential"
              label="使う資格情報"
              inheritedLabel="自動選択（使用率の低いものへ自動で移る）"
              overridden={overrides.credentialId !== undefined}
              onToggle={(on) => patch({ credentialId: on ? mockCredentials[0].id : undefined })}
            >
              <Select value={overrides.credentialId} onValueChange={(v) => patch({ credentialId: v })}>
                <SelectTrigger className="h-8 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {mockCredentials.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.label}
                      {c.usagePercent !== undefined ? `（${c.usagePercent}% 使用）` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CascadeRow>
          </div>
        </div>
      );
    }

    if (section === "project-security") {
      return (
        <div>
          <h1 className="mb-0.5 flex items-center gap-1.5 text-lg font-semibold text-foreground">
            <ShieldAlert className="size-4 text-ink-3" />
            セキュリティ境界
          </h1>
          <p className="mb-3 text-xs text-ink-3">
            Shell・FileSystem をこの根に閉じ込める。
          </p>
          <Input
            value={overrides.securityRoot}
            onChange={(e) => patch({ securityRoot: e.target.value })}
            className="h-8 font-mono text-xs"
          />
        </div>
      );
    }

    // 層ごとに別の節（`project-module:` と `module:`）——1つの画面に両方の層が
    // 並ぶので、id が衝突しないようにする（§6.16）
    const implementationId = section.startsWith("project-module:")
      ? section.slice("project-module:".length)
      : section.slice("module:".length);
    // **実 Module の設定面が先**（決定・2026-09-07、ユーザー指摘）
    // ——モックが決めた枠（左メニューに Module、右側いっぱい）に本物を流し込む
    const canvas = settingsCanvases.find((c) => c.server === implementationId);
    if (canvas) {
      return <ModuleSettingsPanel owner={{ kind: "project", id: projectId }} canvas={canvas} />;
    }

    const impl = getImplementation(implementationId);
    return (
      <div>
        <h1 className="mb-0.5 text-lg font-semibold text-foreground">{impl?.name ?? implementationId}</h1>
        <p className="mb-3 text-xs text-ink-3">この Module 自身が持ち込む設定。</p>
        <ModuleConfigPane implementationId={implementationId} projectId={projectId} />
      </div>
    );
  }

  return <>{renderSection(section)}</>;
}

/**
 * この Project の層に出す節。**繋がっているものだけ**（規則13）——
 * 実データに繋がっていない節は `CONNECTED_FEATURES` で落ちる。
 */
export function useProjectCategories(projectId: string): readonly SettingsNavItem[] {
  useMockStoreVersion();
  const project = getProject(projectId);
  const showMemory = CONNECTED_FEATURES.memory && project?.real;
  return [
    // **いちばん上は「一般」**（名前・根・Close）——この Project が何者か、が先
    ...(project?.real ? [GENERAL_CATEGORY] : []),
    // 実 Project だけ——mock Project には対応する Project が host に無い（規則13）
    ...(CONNECTED_FEATURES.projectModules && project?.real ? [MODULES_CATEGORY] : []),
    ...(CONNECTED_FEATURES.settings ? MOCK_CATEGORIES : []),
    ...(showMemory ? [MEMORY_CATEGORY] : []),
  ];
}

/** この Project の文脈で設定面を出せる Module（左メニューの見出しの下に並ぶ） */
export function useProjectModuleItems(projectId: string): readonly { id: string; name: string }[] {
  useMockStoreVersion();
  const project = getProject(projectId);
  const links = getProjectModuleLinks(projectId);
  const { canvases } = useModuleSettingsCanvases(
    useMemo(() => ({ kind: "project" as const, id: projectId }), [projectId]),
  );
  return [
    ...(project?.real ? canvases.map((c) => ({ id: c.server, name: c.name ?? c.server })) : []),
    ...links.filter((i) => i.hasConfigSurface && i.enabled).map((i) => ({ id: i.id, name: i.name })),
  ];
}
