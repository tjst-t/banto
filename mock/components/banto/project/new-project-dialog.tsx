"use client";

// 新規 Project の作成（§2.2）。既定で見せるのは名前・Base パスだけ、
// Advanced に開くと Configuration の上書き（§2.2「設定のカスケード」と同じ
// 形——instance 既定を継承するか、この Project 用に決め打つか）。
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
import { cn } from "@/lib/utils";
import { createProject } from "@/lib/mock/projects";
import { mockRuntimeDefaults } from "@/lib/mock/settings";

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
  const [model, setModel] = useState(mockRuntimeDefaults.model);
  const [effort, setEffort] = useState<string>(mockRuntimeDefaults.effort);

  function reset() {
    setName("");
    setBasePath("~/worktrees/");
    setShowAdvanced(false);
    setModel(mockRuntimeDefaults.model);
    setEffort(mockRuntimeDefaults.effort);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !basePath.trim()) return;
    const project = createProject({ name: name.trim(), basePath: basePath.trim() });
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
              Project は仕事の入れ物（§1.1）。Module 集合・Configuration は後から足せる。
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-4">
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
              <div className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="new-project-model" className="text-xs text-ink-3">
                    既定モデル
                  </Label>
                  <Select value={model} onValueChange={setModel}>
                    <SelectTrigger id="new-project-model" className="h-8 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="claude-opus-5">claude-opus-5</SelectItem>
                      <SelectItem value="claude-sonnet-5">claude-sonnet-5</SelectItem>
                      <SelectItem value="claude-haiku-4-5-20251001">claude-haiku-4-5-20251001</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="new-project-effort" className="text-xs text-ink-3">
                    既定 reasoning effort
                  </Label>
                  <Select value={effort} onValueChange={setEffort}>
                    <SelectTrigger id="new-project-effort" className="h-8 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="low">low</SelectItem>
                      <SelectItem value="medium">medium</SelectItem>
                      <SelectItem value="high">high</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <p className="text-xs text-ink-3 sm:col-span-2">
                  指定しなければ instance 既定を継承する（§2.2「設定のカスケード」）。
                  値はこのモックでは保存だけで、Project 設定画面には反映していない。
                </p>
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
