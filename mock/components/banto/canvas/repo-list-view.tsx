"use client";

// リポジトリの一覧（2026-09-30、ユーザー決定）——**Repo は banto 全体に1本**なので、
// これは banto 全体の Module の画面。ghq の置き場（`~/ghq/github.com/<owner>/<repo>`）に
// あるものを並べる。
//
// 人がここで知りたいのは2つ：**どの Project が使っているか**と、**GitHub にあるか**
// （無ければ、このマシンが壊れたら消える）。だから行は2つの列だけにして、
// 事実のすぐ隣にその次の手を置く：
//   - 左：名前と、GitHub にあるか。まだなら同じ行に「GitHub に公開」
//   - 右：使っている Project（サイドバーと同じ頭文字）。無ければ「Project を始める」
// アカウントは置き場の owner フォルダの見出しが言う（行ごとに繰り返さない）。
// 違うアカウントで公開したものだけ、その行で言う——それが「置き場のずれ」。
//
// 開き方は2つで、中身は同じ（Skill の置き場の画面と同じ形）：
//   - Project の中：Command Palette の入口 → 会話の隣の Canvas（`banto.repo:repos`）
//   - banto 全体の設定の Repo の面：そこに埋め込む
// 「GitHub に公開」はこの画面の中で公開の画面に替わる（Module の中の移動）。
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CircleAlert,
  CloudUpload,
  Globe,
  HardDrive,
  Link2,
  Lock,
  Plus,
  Search,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { reopenProject } from "@/lib/mock/projects";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import {
  GHQ_ROOT,
  getLocalRepos,
  getPlacement,
  getProjectsUsingRepo,
  isInGhq,
  repoAccountLogin,
  useGithubAccounts,
  type LocalRepo,
} from "@/lib/mock/github";
import type { MockProject } from "@/lib/mock/types";
import { ProjectInitial } from "@/components/banto/shell/nav-panel";
import { AccountMark } from "@/components/banto/project/github-account-chooser";
import { ChoicePills } from "@/components/banto/project/choice-pills";
import { NewProjectDialog, type NewProjectPreset } from "@/components/banto/project/new-project-dialog";
import { RepoPublishPanel } from "./repo-publish-view";

type Filter = "all" | "unused" | "local" | "drift";

/** Canvas（会話の隣）として開いたとき */
export function RepoListView() {
  return <RepoList />;
}

export function RepoList({ embedded = false }: { embedded?: boolean }) {
  useMockStoreVersion();
  const [publishing, setPublishing] = useState<string | null>(null);
  const [starting, setStarting] = useState<NewProjectPreset | null>(null);

  if (publishing) {
    return <RepoPublishPanel folder={publishing} onBack={() => setPublishing(null)} />;
  }

  return (
    <div className={cn("@container min-h-0", !embedded && "h-full overflow-y-auto")} data-testid="repo-list-view">
      <div className={cn("flex flex-col gap-5", !embedded && "mx-auto max-w-3xl px-5 py-8")}>
        <header className="flex flex-col gap-1">
          {embedded ? (
            <h2 className="text-md font-semibold text-foreground">リポジトリ</h2>
          ) : (
            <h2 className="text-xl font-semibold text-foreground">リポジトリ</h2>
          )}
          <p className="text-sm text-ink-2">
            <span className="font-mono text-xs">{GHQ_ROOT}</span> にあるもの。どれも、そのまま Project の Root にできます。
          </p>
        </header>
        <RepoListBody
          onPublish={setPublishing}
          onStart={(repo) => setStarting({ method: "folder", folder: repo.path, name: repo.name })}
        />
      </div>
      {starting ? (
        <NewProjectDialog open onOpenChange={(open) => !open && setStarting(null)} preset={starting} />
      ) : null}
    </div>
  );
}

