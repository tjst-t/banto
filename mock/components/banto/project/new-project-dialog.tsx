"use client";

// 新規 Project の作成（§2.2）。**分担**（改訂・2026-09-30、ユーザー）：
// **フォルダを用意するのは Repo**（banto 全体に1本、Project より先に動く）、
// **そのフォルダを Root にして Project を作るのは banto 本体**。画面も2段に分けて、
// どちらが何をするかが読めるようにする——上が「フォルダ」、下が「Project」。
// Project に Module を自動で繋ぐことはしない（Repo は banto 全体の Module なので要らない）。
//
// フォルダの用意の仕方は3つ（決定・2026-09-29、置き場は改訂・2026-09-30、ユーザー）：
//
// | 用意の仕方 | Root | 誰が何をするか |
// |---|---|---|
// | 手元のフォルダ | 人が打つ／選ぶ | 何もしない（本実装と同じ：Root パス・「選ぶ」） |
// | GitHub から clone | `<置き場>/<repo>`（既定 `~/banto`） | Repo が clone して台帳に足す |
// | 新しいリポジトリ | `<置き場>/<名前>` | Repo が作って git init し、台帳に足す。GitHub へはあとで |
//
// clone と新規の置き場は人が打たない（Repo の設定の「既定の置き場」）。人が決めるのは
// フォルダ名だけで、名前がぶつかれば `<名前>-2` を先に入れておく。**Root パスと、そこに
// 既に何があるか**を押す前に見せる（`RepoRootPreview`）——ここがこの画面でいちばん目立つ場所。
// clone しようとしたリポジトリを台帳が**どこかに**もう持っていれば（Import した `~/ghq/…` でも）、
// clone せずそれを使う。
//
// Advanced（Configuration の上書き）は3つの始め方で共通。§2.2「設定のカスケード」の
// 対象は全部出す——一部だけ出すと「他はここでは上書きできない」と読まれる
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Check,
  ChevronRight,
  CloudDownload,
  FolderOpen,
  FolderPlus,
  Globe,
  Link2,
  Lock,
  Search,
} from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CascadeRow } from "@/components/banto/settings/cascade-row";
import { useRovingFocus } from "@/hooks/use-roving-focus";
import { cn } from "@/lib/utils";
import { createProject, reopenProject } from "@/lib/mock/projects";
import { getRoles, mockCredentials, mockRuntimeDefaults } from "@/lib/mock/settings";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import {
  useGithubAccounts,
  useRepoHome,
  addClonedRepo,
  createLocalRepo,
  folderName,
  freeFolderName,
  getReposForAccount,
  inspectCloneSource,
  inspectTargetFolder,
  parseRepoReference,
  repoExistsOnGithub,
  type MockGithubAccount,
  type ProjectSummary,
} from "@/lib/mock/github";
import type { MockProjectOverrides } from "@/lib/mock/types";
import { moveChoiceByKey } from "./choice-pills";
import { GithubAccountChooser, NoGithubAccount } from "./github-account-chooser";
import { PathPicker, WideRootWarning } from "./path-picker";
import { RepoRootPreview, type RootPreviewStatus } from "./repo-root-preview";

type Overrides = Omit<MockProjectOverrides, "projectId" | "securityRoot">;

export type StartMethod = "folder" | "clone" | "create";

/** 開くときの初期状態（URL の `RepoDemoParams`・リポジトリの一覧の「Project を始める」） */
export interface NewProjectPreset {
  method?: StartMethod;
  /** clone なら `owner/repo` を選んだ状態、新しいリポジトリなら名前（`owner/` は付けても無視する） */
  repo?: string;
  /** 手元のフォルダの Root パス（一覧から来たとき、そのリポジトリの置き場） */
  folder?: string;
  /** Project 名の初期値 */
  name?: string;
}

