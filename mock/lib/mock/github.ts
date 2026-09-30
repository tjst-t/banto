// Repo Module の GitHub まわり（2026-09-29、Repo Module を足す相談のためのモック）。
//
// - アカウントは Repo の設定で登録する（名前・PAT・SSH 鍵）。PAT と鍵の中身は
//   ここに持たない——Vault の alias の名前だけを持つ（VaultUI と同じ作法）
// - **Repo は banto 全体に1本**（改訂・2026-09-30、ユーザー）——Project より先に動き、
//   フォルダを用意する（clone・git init）だけ。Project を作るのは banto 本体
// - **ghq の置き方はやめた**（2026-09-30、ユーザー）——clone・新規は既定の置き場
//   （`~/banto/<名前>`）。Repo は**知っているリポジトリの台帳**を持ち、好きな場所の
//   フォルダを Import できる。GitHub に公開してもフォルダは動かさない
// - 作る先に既にフォルダがあるとき、何が起きるかは `inspectTargetFolder`、Import で
//   何が起きるかは `inspectImport` の1箇所ずつで決める（画面は言い方だけを持つ）
import { useSyncExternalStore } from "react";
import { getActiveProjects, getAllProjects } from "./projects";
import { notifyMockStoreChange, subscribeMockStore } from "./store-events";

export interface MockGithubAccount {
  id: string;
  /** GitHub のユーザー名か Organization */
  login: string;
  /** PAT を預けた Vault の alias（値は持たない） */
  tokenAlias: string;
  /** SSH 鍵を預けた Vault の alias。無ければ HTTPS で clone / push する */
  sshAlias?: string;
}

const SEED_ACCOUNTS: readonly MockGithubAccount[] = [
  { id: "gh.tjst-t", login: "tjst-t", tokenAlias: "github-tjst-t-token", sshAlias: "tjst-t-ssh" },
  { id: "gh.work-org", login: "work-org", tokenAlias: "github-work-org-token" },
];

let accounts: MockGithubAccount[] = [...SEED_ACCOUNTS];

export function getGithubAccounts(): readonly MockGithubAccount[] {
  return accounts;
}

/**
 * 画面から読むときはこちら。サーバは常に登録済みの初期値で描くので、hydration の間は
 * その値を使う——URL の `?accounts=` が効くのは hydration の後（効かせる前に読むと、
 * 後から hydrate される区画だけが食い違う。実測で踏んだ）
 */
export function useGithubAccounts(): readonly MockGithubAccount[] {
  return useSyncExternalStore(subscribeMockStore, getGithubAccounts, () => SEED_ACCOUNTS);
}

export function addGithubAccount(input: Omit<MockGithubAccount, "id">): MockGithubAccount {
  const account = { ...input, id: `gh.${input.login}` };
  accounts = [...accounts.filter((a) => a.login !== input.login), account];
  notifyMockStoreChange();
  return account;
}

export function removeGithubAccount(id: string): void {
  accounts = accounts.filter((a) => a.id !== id);
  notifyMockStoreChange();
}

/** モックの見せ方のためだけ（URL の `?accounts=0|1|2`）——登録済みのアカウント数を切り替える */
export function setGithubAccountCountForDemo(count: number): void {
  const next = SEED_ACCOUNTS.slice(0, Math.max(0, Math.min(count, SEED_ACCOUNTS.length)));
  if (next.length === accounts.length && next.every((a, i) => accounts[i]?.id === a.id)) return;
  accounts = [...next];
  notifyMockStoreChange();
}

export interface MockGithubRepo {
  owner: string;
  name: string;
  description?: string;
  private: boolean;
  /** 最後に push された日（表示用の文言） */
  pushedAt: string;
}

/** アカウントから見えるリポジトリ。本物は GitHub の API に聞く */
const REPOS_BY_ACCOUNT: Record<string, readonly MockGithubRepo[]> = {
  "gh.tjst-t": [
    { owner: "tjst-t", name: "banto", description: "AI と人が一緒に仕事をする道具", private: false, pushedAt: "今日" },
    { owner: "tjst-t", name: "home-automation", description: "自宅サーバの構成と自動化", private: true, pushedAt: "3日前" },
    { owner: "tjst-t", name: "notes", description: "作業メモ", private: true, pushedAt: "2週間前" },
    { owner: "tjst-t", name: "scratch", private: true, pushedAt: "1か月前" },
    { owner: "tjst-t", name: "dotfiles", description: "シェルとエディタの設定", private: false, pushedAt: "4か月前" },
    { owner: "tjst-t", name: "incus-lab", description: "Incus の検証環境", private: false, pushedAt: "5か月前" },
  ],
  "gh.work-org": [
    { owner: "work-org", name: "api-gateway", description: "社内 API の入口", private: true, pushedAt: "昨日" },
    { owner: "work-org", name: "infra", description: "Terraform と Ansible", private: true, pushedAt: "今日" },
    { owner: "work-org", name: "design-tokens", description: "色と字の段", private: true, pushedAt: "6日前" },
  ],
};

