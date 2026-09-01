"use client";

// 階層2：この Project（§6.1）。instance 全体の設定（階層1、/settings）とは
// 別の置き場——会話ごとに中身が違うのでここは Project の overlay として出す
// （use-panel-stack.ts の "settings-project"、既存の stub を実装する）。
import { useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Plus, ShieldAlert, Trash2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
import { closeProject, getActiveProjects, getProject } from "@/lib/mock/projects";
import {
  getImplementation,
  getProjectModuleLinks,
  getProjectOverrides,
  getVaultAliasesForProject,
  mockCredentials,
  mockRoles,
  mockRuntimeDefaults,
} from "@/lib/mock/settings";
import type { MockModuleImplementation, MockProjectOverrides } from "@/lib/mock/types";
import { CascadeRow } from "./cascade-row";
import { DisableImpactDialog } from "./disable-impact-dialog";

export function ProjectSettingsOverlay({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const project = getProject(projectId);
  const baseline = getProjectOverrides(projectId);
  const [overrides, setOverrides] = useState<MockProjectOverrides>(baseline);
  const links = getProjectModuleLinks(projectId);
  const aliases = getVaultAliasesForProject(projectId);
  const [removeTarget, setRemoveTarget] = useState<MockModuleImplementation | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const router = useRouter();

  function patch(next: Partial<MockProjectOverrides>) {
    setOverrides((prev) => ({ ...prev, ...next }));
  }

  function handleClose() {
    closeProject(projectId);
    setConfirmClose(false);
    onOpenChange(false);
    const next = getActiveProjects().find((p) => p.id !== projectId);
    router.push(next ? `/p/${next.id}` : "/settings");
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 overflow-auto p-0 sm:max-w-lg">
        <SheetHeader className="border-b border-border">
          <SheetTitle>Project 設定 — {project.name}</SheetTitle>
        </SheetHeader>

        <div className="flex flex-col gap-6 p-4">
          <section>
            <h3 className="mb-1 text-sm font-semibold text-foreground">繋がっている役割・Module</h3>
            <p className="mb-2 text-xs text-ink-3">
              instance 全体の役割一覧（<a href="/settings" className="underline">/settings</a>）から、
              この Project が使う実装を選ぶ。
            </p>
            <div className="flex flex-col gap-2">
              {mockRoles.map((role) => {
                const active = links.filter((impl) => impl.roleId === role.id);
                return (
                  <div key={role.id} className="rounded-md border border-border p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-foreground">{role.name}</p>
                      <button
                        type="button"
                        className="flex items-center gap-1 text-xs text-ink-3 hover:text-foreground"
                      >
                        <Plus className="size-3.5" /> 実装を足す
                      </button>
                    </div>
                    {active.length === 0 ? (
                      <p className="mt-1 text-xs text-ink-3">繋がっている実装は無い</p>
                    ) : (
                      <ul className="mt-1.5 flex flex-col gap-1">
                        {active.map((impl) => (
                          <li
                            key={impl.id}
                            className="flex items-center justify-between gap-2 rounded bg-surface-2 px-2 py-1 text-xs"
                          >
                            <span className="flex items-center gap-1.5 text-ink-2">
                              {impl.name}
                              <Badge variant="outline" className="text-xs">
                                {impl.isolation}
                              </Badge>
                            </span>
                            <button
                              type="button"
                              aria-label={`${impl.name} をこの Project から外す`}
                              onClick={() => setRemoveTarget(impl)}
                              className="flex size-5 items-center justify-center rounded text-ink-3 hover:bg-destructive/10 hover:text-destructive"
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-sm font-semibold text-foreground">既定値の上書き</h3>
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
                id="override-credential"
                label="使う資格情報"
                inheritedLabel="自動選択（使用率の低いものへ自動で移る、§2.8）"
                overridden={overrides.credentialId !== undefined}
                onToggle={(on) =>
                  patch({ credentialId: on ? mockCredentials[0].id : undefined })
                }
              >
                <Select
                  value={overrides.credentialId}
                  onValueChange={(v) => patch({ credentialId: v })}
                >
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

              <CascadeRow
                id="override-vault"
                label="使う Vault 接続"
                inheritedLabel="instance 既定接続（組み込みローカル）"
                overridden={overrides.vaultImplementationId !== undefined}
                onToggle={(on) =>
                  patch({ vaultImplementationId: on ? "banto.vault-local" : undefined })
                }
              >
                <Select
                  value={overrides.vaultImplementationId}
                  onValueChange={(v) => patch({ vaultImplementationId: v })}
                >
                  <SelectTrigger className="h-8 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {mockRoles
                      .find((r) => r.id === "vault")
                      ?.implementations.map((i) => (
                        <SelectItem key={i.id} value={i.id}>
                          {i.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </CascadeRow>
            </div>
          </section>

          <section>
            <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-foreground">
              <ShieldAlert className="size-4 text-ink-3" />
              セキュリティ境界
            </h3>
            <p className="mb-2 text-xs text-ink-3">
              Shell・FileSystem をこの根に閉じ込める（§2.7）。誰が根を決め、誰が保持するかは
              まだ設計していない——ここでは Project が持つ値として仮に置く
            </p>
            <Input
              value={overrides.securityRoot}
              onChange={(e) => patch({ securityRoot: e.target.value })}
              className="h-8 font-mono text-xs"
            />
          </section>

          <section>
            <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-foreground">
              <KeyRound className="size-4 text-ink-3" />
              Vault の alias（この Project）
            </h3>
            <p className="mb-2 text-xs text-ink-3">
              AI に見えるのは名前だけ。値は banto を一度も通らない（§2.5「alias 方式」）
            </p>
            {aliases.length === 0 ? (
              <p className="text-sm text-ink-3">この Project の alias はまだ無い</p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-ink-3">
                    <th className="py-1 font-medium">名前</th>
                    <th className="py-1 font-medium">接続・パス</th>
                    <th className="py-1 font-medium">使いみち</th>
                  </tr>
                </thead>
                <tbody>
                  {aliases.map((a) => {
                    const impl = getImplementation(a.implementationId);
                    return (
                      <tr key={a.id} className="border-b border-border last:border-b-0">
                        <td className="py-1.5 pr-2 font-mono text-ink-2">${a.name}</td>
                        <td className="py-1.5 pr-2 text-ink-3">
                          {impl?.name} · {a.path}
                        </td>
                        <td className="py-1.5 text-ink-3">{a.usedBy.join(", ")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>

          <section className="rounded-md border border-destructive/30 p-3">
            <h3 className="mb-1 text-sm font-semibold text-foreground">危険な操作</h3>
            <p className="mb-2 text-xs text-ink-3">
              終了は削除ではない——閉じた Project の一覧（サイドバー下部の時計アイコン）から
              概要を読み返し、再度開ける。
            </p>
            <Button type="button" variant="destructive" size="sm" onClick={() => setConfirmClose(true)}>
              この Project を終了する
            </Button>
          </section>
        </div>

        <DisableImpactDialog
          open={removeTarget !== null}
          onOpenChange={(o) => !o && setRemoveTarget(null)}
          targetName={removeTarget ? `${removeTarget.name}（${project.name}）` : ""}
          breaks={removeTarget?.breaksIfDisabled ?? []}
          onConfirm={() => setRemoveTarget(null)}
        />

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
      </SheetContent>
    </Sheet>
  );
}
