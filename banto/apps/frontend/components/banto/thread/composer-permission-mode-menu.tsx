"use client";

// composer に常設する permissionMode のインジケータ兼切り替え
// （v4-frontend.md §6.4「permissionMode は Thread 単位で選べる」）。
// Claude Code 自身が CLI で持つ「その場でモードを切り替える」操作と同じ発想で、
// 新しい呼び名は作らない（規則11）——SDK の6値をそのまま出す。
//
// **常時表示にするのは「いま自分がどのモードで会話しているか」を見失わないため**
// ——とくに bypassPermissions（確認を全部飛ばす）を選んだまま忘れる事故を避ける。
// 危険な見た目にするのはこの1値だけで、他の5値はただの作業モードの切り替え。
import { useState } from "react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  getConfiguredPermissionMode,
  getThreadPermissionMode,
  setThreadPermissionMode,
} from "@/lib/mock/permission-mode";
import { getPermissionModeInfo, MOCK_PERMISSION_MODES } from "@/lib/mock/settings";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import type { MockPermissionMode } from "@/lib/mock/types";
import { cn } from "@/lib/utils";
import { ChevronDownIcon, ShieldAlert, ShieldCheck } from "lucide-react";

export function ComposerPermissionModeMenu({
  threadId,
  projectId,
}: {
  threadId: string;
  projectId: string;
}) {
  useMockStoreVersion();
  const mode = getThreadPermissionMode(threadId, projectId);
  const info = getPermissionModeInfo(mode);
  const configured = getConfiguredPermissionMode(projectId);
  // 危険な値へ移るときだけ、確認を1枚挟む（軽く——他の5値は即座に切り替わる）
  const [pendingDanger, setPendingDanger] = useState<MockPermissionMode | null>(null);

  function choose(next: MockPermissionMode) {
    if (getPermissionModeInfo(next).danger) {
      setPendingDanger(next);
      return;
    }
    setThreadPermissionMode(threadId, next);
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`この会話の permissionMode（現在：${info.label}）`}
            className={cn(
              "flex h-7 items-center gap-1 rounded-full px-2 text-xs",
              info.danger
                ? "bg-warn-soft text-warn font-semibold"
                : "text-ink-3 hover:text-foreground hover:bg-muted-foreground/15",
            )}
          >
            {info.danger ? <ShieldAlert className="size-3.5" /> : <ShieldCheck className="size-3.5" />}
            <span>{info.label}</span>
            <ChevronDownIcon className="size-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-80">
          <DropdownMenuLabel>この会話の permissionMode</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={mode} onValueChange={(v) => choose(v as MockPermissionMode)}>
            {MOCK_PERMISSION_MODES.map((m) => (
              <DropdownMenuRadioItem
                key={m.value}
                value={m.value}
                className={cn("items-start", m.danger && "text-warn")}
              >
                <span className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-1 text-sm">
                    {m.danger ? <ShieldAlert className="size-3.5" /> : null}
                    {m.label}
                    {m.value === configured ? (
                      <span className="text-xs text-ink-3">（設定の既定）</span>
                    ) : null}
                  </span>
                  <span className={cn("text-xs", m.danger ? "text-warn" : "text-ink-3")}>
                    {m.description}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <p className="px-2 py-1.5 text-xs text-ink-3">
            この会話の中でだけ効く。他の会話や新しい会話は設定の既定（{configured}）から始まる。
          </p>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={pendingDanger !== null} onOpenChange={(o) => !o && setPendingDanger(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-1.5 text-warn">
              <ShieldAlert className="size-4" />
              確認をすべて飛ばしますか
            </AlertDialogTitle>
            <AlertDialogDescription>
              bypassPermissions の間は、破壊的なコマンドの実行前確認が出ません。
              Module 間の呼び出しの確認は、このモードでも出ます（AI への信用と、
              Project の配線への信用は別の軸——v4-frontend.md §6.4）。
              この Thread の中でだけ効き、いつでも戻せます。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>やめる</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDanger) setThreadPermissionMode(threadId, pendingDanger);
                setPendingDanger(null);
              }}
            >
              この会話で有効にする
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