export function getReposForAccount(accountId: string): readonly MockGithubRepo[] {
  return REPOS_BY_ACCOUNT[accountId] ?? [];
}

export function repoExistsOnGithub(owner: string, name: string): boolean {
  return Object.values(REPOS_BY_ACCOUNT).some((repos) =>
    repos.some((r) => r.owner === owner && r.name.toLowerCase() === name.toLowerCase()),
  );
}

/** `owner/repo`・`github.com/owner/repo`・`https://…`・`git@github.com:owner/repo.git` を読む */
export function parseRepoReference(text: string): { owner: string; name: string } | null {
  const m = text
    .trim()
    .replace(/^git@github\.com:/, "")
    .replace(/^https?:\/\//, "")
    .replace(/^github\.com\//, "")
    .replace(/\.git$/, "")
    .match(/^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/);
  return m ? { owner: m[1], name: m[2] } : null;
}

// ── 置き場（2026-09-30、ユーザー決定：ghq の置き方はやめる）─────────────────────
//
// clone・新しく作るリポジトリの**既定の置き場は1か所**。Repo の設定で変えられ、既定は
// `~/banto`。フォルダ名はリポジトリ名（`<置き場>/<名前>`）で、ぶつかったら `<名前>-2` を出す。
// 置き場を変えても、今あるフォルダは動かさない（台帳はパスで覚えている）。

export const DEFAULT_REPO_HOME = "~/banto";

let repoHome = DEFAULT_REPO_HOME;

export function getRepoHome(): string {
  return repoHome;
}

export function useRepoHome(): string {
  return useSyncExternalStore(subscribeMockStore, getRepoHome, () => DEFAULT_REPO_HOME);
}

export function setRepoHome(next: string): void {
  const normalized = normalizeFolderPath(next);
  if (normalized === repoHome) return;
  repoHome = normalized;
  notifyMockStoreChange();
}

export function normalizeFolderPath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, "");
  return trimmed === "" ? "~" : trimmed;
}

export function parentFolder(path: string): string | undefined {
  if (path === "~" || path === "/") return undefined;
  const i = path.lastIndexOf("/");
  return i <= 0 ? (path.startsWith("/") ? "/" : "~") : path.slice(0, i);
}

export function folderName(path: string): string {
  return path.split("/").pop() ?? path;
}

// ── このマシンのフォルダ（本物は host が答える）──────────────────────────────
//
// git かどうか・origin・ブランチは**フォルダが真実**（規則3）——台帳は写しを持たない。

/** origin がどこにあるか */
export type RepoRemote =
  | { kind: "github"; owner: string; name: string; private: boolean }
  /** GitHub の外（gitlab 等） */
  | { kind: "elsewhere"; url: string }
  /** origin が無い——このマシンにだけある */
  | { kind: "none" };

interface GitFacts {
  remote: RepoRemote;
  branch: string;
  commits: number;
  lastCommit?: string;
  lastCommitAt?: string;
  otherBranches: readonly string[];
  /** このリポジトリの worktree（別の場所のフォルダ） */
  worktrees: readonly string[];
}

interface HostFolder {
  path: string;
  /** 中の項目の数（git でないフォルダの説明に使う） */
  entries: number;
  git?: GitFacts;
}

function git(remote: RepoRemote, rest: Partial<Omit<GitFacts, "remote">> = {}): GitFacts {
  return { remote, branch: "main", commits: 1, otherBranches: [], worktrees: [], ...rest };
}

const gh = (owner: string, name: string, isPrivate: boolean): RepoRemote => ({
  kind: "github",
  owner,
  name,
  private: isPrivate,
});

