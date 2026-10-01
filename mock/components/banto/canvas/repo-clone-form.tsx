"use client";

// Repo の「clone」の本体（2026-10-01、作り直し）——**Repo Module の画面の中身**。2か所で同じものを使う：
//   - リポジトリの一覧の「URL から clone」（`repo-clone-dialog.tsx`。URL を打つ形）
//   - core の新しい Project の画面に差し出す始め方（`repo-prepare-view.tsx`。アカウントから探す形・URL も貼れる）
// 押す前に言う帯は `RepoRootPreview`。判断は `parseCloneSource`・`inspectCloneSource`・`inspectTargetFolder`・
// `checkCloneAccess` の1箇所ずつ（lib/mock/github.ts）。
//
// ボタンの置き場と言い方は入口ごとに違う（一覧はダイアログの下、core の画面では Module の枠の中）ので、
// この部品は「いま押せること」を `renderActions` に渡すだけで、ボタンは描かない。
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { Check, CircleAlert, Globe, KeyRound, Link2, Lock, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRovingFocus } from "@/hooks/use-roving-focus";
import { cn } from "@/lib/utils";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import {
  addClonedRepo,
  checkCloneAccess,
  freeFolderName,
  getReposForAccount,
  inspectCloneSource,
  inspectTargetFolder,
  isValidFolderName,
  parseCloneSource,
  useGithubAccounts,
  useRepoHome,
  type CloneSource,
  type KnownRepo,
  type MockGithubAccount,
  type ProjectSummary,
} from "@/lib/mock/github";
import {
  GithubAccountChooser,
  NoGithubAccount,
  REPO_SETTINGS_HREF,
} from "@/components/banto/project/github-account-chooser";
import { RepoRootPreview, type RootPreviewStatus } from "./repo-root-preview";

/** clone（し直し）が終わった——どこに、何を */
export interface ClonedFolder {
  path: string;
  /** `tjst-t/incus-lab`・`gitlab.com/tjst-t/zine` */
  label: string;
  /** 見つからない行の元の場所に clone し直した */
  recloned: boolean;
  /** clone し直した場所を、もう Project が使っている（Root が戻るだけ） */
  project?: ProjectSummary;
  /** Project 名の既定（リポジトリ名） */
  suggestedName: string;
}

/** いま押せること。ボタンは入口が描く */
export type CloneStep =
  /** まだ何も選んでいない・打っていない */
  | { kind: "empty" }
  /** URL として読めない（押したら断る） */
  | { kind: "invalid" }
  | { kind: "busy" }
  /** 置く場所にもう何かある・名前が使えない（帯が理由と次の手を言う） */
  | { kind: "blocked" }
  | { kind: "clone"; recloning: boolean; failed: boolean; project?: ProjectSummary; start: () => void }
  /** もう手元にある——clone はしない */
  | { kind: "have"; repo: KnownRepo; project?: ProjectSummary };

type Run =
  | { kind: "cloning"; received: number; total: number; source: CloneSource; path: string; accountId?: string }
  | { kind: "clone-failed"; reason: string; readableBy?: string };

const TOTAL = 3410;

