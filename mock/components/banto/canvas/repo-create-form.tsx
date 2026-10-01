"use client";

// Repositories の「新しいリポジトリ」の本体（2026-10-01、作り直し）——**Repositories Module の画面の中身**。2か所で同じものを使う：
//   - リポジトリの一覧の「新しいリポジトリ」（`repo-create-dialog.tsx`）
//   - core の新しい Project の画面に差し出す始め方（`repo-prepare-view.tsx`）
// 帯は `RepoRootPreview`（mode="create"）——名前の欄は帯の中の1つだけ（リポジトリ名＝フォルダ名）。
// ぶつかれば断って `<名前>-2` を出す（`inspectTargetFolder`）、使えない字は断る（`isValidFolderName`）。
// 登録したアカウントの GitHub に同じ名前があれば、帯の下で「あとで公開するときは別の名前が要ります」と
// 「clone で始める」を添える（作るのは止めない——GitHub に上げるのは公開のとき）。アカウントは聞かない。
// ボタンは入口が描く（`renderActions`）。
import { useState, type ReactNode } from "react";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import {
  createLocalRepo,
  inspectTargetFolder,
  isValidFolderName,
  repoExistsOnGithub,
  useGithubAccounts,
  useRepoHome,
} from "@/lib/mock/github";
import { RepoRootPreview } from "./repo-root-preview";

export function RepoCreateForm({
  initialName = "",
  onCreated,
  onUseAsFolder,
  onOpenAt,
  onSwitchToClone,
  renderActions,
}: {
  initialName?: string;
  onCreated: (folder: { path: string; name: string }) => void;
  /** 帯の「このフォルダで Project を作る」（置く場所に、Repositories の知らないリポジトリがある等） */
  onUseAsFolder: (path: string) => void;
  /** 帯の「「〜」を開く」（置く場所を、もう Project が使っている） */
  onOpenAt: (path: string, projectId: string, closed: boolean) => void;
  /** GitHub の同じ名前のリポジトリを clone で始める（`owner/name`） */
  onSwitchToClone: (reference: string) => void;
  renderActions: (step: { ready: boolean; create: () => void }) => ReactNode;
}) {
  useMockStoreVersion();
  const home = useRepoHome();
  const accounts = useGithubAccounts();
  const [folder, setFolder] = useState(initialName);
  const folderInvalid = folder !== "" && !isValidFolderName(folder);
  const targetState = folder && !folderInvalid ? inspectTargetFolder(home, folder) : null;
  const path = `${home}/${folder}`;
  const takenOnGithub =
    folder && !folderInvalid ? accounts.find((a) => repoExistsOnGithub(a.login, folder))?.login : undefined;
  const ready = targetState?.kind === "free";

  function create() {
    if (!ready) return;
    createLocalRepo(path);
    onCreated({ path, name: folder });
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <RepoRootPreview
          mode="create"
          home={home}
          folder={folder}
          onFolderChange={setFolder}
          folderInvalid={folderInvalid}
          status={{ kind: "target", state: targetState ?? { kind: "free" } }}
          takenOnGithub={takenOnGithub}
          onUseAsFolder={onUseAsFolder}
          onSwitchToClone={() => takenOnGithub && onSwitchToClone(`${takenOnGithub}/${folder}`)}
          onOpenProject={(id, closed) => onOpenAt(path, id, closed)}
        />
        <p className="text-xs text-ink-3">
          GitHub に公開するときも、この名前を使います（そのときに変えられます）。置き場（{home}）はリポジトリの設定で変えられます。
        </p>
      </div>
      {renderActions({ ready, create })}
    </div>
  );
}