const START_METHODS = [
  {
    value: "folder",
    label: "手元のフォルダ",
    icon: FolderOpen,
    lead: () => "あるフォルダを、そのまま使います。",
    who: null,
  },
  {
    value: "clone",
    label: "GitHub から clone",
    icon: CloudDownload,
    lead: (home: string) => `${home} に clone します。`,
    who: "Repo が用意します",
  },
  {
    value: "create",
    label: "新しいリポジトリ",
    icon: FolderPlus,
    lead: (home: string) => `${home} に作って git init します。GitHub へは、あとで公開できます。`,
    who: "Repo が用意します",
  },
] as const satisfies readonly {
  value: StartMethod;
  label: string;
  icon: unknown;
  lead: (home: string) => string;
  who: string | null;
}[];

const REPO_NAME = /^[A-Za-z0-9._-]+$/;

/** Advanced の「使う Vault 接続」で上書きを始めたときの初期値 */
const DEFAULT_VAULT = "banto.vault-local";

type PrimaryAction = "create-at-folder" | "clone" | "reclone" | "use-cloned" | "open-existing" | "create-repo";

export function NewProjectDialog({
  open,
  onOpenChange,
  preset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preset?: NewProjectPreset;
}) {
  // 中身は DialogContent の中に置く——閉じると Radix が中身ごと外すので、
  // 次に開いたときは初期状態から始まる（reset を手で書かない）
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" data-testid="new-project-dialog">
        <NewProjectForm preset={preset} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function NewProjectForm({ preset, onDone }: { preset?: NewProjectPreset; onDone: () => void }) {
  useMockStoreVersion();
  const router = useRouter();
  const accounts = useGithubAccounts();
  const home = useRepoHome();
  const presetRepo = preset?.repo ? parseRepoReference(preset.repo) : null;

  const [method, setMethod] = useState<StartMethod>(preset?.method ?? "folder");
  const [accountChoice, setAccountChoice] = useState<string | null>(() =>
    presetRepo ? (accounts.find((a) => a.login === presetRepo.owner)?.id ?? null) : null,
  );
  // 選んだものが消えていたら先頭（1つだけのときは選ばせない——これがその1つ）
  const account: MockGithubAccount | undefined =
    accounts.find((a) => a.id === accountChoice) ?? accounts[0];

  const [basePath, setBasePath] = useState(preset?.folder ?? "");
  const [picked, setPicked] = useState<{ owner: string; name: string } | null>(
    preset?.method === "clone" ? presetRepo : null,
  );
  const [cloneRun, setCloneRun] = useState<Extract<RootPreviewStatus, { kind: "cloning" | "clone-failed" }> | null>(
    null,
  );
  /** フォルダ名。clone では null＝空いている名前に合わせる（人が打ったら、以後はその値） */
  const [folderInput, setFolderInput] = useState<string | null>(
    preset?.method === "create" && preset.repo ? (presetRepo?.name ?? preset.repo) : null,
  );
  /** null＝リポジトリ名に合わせる（人が打ったら、以後はその値） */
  const [projectName, setProjectName] = useState<string | null>(preset?.name ?? null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [overrides, setOverrides] = useState<Overrides>({});

  const cloneTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => {
    if (cloneTimer.current) clearInterval(cloneTimer.current);
  }, []);

  // clone しようとしたものを、もう持っているか（置き場の外に Import したものでも）。
  // 一覧が覚えているのにフォルダが見つからないなら、その場所に clone し直す
  const source = method === "clone" && picked ? inspectCloneSource(picked.owner, picked.name) : null;
  const have = source?.kind === "have" ? source : null;
  const reclone = source?.kind === "reclone" ? source : null;
  const autoFolder = method === "clone" && picked ? freeFolderName(home, picked.name) : "";
  const folder = method === "folder" ? "" : (folderInput ?? autoFolder);
  const renamedFrom =
    method === "clone" && picked && folderInput === null && autoFolder !== picked.name ? picked.name : undefined;
  const folderInvalid = folder !== "" && (!REPO_NAME.test(folder) || /^\.+$/.test(folder));
  const targetState =
    method !== "folder" && !source && folder && !folderInvalid ? inspectTargetFolder(home, folder) : null;
  const targetPath = source ? source.repo.path : `${home}/${folder}`;
  const showBand = method === "create" || (method === "clone" && !!picked && !!account);
  const preview: RootPreviewStatus | null = !showBand
    ? null
    : (cloneRun ??
      (source ?? { kind: "target", state: targetState ?? { kind: "free" } }));
  const name =
    projectName ??
    (method === "folder" ? "" : source ? source.repo.name : method === "clone" ? (picked?.name ?? "") : folder);
  // 作れるときだけ下の段（Project）を出す（断っているときに名前を聞いても、使い道が無い）
  const canCreateHere =
    cloneRun?.kind !== "clone-failed" &&
    (source ? !source.project : targetState?.kind === "free") &&
    (method !== "clone" || !!account);
  const showProjectStep = method === "folder" || canCreateHere;
  // 「新しいリポジトリ」の名前が、登録したアカウントの GitHub に既にある——その持ち主
  const takenOnGithub =
    method === "create" && folder && !folderInvalid
      ? accounts.find((a) => repoExistsOnGithub(a.login, folder))?.login
      : undefined;

  function changeMethod(next: StartMethod) {
    if (cloneRun?.kind === "cloning") return;
    setMethod(next);
    setCloneRun(null);
    setFolderInput(null);
  }

  function openAsFolder(path: string) {
    setBasePath(path);
    setProjectName(name || folderName(path));
    changeMethod("folder");
  }

  function switchToClone() {
    if (!takenOnGithub) return;
    setAccountChoice(accounts.find((a) => a.login === takenOnGithub)?.id ?? null);
    setPicked({ owner: takenOnGithub, name: folder });
    changeMethod("clone");
  }

  function openProject(projectId: string, closed: boolean) {
    if (closed) reopenProject(projectId);
    onDone();
    router.push(`/p/${projectId}`);
  }

  /** banto 本体の仕事——用意できたフォルダを Root にして Project を作る */
  function finish(path: string) {
    const project = createProject({ name: name.trim(), basePath: path, overrides });
    onDone();
    router.push(`/p/${project.id}`);
    return project;
  }

  /** `reopen`：見つからなかったフォルダを clone し直すとき、それを Root にしていた Project（作らずに開く） */
  function startClone(owner: string, repo: string, path: string, reopen?: ProjectSummary) {
    const total = 3410;
    let received = 0;
    setCloneRun({ kind: "cloning", received, total });
    cloneTimer.current = setInterval(() => {
      received = Math.min(total, received + 487);
      if (received < total) {
        setCloneRun({ kind: "cloning", received, total });
        return;
      }
      if (cloneTimer.current) clearInterval(cloneTimer.current);
      // 一覧に無いものを URL で貼られ、どのアカウントからも見えない——本物は git が 404 を返す
      if (!repoExistsOnGithub(owner, repo)) {
        setCloneRun({
          kind: "clone-failed",
          reason: `github.com/${owner}/${repo} が見つかりません（${account?.login ?? "このアカウント"} からは見えません）`,
        });
        return;
      }
      const listed = accounts
        .flatMap((a) => getReposForAccount(a.id))
        .find((r) => r.owner === owner && r.name === repo);
      addClonedRepo({
        path,
        accountId: account?.id,
        // 一覧に無い（URL で貼った）ものは、読めたのだから公開のリポジトリ
        remote: { kind: "github", owner, name: repo, private: listed?.private ?? false },
      });
      if (reopen) {
        openProject(reopen.id, reopen.closed);
        toast(
          `Repo が ${owner}/${repo} を ${path} に clone し直し、Project「${reopen.name}」を${reopen.closed ? "再開し" : "開き"}ました`,
        );
        return;
      }
      const project = finish(path);
      toast(`Repo が ${owner}/${repo} を ${path} に clone し、Project「${project.name}」を作りました`);
    }, 180);
  }

  // 押す前に言うこと（描画）と、押したときにすること（handleSubmit）を分ける
  const primary = primaryAction();

  function primaryAction(): { label: string; action: PrimaryAction | null } {
    if (method === "folder") {
      return { label: "Project を作る", action: name.trim() && basePath.trim() ? "create-at-folder" : null };
    }
    if (method === "clone") {
      if (cloneRun?.kind === "cloning") return { label: "clone しています…", action: null };
      if (!picked || cloneRun) return { label: "clone して Project を作る", action: null };
      if (reclone) {
        return reclone.project
          ? {
              label: `clone し直して「${reclone.project.name}」を${reclone.project.closed ? "再開" : "開く"}`,
              action: "reclone",
            }
          : { label: "clone し直して Project を作る", action: name.trim() ? "reclone" : null };
      }
      if (have) {
        return have.project
          ? {
              label: `「${have.project.name}」を${have.project.closed ? "再開" : "開く"}`,
              action: "open-existing",
            }
          : { label: "このフォルダで Project を作る", action: name.trim() ? "use-cloned" : null };
      }
      return {
        label: "clone して Project を作る",
        action: targetState?.kind === "free" && name.trim() ? "clone" : null,
      };
    }
    return {
      label: "リポジトリと Project を作る",
      action: targetState?.kind === "free" && name.trim() ? "create-repo" : null,
    };
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    switch (primary.action) {
      case "create-at-folder":
        finish(basePath.trim());
        return;
      case "clone":
        if (picked) startClone(picked.owner, picked.name, targetPath);
        return;
      case "reclone":
        if (picked) startClone(picked.owner, picked.name, targetPath, reclone?.project);
        return;
      case "use-cloned":
        finish(targetPath);
        return;
      case "open-existing":
        if (have?.project) openProject(have.project.id, have.project.closed);
        return;
      case "create-repo": {
        createLocalRepo(targetPath);
        const project = finish(targetPath);
        toast(`Repo が ${targetPath} を作り、Project「${project.name}」を作りました`);
        return;
      }
      case null:
        return;
    }
  }

  const current = START_METHODS.find((m) => m.value === method)!;

  return (
    <form onSubmit={handleSubmit} className="flex min-w-0 flex-col gap-4">
      <DialogHeader>
        <DialogTitle>新しい Project</DialogTitle>
        <DialogDescription>Root にするフォルダを用意して、そこに Project を作ります。</DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-2">
        {/* 上の段：フォルダ。clone・新規なら Repo の仕事 */}
        <StepHeading id="new-project-folder-step" title="Root にするフォルダ" who={current.who} />
        {/* 用意の仕方。本実装の SegmentedTabs と同じ形（全幅・下線・選んだものに地） */}
        <div
          role="tablist"
          aria-labelledby="new-project-folder-step"
          data-testid="start-method"
          onKeyDown={(e) =>
            moveChoiceByKey(
              e,
              START_METHODS.map((m) => m.value),
              method,
              changeMethod,
            )
          }
          className="grid grid-cols-3 border-b border-border"
        >
          {START_METHODS.map((m) => {
            const Icon = m.icon;
            const active = method === m.value;
            return (
              <button
                key={m.value}
                type="button"
                role="tab"
                data-choice
                id={`start-${m.value}`}
                aria-selected={active}
                aria-controls="start-panel"
                tabIndex={active ? 0 : -1}
                data-testid={`start-method-${m.value}`}
                onClick={() => changeMethod(m.value)}
                className={cn(
                  "flex flex-col items-center justify-center gap-1 rounded-t-md px-1.5 py-2 text-xs transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:flex-row sm:gap-1.5",
                  active
                    ? "bg-surface-2 font-medium text-foreground"
                    : "text-ink-3 hover:bg-surface-2/60 hover:text-ink-2",
                )}
              >
                <Icon className="size-4 shrink-0 sm:size-3.5" />
                <span className="text-center leading-tight">{m.label}</span>
              </button>
            );
          })}
        </div>
        <p className="text-xs text-ink-2">{current.lead(home)}</p>
      </div>

      <div
        id="start-panel"
        role="tabpanel"
        aria-labelledby={`start-${method}`}
        // 中身は縮めない——縮むと Root パスの帯の下（断る理由・次の手）が切れる（実測で踏んだ）
        className="flex max-h-[60vh] min-w-0 flex-col gap-4 overflow-y-auto [&>*]:shrink-0"
      >
        {method === "folder" ? (
          <FolderField basePath={basePath} onBasePathChange={setBasePath} autoFocus={!preset?.folder} />
        ) : method === "clone" && !account ? (
          <NoGithubAccount reason="登録すると、ここからリポジトリを探して clone できます。" />
        ) : (
          <>
            {method === "clone" && account ? (
              <>
                <GithubAccountChooser
                  id="new-project-account"
                  accounts={accounts}
                  value={account.id}
                  onChange={(id) => {
                    setAccountChoice(id);
                    setPicked(null);
                    setCloneRun(null);
                    setFolderInput(null);
                  }}
                  singleNote="から見えるリポジトリを出しています"
                />
                <RepoSearch
                  // アカウントを替えたら検索もやり直す
                  key={account.id}
                  account={account}
                  picked={picked}
                  disabled={cloneRun?.kind === "cloning"}
                  onPick={(next) => {
                    setPicked(next);
                    setCloneRun(null);
                    setFolderInput(null);
                  }}
                />
              </>
            ) : null}

            {preview ? (
              <div className="flex flex-col gap-1.5">
                <RepoRootPreview
                  mode={method === "clone" ? "clone" : "create"}
                  home={home}
                  folder={folder}
                  onFolderChange={setFolderInput}
                  folderInvalid={folderInvalid}
                  renamedFrom={renamedFrom}
                  status={preview}
                  takenOnGithub={takenOnGithub}
                  onUseAsFolder={openAsFolder}
                  onSwitchToClone={switchToClone}
                  onOpenProject={openProject}
                />
                {/* 今あるフォルダを使うときは、置き場の話は要らない */}
                {preview.kind !== "have" && preview.kind !== "reclone" ? (
                  <p className="text-xs text-ink-3">
                    {[
                      method === "create" ? "GitHub に公開するときも、この名前を使います（そのときに変えられます）。" : "",
                      `置き場（${home}）は Repo の設定で変えられます。`,
                    ].join("")}
                  </p>
                ) : null}
              </div>
            ) : null}
          </>
        )}

        {/* 下の段：Project。banto 本体の仕事——用意できたフォルダを Root にして作る */}
        {showProjectStep ? (
          <section
            aria-labelledby="new-project-project-step"
            data-testid="new-project-project-step"
            className="flex flex-col gap-4 border-t border-border pt-4"
          >
            <StepHeading
              id="new-project-project-step"
              title="Project"
              who="banto が、このフォルダを Root にして作ります"
            />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-project-name">Project 名</Label>
              <Input
                id="new-project-name"
                value={name}
                onChange={(e) => setProjectName(e.target.value)}
                autoFocus={method === "folder" && !!preset?.folder}
              />
            </div>
            <AdvancedOverrides
              open={showAdvanced}
              onToggle={() => setShowAdvanced((v) => !v)}
              overrides={overrides}
              patch={(next) => setOverrides((prev) => ({ ...prev, ...next }))}
            />
          </section>
        ) : null}
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          やめる
        </Button>
        <Button type="submit" disabled={primary.action === null} data-testid="new-project-submit">
          {primary.label}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** 段の見出し——左に何の段か、右に誰がそれをするか（Repo か banto か） */
function StepHeading({ id, title, who }: { id: string; title: string; who: string | null }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <h3 id={id} className="text-sm font-semibold text-foreground">
        {title}
      </h3>
      {who ? (
        <p data-testid={`${id}-who`} className="text-xs text-ink-3">
          {who}
        </p>
      ) : null}
    </div>
  );
}

function FolderField({
  basePath,
  onBasePathChange,
  autoFocus,
}: {
  basePath: string;
  onBasePathChange: (next: string) => void;
  autoFocus: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="new-project-path">Root パス</Label>
      <PathPicker id="new-project-path" value={basePath} onChange={onBasePathChange} autoFocus={autoFocus} />
      <p className="text-xs text-ink-3">
        Shell・FileSystem などの Module は、この Root パスの中のみアクセス可能
      </p>
      <WideRootWarning path={basePath} />
    </div>
  );
}

/**
 * アカウントから見えるリポジトリを探して選ぶ。一覧に無いもの（ほかの人の公開リポジトリ）は
 * URL か `owner/repo` を貼れば選べる。↓で一覧へ、↑↓で動き、Enter／Space で選ぶ
 */
function RepoSearch({
  account,
  picked,
  disabled,
  onPick,
}: {
  account: MockGithubAccount;
  picked: { owner: string; name: string } | null;
  disabled: boolean;
  onPick: (next: { owner: string; name: string }) => void;
}) {
  const [query, setQuery] = useState("");
  const { containerRef, onKeyDown } = useRovingFocus<HTMLDivElement>();
  const repos = getReposForAccount(account.id);
  const q = query.trim().toLowerCase();
  const pasted = parseRepoReference(query);
  const matches = pasted
    ? repos.filter((r) => r.owner === pasted.owner && r.name === pasted.name)
    : repos.filter(
        (r) => !q || r.name.toLowerCase().includes(q) || r.description?.toLowerCase().includes(q),
      );
  const showPasted = pasted && matches.length === 0;
  const isPicked = (owner: string, name: string) => picked?.owner === owner && picked?.name === name;

  // 選んだ行が一覧の外にあれば見える位置へ（URL から選んだ状態で開いたとき等）
  useEffect(() => {
    containerRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [picked, containerRef]);

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="new-project-repo-search">リポジトリ</Label>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
        <Input
          id="new-project-repo-search"
          value={query}
          disabled={disabled}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowDown") return;
            e.preventDefault();
            containerRef.current?.querySelector<HTMLElement>("[data-roving-item]")?.focus();
          }}
          placeholder="名前で絞る／URL を貼る"
          className="pl-8 text-xs"
          autoFocus
        />
      </div>
      <div
        ref={containerRef}
        onKeyDown={onKeyDown}
        role="listbox"
        aria-label={`${account.login} から見えるリポジトリ`}
        data-testid="repo-list"
        className="max-h-48 overflow-y-auto rounded-md border border-border"
      >
        {matches.map((r) => (
          <RepoRow
            key={`${r.owner}/${r.name}`}
            owner={r.owner}
            name={r.name}
            description={r.description}
            meta={r.pushedAt}
            icon={r.private ? <Lock /> : <Globe />}
            iconLabel={r.private ? "非公開" : "公開"}
            selected={isPicked(r.owner, r.name)}
            disabled={disabled}
            onPick={() => onPick({ owner: r.owner, name: r.name })}
          />
        ))}
        {showPasted ? (
          <RepoRow
            owner={pasted.owner}
            name={pasted.name}
            description="URL から clone"
            icon={<Link2 />}
            iconLabel="URL"
            selected={isPicked(pasted.owner, pasted.name)}
            disabled={disabled}
            onPick={() => onPick(pasted)}
          />
        ) : null}
        {matches.length === 0 && !showPasted ? (
          <p className="px-3 py-4 text-center text-xs text-ink-3">
            「{query.trim()}」に当たるリポジトリはありません。ほかの人のリポジトリなら、URL を貼ってください。
          </p>
        ) : null}
      </div>
    </div>
  );
}

