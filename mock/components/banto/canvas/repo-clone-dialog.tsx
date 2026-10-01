"use client";

// URL から clone（2026-10-01、ユーザー）——リポジトリの一覧から、URL を貼って Repo に clone させる。
// 受けるのは `https://github.com/owner/repo(.git)`・`git@github.com:owner/repo.git`・`owner/repo` と、
// GitHub の外（gitlab.com 等）の URL。GitHub の外は Repo のアカウントを使わず、このマシンの git の設定で
// clone する（台帳はもう GitHub の外の origin を扱える——Import した gitlab の notes）。
//
// 新しい Project の画面の「GitHub から clone」と**部品・判断・文言をそろえる**：
//   - 置く場所と、そこで何が起きるかの帯は同じ `RepoRootPreview`（置き場は字のまま、フォルダ名だけ打てる。
//     ぶつかれば `<名前>-2` を先に入れておく）
//   - 判断は `parseCloneSource`・`inspectCloneSource`・`inspectTargetFolder`・`checkCloneAccess` の1箇所ずつ
//   - アカウントは `GithubAccountChooser`（1つなら選ばせない）
//   - 完了のトーストは「Repo が〜を clone し、Project「〜」を作りました」
//
// **「Project も作る」の既定は切っておく**——ここは Repo の一覧で、用事は「このマシンに置く」こと。
// clone から Project を始める入口は新しい Project の画面にもうあり（そちらは Project を作るのが既定）、
// 両方を同じ既定にすると同じ入口が2つになる。切っておけば一覧に留まり、足した行が「Project はまだ無い」の
// 表に出て、その行の「Project を始める」が次の手になる（設定面に埋め込んだときも、設定から離れない）
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CircleAlert, KeyRound, Link2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { createProject, reopenProject } from "@/lib/mock/projects";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import {
  addClonedRepo,
  checkCloneAccess,
  freeFolderName,
  inspectCloneSource,
  inspectTargetFolder,
  isValidFolderName,
  parseCloneSource,
  useGithubAccounts,
  useRepoHome,
  type CloneSource,
  type ProjectSummary,
} from "@/lib/mock/github";
import { GithubAccountChooser, REPO_SETTINGS_HREF } from "@/components/banto/project/github-account-chooser";
import { RepoRootPreview, type RootPreviewStatus } from "@/components/banto/project/repo-root-preview";

type Run = Extract<RootPreviewStatus, { kind: "cloning" | "clone-failed" }> & { readableBy?: string };