const SEED_FOLDERS: readonly HostFolder[] = [
  { path: "~/Documents", entries: 42 },
  { path: "~/Downloads", entries: 118 },
  { path: "~/srv/media", entries: 6 },
  { path: "~/worktrees/banto-v4", entries: 24 },
  { path: "~/worktrees/old-migration", entries: 31 },
  // 既定の置き場——Repo が clone した・作ったもの
  { path: "~/banto/dotfiles", entries: 19, git: git(gh("tjst-t", "dotfiles", false), { commits: 488 }) },
  {
    path: "~/banto/hermes",
    entries: 12,
    git: git(
      { kind: "none" },
      {
        commits: 7,
        lastCommit: "検索の閾値を 0.72 に下げる",
        lastCommitAt: "2時間前",
        otherBranches: ["try-embedding", "bench"],
      },
    ),
  },
  { path: "~/banto/home-automation", entries: 27, git: git(gh("tjst-t", "home-automation", true), { commits: 312 }) },
  { path: "~/banto/infra", entries: 33, git: git(gh("work-org", "infra", true), { commits: 1203 }) },
  { path: "~/banto/recipe-box", entries: 1, git: git({ kind: "none" }, { commits: 0 }) },
  // 置き場の中にあるが、git でないフォルダ（clone の名前がぶつかる例）
  { path: "~/banto/scratch", entries: 14 },
  { path: "~/banto/tiny-cli", entries: 9, git: git(gh("work-org", "tiny-cli", true), { commits: 23 }) },
  // 置き場の外——前から ghq で置いていたもの。Import したものと、まだのもの
  {
    path: "~/ghq/github.com/tjst-t/banto",
    entries: 21,
    git: git(gh("tjst-t", "banto", false), { commits: 2140, worktrees: ["~/worktrees/banto-v4"] }),
  },
  { path: "~/ghq/github.com/tjst-t/banto/docs", entries: 16 },
  { path: "~/ghq/github.com/tjst-t/banto/mock", entries: 18 },
  { path: "~/ghq/github.com/tjst-t/incus-lab", entries: 11, git: git(gh("tjst-t", "incus-lab", false), { commits: 57 }) },
  { path: "~/ghq/github.com/tjst-t/scratch", entries: 14 },
  {
    path: "~/ghq/gitlab.com/tjst-t/notes",
    entries: 40,
    git: git({ kind: "elsewhere", url: "git@gitlab.com:tjst-t/notes.git" }, { commits: 96 }),
  },
];

let hostFolders: HostFolder[] = [...SEED_FOLDERS];

function hostFolder(path: string): HostFolder | undefined {
  return hostFolders.find((f) => f.path === path);
}

/** そのフォルダがあるか——一覧に載っているフォルダと、その親はある */
export function folderExists(path: string): boolean {
  return path === "~" || hostFolders.some((f) => f.path === path || f.path.startsWith(`${path}/`));
}

/** そのパスか、その上で、いちばん近くにあるフォルダ（無いパスを打たれたときの戻り先） */
export function nearestExistingFolder(path: string): string {
  let at: string | undefined = path;
  while (at && !folderExists(at)) at = parentFolder(at);
  return at ?? "~";
}

/** フォルダの中のフォルダ（パスを選ぶ画面の木）。フォルダの一覧から導く */
export function listChildFolders(path: string): string[] {
  const children = new Set<string>();
  for (const f of hostFolders) {
    if (!f.path.startsWith(`${path}/`)) continue;
    children.add(f.path.slice(path.length + 1).split("/")[0]);
  }
  return [...children].sort();
}

/** そのフォルダを含む git のリポジトリ（フォルダそのものは除く） */
function enclosingGitFolder(path: string): HostFolder | undefined {
  return hostFolders.find((f) => f.git && path.startsWith(`${f.path}/`));
}

/** フォルダの中にある git のリポジトリ（まとめて取り込めない、の説明に使う） */
function gitFoldersInside(path: string): { importable: number; known: number } {
  const inside = hostFolders.filter((f) => f.git && f.path.startsWith(`${path}/`));
  const known = inside.filter((f) => ledger.some((e) => e.path === f.path)).length;
  return { importable: inside.length - known, known };
}

// ── Repo の台帳：知っているリポジトリ ───────────────────────────────────────
//
// 台帳が覚えるのは**置き場所と、どのアカウントで扱うか**だけ。GitHub のどこか・ブランチは
// フォルダ（origin）から読む。一覧は台帳から作る——置き場の中を見て回らない。

interface LedgerEntry {
  path: string;
  /** push・pull に使うアカウント。GitHub に無い／登録していない持ち主なら無し */
  accountId?: string;
}

const SEED_LEDGER: readonly LedgerEntry[] = [
  { path: "~/ghq/github.com/tjst-t/banto", accountId: "gh.tjst-t" },
  { path: "~/banto/home-automation", accountId: "gh.tjst-t" },
  { path: "~/banto/hermes" },
  { path: "~/banto/recipe-box" },
  { path: "~/banto/dotfiles", accountId: "gh.tjst-t" },
  { path: "~/banto/tiny-cli", accountId: "gh.work-org" },
  { path: "~/banto/infra", accountId: "gh.work-org" },
  { path: "~/ghq/gitlab.com/tjst-t/notes" },
];

