"use client";

// リポジトリの一覧（2026-09-30、ユーザー決定）——**Repo は banto 全体に1本**なので、
// これは banto 全体の Module の画面。**Repo の台帳（知っているリポジトリ）から作る**——
// 置き場のフォルダを見て回るのではない。だから置き場の外（`~/ghq/…` など）から
// Import したものも同じ一覧に並ぶ。
//
// 人がここで知りたいのは2つ：**どの Project が使っているか**と、**GitHub にあるか**
// （無ければ、このマシンが壊れたら消える）。並べ方もこの2つで決める：
//   - 区切りは「Project で使っている」「Project はまだ無い」の2つ（前者が今の仕事、
//     後者は始める候補）
//   - 各区切りの中は「フォルダが見つからない」→「このマシンにだけ」の順に先に（次の手が要るもの）、
//     あとは名前順。見つからないものも Project との関係で区切る——Project の Root が消えていれば
//     その Project は動かないので、「Project で使っている」の一番上に出るのがいちばん大事
//     （見つからないものだけの区切りを作ると、どの Project が困っているかが離れる）
// 行は2列（と端に操作）だけにして、事実のすぐ隣にその次の手を置く：
//   - 左：名前・置き場所・GitHub のどこか（アカウント）。まだなら同じ行に「GitHub に公開」
//   - 右：使っている Project（サイドバーと同じ頭文字）。無ければ「Project を始める」
//   - 端：行の操作（「一覧から外す」——フォルダは消さない。押す前にそう言う）
// 置き場所は行ごとに出す——フォルダ名から持ち主は分からないし、Import したものは置き場の外にある。
//
// 開き方は2つで、中身は同じ（Skill の置き場の画面と同じ形）：
//   - Project の中：Command Palette の入口 → 会話の隣の Canvas（`banto.repo:repos`）
//   - banto 全体の設定の Repo の面：そこに埋め込む
// 「GitHub に公開」はこの画面の中で公開の画面に替わる（Module の中の移動）。
// 「フォルダを Import」はこの画面の上のダイアログ（1つずつ選ぶ。まとめて取り込む入口は作らない）。
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  CloudDownload,
  CloudUpload,
  Ellipsis,
  FolderInput,
  FolderX,
  Globe,
  HardDrive,
  History,
  Link2,
  ListX,
  LoaderCircle,
  Lock,
  Plus,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { reopenProject } from "@/lib/mock/projects";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import {
  getProjectsUsingRepo,
  recloneMissingRepo,
  remoteHost,
  removeFromLedger,
  restoreLedgerEntry,
  useLedgerRepos,
  useRepoHome,
  type GithubLocation,
  type KnownRepo,
  type LedgerRepo,
  type MissingRepo,
} from "@/lib/mock/github";
import type { MockProject } from "@/lib/mock/types";
import { ProjectInitial } from "@/components/banto/shell/nav-panel";
import { AccountMark, REPO_SETTINGS_HREF } from "@/components/banto/project/github-account-chooser";
import { ChoicePills } from "@/components/banto/project/choice-pills";
import { NewProjectDialog, type NewProjectPreset } from "@/components/banto/project/new-project-dialog";
import { RepoPublishPanel } from "./repo-publish-view";
import { RepoImportDialog } from "./repo-import-dialog";

type Filter = "all" | "local" | "missing";

/** `at` は同じ行をもう一度光らせるため（行を作り直す key に入れる） */
type Highlight = { path: string; at: number };

/** Canvas（会話の隣）として開いたとき */
export function RepoListView() {
  return <RepoList />;
}