export function RepoCloneDialog({
  initialUrl,
  onClose,
  onShow,
  onStartAt,
}: {
  initialUrl: string;
  onClose: () => void;
  /** 一覧のその行を見せる（clone した・もう一覧にある） */
  onShow: (path: string) => void;
  /** そのフォルダを Root にした新しい Project の画面を開く（帯の「このフォルダで Project を作る」） */
  onStartAt: (path: string) => void;
}) {
  useMockStoreVersion();
  const router = useRouter();
  const home = useRepoHome();
  const accounts = useGithubAccounts();
  const [text, setText] = useState(initialUrl);
  /** Enter・押したときに読めなかった——それまでは打っている途中なので、断らずに例を出すだけ */
  const [tried, setTried] = useState(false);
  const [accountChoice, setAccountChoice] = useState<string | null>(null);
  /** null＝空いている名前に合わせる（人が打ったら、以後はその値） */
  const [folderInput, setFolderInput] = useState<string | null>(null);
  const [withProject, setWithProject] = useState(false);
  /** null＝リポジトリ名に合わせる */
  const [projectName, setProjectName] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
  }, []);

  const source = parseCloneSource(text);
  const github = source?.kind === "github" ? source : null;
  // 持ち主と同じ名前のアカウントがあれば、それを先に選んでおく。無ければ先頭（1つなら選ばせない——これがその1つ）
  const account =
    accounts.find((a) => a.id === accountChoice) ??
    (github ? accounts.find((a) => a.login.toLowerCase() === github.owner.toLowerCase()) : undefined) ??
    accounts[0];
  const inspected = source ? inspectCloneSource(source) : null;
  const have = inspected?.kind === "have" ? inspected : null;
  const reclone = inspected?.kind === "reclone" ? inspected : null;
  const autoFolder = source ? freeFolderName(home, source.name) : "";
  const folder = folderInput ?? autoFolder;
  const renamedFrom = source && folderInput === null && autoFolder !== source.name ? source.name : undefined;
  const folderInvalid = folder !== "" && !isValidFolderName(folder);
  const targetState = source && !inspected && folder && !folderInvalid ? inspectTargetFolder(home, folder) : null;
  const targetPath = inspected ? inspected.repo.path : `${home}/${folder}`;
  const status: RootPreviewStatus | null = source
    ? (run ?? inspected ?? { kind: "target", state: targetState ?? { kind: "free" } })
    : null;
  const cloning = run?.kind === "cloning";
  /** 「Project も作る」で作る先に、もう Project があるか（あれば作らずにそれを開く） */
  const existingProject: ProjectSummary | undefined = inspected?.project;
  const repoName = inspected ? inspected.repo.name : (source?.name ?? "");
  const name = projectName ?? repoName;
  const needsName = withProject && !existingProject;

  function reset() {
    setRun(null);
    setFolderInput(null);
    setProjectName(null);
  }

  function openProject(id: string, closed: boolean) {
    if (closed) reopenProject(id);
    onClose();
    router.push(`/p/${id}`);
  }

  function makeProject(path: string) {
    const project = createProject({ name: name.trim(), basePath: path });
    onClose();
    router.push(`/p/${project.id}`);
    return project;
  }

  function label(s: CloneSource) {
    return s.kind === "github" ? `${s.owner}/${s.name}` : `${s.host}/${s.path}`;
  }

  function startClone(s: CloneSource, path: string) {
    const total = 3410;
    let received = 0;
    setRun({ kind: "cloning", received, total });
    timer.current = setInterval(() => {
      received = Math.min(total, received + 487);
      if (received < total) {
        setRun({ kind: "cloning", received, total });
        return;
      }
      if (timer.current) clearInterval(timer.current);
      const useAccount = s.kind === "github" ? account : undefined;
      const access = checkCloneAccess(s, useAccount?.id);
      if (!access.ok) {
        setRun({ kind: "clone-failed", reason: access.reason, readableBy: access.readableBy?.id });
        return;
      }
      addClonedRepo({
        path,
        accountId: useAccount?.id,
        remote:
          s.kind === "github"
            ? { kind: "github", owner: s.owner, name: s.name, private: access.private }
            : { kind: "elsewhere", url: s.url },
      });
      const again = reclone ? "clone し直し" : "clone し";
      if (!withProject) {
        toast(`Repo が ${label(s)} を ${path} に ${again}、一覧に足しました`);
        onShow(path);
        return;
      }
      if (existingProject) {
        openProject(existingProject.id, existingProject.closed);
        toast(
          `Repo が ${label(s)} を ${path} に ${again}、Project「${existingProject.name}」を${existingProject.closed ? "再開し" : "開き"}ました`,
        );
        return;
      }
      const project = makeProject(path);
      toast(`Repo が ${label(s)} を ${path} に ${again}、Project「${project.name}」を作りました`);
    }, 180);
  }

  // 押す前に言うこと（描画）と、押したときにすること（submit）を分ける
  const primary = primaryAction();

  function primaryAction(): { label: string; action: "clone" | "show" | "open" | "create-here" | null } {
    const verb = withProject ? "clone して Project を作る" : "clone する";
    if (cloning) return { label: "clone しています…", action: null };
    if (!source) return { label: verb, action: null };
    const openLabel = existingProject
      ? `「${existingProject.name}」を${existingProject.closed ? "再開" : "開く"}`
      : null;
    if (have) {
      if (!withProject) return { label: "一覧で見る", action: "show" };
      return openLabel
        ? { label: openLabel, action: "open" }
        : { label: "このフォルダで Project を作る", action: name.trim() ? "create-here" : null };
    }
    if (reclone) {
      if (!withProject) return { label: "clone し直す", action: "clone" };
      return openLabel
        ? { label: `clone し直して${openLabel}`, action: "clone" }
        : { label: "clone し直して Project を作る", action: name.trim() ? "clone" : null };
    }
    const ready = targetState?.kind === "free" && (!needsName || !!name.trim());
    return { label: run?.kind === "clone-failed" ? `もう一度 ${verb}` : verb, action: ready ? "clone" : null };
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!source) {
      setTried(true);
      return;
    }
    switch (primary.action) {
      case "clone":
        startClone(source, targetPath);
        return;
      case "show":
        onShow(targetPath);
        return;
      case "open":
        if (existingProject) openProject(existingProject.id, existingProject.closed);
        return;
      case "create-here": {
        const project = makeProject(targetPath);
        toast(`Project「${project.name}」を作りました（Root は ${targetPath}）`);
        return;
      }
      case null:
        return;
    }
  }

  const readableBy = run?.kind === "clone-failed" ? accounts.find((a) => a.id === run.readableBy) : undefined;
  const failedNext: ReactNode =
    run?.kind !== "clone-failed" ? null : readableBy ? (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          setAccountChoice(readableBy.id);
          setRun(null);
        }}
        data-testid="repo-clone-switch-account"
        className="h-7 w-fit bg-background text-xs"
      >
        {readableBy.login} で clone する
      </Button>
    ) : source?.kind === "elsewhere" ? (
      <p className="text-ink-2">
        URL を確かめてください。非公開なら、このマシンの git（SSH の鍵など）で読めるようにしてから、もう一度押してください。
      </p>
    ) : (
      <p className="text-ink-2">
        URL を確かめてください。非公開なら、
        <Link
          href={REPO_SETTINGS_HREF}
          className="rounded-sm font-medium text-foreground underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
        >
          読めるアカウントを登録
        </Link>
        してから、もう一度押してください。
      </p>
    );

  const showAccount = github && !inspected;
  const unreadable = text.trim() !== "" && !source;

  return (
    <Dialog open onOpenChange={(open) => (open || cloning ? null : onClose())}>
      <DialogContent className="sm:max-w-lg" data-testid="repo-clone-dialog">
        <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>URL から clone</DialogTitle>
            <DialogDescription>Repo が {home} に clone して、一覧に足します。</DialogDescription>
          </DialogHeader>

          <div className="flex max-h-[60vh] min-w-0 flex-col gap-4 overflow-y-auto [&>*]:shrink-0">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="repo-clone-url">リポジトリの URL</Label>
              <Input
                id="repo-clone-url"
                data-testid="repo-clone-url"
                value={text}
                disabled={cloning}
                onChange={(e) => {
                  setText(e.target.value);
                  setTried(false);
                  // アカウントは URL の持ち主で選び直す（前の URL で選んだものを持ち越さない）
                  setAccountChoice(null);
                  reset();
                }}
                placeholder="https://github.com/owner/repo"
                aria-invalid={(tried && unreadable) || undefined}
                aria-describedby="repo-clone-url-help"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                className="font-mono text-xs"
              />
              <p
                id="repo-clone-url-help"
                data-testid="repo-clone-url-help"
                className={cn("flex items-start gap-1 text-xs", tried && unreadable ? "text-foreground" : "text-ink-3")}
              >
                {unreadable ? (
                  <>
                    <CircleAlert className={cn("mt-0.5 size-3.5 shrink-0", tried ? "text-turn" : "text-ink-3")} />
                    <span>
                      URL として読めません。<span className="font-mono">https://github.com/owner/repo</span>・
                      <span className="font-mono">git@github.com:owner/repo.git</span>・
                      <span className="font-mono">owner/repo</span> の形で入れてください。
                    </span>
                  </>
                ) : source?.kind === "elsewhere" ? (
                  <>
                    <Link2 className="mt-0.5 size-3.5 shrink-0" />
                    <span data-testid="repo-clone-elsewhere">
                      GitHub の外（{source.host}）です。Repo のアカウントは使わず、このマシンの git の設定で clone します。
                    </span>
                  </>
                ) : source ? null : (
                  "GitHub の URL か owner/repo。GitHub の外（gitlab.com など）の URL も使えます。"
                )}
              </p>
            </div>

            {showAccount ? (
              accounts.length > 0 && account ? (
                <GithubAccountChooser
                  id="repo-clone-account"
                  accounts={accounts}
                  value={account.id}
                  onChange={(id) => {
                    setAccountChoice(id);
                    setRun(null);
                  }}
                  singleNote="で clone します"
                />
              ) : (
                <p
                  data-testid="repo-clone-no-account"
                  className="flex items-start gap-1.5 text-xs text-ink-2"
                >
                  <KeyRound className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
                  <span>
                    GitHub のアカウントがありません。公開のリポジトリだけ clone できます（
                    <Link
                      href={REPO_SETTINGS_HREF}
                      className="rounded-sm font-medium text-foreground underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      アカウントを登録する
                    </Link>
                    ）。
                  </span>
                </p>
              )
            ) : null}

            {status ? (
              <div className="flex flex-col gap-1.5">
                <RepoRootPreview
                  mode="clone"
                  home={home}
                  folder={folder}
                  onFolderChange={setFolderInput}
                  folderInvalid={folderInvalid}
                  renamedFrom={renamedFrom}
                  status={status}
                  onUseAsFolder={(path) => {
                    onClose();
                    onStartAt(path);
                  }}
                  onSwitchToClone={() => undefined}
                  onOpenProject={openProject}
                  failedNext={failedNext}
                />
                {status.kind !== "have" && status.kind !== "reclone" ? (
                  <p className="text-xs text-ink-3">置き場（{home}）は Repo の設定で変えられます。</p>
                ) : null}
              </div>
            ) : null}

            {/* Project は banto 本体の仕事——用意できたフォルダを Root にして作る（新しい Project の画面の下の段と同じ言い方） */}
            {source ? (
              <section
                aria-label="Project"
                data-testid="repo-clone-project"
                className="flex flex-col gap-3 border-t border-border pt-4"
              >
                <label className="flex items-start gap-2.5">
                  <Switch
                    checked={withProject}
                    onCheckedChange={setWithProject}
                    disabled={cloning}
                    data-testid="repo-clone-with-project"
                    className="mt-0.5"
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium text-foreground">Project も作る</span>
                    <span className="text-xs text-ink-3">
                      {existingProject
                        ? `このフォルダは Project「${existingProject.name}」が使っています。作らずに、それを${existingProject.closed ? "再開" : "開き"}ます`
                        : "banto が、このフォルダを Root にして作り、開きます"}
                    </span>
                  </span>
                </label>
                {needsName ? (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="repo-clone-project-name">Project 名</Label>
                    <Input
                      id="repo-clone-project-name"
                      data-testid="repo-clone-project-name"
                      value={name}
                      disabled={cloning}
                      onChange={(e) => setProjectName(e.target.value)}
                    />
                  </div>
                ) : null}
              </section>
            ) : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={cloning}>
              やめる
            </Button>
            <Button
              type="submit"
              disabled={text.trim() === "" || (source !== null && primary.action === null)}
              data-testid="repo-clone-submit"
            >
              {primary.label}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
