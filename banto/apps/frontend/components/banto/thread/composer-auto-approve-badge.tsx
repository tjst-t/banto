"use client";

// **入力欄の「自動で許可中」の印**（決定・2026-10-05、ユーザー。v4-frontend.md §6.4「承認をすべて自動で許可する」）。
//
// Project の設定で「承認をすべて自動で許可する」がオンなら、permissionMode のメニューの隣に出す——承認のカードが
// 出ないまま進むのを、会話の画面で見失わないため。オフのとき・まだ host から聞いていないときは何も出さない
import { ShieldAlert } from "lucide-react";
import { useAutoApproveAll } from "@/lib/backend/auto-approve";

export function ComposerAutoApproveBadge({ projectId }: { projectId: string }) {
  const enabled = useAutoApproveAll(projectId, true);
  if (enabled !== true) return null;
  return (
    <span
      data-testid="composer-auto-approve-badge"
      title="この Project は「承認をすべて自動で許可する」がオンです（Project の設定で切り替え）"
      className="flex h-7 shrink-0 items-center gap-1 rounded-full bg-warn-soft px-2 text-xs font-semibold text-warn"
    >
      <ShieldAlert className="size-3.5 shrink-0" />
      自動で許可中
    </span>
  );
}
