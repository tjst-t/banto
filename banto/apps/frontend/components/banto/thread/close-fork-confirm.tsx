"use client";

// **Fork を閉じるときの警告**（決定・2026-10-08、ユーザー。v4-frontend.md §6「Fork を閉じるときの警告」）。
// その Fork が頼んだ裏の仕事が残っていれば、閉じる前に件数と中身を出して確かめる。人は承知で閉じられる
// （AI の `close_fork` は断るが、人は断らない）。無ければ今までどおり確かめずに閉じる。
// 裏の仕事を知るのは画面が既に持っているバックグラウンドの一覧（§6.33）——host に聞き直さない。
// サイドバーの「…」とヘッダの Close は同じ手順（`foldForkThread`）を通るので、どちらもここで確かめる。
// **自動化の専用の Fork**（v4-frontend.md §6.42）は、閉じると host がその自動化を一時停止する——動いている自動化なら
// 裏の仕事が無くても確かめ、「自動化を一時停止します」と言う。
import { useState, type ReactNode } from "react";
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
import { getThreadBackground, type BackgroundItem } from "@/lib/backend/background-work";
import { automationOfThread } from "@/lib/backend/automations";
import { BackgroundItemsSummary } from "@/components/banto/shell/background-work";

interface Pending {
  title: string;
  items: readonly BackgroundItem[];
  /** 閉じると一時停止する自動化の名前（動いている自動化の専用の Fork のときだけ） */
  automation?: string;
  close: () => void;
}

/**
 * `confirmClose(threadId, title, close)`：裏の仕事が無ければすぐ `close` を呼び、あれば小窓を出して「それでも閉じる」で呼ぶ。
 * `dialog` は呼ぶ側が描く
 */
export function useCloseForkConfirm(): {
  confirmClose: (threadId: string, title: string, close: () => void) => void;
  dialog: ReactNode;
} {
  const [pending, setPending] = useState<Pending | null>(null);

  function confirmClose(threadId: string, title: string, close: () => void) {
    const items = getThreadBackground(threadId);
    const automation = automationOfThread(threadId);
    const pausing = automation && !automation.paused ? automation.name : undefined;
    if (items.length === 0 && !pausing) {
      close();
      return;
    }
    setPending({ title, items, ...(pausing ? { automation: pausing } : {}), close });
  }

  const dialog = (
    <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
      <AlertDialogContent data-testid="close-fork-warning">
        <AlertDialogHeader>
          <AlertDialogTitle>「{pending?.title}」を閉じますか</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              {pending?.automation ? (
                <p data-testid="close-fork-automation">
                  自動化「{pending.automation}」を一時停止します。この Fork は自動化の専用の Fork です——開き直しても自動では再開しません。
                  動かし続けるなら、自動化の画面で再開してください。
                </p>
              ) : null}
              {pending && pending.items.length > 0 ? (
                <>
                  <p>この Fork が頼んだ仕事が {pending.items.length} 件残っています。</p>
                  <p>閉じても仕事は止まりません。結果はこの Fork に溜まり、開き直すまで AI は読みません。</p>
                </>
              ) : null}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {pending && pending.items.length > 0 ? (
          <div className="max-h-64 overflow-y-auto">
            <BackgroundItemsSummary items={pending.items} />
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>やめる</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              const close = pending?.close;
              setPending(null);
              close?.();
            }}
          >
            それでも閉じる
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { confirmClose, dialog };
}