export function RepoList({ embedded = false }: { embedded?: boolean }) {
  useMockStoreVersion();
  const home = useRepoHome();
  // 台帳が空なら、Import の入口は空の案内の中の1つだけにする（同じボタンを2つ並べない）
  const empty = useLedgerRepos().length === 0;
  // モックの見せ方のためだけ：`?import=<path>` で Import をそのフォルダから開く
  const importParam = useSearchParams().get("import");
  const [publishing, setPublishing] = useState<string | null>(null);
  const [starting, setStarting] = useState<NewProjectPreset | null>(null);
  const [importAt, setImportAt] = useState<string | null>(importParam);
  /** Import した・「一覧で見る」で来た行——少しの間だけ地を付けて、どこに入ったかを見せる */
  const [highlight, setHighlight] = useState<Highlight | null>(null);

  if (publishing) {
    return <RepoPublishPanel folder={publishing} onBack={() => setPublishing(null)} />;
  }

  return (
    <div className={cn("@container min-h-0", !embedded && "h-full overflow-y-auto")} data-testid="repo-list-view">
      <div className={cn("flex flex-col gap-5", !embedded && "mx-auto max-w-3xl px-5 py-8")}>
        <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="flex min-w-0 flex-col gap-1">
            {embedded ? (
              <h2 className="text-md font-semibold text-foreground">リポジトリ</h2>
            ) : (
              <h2 className="text-xl font-semibold text-foreground">リポジトリ</h2>
            )}
            <p data-testid="repo-list-lead" className="text-sm text-ink-2">
              Repo が知っているもの。clone・新しく作るものは{" "}
              <span className="font-mono text-xs">{home}</span> に置きます
              <span className="text-ink-3">
                （
                <Link
                  href={embedded ? "#anchor-repo-home" : `${REPO_SETTINGS_HREF}#anchor-repo-home`}
                  className="rounded-sm underline decoration-border underline-offset-2 hover:text-foreground hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-ring"
                >
                  変える
                </Link>
                ）
              </span>
            </p>
          </div>
          {empty ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 shrink-0 gap-1.5 text-xs"
              onClick={() => setImportAt("~")}
              data-testid="repo-import-open"
            >
              <FolderInput className="size-3.5" />
              フォルダを Import
            </Button>
          )}
        </header>
        <RepoListBody
          highlight={highlight}
          onPublish={setPublishing}
          onStart={(repo) => setStarting({ method: "folder", folder: repo.path, name: repo.name })}
          onImport={() => setImportAt("~")}
          onShow={(path) => setHighlight({ path, at: Date.now() })}
        />
      </div>
      {starting ? (
        <NewProjectDialog open onOpenChange={(open) => !open && setStarting(null)} preset={starting} />
      ) : null}
      {importAt ? (
        <RepoImportDialog
          startAt={importAt}
          onClose={() => setImportAt(null)}
          onShow={(path) => {
            setImportAt(null);
            setHighlight({ path, at: Date.now() });
          }}
        />
      ) : null}
    </div>
  );
}

