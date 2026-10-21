"use client";

// **番頭を全部止める・再開する**（v4-frontend.md §6.54、アーキ仕様 §4.5「止める」）。番頭の画面の見出しと受信箱の見出しが同じ手順を
// 通る（規則3）：確かめのカードで何が起きるかを出し、押したら host に頼んで一覧を取り直す
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
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
import { resumeAllRealSupervisors, stopAllRealSupervisors } from "@/lib/backend/client";
import { refreshSupervisors } from "@/lib/backend/supervisors";
import { describeFailure } from "@/lib/report-failure";
import { SUPERVISOR_LABEL as L } from "@/lib/supervisor-label";

export function useStopAllSupervisors(): { request: (kind: "stop" | "resume") => void; busy: boolean; dialog: ReactNode } {
  const [confirm, setConfirm] = useState<"stop" | "resume" | null>(null);
  const [busy, setBusy] = useState(false);

  async function apply(kind: "stop" | "resume") {
    setBusy(true);
    try {
      if (kind === "stop") await stopAllRealSupervisors();
      else await resumeAllRealSupervisors();
      await refreshSupervisors();
      toast(kind === "stop" ? `${L}を全部止めました` : `${L}を再開しました`);
    } catch (err) {
      toast(`${kind === "stop" ? `${L}を止められませんでした` : `${L}を再開できませんでした`}：${describeFailure(err)}`);
    } finally {
      setBusy(false);
    }
  }

  const dialog = (
    <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
      <AlertDialogContent data-testid="supervisor-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>{confirm === "stop" ? `${L}を全部止めますか` : `${L}を再開しますか`}</AlertDialogTitle>
          <AlertDialogDescription>
            {confirm === "stop"
              ? `全部の Project の${L}を一時停止し、動いている${L}の回を止めます。まだ始まっていない頼みは捨て、答えかけの決めることは人に回します。Factory に流した件は止めません（記録の「取りやめる」で止められます）。`
              : `全部止めたときに止めた${L}を再開します。Project ごとに一時停止したものは止めたままです。`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>やめる</AlertDialogCancel>
          <AlertDialogAction
            data-testid="supervisor-confirm-ok"
            onClick={() => {
              const kind = confirm;
              setConfirm(null);
              if (kind) void apply(kind);
            }}
          >
            {confirm === "stop" ? "全部止める" : "再開する"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  return { request: (kind) => setConfirm(kind), busy, dialog };
}
