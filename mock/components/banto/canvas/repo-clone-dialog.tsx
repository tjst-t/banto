"use client";

// URL から clone（2026-10-01、ユーザー）——リポジトリの一覧から、URL を貼って Repositories に clone させる。
// 中身は `RepoCloneForm`（core の新しい Project の画面に差し出す「clone」と同じ本体。こちらは URL を打つ形）。
// GitHub の外（gitlab.com 等）も受ける——台帳は GitHub の外の場所も覚え、フォルダが消えたら clone し直せる。
//
// 「Project も作る」は `RepoProjectOption`（既定オン。オンなら clone のあと、一覧が core の新しい Project の画面を
// そのフォルダで開く）。意味が無いときは出さない：
//   - もう手元にある（clone しない）——**clone のボタンも出さない**。次の手は「一覧で見る」、Project があれば
//     「〜を開く」、無ければ帯の「この場所で Project を始める」
//   - 見つからない行の clone し直しで、その場所をもう Project が使っている（Root が戻るだけ）
import { useCallback, useState, type FormEvent } from "react";
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
import { RepoCloneForm, type ClonedFolder } from "./repo-clone-form";
import { RepoProjectOption } from "./repo-project-option";

export function RepoCloneDialog({
  initialUrl,
  onClose,
  onShow,
  onStartAt,
  onStartProject,
}: {
  initialUrl: string;
  onClose: () => void;
  /** 一覧のその行を見せる（clone した・もう一覧にある）。ダイアログも閉じる */
  onShow: (path: string) => void;
  /** そのフォルダで core の新しい Project の画面を開く（帯の「このフォルダで Project を作る」など） */
  onStartAt: (path: string) => void;
  /** 「Project も作る」がオンで clone が済んだ——そのフォルダと名前の既定で core の画面を開く */
  onStartProject: (path: string, name: string) => void;
}) {
  const router = useRouter();
  const home = useRepoHome();
  const [withProject, setWithProject] = useState(true);

  function openProject(id: string, closed: boolean) {
    if (closed) reopenProject(id);
    onClose();
    router.push(`/p/${id}`);
  }

  const onCloned = useCallback(
    (f: ClonedFolder) => {
      // clone し直した場所をもう Project が使っているなら、作る画面へは行かない（Root が戻るだけ）
      const toProject = withProject && !f.project;
      const head = f.recloned
        ? `${f.label} を ${f.path} に clone し直しました` +
          (f.project ? `（Project「${f.project.name}」の Root です）` : "")
        : `${f.label} を ${f.path} に clone しました`;
      toast(toProject ? `${head}。Project の作成に進みます` : f.recloned ? head : `${head}。一覧に足しました`);
      onShow(f.path);
      if (toProject) onStartProject(f.path, f.suggestedName);
    },
    [withProject, onShow, onStartProject],
  );

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="sm:max-w-lg" data-testid="repo-clone-dialog">
        {/* Enter は既定のボタン（下の「clone する」など）を押したことになる——押せることはボタンの onClick だけに置く */}
        <form onSubmit={(e: FormEvent) => e.preventDefault()} className="flex min-w-0 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>URL から clone</DialogTitle>
            <DialogDescription>{home} に clone して、一覧に足します。</DialogDescription>
          </DialogHeader>
          <div className="flex max-h-[65vh] min-w-0 flex-col overflow-y-auto">
            <RepoCloneForm
              picker="url"
              initialInput={initialUrl}
              onCloned={onCloned}
              onUseAsFolder={(path) => {
                onClose();
                onStartAt(path);
              }}
              onOpenAt={(_, id, closed) => openProject(id, closed)}
              onStartHere={(path) => {
                onClose();
                onStartAt(path);
              }}
              renderActions={(step, markTried) => {
                const offerProject = step.kind === "clone" ? !step.project : step.kind !== "have";
                const toProject = withProject && offerProject;
                const verb = toProject ? "clone して Project の作成へ" : "clone する";
                return (
                  <>
                    {offerProject && step.kind !== "empty" && step.kind !== "invalid" ? (
                      <RepoProjectOption
                        checked={withProject}
                        onCheckedChange={setWithProject}
                        disabled={step.kind === "busy"}
                      />
                    ) : null}
                    <DialogFooter>
                      <Button type="button" variant="outline" onClick={onClose} disabled={step.kind === "busy"}>
                        やめる
                      </Button>
                      {step.kind === "have" ? (
                        step.project ? (
                          <>
                            <Button
                              type="button"
                              variant="outline"
                              onClick={() => onShow(step.repo.path)}
                              data-testid="repo-clone-show"
                            >
                              一覧で見る
                            </Button>
                            <Button
                              type="submit"
                              data-testid="repo-clone-submit"
                              onClick={() => openProject(step.project!.id, step.project!.closed)}
                            >
                              「{step.project.name}」を{step.project.closed ? "再開" : "開く"}
                            </Button>
                          </>
                        ) : (
                          <Button type="submit" data-testid="repo-clone-submit" onClick={() => onShow(step.repo.path)}>
                            一覧で見る
                          </Button>
                        )
                      ) : step.kind === "clone" ? (
                        <Button type="submit" data-testid="repo-clone-submit" onClick={step.start}>
                          {step.failed ? "もう一度 " : ""}
                          {step.recloning ? (toProject ? "clone し直して Project の作成へ" : "clone し直す") : verb}
                        </Button>
                      ) : step.kind === "invalid" ? (
                        // 読めない URL のまま押した（Enter）——欄を断る
                        <Button type="submit" data-testid="repo-clone-submit" onClick={markTried}>
                          {verb}
                        </Button>
                      ) : (
                        <Button type="submit" data-testid="repo-clone-submit" disabled>
                          {step.kind === "busy" ? "clone しています…" : verb}
                        </Button>
                      )}
                    </DialogFooter>
                  </>
                );
              }}
            />
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