let ledger: LedgerEntry[] = [...SEED_LEDGER];

/** モックの見せ方のためだけ（URL の `?repos=0`）——台帳を空にする（フォルダは残る） */
export function setLedgerEmptyForDemo(): void {
  if (ledger.length === 0) return;
  ledger = [];
  notifyMockStoreChange();
}

/** 台帳の1行と、そのフォルダの git の事実を合わせたもの（画面はこれを読む） */
export interface KnownRepo extends GitFacts {
  path: string;
  /** フォルダ名 */
  name: string;
  accountId?: string;
}

function join(entry: LedgerEntry): KnownRepo | undefined {
  const facts = hostFolder(entry.path)?.git;
  return facts && { ...facts, path: entry.path, name: folderName(entry.path), accountId: entry.accountId };
}

export function getKnownRepos(): readonly KnownRepo[] {
  return ledger.flatMap((e) => join(e) ?? []);
}

/**
 * 画面の一覧から読むときはこちら。hydration の間は初期の台帳で描く——`?repos=0` が効くのは
 * hydration の後（アカウントの `useGithubAccounts` と同じ理由。後から hydrate される Canvas だけが食い違う）
 */
export function useKnownRepos(): readonly KnownRepo[] {
  const entries = useSyncExternalStore(subscribeMockStore, () => ledger, () => SEED_LEDGER);
  return entries.flatMap((e) => join(e) ?? []);
}

/** そのフォルダ（台帳のフォルダそのもの、または worktree）のリポジトリ */
export function findRepoForFolder(path: string): KnownRepo | undefined {
  return getKnownRepos().find((r) => r.path === path || r.worktrees.includes(path));
}

/** GitHub の同じリポジトリを、もうどこかに持っているか */
export function findKnownGithubRepo(owner: string, name: string): KnownRepo | undefined {
  return getKnownRepos().find(
    (r) =>
      r.remote.kind === "github" &&
      r.remote.owner.toLowerCase() === owner.toLowerCase() &&
      r.remote.name.toLowerCase() === name.toLowerCase(),
  );
}

/** そのリポジトリを Root（フォルダそのもの・worktree）にしている Project */
export function getProjectsUsingRepo(repo: KnownRepo) {
  return getAllProjects().filter((p) => p.basePath === repo.path || repo.worktrees.includes(p.basePath));
}

function projectSummary(repo: KnownRepo) {
  const p = getProjectsUsingRepo(repo)[0];
  return p && { id: p.id, name: p.name, closed: !getActiveProjects().some((a) => a.id === p.id) };
}

export type ProjectSummary = NonNullable<ReturnType<typeof projectSummary>>;

function addToLedger(entry: LedgerEntry): void {
  ledger = [...ledger.filter((e) => e.path !== entry.path), entry];
}

function putGitFolder(path: string, facts: GitFacts): void {
  const existing = hostFolder(path);
  hostFolders = existing
    ? hostFolders.map((f) => (f.path === path ? { ...f, git: facts } : f))
    : [...hostFolders, { path, entries: 1, git: facts }];
}

/** Repo が clone した——フォルダを作って台帳に足す */
export function addClonedRepo(input: {
  path: string;
  accountId?: string;
  remote: Extract<RepoRemote, { kind: "github" }>;
}): void {
  putGitFolder(input.path, git(input.remote));
  addToLedger({ path: input.path, accountId: input.accountId });
  notifyMockStoreChange();
}

/** Repo が新しく作った（git init）——GitHub にはまだ無い */
export function createLocalRepo(path: string): void {
  putGitFolder(path, git({ kind: "none" }, { commits: 0 }));
  addToLedger({ path });
  notifyMockStoreChange();
}

/** 今あるフォルダで git init して台帳に足す（公開の画面・Import の「git init して Import」） */
export function gitInitFolder(path: string): void {
  putGitFolder(path, git({ kind: "none" }, { commits: 0 }));
  addToLedger({ path });
  notifyMockStoreChange();
}

/** GitHub に公開した——origin を付け、どのアカウントで扱うかを覚える（フォルダは動かさない） */
export function setRepoRemote(path: string, remote: RepoRemote, accountId?: string): void {
  const facts = hostFolder(path)?.git;
  if (facts) putGitFolder(path, { ...facts, remote });
  ledger = ledger.map((e) => (e.path === path ? { ...e, accountId } : e));
  notifyMockStoreChange();
}

