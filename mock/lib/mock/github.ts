// Repositories Module の GitHub まわり（2026-09-29、Repositories Module を足す相談のためのモック）。
//
// - アカウントは Repositories の設定で登録する（名前・PAT・SSH 鍵）。PAT と鍵の中身は
//   ここに持たない——Vault の alias の名前だけを持つ（VaultUI と同じ作法）
// - **Repositories は banto 全体に1本**（改訂・2026-09-30、ユーザー）——Project より先に動き、
//   フォルダを用意する（clone・git init）だけ。Project を作るのは banto 本体
// - **ghq の置き方はやめた**（2026-09-30、ユーザー）——clone・新規は既定の置き場
//   （`~/banto/<名前>`）。Repositories は**知っているリポジトリの台帳**を持ち、好きな場所の
//   フォルダを Import できる。GitHub に公開してもフォルダは動かさない
// - 作る先に既にフォルダがあるとき、何が起きるかは `inspectTargetFolder`、Import で
//   何が起きるかは `inspectImport` の1箇所ずつで決める（画面は言い方だけを持つ）
// - 台帳は GitHub の場所（owner/name）と、GitHub の外の origin の URL も覚える（2026-09-30・10-01、ユーザー）——フォルダが消えても
//   clone し直せるように。フォルダの origin と食い違ったら origin を正として台帳を直す（`syncWithFolders`）
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
    { owner: "work-org", name: "db-migration", description: "旧DBから新DBへの移行", private: true, pushedAt: "2か月前" },
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

