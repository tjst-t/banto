"use client";

// **Module を1本足す**（改訂・2026-09-16、ユーザー指摘「普通の人には使いづらい」）。
//
// **打たせない。貼らせる。** 人が実際にやっているのは、README や Claude Code の
// 設定から `mcpServers` の JSON をコピーしてくること——それをそのまま受ける
// （`docs/specs/v4-architecture.md` §5.1「独自形式を作らない」）。
//
// 手で書く欄も残すが、**二番手**にする。
//
// **聞かないことは変えていない**：
// - 「Project のフォルダを触りますか」は聞かない（誤答の被害が釣り合わない）
//   ——`${projectRoot}` を書いたかで決まる
// - 閉じ込めは外せない。外から繋ぐコードは必ず閉じ込める

import { useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";

const PROJECT_ROOT = "${projectRoot}";

const SAMPLE = `{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "..." }
    }
  }
}`;

export interface AddInstanceModuleDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** 手で書いた1本を足す。 */
  onSubmit(declaration: {
    name: string;
    launch: { command: string; args: string[]; env?: Record<string, string> };
    meta: unknown;
  }): Promise<void>;
  /** 貼り付けた `mcpServers` を足す。足した名前を返す。 */
  onPaste(json: string): Promise<string[]>;
}

export function AddInstanceModuleDialog({
  open,
  onOpenChange,
  onSubmit,
  onPaste,
}: AddInstanceModuleDialogProps) {
  const [mode, setMode] = useState<"paste" | "manual">("paste");
  const [pasted, setPasted] = useState("");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const args = argsText.split(/\s+/).filter(Boolean);
  // **どこに立つかは、書いたものから決まる**（聞かない）
  const perProject = mode === "manual" ? args.includes(PROJECT_ROOT) || command.includes(PROJECT_ROOT) : pasted.includes(PROJECT_ROOT);

  function reset() {
    setPasted("");
    setName("");
    setCommand("");
    setArgsText("");
    setError(null);
    setMode("paste");
  }

  const canSubmit =
    mode === "paste" ? pasted.trim().length > 0 : name.trim().length > 0 && command.trim().length > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Module を追加</DialogTitle>
          <DialogDescription>
            <strong>設定をそのまま貼り付けてください。</strong>
            Claude Code などと同じ形（<code>mcpServers</code>）で受けます
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1" role="tablist">
          <Button
            type="button"
            size="sm"
            role="tab"
            variant={mode === "paste" ? "default" : "ghost"}
            onClick={() => setMode("paste")}
          >
            貼り付ける
          </Button>
          <Button
            type="button"
            size="sm"
            role="tab"
            variant={mode === "manual" ? "default" : "ghost"}
            onClick={() => setMode("manual")}
          >
            自分で書く
          </Button>
        </div>

        {mode === "paste" ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor="add-module-paste">設定（JSON）</Label>
            <Textarea
              id="add-module-paste"
              rows={10}
              className="font-mono text-xs"
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder={SAMPLE}
            />
            <p className="text-xs text-ink-3">
              <code>mcpServers</code> の中身だけでも受けます。複数まとめて貼ってもかまいません
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="add-module-name">名前</Label>
              <Input
                id="add-module-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="weather"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="add-module-command">コマンド</Label>
              <Input
                id="add-module-command"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="npx"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="add-module-args">引数（空白区切り）</Label>
              <Input
                id="add-module-args"
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                placeholder="-y @modelcontextprotocol/server-weather"
              />
              <div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setArgsText((prev) => `${prev} ${PROJECT_ROOT}`.trim())}
                >
                  ＋ この Project のフォルダを渡す
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* **押す前に、何が決まるかを出す**（導出は隠さない） */}
        <p className="text-xs text-ink-3" data-testid="add-module-effect">
          {perProject
            ? "Project ごとに1本立ち、その Project のフォルダだけを渡します"
            : "banto 全体で1本立ちます（Project のフォルダは渡りません）"}
          。<strong>外から繋ぐコードは必ず閉じ込めます</strong>
        </p>

        {error ? (
          <p className="text-xs text-danger" data-testid="add-module-error">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            やめる
          </Button>
          <Button
            type="button"
            disabled={busy || !canSubmit}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                if (mode === "paste") {
                  await onPaste(pasted);
                } else {
                  await onSubmit({
                    name: name.trim(),
                    launch: { command: command.trim(), args },
                    meta: {
                      satisfies: [],
                      dependsOn: [],
                      isolation: "subprocess",
                      ...(perProject ? { scope: "project" } : {}),
                      confinement: { kind: "landlock", root: perProject ? "project" : "none" },
                    },
                  });
                }
                reset();
                onOpenChange(false);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            追加する
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
