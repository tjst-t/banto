"use client";

// 階層2：この Project（§6.1）。instance 全体の設定（階層1、/settings）とは
// 別の置き場——会話ごとに中身が違うのでここは Project の overlay として出す
// （use-panel-stack.ts の "settings-project"）。
//
// **右から出てくる細い Sheet ではなく、instance 側の /settings と同じ
// 左メニュー＋右詳細のレイアウトを、画面いっぱいの Dialog で開く**
// （レビュー指摘・2026-09-02）——Module 自身の設定面を Project の文脈つきで
// 埋め込めるようにした以上（§6.2）、狭い Sheet の中に収まる保証が無い。
// §6.6 の Dialog/Sheet 基準（one-shot か、背景を見ながら参照するか）の
// どちらにも綺麗には当てはまらないが、instance 設定画面と同じ「その場に
// 覆いかぶさる、独立した画面」という扱いのほうが実態に合う——背景の会話は
// 見せる必要が無く、閉じたらそこに戻るだけでよい。
import { X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { getProject } from "@/lib/mock/projects";
import { ProjectSettingsContent } from "./project-settings-content";

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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-0 left-0 h-dvh w-screen max-w-none translate-x-0 translate-y-0 gap-0 rounded-none p-0 sm:max-w-none"
      >
        <DialogTitle className="sr-only">Project 設定 — {project.name}</DialogTitle>
        <div className="flex h-full min-h-0 flex-col">
          <ProjectSettingsHeader projectName={project.name} onClose={() => onOpenChange(false)} />
          <div className="min-h-0 flex-1">
            <ProjectSettingsContent projectId={projectId} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProjectSettingsHeader({ projectName, onClose }: { projectName: string; onClose: () => void }) {
  return (
    <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
      <p className="text-sm font-semibold text-foreground">Project 設定 — {projectName}</p>
      <button
        type="button"
        onClick={onClose}
        aria-label="Project 設定を閉じる"
        className="flex size-7 items-center justify-center rounded-md text-ink-2 hover:bg-accent"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
