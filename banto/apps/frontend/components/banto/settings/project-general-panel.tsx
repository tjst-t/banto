"use client";

// **この Project そのものの設定**（決定・2026-09-11、ユーザー要望）。
//
// Project の層のいちばん上に置く——名前と根は「この Project が何者か」なので、
// Module の選択や上書きより先に来る。
//
// **根は閉じ込めの範囲そのもの**（`docs/specs/v4-security.md`——Project のコンテナに見せるのはこの根）。変えると、その
// Project の Module は立て直しになる（host が落とし、次に要るときに新しい根で
// 立つ）。広い根なら**保存する前に**警告を出す。
//
// いちばん下に「危険な操作」——**Close**（閉じる。削除ではない）。
import { useState } from "react";
import { useRouter } from "next/navigation";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { reportFailure } from "@/lib/report-failure";
import { closeProject, getActiveProjects, getProject, updateRealProject } from "@/lib/mock/projects";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import { WideRootWarning, useRootScope } from "@/components/banto/settings/wide-root-warning";
import { PathPicker } from "@/components/banto/settings/path-picker";
import { ProjectContainerSection } from "@/components/banto/settings/project-container-section";
import { ProjectClaudeLoginSection } from "@/components/banto/settings/project-claude-login-section";
import { ProjectMessageSendersSection } from "@/components/banto/settings/project-message-senders-section";
import { ProjectAutoApproveSection } from "@/components/banto/settings/project-auto-approve-section";
import { ProjectTurnSummarySection } from "@/components/banto/settings/project-turn-summary-section";

export function ProjectGeneralPanel({ projectId }: { projectId: string }) {
  useMockStoreVersion();
  const project = getProject(projectId);
  const router = useRouter();
  const [name, setName] = useState(project.name);
  const [root, setRoot] = useState(project.basePath);
  const [saving, setSaving] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const rootScope = useRootScope(root);

  // **別の Project に切り替わったら、その Project の値から始める。**
  // 打っている途中の値を捨てないよう、見ている Project が変わったときだけ。
  const [shownProjectId, setShownProjectId] = useState(project.id);
  if (shownProjectId !== project.id) {
    setShownProjectId(project.id);
    setName(project.name);
    setRoot(project.basePath);
  }

  const dirty = name.trim() !== project.name || root.trim() !== project.basePath;
  const rootChanged = root.trim() !== project.basePath;

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await updateRealProject(projectId, {
        ...(name.trim() !== project.name ? { name: name.trim() } : {}),
        ...(rootChanged ? { root: root.trim() } : {}),
      });
    } catch (err) {
      reportFailure("この Project の設定を保存できませんでした", err);
    } finally {
      setSaving(false);
    }
  }

  async function handleClose() {
    try {
      await closeProject(projectId);
    } catch (err) {
      // **閉じられなかったのに、閉じた先へ飛ばさない**（規則2）
      reportFailure("Project を Close できませんでした", err);
      return;
    }
    setConfirmClose(false);
    const next = getActiveProjects().find((p) => p.id !== projectId);
    router.push(next ? `/p/${next.id}` : "/settings");
  }

  return (
    <div data-testid="project-general-panel">
      <h1 className="mb-0.5 text-lg font-semibold text-foreground">一般</h1>
      <p className="mb-4 text-xs text-ink-3">この Project の名前と、作業する場所。</p>

      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="project-name">Project 名</Label>
          <Input
            id="project-name"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="project-root">Root パス</Label>
          <PathPicker id="project-root" value={root} onChange={setRoot} />
          <p className="text-xs text-ink-3">
            Shell・FileSystem などの Module は、この Root パスの中のみアクセス可能。
            {rootChanged ? "変えると、この Project の Module は立て直しになる。" : ""}
          </p>
          <WideRootWarning scope={rootScope} />
        </div>

        {dirty ? (
          <div
            data-testid="project-general-bar"
            className="sticky bottom-0 -mx-1 flex items-center justify-between gap-2 rounded-md border border-border bg-popover px-3 py-2 shadow-md"
          >
            <p className="text-xs text-ink-2">未保存の変更</p>
            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => {
                  setName(project.name);
                  setRoot(project.basePath);
                }}
              >
                捨てる
              </Button>
              <Button
                size="sm"
                className="h-7 px-3 text-xs"
                disabled={saving || !name.trim() || !root.trim()}
                onClick={() => void save()}
              >
                {saving ? "保存中…" : "保存"}
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <ProjectContainerSection projectId={projectId} />
      <ProjectClaudeLoginSection projectId={projectId} />

      <ProjectMessageSendersSection projectId={projectId} />

      <ProjectAutoApproveSection projectId={projectId} />
      <ProjectTurnSummarySection projectId={projectId} />

      {/* **危険な操作は、いちばん下**（決定・2026-09-11、ユーザー要望） */}
      <h2 className="mt-8 mb-2 text-sm font-semibold text-foreground">危険な操作</h2>
      <div className="rounded-md border border-destructive/30 p-3">
        <p className="mb-2 text-xs text-ink-3">
          Close は削除ではない——閉じた Project の一覧（サイドバー下部の時計アイコン）から
          概要を読み返し、再度開ける。
        </p>
        <Button type="button" variant="destructive" size="sm" onClick={() => setConfirmClose(true)}>
          この Project を Close する
        </Button>
      </div>

      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{project.name} を Close しますか</AlertDialogTitle>
            <AlertDialogDescription>
              削除ではない——閉じた Project の一覧からいつでも再度開ける。
              今開いている Thread は畳まれた状態で保存される。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>やめる</AlertDialogCancel>
            <AlertDialogAction onClick={handleClose}>Close する</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