function RepoRow({
  owner,
  name,
  description,
  meta,
  icon,
  iconLabel,
  selected,
  disabled,
  onPick,
}: {
  owner: string;
  name: string;
  description?: string;
  meta?: string;
  icon: React.ReactNode;
  iconLabel: string;
  selected: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      data-roving-item
      data-testid="repo-row"
      disabled={disabled}
      onClick={onPick}
      className={cn(
        "flex w-full items-center gap-2.5 border-b border-border px-3 py-2 text-left last:border-b-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:opacity-60",
        selected ? "bg-surface-2" : "hover:bg-accent",
      )}
    >
      <span className="shrink-0 text-ink-3 [&>svg]:size-3.5" title={iconLabel} aria-label={iconLabel}>
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-ink-3">
          {owner}/<span className="font-medium text-foreground">{name}</span>
        </span>
        {description ? <span className="truncate text-xs text-ink-3">{description}</span> : null}
      </span>
      {meta ? <span className="hidden shrink-0 text-xs text-ink-3 sm:inline">{meta}</span> : null}
      <Check className={cn("size-3.5 shrink-0 text-primary", selected ? "visible" : "invisible")} />
    </button>
  );
}

function AdvancedOverrides({
  open,
  onToggle,
  overrides,
  patch,
}: {
  open: boolean;
  onToggle: () => void;
  overrides: Overrides;
  patch: (next: Partial<Overrides>) => void;
}) {
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-fit items-center gap-1 text-xs text-ink-3 hover:text-foreground"
      >
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        Advanced——Configuration の上書き
      </button>
      {open ? (
        <div className="rounded-md border border-border px-3">
          <CascadeRow
            id="new-project-model"
            label="既定モデル"
            inheritedLabel={mockRuntimeDefaults.model}
            overridden={overrides.model !== undefined}
            onToggle={(on) => patch({ model: on ? mockRuntimeDefaults.model : undefined })}
          >
            <Select value={overrides.model} onValueChange={(v) => patch({ model: v })}>
              <SelectTrigger className="h-8 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude-opus-5">claude-opus-5</SelectItem>
                <SelectItem value="claude-sonnet-5">claude-sonnet-5</SelectItem>
                <SelectItem value="claude-haiku-4-5-20251001">claude-haiku-4-5-20251001</SelectItem>
              </SelectContent>
            </Select>
          </CascadeRow>

          <CascadeRow
            id="new-project-effort"
            label="既定 reasoning effort"
            inheritedLabel={mockRuntimeDefaults.effort}
            overridden={overrides.effort !== undefined}
            onToggle={(on) => patch({ effort: on ? mockRuntimeDefaults.effort : undefined })}
          >
            <Select value={overrides.effort} onValueChange={(v) => patch({ effort: v as Overrides["effort"] })}>
              <SelectTrigger className="h-8 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">low</SelectItem>
                <SelectItem value="medium">medium</SelectItem>
                <SelectItem value="high">high</SelectItem>
              </SelectContent>
            </Select>
          </CascadeRow>

          <CascadeRow
            id="new-project-memory"
            label="Memory 上限文字数"
            inheritedLabel={`${mockRuntimeDefaults.memoryLimitChars.toLocaleString()} 文字`}
            overridden={overrides.memoryLimitChars !== undefined}
            onToggle={(on) =>
              patch({ memoryLimitChars: on ? mockRuntimeDefaults.memoryLimitChars : undefined })
            }
          >
            <Input
              type="number"
              className="h-8"
              value={overrides.memoryLimitChars ?? mockRuntimeDefaults.memoryLimitChars}
              onChange={(e) => patch({ memoryLimitChars: Number(e.target.value) })}
            />
          </CascadeRow>

          <CascadeRow
            id="new-project-credential"
            label="使う資格情報"
            inheritedLabel="自動選択（使用率の低いものへ自動で移る）"
            overridden={overrides.credentialId !== undefined}
            onToggle={(on) => patch({ credentialId: on ? mockCredentials[0].id : undefined })}
          >
            <Select value={overrides.credentialId} onValueChange={(v) => patch({ credentialId: v })}>
              <SelectTrigger className="h-8 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {mockCredentials.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.label}
                    {c.usagePercent !== undefined ? `（${c.usagePercent}% 使用）` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CascadeRow>

          <CascadeRow
            id="new-project-vault"
            label="使う Vault 接続"
            inheritedLabel="instance 既定接続（組み込みローカル）"
            overridden={overrides.vaultImplementationId !== undefined}
            onToggle={(on) => patch({ vaultImplementationId: on ? DEFAULT_VAULT : undefined })}
          >
            <Select
              value={overrides.vaultImplementationId}
              onValueChange={(v) => patch({ vaultImplementationId: v })}
            >
              <SelectTrigger className="h-8 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {getRoles()
                  .find((r) => r.id === "vault")
                  ?.implementations.map((i) => (
                    <SelectItem key={i.id} value={i.id}>
                      {i.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </CascadeRow>
        </div>
      ) : null}
    </>
  );
}
