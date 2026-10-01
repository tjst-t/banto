"use client";

// 新しいリポジトリ（2026-10-01、ユーザー）——リポジトリの一覧から、手元に新しいリポジトリを始める。
// 中身は `RepoCreateForm`（core の新しい Project の画面に差し出す「新しいリポジトリ」と同じ本体）。
// Repositories が既定の置き場（`~/banto/<名前>`）にフォルダを作って git init し、台帳に足す。GitHub にはまだ作らない。
// 「Project も作る」は clone と同じ部品・同じ既定（オン）——オンなら作ったあと、一覧が core の新しい Project の画面を
// そのフォルダで開く。オフなら「Project はまだ無い」の表に「このマシンにだけ」として入る。
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { reopenProject } from "@/lib/mock/projects";
import { useRepoHome } from "@/lib/mock/github";
import { RepoCreateForm } from "./repo-create-form";
import { RepoProjectOption } from "./repo-project-option";

export function RepoCreateDialog({
  initialName,
  onClose,
  onShow,
  onStartAt,
  onStartProject,
  onClone,
}: {
  initialName: string;
  onClose: () => void;
  /** 一覧のその行を見せる（作った）。ダイアログも閉じる */
  onShow: (path: string) => void;
  /** そのフォルダで core の新しい Project の画面を開く（帯の「このフォルダで Project を作る」） */
  onStartAt: (path: string) => void;
  /** 「Project も作る」がオンで作り終えた——そのフォルダと名前の既定で core の画面を開く */
  onStartProject: (path: string, name: string) => void;
  /** GitHub の同じ名前のリポジトリを clone で始める（`owner/name`） */
  onClone: (reference: string) => void;
}) {
  const router = useRouter();
  const home = useRepoHome();
  const [withProject, setWithProject] = useState(true);

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="sm:max-w-lg" data-testid="repo-create-dialog">
        <form onSubmit={(e: FormEvent) => e.preventDefault()} className="flex min-w-0 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>新しいリポジトリ</DialogTitle>
            <DialogDescription>
              {home} に作って git init します。GitHub へは、あとで公開できます。
            </DialogDescription>
          </DialogHeader>
          <div className="flex max-h-[65vh] min-w-0 flex-col overflow-y-auto">
            <RepoCreateForm
              initialName={initialName}
              onCreated={({ path, name }) => {
                toast(withProject ? `${path} を作りました。Project の作成に進みます` : `${path} を作り、一覧に足しました`);
                onShow(path);
                if (withProject) onStartProject(path, name);
              }}
              onUseAsFolder={(path) => {
                onClose();
                onStartAt(path);
              }}
              onOpenAt={(_, id, closed) => {
                if (closed) reopenProject(id);
                onClose();
                router.push(`/p/${id}`);
              }}
              onSwitchToClone={(reference) => {
                onClose();
                onClone(reference);
              }}
              renderActions={({ ready, create }) => (
                <>
                  <RepoProjectOption checked={withProject} onCheckedChange={setWithProject} disabled={false} />
                  <DialogFooter>
                    <Button type="button" variant="outline" onClick={onClose}>
                      やめる
                    </Button>
                    <Button type="submit" disabled={!ready} onClick={create} data-testid="repo-create-submit">
                      {withProject ? "作って Project の作成へ" : "リポジトリを作る"}
                    </Button>
                  </DialogFooter>
                </>
              )}
            />
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