function RepoListBody({
  highlight,
  onPublish,
  onStart,
  onImport,
  onShow,
}: {
  highlight: Highlight | null;
  onPublish: (path: string) => void;
  onStart: (repo: KnownRepo) => void;
  onImport: () => void;
  onShow: (path: string) => void;
}) {
  const [filterChoice, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const facts = useLedgerRepos().map((repo) => ({ repo, projects: getProjectsUsingRepo(repo) }));
  const localCount = facts.filter((f) => isLocalOnly(f.repo)).length;
  const missingCount = facts.filter((f) => f.repo.missing).length;
  // 最後の1つを外したら札ごと消えるので、選んでいた絞り込みも「すべて」へ戻す
  const filter = filterChoice === "missing" && missingCount === 0 ? "all" : filterChoice;
  const q = query.trim().toLowerCase();
  const shown = facts
    .filter(
      (f) =>
        (filter === "all" || (filter === "local" ? isLocalOnly(f.repo) : f.repo.missing)) &&
        (q === "" || `${f.repo.name} ${f.repo.path} ${githubName(f.repo) ?? ""}`.toLowerCase().includes(q)),
    )
    // 次の手が要る順：フォルダが見つからない → このマシンにだけ → あとは名前順
    .sort((a, b) => rank(a.repo) - rank(b.repo) || a.repo.name.localeCompare(b.repo.name));
  const groups = [
    { id: "used", title: "Project で使っている", items: shown.filter((f) => f.projects.length > 0) },
    { id: "unused", title: "Project はまだ無い", items: shown.filter((f) => f.projects.length === 0) },
  ].filter((g) => g.items.length > 0);

  if (facts.length === 0) return <EmptyLedger onImport={onImport} />;

  const choices: { value: Filter; label: ReactNode }[] = [
    { value: "all", label: <FilterLabel text="すべて" count={facts.length} /> },
    { value: "local", label: <FilterLabel text="このマシンにだけ" count={localCount} /> },
    // 見つからないものが無ければ札を出さない（いつも0の札は、ただの飾りになる）
    ...(missingCount > 0
      ? [{ value: "missing" as const, label: <FilterLabel text="フォルダが見つからない" count={missingCount} /> }]
      : []),
  ];

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <ChoicePills
          labelledBy="repo-filter-label"
          testId="repo-filter"
          value={filter}
          onChange={setFilter}
          choices={choices}
        />
        <span id="repo-filter-label" className="sr-only">
          絞り込み
        </span>
        <div className="relative ml-auto w-full @md:w-48">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="名前・場所で絞る"
            aria-label="名前・場所で絞る"
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>

      {shown.length === 0 ? (
        <EmptyResult
          filter={filter}
          query={query.trim()}
          onClear={() => {
            setFilter("all");
            setQuery("");
          }}
        />
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((g) => (
            <section key={g.id} aria-labelledby={`repo-group-${g.id}`} data-testid="repo-group" data-group={g.id}>
              <h3 id={`repo-group-${g.id}`} className="flex items-baseline gap-2 pb-1.5 text-xs font-medium text-ink-2">
                {g.title}
                <span className="font-normal text-ink-3 tabular-nums">{g.items.length}</span>
              </h3>
              <ul className="flex flex-col border-t border-border">
                {g.items.map((f) => (
                  <RepoRow
                    key={highlight?.path === f.repo.path ? `${f.repo.path}:${highlight.at}` : f.repo.path}
                    repo={f.repo}
                    projects={f.projects}
                    highlighted={highlight?.path === f.repo.path}
                    onPublish={() => onPublish(f.repo.path)}
                    onStart={() => !f.repo.missing && onStart(f.repo)}
                    onImport={onImport}
                    onShow={onShow}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

function isLocalOnly(repo: LedgerRepo): boolean {
  return !repo.missing && repo.remote.kind === "none";
}

/** 区切りの中の並び——見つからないもの（Project が動かない・戻す手が要る）を一番上に */
function rank(repo: LedgerRepo): number {
  return repo.missing ? 0 : isLocalOnly(repo) ? 1 : 2;
}

function githubName(repo: LedgerRepo): string | undefined {
  if (repo.missing) return repo.github && `${repo.github.owner}/${repo.github.name}`;
  return repo.remote.kind === "github" ? `${repo.remote.owner}/${repo.remote.name}` : undefined;
}

function FilterLabel({ text, count }: { text: string; count: number }) {
  return (
    <>
      {text}
      <span className="font-normal text-ink-3 tabular-nums">{count}</span>
    </>
  );
}

function RepoRow({
  repo,
  projects,
  highlighted,
  onPublish,
  onStart,
  onImport,
  onShow,
}: {
  repo: LedgerRepo;
  projects: readonly MockProject[];
  highlighted: boolean;
  onPublish: () => void;
  onStart: () => void;
  onImport: () => void;
  onShow: (path: string) => void;
}) {
  const [lit, setLit] = useState(highlighted);
  // 見える位置へ出して、少ししたら地を戻す（動きを減らす設定では色の移り変わりを止める）
  useEffect(() => {
    if (!highlighted) return;
    const row = document.querySelector<HTMLElement>(`[data-repo-path="${CSS.escape(repo.path)}"]`);
    row?.scrollIntoView({ block: "nearest" });
    row?.focus({ preventScroll: true });
    const t = setTimeout(() => setLit(false), 2400);
    return () => clearTimeout(t);
  }, [highlighted, repo.path]);

  function remove(trigger: HTMLElement | null) {
    // 行が消えると焦点の行き先が無くなる——隣の行の操作、無ければ上の「フォルダを Import」へ
    const li = trigger?.closest("li");
    const nextFocus =
      (li?.nextElementSibling ?? li?.previousElementSibling)?.querySelector<HTMLElement>(
        '[data-testid="repo-row-menu"]',
      ) ?? document.querySelector<HTMLElement>('[data-testid="repo-import-open"]');
    const entry = removeFromLedger(repo.path);
    if (!entry) return;
    requestAnimationFrame(() => nextFocus?.focus());
    const kept = [
      repo.missing ? null : `フォルダは ${repo.path} のまま`,
      projects.length > 0 ? `Project「${projects.map((p) => p.name).join("」「")}」もそのまま` : null,
    ].filter(Boolean);
    toast(`${repo.name} を一覧から外しました${kept.length > 0 ? `（${kept.join("・")}です）` : ""}`, {
      action: {
        label: "元に戻す",
        onClick: () => {
          restoreLedgerEntry(entry);
          onShow(entry.path);
        },
      },
    });
  }

  return (
    <li
      data-testid="repo-item"
      data-repo-path={repo.path}
      data-state={repo.missing ? "missing" : undefined}
      data-highlighted={lit || undefined}
      tabIndex={highlighted ? -1 : undefined}
      className={cn(
        // 狭い幅：[名前など｜操作] の下に Project。広い幅：[名前など｜Project｜操作]
        "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 border-b border-border py-3 transition-colors duration-700 outline-none motion-reduce:transition-none @lg:grid-cols-[minmax(0,1fr)_13rem_auto] @lg:items-start @lg:gap-x-6",
        lit && "bg-surface-2",
      )}
    >
      <div className="col-start-1 row-start-1 flex min-w-0 flex-col gap-0.5">
        <p className="truncate text-md font-medium text-foreground">{repo.name}</p>
        <p data-testid="repo-path" className="font-mono text-xs break-all text-ink-3">
          {repo.path}
        </p>
        {repo.missing ? (
          <MissingLine repo={repo} projects={projects} onRemove={remove} onImport={onImport} onShow={onShow} />
        ) : (
          <>
            <div data-testid="repo-remote" className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <RemoteLine repo={repo} />
              {isLocalOnly(repo) ? (
                <button
                  type="button"
                  onClick={onPublish}
                  data-testid="repo-publish-open"
                  className="flex items-center gap-1 rounded-sm font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <CloudUpload className="size-3.5" />
                  GitHub に公開
                </button>
              ) : null}
            </div>
            {repo.correctedFrom ? <CorrectedNote from={repo.correctedFrom} /> : null}
          </>
        )}
      </div>

      <div
        data-testid="repo-projects"
        className="col-span-2 row-start-2 flex flex-col gap-1 @lg:col-span-1 @lg:col-start-2 @lg:row-start-1"
      >
        {projects.length > 0 ? (
          projects.map((p) => <ProjectLink key={p.id} project={p} viaWorktree={p.basePath !== repo.path} />)
        ) : repo.missing ? null : (
          <button
            type="button"
            onClick={onStart}
            data-testid="repo-start-project"
            className="flex w-fit items-center gap-2 rounded-md py-0.5 pr-2 text-sm text-ink-3 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span
              aria-hidden
              className="flex size-6 shrink-0 items-center justify-center rounded-md border border-dashed border-border text-ink-3"
            >
              <Plus className="size-3.5" />
            </span>
            Project を始める
          </button>
        )}
      </div>

      <div className="col-start-2 row-start-1 -mt-1 @lg:col-start-3">
        <RowMenu repo={repo} projects={projects} onRemove={remove} />
      </div>
    </li>
  );
}

/**
 * 行の操作。いまは「一覧から外す」だけ——**押す前に、フォルダは消えないことを言う**
 * （メニューの項目の下に1行）。外すのは Repo の記録だけで、フォルダ・GitHub・Project には触らない。
 *
 * Project が使っているものも外せる（止めない）。Project の Root はフォルダのパスで、Repo の台帳を
 * 通していない——外しても Project はそのまま動く。失うのは Repo の記録（どのアカウントで push するか・
 * GitHub の場所）だけで、フォルダが残っているので Import すればすぐ戻る。だから確かめの画面は挟まず、
 * そのことを項目の下とトーストで言い、トーストに「元に戻す」を置く
 */
function RowMenu({
  repo,
  projects,
  onRemove,
}: {
  repo: LedgerRepo;
  projects: readonly MockProject[];
  onRemove: (trigger: HTMLElement | null) => void;
}) {
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const github = githubName(repo);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          ref={setTrigger}
          type="button"
          data-testid="repo-row-menu"
          aria-label={`${repo.name} の操作`}
          className="flex size-9 items-center justify-center rounded-md text-ink-3 hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring data-[state=open]:bg-accent data-[state=open]:text-foreground @lg:size-8"
        >
          <Ellipsis className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuItem
          data-testid="repo-remove"
          onSelect={() => onRemove(trigger)}
          className="items-start gap-2 py-2"
        >
          <ListX className="mt-0.5 size-4 shrink-0" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="font-medium">一覧から外す</span>
            {repo.missing ? (
              <span data-testid="repo-remove-note" className="text-xs text-ink-3">
                Repo の記録だけを消します。{github ? <>GitHub の {github} には触りません。</> : null}
              </span>
            ) : (
              // いちばん先に言うのは「フォルダは消えない」。パスは1行に分けて、途中で折れないようにする
              <span data-testid="repo-remove-note" className="flex flex-col gap-0.5 text-xs text-ink-3">
                <span className="text-ink-2">フォルダは消さず、そのまま残ります</span>
                <span className="font-mono break-all">{repo.path}</span>
                {projects.length > 0 ? (
                  <span>Project「{projects.map((p) => p.name).join("」「")}」もそのまま使えます</span>
                ) : null}
              </span>
            )}
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 台帳にあるのに、フォルダが見つからない。この一覧で**いちばん強く塗る**のはここ（turn の地
 * ——人の手が要る）。次の手はそのすぐ隣に1つ：GitHub の場所を覚えていれば「clone し直す」
 * （元の場所へ。Project の Root もそこなので、そのまま動くようになる）、無ければ「一覧から外す」
 */
function MissingLine({
  repo,
  projects,
  onRemove,
  onImport,
  onShow,
}: {
  repo: MissingRepo;
  projects: readonly MockProject[];
  onRemove: (trigger: HTMLElement | null) => void;
  onImport: () => void;
  onShow: (path: string) => void;
}) {
  const [run, setRun] = useState<{ kind: "cloning" } | { kind: "failed"; reason: string } | null>(null);
  const { github } = repo;

  function reclone() {
    setRun({ kind: "cloning" });
    // 本物は git clone を待つ。モックは少しだけ待たせて、押したことが見えるようにする
    setTimeout(() => {
      const result = recloneMissingRepo(repo.path);
      if (!result.ok) {
        setRun({ kind: "failed", reason: result.reason });
        return;
      }
      toast(
        `Repo が ${github?.owner}/${github?.name} を ${repo.path} に clone し直しました` +
          (projects.length > 0 ? `（Project「${projects[0].name}」の Root です）` : ""),
      );
      onShow(repo.path);
    }, 1200);
  }

  return (
    <div data-testid="repo-missing" className="mt-0.5 flex flex-col gap-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="flex items-center gap-1 rounded-sm bg-turn-soft px-1.5 py-0.5 font-medium text-foreground">
          <FolderX className="size-3.5 shrink-0 text-turn" />
          フォルダが見つかりません
        </span>
        {github ? (
          <span className="flex min-w-0 items-center gap-1 text-ink-3">
            GitHub の
            <AccountMark login={github.owner} />
            <span className="font-mono break-all text-ink-2">
              {github.owner}/{github.name}
            </span>
            にあります
          </span>
        ) : (
          <span className="text-ink-3">GitHub にも無いので、戻す手はありません</span>
        )}
      </div>
      {github ? (
        run?.kind === "cloning" ? (
          <p role="status" className="flex items-center gap-1.5 text-ink-2">
            <LoaderCircle className="size-3.5 motion-safe:animate-spin" />
            Repo が clone し直しています…
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={reclone}
              data-testid="repo-reclone"
              className="h-7 w-fit gap-1.5 text-xs"
            >
              <CloudDownload className="size-3.5" />
              {run ? "もう一度 clone し直す" : "clone し直す"}
            </Button>
            <span className="text-ink-3">元の場所に戻します</span>
          </div>
        )
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={(e) => onRemove(e.currentTarget)}
            data-testid="repo-remove-inline"
            className="h-7 w-fit gap-1.5 text-xs"
          >
            <ListX className="size-3.5" />
            一覧から外す
          </Button>
          <button
            type="button"
            onClick={onImport}
            className="rounded-sm text-ink-3 underline decoration-border underline-offset-2 hover:text-foreground hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            移したなら、移した先を Import
          </button>
        </div>
      )}
      {run?.kind === "failed" ? (
        <p data-testid="repo-reclone-failed" role="alert" className="text-ink-2">
          clone できませんでした：{run.reason}。
          <Link
            href={REPO_SETTINGS_HREF}
            className="rounded-sm font-medium text-foreground underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
          >
            読めるアカウントを登録する
          </Link>
        </p>
      ) : null}
    </div>
  );
}

/** 台帳の GitHub の場所を、フォルダの origin に合わせて直した——そのことを1行で言う */
function CorrectedNote({ from }: { from: GithubLocation }) {
  return (
    <p data-testid="repo-corrected" className="mt-0.5 flex items-start gap-1 text-xs text-ink-3">
      <History className="mt-px size-3.5 shrink-0" />
      <span>
        フォルダの origin に合わせて、GitHub の場所を直しました（前は{" "}
        <span className="font-mono whitespace-nowrap">
          {from.owner}/{from.name}
        </span>
        ）
      </span>
    </p>
  );
}

function RemoteLine({ repo }: { repo: KnownRepo }) {
  const { remote } = repo;
  if (remote.kind === "none") {
    // この一覧で塗るのは、ここと「フォルダが見つかりません」の2つだけ——次の手が要るもの。
    // こちらは warn（壊れたら消える）、見つからないほうは turn（もう動かない・人の手が要る）
    return (
      <>
        <span
          data-testid="repo-local-only"
          className="flex items-center gap-1 rounded-sm bg-warn-soft px-1.5 py-0.5 font-medium text-foreground"
        >
          <HardDrive className="size-3.5 shrink-0 text-warn" />
          このマシンにだけ
        </span>
        <span className="text-ink-3">
          {repo.commits > 0 ? (
            <>
              <span className="font-mono">{repo.branch}</span> · {repo.commits} コミット
            </>
          ) : (
            "まだコミットがありません"
          )}
        </span>
      </>
    );
  }
  if (remote.kind === "elsewhere") {
    return (
      <span className="flex items-center gap-1 text-ink-3">
        <Link2 className="size-3.5 shrink-0" />
        GitHub の外（{remoteHost(remote.url)}）
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-ink-3">
      <span className="flex items-center gap-1">
        {remote.private ? <Lock className="size-3.5 shrink-0" /> : <Globe className="size-3.5 shrink-0" />}
        GitHub{remote.private ? "・非公開" : "・公開"}
      </span>
      <span aria-hidden>·</span>
      {/* どのアカウントのものか——GitHub の持ち主 */}
      <span className="flex min-w-0 items-center gap-1">
        <AccountMark login={remote.owner} />
        <span className="font-mono break-all text-ink-2">
          {remote.owner}/{remote.name}
        </span>
      </span>
    </span>
  );
}

function ProjectLink({ project, viaWorktree }: { project: MockProject; viaWorktree: boolean }) {
  const router = useRouter();
  const closed = project.status === "closed";
  const body = (
    <>
      <ProjectInitial project={project} active={false} />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className={cn("truncate text-sm", closed ? "text-ink-3" : "text-foreground")}>{project.name}</span>
        {closed || viaWorktree ? (
          <span className="truncate text-xs text-ink-3">
            {[closed ? "閉じた Project" : null, viaWorktree ? "worktree で" : null].filter(Boolean).join(" · ")}
          </span>
        ) : null}
      </span>
    </>
  );
  const className =
    "flex w-fit max-w-full items-center gap-2 rounded-md py-0.5 pr-2 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring";
  if (closed) {
    return (
      <button
        type="button"
        data-testid="repo-project"
        title={`「${project.name}」を再開して開く`}
        onClick={() => {
          reopenProject(project.id);
          router.push(`/p/${project.id}`);
        }}
        className={cn(className, "text-left")}
      >
        {body}
      </button>
    );
  }
  return (
    <Link href={`/p/${project.id}`} data-testid="repo-project" title={`「${project.name}」を開く`} className={className}>
      {body}
    </Link>
  );
}

/** 台帳が空——次の手は2つ（新しい Project から clone・作る／手元のフォルダを Import） */
function EmptyLedger({ onImport }: { onImport: () => void }) {
  return (
    <div
      data-testid="repo-list-empty"
      className="flex flex-col items-start gap-3 rounded-md border border-dashed border-border px-4 py-5 text-sm text-ink-2"
    >
      <p>まだ知っているリポジトリがありません。</p>
      <p className="text-xs text-ink-3">
        新しい Project の画面で GitHub から clone するか新しく作ると、ここに並びます。
        手元にあるリポジトリは、そのままの場所で足せます。
      </p>
      <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={onImport}>
        <FolderInput className="size-3.5" />
        フォルダを Import
      </Button>
    </div>
  );
}

function EmptyResult({ filter, query, onClear }: { filter: Filter; query: string; onClear: () => void }) {
  const message = query
    ? `「${query}」に当たるリポジトリはありません。`
    : filter === "missing"
      ? "フォルダが見つからないものはありません。"
      : "このマシンにだけあるものはありません。どれも GitHub かほかの場所にあります。";
  return (
    <div data-testid="repo-list-empty" className="flex flex-col items-start gap-2 py-6 text-sm text-ink-2">
      <p>{message}</p>
      {filter !== "all" || query ? (
        <button
          type="button"
          onClick={onClear}
          className="rounded-sm text-xs font-medium text-foreground underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
        >
          すべて表示する
        </button>
      ) : null}
    </div>
  );
}
