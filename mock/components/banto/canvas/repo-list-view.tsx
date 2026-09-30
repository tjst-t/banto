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
//   - 各区切りの中は「このマシンにだけ」を先に（次の手が要るもの）、あとは名前順
// 行は2列だけにして、事実のすぐ隣にその次の手を置く：
//   - 左：名前・置き場所・GitHub のどこか（アカウント）。まだなら同じ行に「GitHub に公開」
//   - 右：使っている Project（サイドバーと同じ頭文字）。無ければ「Project を始める」
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
import { CloudUpload, FolderInput, Globe, HardDrive, Link2, Lock, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { reopenProject } from "@/lib/mock/projects";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import {
  getProjectsUsingRepo,
  remoteHost,
  useKnownRepos,
  useRepoHome,
  type KnownRepo,
} from "@/lib/mock/github";
import type { MockProject } from "@/lib/mock/types";
import { ProjectInitial } from "@/components/banto/shell/nav-panel";
import { AccountMark, REPO_SETTINGS_HREF } from "@/components/banto/project/github-account-chooser";
import { ChoicePills } from "@/components/banto/project/choice-pills";
import { NewProjectDialog, type NewProjectPreset } from "@/components/banto/project/new-project-dialog";
import { RepoPublishPanel } from "./repo-publish-view";
import { RepoImportDialog } from "./repo-import-dialog";

type Filter = "all" | "local";

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
  const empty = useKnownRepos().length === 0;
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
}: {
  highlight: Highlight | null;
  onPublish: (path: string) => void;
  onStart: (repo: KnownRepo) => void;
  onImport: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const facts = useKnownRepos().map((repo) => ({ repo, projects: getProjectsUsingRepo(repo) }));
  const localCount = facts.filter((f) => f.repo.remote.kind === "none").length;
  const q = query.trim().toLowerCase();
  const shown = facts
    .filter(
      (f) =>
        (filter === "all" || f.repo.remote.kind === "none") &&
        (q === "" || `${f.repo.name} ${f.repo.path} ${githubName(f.repo) ?? ""}`.toLowerCase().includes(q)),
    )
    // このマシンにだけあるものを先に、あとは名前順
    .sort(
      (a, b) =>
        Number(b.repo.remote.kind === "none") - Number(a.repo.remote.kind === "none") ||
        a.repo.name.localeCompare(b.repo.name),
    );
  const groups = [
    { id: "used", title: "Project で使っている", items: shown.filter((f) => f.projects.length > 0) },
    { id: "unused", title: "Project はまだ無い", items: shown.filter((f) => f.projects.length === 0) },
  ].filter((g) => g.items.length > 0);

  if (facts.length === 0) return <EmptyLedger onImport={onImport} />;

  const choices: { value: Filter; label: ReactNode }[] = [
    { value: "all", label: <FilterLabel text="すべて" count={facts.length} /> },
    { value: "local", label: <FilterLabel text="このマシンにだけ" count={localCount} /> },
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
                    onStart={() => onStart(f.repo)}
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

function githubName(repo: KnownRepo): string | undefined {
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
}: {
  repo: KnownRepo;
  projects: readonly MockProject[];
  highlighted: boolean;
  onPublish: () => void;
  onStart: () => void;
}) {
  const local = repo.remote.kind === "none";
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

  return (
    <li
      data-testid="repo-item"
      data-repo-path={repo.path}
      data-highlighted={lit || undefined}
      tabIndex={highlighted ? -1 : undefined}
      className={cn(
        "grid grid-cols-1 gap-x-6 gap-y-2 border-b border-border py-3 transition-colors duration-700 outline-none motion-reduce:transition-none @lg:grid-cols-[minmax(0,1fr)_13rem] @lg:items-start",
        lit && "bg-surface-2",
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="truncate text-md font-medium text-foreground">{repo.name}</p>
        <p data-testid="repo-path" className="font-mono text-xs break-all text-ink-3">
          {repo.path}
        </p>
        <div data-testid="repo-remote" className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <RemoteLine repo={repo} />
          {local ? (
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
      </div>

      <div data-testid="repo-projects" className="flex flex-col gap-1">
        {projects.length > 0 ? (
          projects.map((p) => <ProjectLink key={p.id} project={p} viaWorktree={p.basePath !== repo.path} />)
        ) : (
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
    </li>
  );
}

function RemoteLine({ repo }: { repo: KnownRepo }) {
  const { remote } = repo;
  if (remote.kind === "none") {
    // この一覧で塗るのはここだけ——壊れたら消えるもの、次の手が要るもの
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
