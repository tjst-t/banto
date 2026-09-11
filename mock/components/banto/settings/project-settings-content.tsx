"use client";

// 階層2：この Project（§6.1）。階層1（`/settings`、instance level）と
// 同じ SettingsShell（左メニュー＋右詳細、決定・2026-09-02）を使う——
// Project 側にも「role→実装の一覧」と「Module 自身の設定面」という同じ形が
// 出てくると分かった以上、専用の狭い Sheet に押し込める理由が無い（レビュー
// 指摘：「Project 単位で Module の設定画面を出せるとなると、右から出てくる
// メニューでは足りない」）。Module 自身の設定面には `projectId` を渡す
// （§6.2「設定面への Project の文脈」）——instance 側の同じ Module の設定と
// 見比べると、Project 単位の中身（Vault の alias 等）が増えているのが分かる
import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Puzzle, ShieldAlert, SlidersHorizontal, TriangleAlert } from "lucide-react";
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
import { ModuleConfigPane } from "@/components/banto/settings/module-config-pane";
import { ProjectModulesPanel } from "@/components/banto/settings/project-modules-panel";
import {
  type SearchEntry,
  type SettingsNavItem,
  type SettingsSection,
} from "@/components/banto/settings/settings-shell";
import { CascadeRow } from "@/components/banto/settings/cascade-row";
import { closeProject, getActiveProjects, getProject } from "@/lib/mock/projects";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import {
  getImplementation,
  getProjectModuleLinks,
  getProjectOverrides,
  mockCredentials,
  getRoles,
  MOCK_PERMISSION_MODES,
  mockRuntimeDefaults,
} from "@/lib/mock/settings";
import type { MockProjectOverrides } from "@/lib/mock/types";

export const PROJECT_CATEGORIES: readonly SettingsNavItem[] = [
  { section: "project-modules", label: "この Project の Module", icon: Puzzle },
  { section: "project-overrides", label: "既定値の上書き", icon: SlidersHorizontal },
  { section: "project-security", label: "セキュリティ境界", icon: ShieldAlert },
  { section: "project-danger", label: "危険な操作", icon: TriangleAlert },
];

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
 * Project の設定の中身1つぶん。**設定画面は1つ**（決定・2026-09-11、ユーザー要望）
 * ——骨格（SettingsShell）は `/settings` が1つだけ持ち、ここは中身を描くだけ。
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
  const [confirmClose, setConfirmClose] = useState(false);
  const router = useRouter();

  function patch(next: Partial<MockProjectOverrides>) {
    setOverrides((prev) => ({ ...prev, ...next }));
  }

  function handleClose() {
    closeProject(projectId);
    setConfirmClose(false);
    const next = getActiveProjects().find((p) => p.id !== projectId);
    router.push(next ? `/p/${next.id}` : "/settings");
  }

  function renderSection(section: SettingsSection): ReactNode {
    if (section === "project-modules") {
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

    if (section === "project-danger") {
      return (
        <div>
          <h1 className="mb-0.5 text-lg font-semibold text-foreground">危険な操作</h1>
          <div className="mt-3 rounded-md border border-destructive/30 p-3">
            <p className="mb-2 text-xs text-ink-3">
              終了は削除ではない——閉じた Project の一覧（サイドバー下部の時計アイコン）から
              概要を読み返し、再度開ける。
            </p>
            <Button type="button" variant="destructive" size="sm" onClick={() => setConfirmClose(true)}>
              この Project を終了する
            </Button>
          </div>

          <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{project.name} を終了しますか</AlertDialogTitle>
                <AlertDialogDescription>
                  削除ではない——閉じた Project の一覧からいつでも再度開ける。
                  今開いている Thread は畳まれた状態で保存される。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>やめる</AlertDialogCancel>
                <AlertDialogAction onClick={handleClose}>終了する</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      );
    }

    const implementationId = section.slice("module:".length);
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

/** この Project の文脈で設定面を出せる Module（左メニューの見出し下に並ぶ） */
export function projectConfigurableModules(projectId: string) {
  return getProjectModuleLinks(projectId).filter((i) => i.hasConfigSurface && i.enabled);
}
