// Repo Module の GitHub まわり（2026-09-29、Repo Module を足す相談のためのモック）。
//
// - アカウントは Repo の設定で登録する（名前・PAT・SSH 鍵）。PAT と鍵の中身は
//   ここに持たない——Vault の alias の名前だけを持つ（VaultUI と同じ作法）
// - clone 先は ghq の置き方（`~/ghq/github.com/<owner>/<repo>`）
// - 置き場に既にフォルダがあるとき、何が起きるかは `inspectRepoFolder` の1箇所で決める
//   （新しい Project の画面の3つの始め方と、あとで公開する画面が同じ答えを使う）
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

/**
 * ghq の置き場に、いま何があるか（本物は host が見て答える）。
 * `tjst-t/home-automation` は「自宅サーバ」の Project の Root になっている
 */
const LOCAL_FOLDERS: Record<string, { kind: "git"; origin: string } | { kind: "plain"; entries: number }> = {
  "tjst-t/banto": { kind: "git", origin: "git@github.com:tjst-t/banto.git" },
  "tjst-t/home-automation": { kind: "git", origin: "git@github.com:tjst-t/home-automation.git" },
  "tjst-t/notes": { kind: "git", origin: "git@gitlab.com:tjst-t/notes.git" },
  "tjst-t/scratch": { kind: "plain", entries: 14 },
  "work-org/infra": { kind: "git", origin: "https://github.com/work-org/infra.git" },
};

/** このモックの中で clone / 作成したフォルダ（2回目に同じものを選ぶと「既にある」になる） */
const createdFolders = new Map<string, { kind: "git"; origin: string }>();

export function recordCreatedFolder(owner: string, name: string, origin: string): void {
  createdFolders.set(ghqPath(owner, name), { kind: "git", origin });
}

export type RepoFolderState =
  /** 何も無い——clone する（または新しく作る） */
  | { kind: "empty" }
  /** 同じリポジトリが既にある——clone せず、そのフォルダを使う */
  | { kind: "same-repo" }
  /** 同じリポジトリがあり、そこを Root にした Project もある——新しく作らず、その Project を開く */
  | { kind: "same-repo-project"; projectId: string; projectName: string; closed: boolean }
  /** 別のリポジトリがある——上書きしない */
  | { kind: "other-repo"; origin: string }
  /** git でないフォルダがある——上書きしない */
  | { kind: "not-git"; entries: number };

export function inspectRepoFolder(owner: string, name: string): RepoFolderState {
  const path = ghqPath(owner, name);
  const found = LOCAL_FOLDERS[`${owner}/${name}`] ?? createdFolders.get(path);
  if (!found) return { kind: "empty" };
  if (found.kind === "plain") return { kind: "not-git", entries: found.entries };
  const origin = parseRepoReference(found.origin.replace(/^git@github\.com:/, "github.com/"));
  const sameRepo =
    found.origin.includes("github.com") && origin?.owner === owner && origin?.name === name;
  if (!sameRepo) return { kind: "other-repo", origin: found.origin };
  const project = getAllProjects().find((p) => p.basePath === path);
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

// ── Project ごとのリポジトリの状態（あとで GitHub に公開する画面が読む） ──────────

export type ProjectRepoState =
  | { kind: "github"; owner: string; name: string; private: boolean }
  | {
      kind: "local";
      branch: string;
      commits: number;
      lastCommit: string;
      lastCommitAt: string;
      otherBranches: readonly string[];
    }
  | { kind: "not-git" };

const projectRepos = new Map<string, ProjectRepoState>([
  ["banto", { kind: "github", owner: "tjst-t", name: "banto", private: false }],
  ["home", { kind: "github", owner: "tjst-t", name: "home-automation", private: true }],
  [
    "hermes",
    {
      kind: "local",
      branch: "main",
      commits: 7,
      lastCommit: "検索の閾値を 0.72 に下げる",
      lastCommitAt: "2時間前",
      otherBranches: ["try-embedding", "bench"],
    },
  ],
]);

export function getProjectRepoState(projectId: string): ProjectRepoState {
  return projectRepos.get(projectId) ?? { kind: "not-git" };
}

export function setProjectRepoState(projectId: string, state: ProjectRepoState): void {
  projectRepos.set(projectId, state);
  notifyMockStoreChange();
}