function RepoListBody({
  onPublish,
  onStart,
}: {
  onPublish: (path: string) => void;
  onStart: (repo: LocalRepo) => void;
}) {
  const accounts = useGithubAccounts();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  // 一覧に出すのは置き場の中のものだけ（「フォルダを選ぶ」で git init した置き場の外のものは出さない）
  const repos = getLocalRepos().filter(isInGhq);
  const facts = repos.map((repo) => ({
    repo,
    projects: getProjectsUsingRepo(repo),
    placement: getPlacement(repo),
  }));
  const counts: Record<Filter, number> = {
    all: facts.length,
    unused: facts.filter((f) => f.projects.length === 0).length,
    local: facts.filter((f) => f.repo.remote.kind === "none").length,
    drift: facts.filter((f) => f.placement.kind !== "ok").length,
  };
  const q = query.trim().toLowerCase();
  const shown = facts.filter(
    (f) =>
      (filter === "all" ||
        (filter === "unused" && f.projects.length === 0) ||
        (filter === "local" && f.repo.remote.kind === "none") ||
        (filter === "drift" && f.placement.kind !== "ok")) &&
      (q === "" || `${f.repo.owner}/${f.repo.name}`.toLowerCase().includes(q)),
  );
  // owner フォルダごと——置き場の形そのまま。アカウントはこの見出しが言う
  const owners = [...new Set(shown.map((f) => f.repo.owner))];

  const choices: { value: Filter; label: ReactNode }[] = [
    { value: "all", label: <FilterLabel text="すべて" count={counts.all} /> },
    { value: "unused", label: <FilterLabel text="Project なし" count={counts.unused} /> },
    { value: "local", label: <FilterLabel text="このマシンにだけ" count={counts.local} /> },
  ];
  // ずれが無いときは札を出さない（0件の絞り込みを並べない）
  if (counts.drift > 0 || filter === "drift") {
    choices.push({ value: "drift", label: <FilterLabel text="置き場のずれ" count={counts.drift} /> });
  }

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
            placeholder="名前で絞る"
            aria-label="名前で絞る"
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>

      {shown.length === 0 ? (
        <EmptyResult filter={filter} query={query.trim()} onClear={() => { setFilter("all"); setQuery(""); }} />
      ) : (
        <div className="flex flex-col gap-6">
          {owners.map((owner) => {
            const registered = accounts.some((a) => a.login === owner);
            return (
              <section key={owner} aria-labelledby={`repo-owner-${owner}`} data-testid="repo-owner">
                <h3
                  id={`repo-owner-${owner}`}
                  className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pb-1.5"
                >
                  <AccountMark login={owner} />
                  <span className="text-sm font-semibold text-foreground">{owner}</span>
                  <span className="font-mono text-xs text-ink-3">
                    {GHQ_ROOT}/{owner}/
                  </span>
                  {registered ? null : (
                    <span className="text-xs text-ink-3">· 登録していないアカウント</span>
                  )}
                </h3>
                <ul className="flex flex-col border-t border-border">
                  {shown
                    .filter((f) => f.repo.owner === owner)
                    .map((f) => (
                      <RepoRow
                        key={f.repo.path}
                        repo={f.repo}
                        projects={f.projects}
                        placement={f.placement}
                        onPublish={() => onPublish(f.repo.path)}
                        onStart={() => onStart(f.repo)}
                      />
                    ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
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
  placement,
  onPublish,
  onStart,
}: {
  repo: LocalRepo;
  projects: readonly MockProject[];
  placement: ReturnType<typeof getPlacement>;
  onPublish: () => void;
  onStart: () => void;
}) {
  const local = repo.remote.kind === "none";
  return (
    <li
      data-testid="repo-item"
      data-repo={`${repo.owner}/${repo.name}`}
      className="grid grid-cols-1 gap-x-6 gap-y-2 border-b border-border py-3 @lg:grid-cols-[minmax(0,1fr)_13rem] @lg:items-start"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="truncate text-md font-medium text-foreground">{repo.name}</p>
        <div
          data-testid="repo-remote"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
        >
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
        {placement.kind !== "ok" ? (
          <p data-testid="repo-drift" className="mt-1 flex items-start gap-1.5 text-xs text-ink-2">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" />
            <span className="min-w-0">
              置き場がずれています——
              {placement.kind === "moved" ? (
                <>
                  ghq の置き方なら <span className="font-mono break-all">{placement.expected}</span>
                </>
              ) : (
                <>github.com の下にありますが、origin は {placement.host} です</>
              )}
            </span>
          </p>
        ) : null}
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

function RemoteLine({ repo }: { repo: LocalRepo }) {
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
    const host = remote.url.replace(/^git@/, "").replace(/^https?:\/\//, "").split(/[:/]/)[0];
    return (
      <span className="flex items-center gap-1 text-ink-3">
        <Link2 className="size-3.5 shrink-0" />
        GitHub にはありません（origin は {host}）
      </span>
    );
  }
  const other = remote.owner !== repo.owner || remote.name !== repo.name;
  return (
    <span className="flex min-w-0 items-center gap-1 text-ink-3">
      {remote.private ? <Lock className="size-3.5 shrink-0" /> : <Globe className="size-3.5 shrink-0" />}
      GitHub{remote.private ? "・非公開" : "・公開"}
      {other ? (
        <>
          {" · "}
          <AccountMark login={repoAccountLogin(repo)} />
          <span className="font-mono break-all text-ink-2">
            {remote.owner}/{remote.name}
          </span>
        </>
      ) : null}
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

function EmptyResult({ filter, query, onClear }: { filter: Filter; query: string; onClear: () => void }) {
  const message = query
    ? `「${query}」に当たるリポジトリはありません。`
    : filter === "local"
      ? "このマシンにだけあるものはありません。どれも GitHub にあります。"
      : filter === "unused"
        ? "どのリポジトリも、どこかの Project が使っています。"
        : filter === "drift"
          ? "置き場のずれはありません。"
          : `${GHQ_ROOT} には、まだリポジトリがありません。新しい Project の画面から clone するか、作ってください。`;
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