// ── clone・新しく作る先 ──────────────────────────────────────────────────

/** そのパスが使われているか——フォルダがある、または台帳にある */
function pathTaken(path: string): boolean {
  return folderExists(path) || ledger.some((e) => e.path === path);
}

/** 置き場の中で空いている名前——`<名前>`、ぶつかったら `<名前>-2`、`-3`… */
export function freeFolderName(home: string, name: string): string {
  if (!pathTaken(`${home}/${name}`)) return name;
  for (let n = 2; ; n += 1) {
    const candidate = `${name}-${n}`;
    if (!pathTaken(`${home}/${candidate}`)) return candidate;
  }
}

/**
 * clone・新しく作る先のフォルダに、もう何があるか。判断はここ1箇所
 * （新しい Project の画面が言い方だけを持つ）
 */
export type TargetFolderState =
  /** 何も無い——ここに clone する／作る */
  | { kind: "free" }
  /** 台帳にあるリポジトリがある */
  | { kind: "taken-repo"; repo: KnownRepo; project?: ProjectSummary; suggestion: string }
  /** 台帳に無い git のリポジトリがある（Import できる） */
  | { kind: "taken-unknown-repo"; suggestion: string }
  /** git でないフォルダがある */
  | { kind: "taken-folder"; entries: number; suggestion: string };

export function inspectTargetFolder(home: string, name: string): TargetFolderState {
  const path = `${home}/${name}`;
  if (!pathTaken(path)) return { kind: "free" };
  const suggestion = freeFolderName(home, name);
  const known = getKnownRepos().find((r) => r.path === path);
  if (known) return { kind: "taken-repo", repo: known, project: projectSummary(known), suggestion };
  const folder = hostFolder(path);
  if (folder?.git) return { kind: "taken-unknown-repo", suggestion };
  return { kind: "taken-folder", entries: folder?.entries ?? listChildFolders(path).length, suggestion };
}

/** clone しようとしている GitHub のリポジトリを、もう持っているか */
export function inspectCloneSource(
  owner: string,
  name: string,
): { repo: KnownRepo; project?: ProjectSummary } | null {
  const repo = findKnownGithubRepo(owner, name);
  return repo ? { repo, project: projectSummary(repo) } : null;
}

// ── Import：好きな場所のフォルダを、そのまま台帳に足す ───────────────────────
//
// 人がフォルダを1つずつ選ぶ（まとめて取り込む入口は作らない）。フォルダは移さない。

export type ImportCheck =
  /** git のリポジトリで、まだ台帳に無い——Import できる */
  | { kind: "ready"; facts: GitFacts; accountId?: string }
  /** もう台帳にある */
  | { kind: "known"; repo: KnownRepo }
  /** 台帳にあるリポジトリの worktree */
  | { kind: "worktree"; repo: KnownRepo }
  /** git のリポジトリの中のフォルダ——一番上を選ぶ */
  | { kind: "inside"; top: string }
  /** git でないフォルダ。中にリポジトリがあれば、その数（まだ一覧に無いもの・もうあるもの） */
  | { kind: "not-git"; entries: number; reposInside: { importable: number; known: number } }
  /** そのフォルダは無い */
  | { kind: "missing" };

export function inspectImport(path: string): ImportCheck {
  if (!folderExists(path)) return { kind: "missing" };
  const known = getKnownRepos().find((r) => r.path === path);
  if (known) return { kind: "known", repo: known };
  const owner = getKnownRepos().find((r) => r.worktrees.includes(path));
  if (owner) return { kind: "worktree", repo: owner };
  const folder = hostFolder(path);
  if (folder?.git) {
    const { remote } = folder.git;
    const accountId =
      remote.kind === "github" ? accounts.find((a) => a.login === remote.owner)?.id : undefined;
    return { kind: "ready", facts: folder.git, accountId };
  }
  const top = enclosingGitFolder(path);
  if (top) return { kind: "inside", top: top.path };
  return {
    kind: "not-git",
    entries: folder?.entries ?? listChildFolders(path).length,
    reposInside: gitFoldersInside(path),
  };
}

export function importFolder(path: string): KnownRepo | undefined {
  const check = inspectImport(path);
  if (check.kind !== "ready") return undefined;
  addToLedger({ path, accountId: check.accountId });
  notifyMockStoreChange();
  return findRepoForFolder(path);
}

/** origin の URL からホスト名だけ（`git@gitlab.com:…` → `gitlab.com`） */
export function remoteHost(url: string): string {
  return url.replace(/^git@/, "").replace(/^https?:\/\//, "").split(/[:/]/)[0];
}