/** 登録したアカウントのどれかから見えるか（非公開のものは、見えるアカウントが無いと clone できない） */
function visibleGithubRepo(owner: string, name: string): MockGithubRepo | undefined {
  return accounts
    .flatMap((a) => getReposForAccount(a.id))
    .find((r) => r.owner === owner && r.name.toLowerCase() === name.toLowerCase());
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

/**
 * clone の元（2026-10-01、ユーザー——リポジトリの一覧から URL で clone する）。GitHub なら `owner/name`、
 * GitHub の外（gitlab.com 等）は URL のまま。GitHub の外も受けるのは、台帳がもう GitHub の外の origin を
 * 扱えて（Import した gitlab の notes）、断ると「端末で clone して Import」という回り道になるから
 */
export type CloneSource =
  | { kind: "github"; owner: string; name: string }
  | { kind: "elsewhere"; url: string; host: string; path: string; name: string };

/**
 * clone の元を読む——`owner/repo`・`https://github.com/owner/repo(.git)`・`git@github.com:owner/repo.git`、
 * GitHub の外は `https://<host>/<path>`・`git@<host>:<path>.git`（`ssh://` も）。読めなければ null
 */
export function parseCloneSource(text: string): CloneSource | null {
  const t = text.trim().replace(/\/+$/, "");
  const gh = parseRepoReference(t.replace(/^(https?:\/\/)?www\.github\.com\//, "github.com/"));
  if (gh) return { kind: "github", ...gh };
  const m =
    t.match(/^https?:\/\/([^/\s]+\.[^/\s]+)\/([^\s]+?)(?:\.git)?$/) ??
    t.match(/^(?:ssh:\/\/)?git@([^:/\s]+\.[^:/\s]+)[:/]([^\s]+?)(?:\.git)?$/);
  if (!m || !m[2].includes("/")) return null;
  const path = m[2];
  return { kind: "elsewhere", url: t, host: m[1].toLowerCase(), path, name: path.split("/").pop() ?? path };
}

/** 同じリポジトリかを比べる鍵（`git@gitlab.com:a/b.git` と `https://gitlab.com/a/b` は同じ） */
function remoteKey(url: string): string {
  return url
    .trim()
    .replace(/^(ssh:\/\/)?git@/, "")
    .replace(/^https?:\/\//, "")
    .replace(/\.git$/, "")
    .replace(":", "/")
    .toLowerCase();
}

/** 誰でも読める GitHub のリポジトリ（登録したアカウントの外。本物は GitHub に聞く） */
const PUBLIC_GITHUB_REPOS: readonly { owner: string; name: string }[] = [{ owner: "octocat", name: "hello-world" }];

/** GitHub の外で、このマシンから読めるリポジトリ（本物は git ls-remote が答える） */
const READABLE_ELSEWHERE: readonly string[] = [
  "gitlab.com/tjst-t/notes",
  "gitlab.com/tjst-t/recipes-archive",
  "gitlab.com/tjst-t/zine",
];

/**
 * clone できるか（どのアカウントで読めるか）。判断はここ1箇所——新しい Project の画面と一覧の clone が使う。
 * 本物は clone を走らせて初めて分かるので、画面は押したあとに言う（押す前には分からない）
 */
export function checkCloneAccess(
  source: CloneSource,
  accountId: string | undefined,
): { ok: true; private: boolean } | { ok: false; reason: string; readableBy?: MockGithubAccount } {
  if (source.kind === "elsewhere") {
    return READABLE_ELSEWHERE.includes(remoteKey(source.url))
      ? { ok: true, private: false }
      : { ok: false, reason: `${source.host}/${source.path} が見つからないか、このマシンからは読めません` };
  }
  const { owner, name } = source;
  const same = (r: { owner: string; name: string }) =>
    r.owner.toLowerCase() === owner.toLowerCase() && r.name.toLowerCase() === name.toLowerCase();
  const mine = accountId ? getReposForAccount(accountId).find(same) : undefined;
  if (mine) return { ok: true, private: mine.private };
  const listed = Object.values(REPOS_BY_ACCOUNT).flat().find(same);
  if ((listed && !listed.private) || PUBLIC_GITHUB_REPOS.some(same)) return { ok: true, private: false };
  const readableBy = accounts.find((a) => getReposForAccount(a.id).some(same));
  const login = accounts.find((a) => a.id === accountId)?.login;
  if (readableBy) {
    return { ok: false, reason: `${owner}/${name} は非公開で、${login ?? "このアカウント"} からは読めません`, readableBy };
  }
  return {
    ok: false,
    reason: `github.com/${owner}/${name} が見つかりません（非公開なら、登録したアカウントのどれからも読めません）`,
  };
}

// ── 置き場（2026-09-30、ユーザー決定：ghq の置き方はやめる）─────────────────────
//
// clone・新しく作るリポジトリの**既定の置き場は1か所**。Repositories の設定で変えられ、既定は
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
// git かどうか・origin・ブランチは**フォルダが真実**（規則3）——台帳が持つ写しは GitHub の場所だけで、
// 食い違えばフォルダに合わせる（下の台帳の節）。

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
  // 既定の置き場——Repositories が clone した・作ったもの
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

// ── Repositories の台帳：知っているリポジトリ ───────────────────────────────────────
//
// 台帳が覚えるのは**置き場所・どのアカウントで扱うか・GitHub の場所（owner/name）**。
// GitHub の場所はフォルダの origin の写しだが、**フォルダが消えたときに clone し直すため**に持つ
// （2026-09-30、ユーザー決定。規則3 の例外——写しを持つ理由は「元が消えうる」こと）。
// 食い違ったら **origin を正として台帳を直す**（`syncWithFolders` の1箇所）。フォルダが
// 見つからない間は、台帳の値だけが手がかりなので直さない。
// ブランチ・コミットはフォルダから読む。一覧は台帳から作る——置き場の中を見て回らない。

export interface GithubLocation {
  owner: string;
  name: string;
}

export interface LedgerEntry {
  path: string;
  /** push・pull に使うアカウント。GitHub に無い／登録していない持ち主なら無し */
  accountId?: string;
  /** GitHub の場所。フォルダが消えても clone し直せるように覚えておく。GitHub に無ければ無し */
  github?: GithubLocation;
  /**
   * GitHub の外（gitlab.com 等）の origin の URL——同じ理由で覚えておく（2026-10-01、ユーザー決定）。
   * GitHub の場所と同じく origin の写しで、食い違ったら origin に合わせる（お知らせはしない——
   * 覚えていなかったものを覚えるだけで、覚えていた場所が変わるのではない）
   */
  elsewhere?: string;
  /** origin に合わせて直したとき、それまで覚えていた場所（一覧で一度だけ言うため） */
  correctedFrom?: GithubLocation;
}

const sameLocation = (a?: GithubLocation, b?: GithubLocation) =>
  a?.owner.toLowerCase() === b?.owner.toLowerCase() && a?.name.toLowerCase() === b?.name.toLowerCase();

const originLocation = (remote: RepoRemote): GithubLocation | undefined =>
  remote.kind === "github" ? { owner: remote.owner, name: remote.name } : undefined;

/** 台帳に書く origin の場所（GitHub か、その外の URL か） */
const originFields = (remote: RepoRemote): Pick<LedgerEntry, "github" | "elsewhere"> => ({
  github: originLocation(remote),
  elsewhere: remote.kind === "elsewhere" ? remote.url : undefined,
});

/**
 * 台帳の GitHub の場所を、フォルダの origin に合わせる。本物は Repositories が一覧を答えるとき・
 * フォルダに触れたとき（clone・公開・Import）に走らせる。フォルダが見つからない行は触らない
 */
function syncWithFolders(entries: readonly LedgerEntry[], folders: readonly HostFolder[]): LedgerEntry[] {
  return entries.map((e) => {
    const facts = folders.find((f) => f.path === e.path)?.git;
    if (!facts) return e;
    const origin = originLocation(facts.remote);
    const url = facts.remote.kind === "elsewhere" ? facts.remote.url : undefined;
    let next = e;
    if (!(sameLocation(origin, e.github) || (!origin && !e.github))) {
      next = { ...next, github: origin, correctedFrom: e.github };
    }
    return next.elsewhere === url ? next : { ...next, elsewhere: url };
  });
}

const SEED_LEDGER: readonly LedgerEntry[] = syncWithFolders(
  [
    { path: "~/ghq/github.com/tjst-t/banto", accountId: "gh.tjst-t", github: { owner: "tjst-t", name: "banto" } },
    {
      path: "~/banto/home-automation",
      accountId: "gh.tjst-t",
      github: { owner: "tjst-t", name: "home-automation" },
    },
    { path: "~/banto/hermes" },
    { path: "~/banto/recipe-box" },
    { path: "~/banto/dotfiles", accountId: "gh.tjst-t", github: { owner: "tjst-t", name: "dotfiles" } },
    // GitHub の上で tjst-t から work-org へ移した——台帳は古いまま、origin は新しい（食い違いの例）
    { path: "~/banto/tiny-cli", accountId: "gh.work-org", github: { owner: "tjst-t", name: "tiny-cli" } },
    { path: "~/banto/infra", accountId: "gh.work-org", github: { owner: "work-org", name: "infra" } },
    { path: "~/ghq/gitlab.com/tjst-t/notes" },
    // フォルダが見つからない——GitHub にあるので clone し直せる（閉じた Project「旧DBの移行検証」の Root）
    {
      path: "~/banto/db-migration",
      accountId: "gh.work-org",
      github: { owner: "work-org", name: "db-migration" },
    },
    // フォルダが見つからない——GitHub にも無い（戻す手は無く、一覧から外すしかない）
    { path: "~/banto/sketches" },
    // フォルダが見つからない——GitHub の外（gitlab）の場所を覚えているので clone し直せる
    { path: "~/banto/zine", elsewhere: "git@gitlab.com:tjst-t/zine.git" },
  ],
  SEED_FOLDERS,
);

let ledger: LedgerEntry[] = [...SEED_LEDGER];

/** モックの見せ方のためだけ（URL の `?repos=0`）——台帳を空にする（フォルダは残る） */
export function setLedgerEmptyForDemo(): void {
  if (ledger.length === 0) return;
  ledger = [];
  notifyMockStoreChange();
}

/** 台帳の1行と、そのフォルダの git の事実を合わせたもの（画面はこれを読む） */
export interface KnownRepo extends GitFacts {
  missing: false;
  path: string;
  /** フォルダ名 */
  name: string;
  accountId?: string;
  correctedFrom?: GithubLocation;
}

/** 台帳にあるのに、フォルダが見つからない——手がかりは台帳の値だけ */
export interface MissingRepo {
  missing: true;
  path: string;
  name: string;
  accountId?: string;
  github?: GithubLocation;
  /** GitHub の外の origin の URL（覚えていれば clone し直せる） */
  elsewhere?: string;
}

export type LedgerRepo = KnownRepo | MissingRepo;

function join(entry: LedgerEntry): LedgerRepo | undefined {
  const base = { path: entry.path, name: folderName(entry.path), accountId: entry.accountId };
  const folder = hostFolder(entry.path);
  if (!folder) return { ...base, missing: true, github: entry.github, elsewhere: entry.elsewhere };
  // フォルダはあるが git でない（.git を消した等）——この相談の外なので一覧に出さない
  if (!folder.git) return undefined;
  return { ...folder.git, ...base, missing: false, correctedFrom: entry.correctedFrom };
}

function ledgerRepos(entries: readonly LedgerEntry[]): LedgerRepo[] {
  return entries.flatMap((e) => join(e) ?? []);
}

/** フォルダが見つかる台帳のリポジトリ */
export function getKnownRepos(): readonly KnownRepo[] {
  return ledgerRepos(ledger).filter((r): r is KnownRepo => !r.missing);
}

/**
 * 画面の一覧から読むときはこちら（フォルダが見つからないものも含む）。hydration の間は初期の
 * 台帳で描く——`?repos=0` が効くのは hydration の後（アカウントの `useGithubAccounts` と同じ理由。
 * 後から hydrate される Canvas だけが食い違う）
 */
export function useLedgerRepos(): readonly LedgerRepo[] {
  const entries = useSyncExternalStore(subscribeMockStore, () => ledger, () => SEED_LEDGER);
  return ledgerRepos(entries);
}

/** そのフォルダ（台帳のフォルダそのもの、または worktree）のリポジトリ */
export function findRepoForFolder(path: string): KnownRepo | undefined {
  return getKnownRepos().find((r) => r.path === path || r.worktrees.includes(path));
}

/**
 * そのフォルダの git の事実——台帳に無くても（一覧から外したものでも）フォルダから読む。
 * 公開の画面はこちらを使う（公開できるかはフォルダが決める。台帳が決めるのではない）
 */
export function readFolderRepo(path: string): KnownRepo | undefined {
  const inLedger = findRepoForFolder(path);
  if (inLedger) return inLedger;
  const top = hostFolders.find((f) => f.git && (f.path === path || f.git.worktrees.includes(path)));
  return top?.git && { ...top.git, missing: false, path: top.path, name: folderName(top.path) };
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

/** そのリポジトリを台帳が覚えているのに、フォルダが見つからない行（GitHub は owner/name、外は URL で比べる） */
function findMissingRepo(source: CloneSource): MissingRepo | undefined {
  return ledgerRepos(ledger).find(
    (r): r is MissingRepo =>
      r.missing &&
      (source.kind === "github"
        ? sameLocation(r.github, source)
        : !!r.elsewhere && remoteKey(r.elsewhere) === remoteKey(source.url)),
  );
}

/** 見つからない行が覚えている clone の元（GitHub の場所か、その外の URL）。どちらも無ければ戻す手は無い */
export function missingRepoSource(repo: MissingRepo): CloneSource | null {
  if (repo.github) return { kind: "github", ...repo.github };
  return repo.elsewhere ? parseCloneSource(repo.elsewhere) : null;
}

/** そのリポジトリを Root（フォルダそのもの・worktree）にしている Project */
export function getProjectsUsingRepo(repo: LedgerRepo) {
  const worktrees = repo.missing ? [] : repo.worktrees;
  return getAllProjects().filter((p) => p.basePath === repo.path || worktrees.includes(p.basePath));
}

function projectSummary(repo: LedgerRepo) {
  const p = getProjectsUsingRepo(repo)[0];
  return (
    p && {
      id: p.id,
      name: p.name,
      closed: !getActiveProjects().some((a) => a.id === p.id),
      /** その Project の Root はこのリポジトリの worktree（フォルダそのものではない） */
      viaWorktree: p.basePath !== repo.path,
    }
  );
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

/** Repositories が clone した——フォルダを作って台帳に足す（見つからなかった行なら、その行を置き換える） */
export function addClonedRepo(input: {
  path: string;
  accountId?: string;
  remote: Exclude<RepoRemote, { kind: "none" }>;
}): void {
  putGitFolder(input.path, git(input.remote));
  addToLedger({ path: input.path, accountId: input.accountId, ...originFields(input.remote) });
  notifyMockStoreChange();
}

/**
 * 見つからないフォルダを、台帳が覚えている場所（GitHub か、その外の URL）から**元の場所に** clone し直す。
 * 読めなければ（見えるアカウントが無い非公開・このマシンから読めない）理由を返して何もしない
 */
export function recloneMissingRepo(path: string): { ok: true } | { ok: false; reason: string } {
  const entry = ledger.find((e) => e.path === path);
  const repo = ledgerRepos(ledger).find((r): r is MissingRepo => r.missing && r.path === path);
  const source = repo ? missingRepoSource(repo) : null;
  if (!entry || !source || hostFolder(path)) return { ok: false, reason: "clone し直せる行ではありません" };
  if (source.kind === "elsewhere") {
    const access = checkCloneAccess(source, undefined);
    if (!access.ok) return { ok: false, reason: access.reason };
    addClonedRepo({ path, remote: { kind: "elsewhere", url: source.url } });
    return { ok: true };
  }
  const { owner, name } = source;
  const listed = visibleGithubRepo(owner, name);
  if (!listed) {
    return { ok: false, reason: `${owner}/${name} は、登録したアカウントのどれからも見えません` };
  }
  addClonedRepo({
    path,
    accountId: accounts.some((a) => a.id === entry.accountId) ? entry.accountId : undefined,
    remote: { kind: "github", owner, name, private: listed.private },
  });
  return { ok: true };
}

/**
 * 一覧から外す——台帳の行だけを消す。**フォルダには触らない**（消さない・動かさない）。
 * そのフォルダを Root にした Project もそのまま。戻すときのために外した行を返す
 */
export function removeFromLedger(path: string): LedgerEntry | undefined {
  const entry = ledger.find((e) => e.path === path);
  if (!entry) return undefined;
  ledger = ledger.filter((e) => e.path !== path);
  notifyMockStoreChange();
  return entry;
}

/** 台帳を直したお知らせを見た——一度見たら消す（覚えていた古い場所も一緒に忘れる） */
export function dismissCorrection(path: string): void {
  if (!ledger.some((e) => e.path === path && e.correctedFrom)) return;
  ledger = ledger.map((e) => (e.path === path ? { ...e, correctedFrom: undefined } : e));
  notifyMockStoreChange();
}

/** 「元に戻す」——外した行を、そのまま台帳に戻す */
export function restoreLedgerEntry(entry: LedgerEntry): void {
  addToLedger(entry);
  ledger = syncWithFolders(ledger, hostFolders);
  notifyMockStoreChange();
}


/** Repositories が新しく作った（git init）——GitHub にはまだ無い */
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

/**
 * GitHub に公開した——origin を付け、どのアカウントで扱うか・GitHub の場所を覚える（フォルダは動かさない）。
 * 一覧から外していたフォルダでも、公開したら台帳に戻す（Repositories が push したものは Repositories が覚える）
 */
export function setRepoRemote(path: string, remote: RepoRemote, accountId?: string): void {
  const facts = hostFolder(path)?.git;
  if (facts) putGitFolder(path, { ...facts, remote });
  const rest = ledger.find((e) => e.path === path);
  addToLedger({ ...rest, path, accountId, ...originFields(remote), correctedFrom: undefined });
  notifyMockStoreChange();
}

// ── clone・新しく作る先 ──────────────────────────────────────────────────

/** そのパスが使われているか——フォルダがある、または台帳にある */
function pathTaken(path: string): boolean {
  return folderExists(path) || ledger.some((e) => e.path === path);
}

/** clone・新しく作るときのフォルダ名に使えるか（英数字と - _ .、ドットだけは不可） */
export function isValidFolderName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && !/^\.+$/.test(name);
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
  /** 台帳にあるリポジトリの場所だが、フォルダが見つからない（clone し直す先として空けておく） */
  | { kind: "taken-missing"; repo: MissingRepo; suggestion: string }
  /** 台帳に無い git のリポジトリがある（Import できる） */
  | { kind: "taken-unknown-repo"; suggestion: string }
  /** git でないフォルダがある */
  | { kind: "taken-folder"; entries: number; suggestion: string };

export function inspectTargetFolder(home: string, name: string): TargetFolderState {
  const path = `${home}/${name}`;
  if (!pathTaken(path)) return { kind: "free" };
  const suggestion = freeFolderName(home, name);
  const listed = ledgerRepos(ledger).find((r) => r.path === path);
  if (listed?.missing) return { kind: "taken-missing", repo: listed, suggestion };
  if (listed) return { kind: "taken-repo", repo: listed, project: projectSummary(listed), suggestion };
  const folder = hostFolder(path);
  if (folder?.git) return { kind: "taken-unknown-repo", suggestion };
  return { kind: "taken-folder", entries: folder?.entries ?? listChildFolders(path).length, suggestion };
}

/**
 * clone しようとしているリポジトリを、もう持っているか（どこにあっても）。フォルダが見つからない行が
 * そのリポジトリを覚えていれば、**その行の場所に clone し直す**（一覧の「clone し直す」と同じ）。
 * GitHub の外は origin の URL で比べる（台帳は GitHub の外の URL も覚えるので、見つからない行は clone し直せる）
 */
export function inspectCloneSource(
  source: CloneSource,
):
  | { kind: "have"; repo: KnownRepo; project?: ProjectSummary }
  | { kind: "reclone"; repo: MissingRepo; project?: ProjectSummary }
  | null {
  const repo =
    source.kind === "elsewhere"
      ? getKnownRepos().find((r) => r.remote.kind === "elsewhere" && remoteKey(r.remote.url) === remoteKey(source.url))
      : findKnownGithubRepo(source.owner, source.name);
  if (repo) return { kind: "have", repo, project: projectSummary(repo) };
  const missing = findMissingRepo(source);
  return missing ? { kind: "reclone", repo: missing, project: projectSummary(missing) } : null;
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
  addToLedger({ path, accountId: check.accountId, ...originFields(check.facts.remote) });
  notifyMockStoreChange();
  return findRepoForFolder(path);
}

/** origin の URL からホスト名だけ（`git@gitlab.com:…` → `gitlab.com`） */
export function remoteHost(url: string): string {
  return url.replace(/^git@/, "").replace(/^https?:\/\//, "").split(/[:/]/)[0];
}
