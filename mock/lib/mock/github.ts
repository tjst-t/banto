// Repo Module の GitHub まわり（2026-09-29、Repo Module を足す相談のためのモック）。
//
// - アカウントは Repo の設定で登録する（名前・PAT・SSH 鍵）。PAT と鍵の中身は
//   ここに持たない——Vault の alias の名前だけを持つ（VaultUI と同じ作法）
// - clone 先は ghq の置き方（`~/ghq/github.com/<owner>/<repo>`）
// - **Repo は banto 全体に1本**（改訂・2026-09-30、ユーザー）——Project より先に動き、
//   フォルダを用意する（clone・git init）だけ。Project を作るのは banto 本体
// - 置き場に既にフォルダがあるとき、何が起きるかは `inspectRepoFolder` の1箇所で決める
//   （新しい Project の画面と、リポジトリの一覧が同じ答えを使う）
import { useSyncExternalStore } from "react";
import { getActiveProjects, getAllProjects } from "./projects";
import { notifyMockStoreChange, subscribeMockStore } from "./store-events";

export interface MockGithubAccount {
  id: string;
  /** GitHub のユーザー名。置き場のパス（`~/ghq/github.com/<login>/…`）にもなる */
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

export const GHQ_ROOT = "~/ghq/github.com";

export function ghqPath(owner: string, name: string): string {
  return `${GHQ_ROOT}/${owner}/${name}`;
}

// ── ghq の置き場にあるリポジトリ（2026-09-30、Repo は banto 全体に1本）──────────
//
// **真実はフォルダ1つずつ**（規則3）。Project の側には写しを持たない——
// 「この Project のリポジトリ」は Project の Root からここを引いて導く。
// 本物は Repo が host のフォルダを見て答える。

/** origin がどこにあるか */
export type RepoRemote =
  | { kind: "github"; owner: string; name: string; private: boolean }
  /** GitHub の外（gitlab 等） */
  | { kind: "elsewhere"; url: string }
  /** origin が無い——このマシンにだけある */
  | { kind: "none" };

export interface LocalRepo {
  /** `~/ghq/github.com/<owner>/<name>`——置き場のパスが owner と name を決める */
  path: string;
  owner: string;
  name: string;
  remote: RepoRemote;
  branch: string;
  commits: number;
  lastCommit?: string;
  lastCommitAt?: string;
  otherBranches: readonly string[];
  /** このリポジトリの worktree（Project の Root が置き場の外にあるとき） */
  worktrees: readonly string[];
}

function repo(
  owner: string,
  name: string,
  rest: Omit<LocalRepo, "path" | "owner" | "name" | "otherBranches" | "worktrees"> &
    Partial<Pick<LocalRepo, "otherBranches" | "worktrees">>,
): LocalRepo {
  return { path: ghqPath(owner, name), owner, name, otherBranches: [], worktrees: [], ...rest };
}

const SEED_REPOS: readonly LocalRepo[] = [
  repo("tjst-t", "banto", {
    remote: { kind: "github", owner: "tjst-t", name: "banto", private: false },
    branch: "main",
    commits: 2140,
    worktrees: ["~/worktrees/banto-v4"],
  }),
  repo("tjst-t", "home-automation", {
    remote: { kind: "github", owner: "tjst-t", name: "home-automation", private: true },
    branch: "main",
    commits: 312,
  }),
  repo("tjst-t", "hermes", {
    remote: { kind: "none" },
    branch: "main",
    commits: 7,
    lastCommit: "検索の閾値を 0.72 に下げる",
    lastCommitAt: "2時間前",
    otherBranches: ["try-embedding", "bench"],
  }),
  repo("tjst-t", "recipe-box", {
    remote: { kind: "none" },
    branch: "main",
    commits: 0,
  }),
  repo("tjst-t", "dotfiles", {
    remote: { kind: "github", owner: "tjst-t", name: "dotfiles", private: false },
    branch: "main",
    commits: 488,
  }),
  // 別のアカウントで公開した——置き場は tjst-t/ のまま
  repo("tjst-t", "tiny-cli", {
    remote: { kind: "github", owner: "work-org", name: "tiny-cli", private: true },
    branch: "main",
    commits: 23,
  }),
  repo("tjst-t", "notes", {
    remote: { kind: "elsewhere", url: "git@gitlab.com:tjst-t/notes.git" },
    branch: "main",
    commits: 96,
  }),
  repo("work-org", "infra", {
    remote: { kind: "github", owner: "work-org", name: "infra", private: true },
    branch: "main",
    commits: 1203,
  }),
];

let localRepos: LocalRepo[] = [...SEED_REPOS];

/** git でないフォルダ（置き場にあるが、リポジトリではない） */
const PLAIN_FOLDERS: Record<string, number> = {
  [ghqPath("tjst-t", "scratch")]: 14,
};

export function getLocalRepos(): readonly LocalRepo[] {
  return localRepos;
}

/** そのフォルダ（置き場そのもの、または worktree）のリポジトリ */
export function findRepoForFolder(path: string): LocalRepo | undefined {
  return localRepos.find((r) => r.path === path || r.worktrees.includes(path));
}

/** Repo が clone した・git init したフォルダを置き場に足す */
export function addLocalRepo(input: Pick<LocalRepo, "owner" | "name" | "remote">): LocalRepo {
  const next = repo(input.owner, input.name, {
    remote: input.remote,
    branch: "main",
    commits: input.remote.kind === "none" ? 0 : 1,
  });
  localRepos = [...localRepos.filter((r) => r.path !== next.path), next];
  notifyMockStoreChange();
  return next;
}

/** GitHub に公開した——origin を付ける（フォルダは動かさない） */
export function setRepoRemote(path: string, remote: RepoRemote): void {
  localRepos = localRepos.map((r) => (r.path === path ? { ...r, remote } : r));
  notifyMockStoreChange();
}

/** 置き場の外のフォルダで git init した（「フォルダを選ぶ」で始めた Project） */
export function gitInitFolder(path: string): void {
  const name = path.split("/").pop() ?? path;
  localRepos = [
    ...localRepos,
    { path, owner: "", name, remote: { kind: "none" }, branch: "main", commits: 0, otherBranches: [], worktrees: [] },
  ];
  notifyMockStoreChange();
}

export function isInGhq(repo: LocalRepo): boolean {
  return repo.path === ghqPath(repo.owner, repo.name);
}

/** そのリポジトリを Root（置き場そのもの・worktree）にしている Project */
export function getProjectsUsingRepo(repo: LocalRepo) {
  return getAllProjects().filter((p) => p.basePath === repo.path || repo.worktrees.includes(p.basePath));
}

/**
 * **置き場がずれているか**——ghq の置き方なら `github.com/<owner>/<name>` は origin と同じになる。
 * 別の名前・別のアカウントで公開すると、フォルダは元の場所に残るのでずれる。
 * 直すか（フォルダを移すか）はまだ決めていない——ここは見せるだけ
 */
export type Placement =
  | { kind: "ok" }
  | { kind: "moved"; expected: string }
  | { kind: "not-github"; host: string };

export function getPlacement(repo: LocalRepo): Placement {
  if (!isInGhq(repo)) return { kind: "ok" };
  if (repo.remote.kind === "elsewhere") {
    const host = repo.remote.url.replace(/^git@/, "").replace(/^https?:\/\//, "").split(/[:/]/)[0];
    return { kind: "not-github", host };
  }
  if (repo.remote.kind !== "github") return { kind: "ok" };
  const { owner, name } = repo.remote;
  return owner === repo.owner && name === repo.name
    ? { kind: "ok" }
    : { kind: "moved", expected: ghqPath(owner, name) };
}

/** どのアカウントのものか——GitHub にあれば origin の持ち主、まだなら置き場の owner */
export function repoAccountLogin(repo: LocalRepo): string {
  return repo.remote.kind === "github" ? repo.remote.owner : repo.owner;
}

export type RepoFolderState =
  /** 何も無い——clone する（または新しく作る） */
  | { kind: "empty" }
  /** 同じリポジトリが既にある——clone せず、そのフォルダを使う */
  | { kind: "same-repo" }
  /** 同じリポジトリがあり、そこを Root にした Project もある——新しく作らず、その Project を開く */
  | { kind: "same-repo-project"; projectId: string; projectName: string; closed: boolean }
  /** まだ GitHub に上げていない同じ名前のリポジトリがある（Repo が git init したもの等） */
  | { kind: "local-only"; project?: { id: string; name: string; closed: boolean } }
  /** 別のリポジトリがある——上書きしない */
  | { kind: "other-repo"; origin: string }
  /** git でないフォルダがある——上書きしない */
  | { kind: "not-git"; entries: number };

export function inspectRepoFolder(owner: string, name: string): RepoFolderState {
  const path = ghqPath(owner, name);
  const plain = PLAIN_FOLDERS[path];
  if (plain !== undefined) return { kind: "not-git", entries: plain };
  const found = localRepos.find((r) => r.path === path);
  if (!found) return { kind: "empty" };
  const { remote } = found;
  if (remote.kind === "none") {
    const p = getProjectsUsingRepo(found)[0];
    return {
      kind: "local-only",
      project: p && { id: p.id, name: p.name, closed: !getActiveProjects().some((a) => a.id === p.id) },
    };
  }
  if (remote.kind === "elsewhere") return { kind: "other-repo", origin: remote.url };
  if (remote.owner !== owner || remote.name !== name) {
    return { kind: "other-repo", origin: `github.com/${remote.owner}/${remote.name}` };
  }
  const project = getProjectsUsingRepo(found)[0];
  if (project) {
    return {
      kind: "same-repo-project",
      projectId: project.id,
      projectName: project.name,
      closed: !getActiveProjects().some((p) => p.id === project.id),
    };
  }
  return { kind: "same-repo" };
}