export function RepoCloneForm({
  picker,
  initialInput = "",
  onCloned,
  onUseAsFolder,
  onOpenAt,
  onStartHere,
  renderActions,
}: {
  /** `url`：URL を打つ（一覧）。`search`：アカウントから見えるものを探す・URL も貼れる（core の画面） */
  picker: "url" | "search";
  initialInput?: string;
  onCloned: (folder: ClonedFolder) => void;
  /** 帯の「このフォルダで Project を作る」（置く場所に、Repo の知らないリポジトリがある等） */
  onUseAsFolder: (path: string) => void;
  /** 帯の「「〜」を開く」（置く場所を、もう Project が使っている）——その場所を渡す */
  onOpenAt: (path: string, projectId: string, closed: boolean) => void;
  /** もう手元にあり Project が無いときの、帯の次の手（無ければ出さない） */
  onStartHere?: (path: string) => void;
  renderActions: (step: CloneStep, markTried: () => void) => ReactNode;
}) {
  useMockStoreVersion();
  const home = useRepoHome();
  const accounts = useGithubAccounts();
  const [text, setText] = useState(picker === "url" ? initialInput : "");
  const [picked, setPicked] = useState<CloneSource | null>(() =>
    picker === "search" && initialInput ? parseCloneSource(initialInput) : null,
  );
  /** 押したときに読めなかった——それまでは打っている途中なので、断らずに例を出すだけ */
  const [tried, setTried] = useState(false);
  const [accountChoice, setAccountChoice] = useState<string | null>(null);
  /** null＝空いている名前に合わせる（人が打ったら、以後はその値） */
  const [folderInput, setFolderInput] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);

  const source = picker === "url" ? parseCloneSource(text) : picked;
  const github = source?.kind === "github" ? source : null;
  // 持ち主と同じ名前のアカウントがあれば、それを先に選んでおく。無ければ先頭（1つなら選ばせない——これがその1つ）
  const account: MockGithubAccount | undefined =
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

  // clone の進み——押した値は run が持つ（打ち直しても、走っている clone は変わらない）。ref を使わない
  useEffect(() => {
    if (run?.kind !== "cloning") return;
    const t = setTimeout(() => {
      if (run.received + 487 < run.total) {
        setRun({ ...run, received: run.received + 487 });
        return;
      }
      const access = checkCloneAccess(run.source, run.accountId);
      if (!access.ok) {
        setRun({ kind: "clone-failed", reason: access.reason, readableBy: access.readableBy?.id });
        return;
      }
      const found = inspectCloneSource(run.source);
      addClonedRepo({
        path: run.path,
        accountId: run.accountId,
        remote:
          run.source.kind === "github"
            ? { kind: "github", owner: run.source.owner, name: run.source.name, private: access.private }
            : { kind: "elsewhere", url: run.source.url },
      });
      setRun(null);
      onCloned({
        path: run.path,
        label:
          run.source.kind === "github" ? `${run.source.owner}/${run.source.name}` : `${run.source.host}/${run.source.path}`,
        recloned: found?.kind === "reclone",
        project: found?.kind === "reclone" ? found.project : undefined,
        suggestedName: run.source.name,
      });
    }, 180);
    return () => clearTimeout(t);
  }, [run, onCloned]);

  function reset() {
    setRun(null);
    setFolderInput(null);
    // アカウントは clone の元の持ち主で選び直す（前に選んだものを持ち越さない）
    setAccountChoice(null);
  }

  function start() {
    if (!source) return;
    setRun({
      kind: "cloning",
      received: 0,
      total: TOTAL,
      source,
      path: targetPath,
      accountId: source.kind === "github" ? account?.id : undefined,
    });
  }

  const cloning = run?.kind === "cloning";
  const step: CloneStep = cloning
    ? { kind: "busy" }
    : !source
      ? text.trim() === "" ? { kind: "empty" } : { kind: "invalid" }
      : have
        ? { kind: "have", repo: have.repo, project: have.project }
        : reclone || targetState?.kind === "free"
          ? { kind: "clone", recloning: !!reclone, failed: run?.kind === "clone-failed", project: reclone?.project, start }
          : { kind: "blocked" };

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

  const unreadable = picker === "url" && text.trim() !== "" && !source;
  const showAccount = !!github && !inspected;
  const markTried = () => setTried(true);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {picker === "url" ? (
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
              <ElsewhereNote host={source.host} />
            ) : source ? null : (
              "GitHub の URL か owner/repo。GitHub の外（gitlab.com など）の URL も使えます。"
            )}
          </p>
        </div>
      ) : accounts.length === 0 ? (
        <NoGithubAccount reason="登録すると、ここからリポジトリを探して clone できます。" />
      ) : (
        <>
          {account ? (
            <GithubAccountChooser
              id="repo-clone-account"
              accounts={accounts}
              value={account.id}
              onChange={(id) => {
                setAccountChoice(id);
                setPicked(null);
                setRun(null);
                setFolderInput(null);
              }}
              singleNote="から見えるリポジトリを出しています"
            />
          ) : null}
          {account ? (
            <RepoSearch
              key={account.id}
              account={account}
              picked={picked}
              disabled={cloning}
              onPick={(next) => {
                setPicked(next);
                setRun(null);
                setFolderInput(null);
              }}
            />
          ) : null}
          {picked?.kind === "elsewhere" ? (
            <p className="flex items-start gap-1 text-xs text-ink-3">
              <ElsewhereNote host={picked.host} />
            </p>
          ) : null}
        </>
      )}

      {picker === "url" && showAccount ? (
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
          <p data-testid="repo-clone-no-account" className="flex items-start gap-1.5 text-xs text-ink-2">
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
            onUseAsFolder={onUseAsFolder}
            onSwitchToClone={() => undefined}
            onOpenProject={(id, closed) => onOpenAt(targetPath, id, closed)}
            failedNext={failedNext}
            onStartHere={onStartHere}
          />
          {status.kind !== "have" && status.kind !== "reclone" ? (
            <p className="text-xs text-ink-3">置き場（{home}）は Repo の設定で変えられます。</p>
          ) : null}
        </div>
      ) : null}

      {renderActions(step, markTried)}
    </div>
  );
}

