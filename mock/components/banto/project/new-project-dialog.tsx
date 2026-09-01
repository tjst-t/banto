"use client";

// 新規 Project の作成（§2.2）。既定で見せるのは名前・Base パスだけ、
// Advanced に開くと Configuration の上書き——§2.2「設定のカスケード」の
// 対象になる項目は全部出す（Project 設定画面の階層2と同じ集合・同じ
// CascadeRow）。一部だけ出すと「他の項目はここでは上書きできない」という
// 誤解を生む
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CascadeRow } from "@/components/banto/settings/cascade-row";
import { cn } from "@/lib/utils";
import { createProject } from "@/lib/mock/projects";
import { mockCredentials, mockRoles, mockRuntimeDefaults } from "@/lib/mock/settings";
import type { MockProjectOverrides } from "@/lib/mock/types";

type Overrides = Omit<MockProjectOverrides, "projectId" | "securityRoot">;

const EMPTY_OVERRIDES: Overrides = {};

export function NewProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [basePath, setBasePath] = useState("~/worktrees/");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [overrides, setOverrides] = useState<Overrides>(EMPTY_OVERRIDES);

  function patch(next: Partial<Overrides>) {
    setOverrides((prev) => ({ ...prev, ...next }));
  }

  function reset() {
    setName("");
    setBasePath("~/worktrees/");
    setShowAdvanced(false);
    setOverrides(EMPTY_OVERRIDES);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !basePath.trim()) return;
    const project = createProject({ name: name.trim(), basePath: basePath.trim(), overrides });
    onOpenChange(false);
    reset();
    router.push(`/p/${project.id}`);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>新しい Project</DialogTitle>
            <DialogDescription>
              Project は仕事の入れ物（§1.1）。Module 集合は後から足せる。
            </DialogDescription>
          </DialogHeader>

          <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto py-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-project-name">Project 名</Label>
              <Input
                id="new-project-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例：決済まわりの改修"
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-project-path">Base パス</Label>
              <Input
                id="new-project-path"
                value={basePath}
                onChange={(e) => setBasePath(e.target.value)}
                placeholder="~/worktrees/..."
                className="font-mono text-xs"
              />
              <p className="text-xs text-ink-3">
                Shell・FileSystem をこの根に閉じ込める（§2.7）
              </p>
            </div>

            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="flex items-center gap-1 text-xs text-ink-3 hover:text-foreground"
            >
              <ChevronRight className={cn("size-3.5 transition-transform", showAdvanced && "rotate-90")} />
              Advanced——Configuration の上書き
            </button>
            {showAdvanced ? (
              <div className="rounded-md border border-border px-3">
                <CascadeRow
                  id="new-project-model"
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
                  id="new-project-effort"
                  label="既定 reasoning effort"
                  inheritedLabel={mockRuntimeDefaults.effort}
                  overridden={overrides.effort !== undefined}
                  onToggle={(on) => patch({ effort: on ? mockRuntimeDefaults.effort : undefined })}
                >
                  <Select
                    value={overrides.effort}
                    onValueChange={(v) => patch({ effort: v as Overrides["effort"] })}
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
                  id="new-project-memory"
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
                  id="new-project-credential"
                  label="使う資格情報"
                  inheritedLabel="自動選択（使用率の低いものへ自動で移る、§2.8）"
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

                <CascadeRow
                  id="new-project-vault"
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
            ) : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              やめる
            </Button>
            <Button type="submit" disabled={!name.trim() || !basePath.trim()}>
              作成する
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
