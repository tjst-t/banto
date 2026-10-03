"use client";

// **Module の画面から頼まれた「Project を閉じる」の確かめ**（2026-10-03、`lib/backend/canvas-close-projects.ts`）。
// Repositories の「このマシンから削除」で、消したフォルダを使っていた Project を閉じるかを、人がここで決める。
// 閉じるのは core の「Project を閉じる」（`closeProject`——削除ではない。閉じた Project の一覧から再開できる）と同じ。
// Module は Project に触らない。どの面（Project・設定・ホーム）にいても、外枠がこの1つを持つ。
import { useEffect, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
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
import { closeProjectsRequests } from "@/lib/backend/canvas-close-projects";
import { closeProject, getActiveProjects, getAllProjects } from "@/lib/mock/projects";
import { reportFailure } from "@/lib/report-failure";

export function RequestedCloseProjectsDialog() {
  const request = useSyncExternalStore(closeProjectsRequests.subscribe, closeProjectsRequests.get, () => null);
  const router = useRouter();
  const pathname = usePathname();
  const [busy, setBusy] = useState(false);
  // 開く場所が出ていることを知らせる（無い面——別タブの Canvas——からの頼みは断る）
  useEffect(() => closeProjectsRequests.registerHost(), []);
  if (!request) return null;
  const all = getAllProjects();
  const targets = request.projectIds.map((id) => all.find((p) => p.id === id));
  const known = targets.filter((p): p is NonNullable<typeof p> => !!p && p.status !== "closed");
  const unknown = targets.filter((p) => !p).length;

  async function closeAll() {
    setBusy(true);
    try {
      for (const p of known) await closeProject(p.id);
    } catch (err) {
      // 閉じられなかったのに、閉じた先へ飛ばさない（規則2）
      reportFailure("Project を Close できませんでした", err);
      setBusy(false);
      return;
    }
    setBusy(false);
    closeProjectsRequests.clear();
    // 見ていた Project を閉じたなら、ほかへ移る
    if (known.some((p) => pathname.startsWith(`/p/${p.id}`))) {
      const next = getActiveProjects()[0];
      router.push(next ? `/p/${next.id}` : "/settings");
    }
  }

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) closeProjectsRequests.clear();
      }}
    >
      <AlertDialogContent data-testid="close-projects-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {known.length > 0 ? `Project「${known.map((p) => p.name).join("」「")}」を Close しますか` : "閉じる Project はありません"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            削除ではない——閉じた Project の一覧からいつでも再度開ける。
          </AlertDialogDescription>
          {request.from ? (
            // 出所を見せる——Module の画面が開かせた。閉じるのは、ここで押したとき
            <p data-testid="close-projects-requested-by" className="text-xs text-ink-2">
              「{request.from}」の画面から頼まれて開きました。閉じるのは、ここで押したときです。
            </p>
          ) : null}
          {unknown > 0 ? <p className="text-xs text-ink-3">見つからない Project が {unknown} 件ありました（もう無いか、閉じています）。</p> : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>閉じない</AlertDialogCancel>
          {known.length > 0 ? (
            <AlertDialogAction
              data-testid="close-projects-confirm"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void closeAll();
              }}
            >
              {busy ? "Close しています…" : "Close する"}
            </AlertDialogAction>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