function ElsewhereNote({ host }: { host: string }) {
  return (
    <>
      <Link2 className="mt-0.5 size-3.5 shrink-0" />
      <span data-testid="repo-clone-elsewhere">
        GitHub の外（{host}）です。Repo のアカウントは使わず、このマシンの git の設定で clone します。
      </span>
    </>
  );
}

/**
 * アカウントから見えるリポジトリを探して選ぶ。一覧に無いもの（ほかの人の公開リポジトリ・GitHub の外）は
 * URL か `owner/repo` を貼れば選べる。↓で一覧へ、↑↓で動き、Enter／Space で選ぶ
 */
function RepoSearch({
  account,
  picked,
  disabled,
  onPick,
}: {
  account: MockGithubAccount;
  picked: CloneSource | null;
  disabled: boolean;
  onPick: (next: CloneSource) => void;
}) {
  const [query, setQuery] = useState("");
  const { containerRef, onKeyDown } = useRovingFocus<HTMLDivElement>();
  const repos = getReposForAccount(account.id);
  const q = query.trim().toLowerCase();
  const pasted = q.includes("/") ? parseCloneSource(query) : null;
  const matches =
    pasted?.kind === "github"
      ? repos.filter((r) => r.owner === pasted.owner && r.name === pasted.name)
      : pasted
        ? []
        : repos.filter((r) => !q || r.name.toLowerCase().includes(q) || r.description?.toLowerCase().includes(q));
  const showPasted = pasted && matches.length === 0;
  const isPicked = (s: CloneSource) =>
    picked?.kind === s.kind &&
    (s.kind === "github"
      ? picked.kind === "github" && picked.owner === s.owner && picked.name === s.name
      : picked.kind === "elsewhere" && picked.url === s.url);

  // 選んだ行が一覧の外にあれば見える位置へ（URL から選んだ状態で開いたとき等）
  useEffect(() => {
    containerRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [picked, containerRef]);

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="repo-clone-search">リポジトリ</Label>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
        <Input
          id="repo-clone-search"
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
        className="max-h-48 overflow-y-auto rounded-md border border-border bg-background"
      >
        {matches.map((r) => {
          const s: CloneSource = { kind: "github", owner: r.owner, name: r.name };
          return (
            <SearchRow
              key={`${r.owner}/${r.name}`}
              owner={r.owner}
              name={r.name}
              description={r.description}
              meta={r.pushedAt}
              icon={r.private ? <Lock /> : <Globe />}
              iconLabel={r.private ? "非公開" : "公開"}
              selected={isPicked(s)}
              disabled={disabled}
              onPick={() => onPick(s)}
            />
          );
        })}
        {showPasted ? (
          <SearchRow
            owner={pasted.kind === "github" ? pasted.owner : pasted.host}
            name={pasted.kind === "github" ? pasted.name : pasted.path}
            description="URL から clone"
            icon={<Link2 />}
            iconLabel="URL"
            selected={isPicked(pasted)}
            disabled={disabled}
            onPick={() => onPick(pasted)}
          />
        ) : null}
        {matches.length === 0 && !showPasted ? (
          <p className="px-3 py-4 text-center text-xs text-ink-3">
            「{query.trim()}」に当たるリポジトリはありません。ほかの人のリポジトリ・GitHub の外なら、URL を貼ってください。
          </p>
        ) : null}
      </div>
    </div>
  );
}

function SearchRow({
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
  icon: ReactNode;
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
