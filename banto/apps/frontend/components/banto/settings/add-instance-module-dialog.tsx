"use client";

// **Module を1本足す**（追加・2026-09-15）。
//
// **聞かないことを決めるのが要**：
//
// - **「Project のフォルダを触りますか」は聞かない**（決定・2026-09-15）。
//   誤答の被害が左右で釣り合わないので、設問のほうが悪い。代わりに
//   **引数に「この Project のフォルダ」を差し込んだかどうか**で決まる
// - **閉じ込めは外せない**。外から繋ぐコードは必ず閉じ込める（`v4-security.md`）
//   ——根は「Project のフォルダを渡したか」で自動的に決まる

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

const PROJECT_ROOT = "${projectRoot}";

export interface AddInstanceModuleDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  onSubmit(declaration: {
    name: string;
    launch: { command: string; args: string[]; env?: Record<string, string> };
    meta: unknown;
  }): Promise<void>;
}

export function AddInstanceModuleDialog({ open, onOpenChange, onSubmit }: AddInstanceModuleDialogProps) {
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const args = argsText.split(/\s+/).filter(Boolean);
  // **どこに立つかは、書いたものから決まる**（聞かない）
  const perProject = args.includes(PROJECT_ROOT) || command.includes(PROJECT_ROOT);

  function reset() {
    setName("");
    setCommand("");
    setArgsText("");
    setError(null);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Module を追加</DialogTitle>
          <DialogDescription>
            もう手元にあるプログラムを起動します。<strong>外から繋ぐコードは必ず閉じ込めます</strong>
          </DialogDescription>
        </DialogHeader>

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

          {/* **押す前に、何が決まるかを出す**（導出は隠さない） */}
          <p className="text-xs text-ink-3" data-testid="add-module-effect">
            {perProject
              ? "この Module は Project ごとに1本立ち、その Project のフォルダだけを渡します"
              : "この Module は banto 全体で1本立ちます（Project のフォルダは渡りません）"}
          </p>

          {error ? (
            <p className="text-xs text-danger" data-testid="add-module-error">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            やめる
          </Button>
          <Button
            type="button"
            disabled={busy || !name.trim() || !command.trim()}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onSubmit({
                  name: name.trim(),
                  launch: { command: command.trim(), args },
                  meta: {
                    satisfies: [],
                    dependsOn: [],
                    isolation: "subprocess",
                    // **閉じ込めは外せない。根は書いたものから決まる**
                    ...(perProject ? { scope: "project" } : {}),
                    confinement: { kind: "landlock", root: perProject ? "project" : "none" },
                  },
                });
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
