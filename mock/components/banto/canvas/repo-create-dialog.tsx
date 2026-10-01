"use client";

// 新しいリポジトリ（2026-10-01、ユーザー）——リポジトリの一覧から、手元に新しいリポジトリを始める。
// Repo が既定の置き場（`~/banto/<名前>`）にフォルダを作って git init し、台帳に足す。GitHub にはまだ作らない
// （上げるのは公開のとき）。一覧では「Project はまだ無い」の表に「このマシンにだけ」として入る。
//
// 新しい Project の画面の「新しいリポジトリ」と**部品・判断・文言をそろえる**：
//   - 帯は同じ `RepoRootPreview`（mode="create"）——名前の欄は帯の中の1つだけ（リポジトリ名＝フォルダ名）。
//     ぶつかれば断って `<名前>-2` を出す（判断は `inspectTargetFolder`・`isValidFolderName`）
//   - 登録したアカウントの GitHub に同じ名前があれば、帯の下で「あとで公開するときは別の名前が要ります」と
//     「clone で始める」を添える（作るのは止めない——GitHub に上げるのは公開のときなので）
//   - アカウントは聞かない（GitHub のアカウントが1つも無くても作れる）
//   - トーストは「Repo が〜を作り、Project「〜」を作りました」
// 「Project も作る」は `RepoProjectOption`（clone と同じ形・同じ既定＝切）。
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
import { createProject, reopenProject } from "@/lib/mock/projects";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import {
  createLocalRepo,
  inspectTargetFolder,
  isValidFolderName,
  repoExistsOnGithub,
  useGithubAccounts,
  useRepoHome,
} from "@/lib/mock/github";
import { RepoRootPreview } from "@/components/banto/project/repo-root-preview";
import { RepoProjectOption } from "./repo-project-option";

export function RepoCreateDialog({
  initialName,
  onClose,
  onShow,
  onStartAt,
  onClone,
}: {
  initialName: string;
  onClose: () => void;
  /** 一覧のその行を見せる（作った） */
  onShow: (path: string) => void;
  /** そのフォルダを Root にした新しい Project の画面を開く（帯の「このフォルダで Project を作る」） */
  onStartAt: (path: string) => void;
  /** GitHub の同じ名前のリポジトリを clone で始める（`owner/name`） */
  onClone: (reference: string) => void;
}) {
  useMockStoreVersion();
  const router = useRouter();
  const home = useRepoHome();
  const accounts = useGithubAccounts();
  const [folder, setFolder] = useState(initialName);
  const [withProject, setWithProject] = useState(false);
  /** null＝リポジトリ名に合わせる */
  const [projectName, setProjectName] = useState<string | null>(null);

  const folderInvalid = folder !== "" && !isValidFolderName(folder);
  const targetState = folder && !folderInvalid ? inspectTargetFolder(home, folder) : null;
  const path = `${home}/${folder}`;
  // 新しい Project の画面と同じ——登録したアカウントの GitHub に同じ名前があるか（作るのは止めない）
  const takenOnGithub =
    folder && !folderInvalid ? accounts.find((a) => repoExistsOnGithub(a.login, folder))?.login : undefined;
  const name = projectName ?? folder;
  const ready = targetState?.kind === "free" && (!withProject || !!name.trim());

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    createLocalRepo(path);
    if (withProject) {
      const project = createProject({ name: name.trim(), basePath: path });
      onClose();
      router.push(`/p/${project.id}`);
      toast(`Repo が ${path} を作り、Project「${project.name}」を作りました`);
      return;
    }
    toast(`Repo が ${path} を作り、一覧に足しました`);
    onShow(path);
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="sm:max-w-lg" data-testid="repo-create-dialog">
        <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>新しいリポジトリ</DialogTitle>
            <DialogDescription>
              Repo が {home} に作って git init します。GitHub へは、あとで公開できます。
            </DialogDescription>
          </DialogHeader>

          <div className="flex max-h-[60vh] min-w-0 flex-col gap-4 overflow-y-auto [&>*]:shrink-0">
            <div className="flex flex-col gap-1.5">
              <RepoRootPreview
                mode="create"
                home={home}
                folder={folder}
                onFolderChange={setFolder}
                folderInvalid={folderInvalid}
                status={{ kind: "target", state: targetState ?? { kind: "free" } }}
                takenOnGithub={takenOnGithub}
                onUseAsFolder={(at) => {
                  onClose();
                  onStartAt(at);
                }}
                onSwitchToClone={() => {
                  if (!takenOnGithub) return;
                  onClose();
                  onClone(`${takenOnGithub}/${folder}`);
                }}
                onOpenProject={(id, closed) => {
                  if (closed) reopenProject(id);
                  onClose();
                  router.push(`/p/${id}`);
                }}
                targetLabel="置く場所"
              />
              <p className="text-xs text-ink-3">
                GitHub に公開するときも、この名前を使います（そのときに変えられます）。置き場（{home}）は Repo の設定で変えられます。
              </p>
            </div>

            {folder ? (
              <RepoProjectOption
                checked={withProject}
                onCheckedChange={setWithProject}
                name={name}
                onNameChange={setProjectName}
                disabled={false}
              />
            ) : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              やめる
            </Button>
            <Button type="submit" disabled={!ready} data-testid="repo-create-submit">
              {withProject ? "リポジトリと Project を作る" : "リポジトリを作る"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
