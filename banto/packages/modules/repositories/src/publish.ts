// GitHub に公開（docs/specs/v4-modules.md §2.4「GitHub に公開」、段階5）。
//
// 判断はここで決め、画面は言い方だけを持つ（モックの `repo-publish-view.tsx`）。**対象はフォルダ**（Project ではない）
// ——一覧の行からはその行、Project の画面の入口からはその Project の Root を含む台帳の行。
//
// - **公開できるのは、台帳の行で、origin が無いリポジトリ**。origin がもうある（GitHub の外を指していても）なら
//   断る——台帳は origin を正としてリモートの場所を覚えるので、別の名前の remote を足すとリモートの場所が2つになる。
//   worktree・detached HEAD も断る（理由と次の手つき）
// - **する事**：GitHub に空のリポジトリを作る（`POST /user/repos`・`POST /orgs/{org}/repos`。README 等は作らない）
//   → origin を足す → いまのブランチを upstream つきで push（コミットが無ければ origin を足すところまで）→ 台帳に
//   リモートの場所とアカウントを書く
// - **資格情報**は clone と同じ（段階3）：GitHub のアカウントのトークンは一度きりの窓口から credential helper へ、
//   SSH 鍵のアカウントは Vault の ssh-agent と GitHub の host 鍵。**origin の URL に資格情報は入れない**
// - **push の送り先・TLS を変える設定がリポジトリにあれば push しない**（`pushBlockers`）。**push の直前にも読み直し**、
//   origin の push 先が作った URL の1つだけであることを確かめる（押したあとに `.git/config` が書き換えられうる）。
//   submodule へは辿らない（`writeEnv`）。頼んだ公開範囲で作られなければ origin も push もしない
// - **作れたのに push で失敗したら、作ったリポジトリは消さない**（人のものを勝手に消さない）。「GitHub にはできて
//   います」と言い、push だけやり直せる（`retryPush`）。やり直せる状態は**フォルダから導く**——origin が GitHub で、
//   いまのブランチが origin にまだ無い（「push に失敗した」という印は持たない、規則3）
// - GitHub に作るのは押した呼び出しの中（Vault・GitHub の口はそこで使い終える）。origin を足すのと push は背景の仕事で、
//   画面が進み具合を聞きに来る。push はやめられる

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import type { GithubAccounts } from "./accounts.js";
import { writeGithubKnownHosts } from "./clone.js";
import { openCredentialWindow, type CredentialWindow } from "./credential-server.js";
import {
  branchFacts,
  gitPush,
  gitRemoteAdd,
  pushBlockers,
  pushUrls,
  readFolder,
  sshCommandFor,
  type BranchFacts,
  type CloneProgress,
  type GitCredential,
} from "./git.js";
import { GithubError, type GithubApi, type GithubEndpoints, type PublishOwner } from "./github.js";
import { syncWithOrigin, type LedgerEntry, type LedgerStore } from "./ledger.js";
import { displayPath } from "./paths.js";
import type { ProjectsLookup } from "./repositories.js";
import type { VaultAccess } from "./vault.js";

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** GitHub のリポジトリ名に使えるか（英数字と - _ .、100字まで。`.`・`..` は不可） */
export function isValidRepoName(name: string): boolean {
  return REPO_NAME.test(name) && name !== "." && name !== "..";
}

/** GitHub の持ち主（ユーザー・Organization）の名前に使える形 */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * **試験で差し込む穴**——push の直前（origin と台帳のあと、読み直しの前）に呼ぶ。試験はここで `.git/config` を書き換える
 * （Project の Root はコンテナに mount されるので、中の AI が押したあとに書き換えうる）・やめるを押す
 */
export const PUBLISH_HOOKS: { beforePush?: (path: string, jobId: string) => Promise<void> } = {};

export interface PublishInspection {
  path: string;
  displayPath: string;
  /** フォルダ名（リポジトリ名の既定） */
  name: string;
  /** 公開も push もできない理由（次の手つき） */
  refusal?: string;
  /**
   * `local`：まだこのマシンにだけ——公開できる。`needs-push`：GitHub の origin はあるが、いまのブランチがまだ GitHub に
   * 無い——push だけやり直せる。`published`：GitHub にあり、いまのブランチも GitHub にある
   */
  state?: "local" | "needs-push" | "published";
  github?: { owner: string; name: string };
  /** 台帳が覚えているアカウント（あれば先に選ぶ。push のやり直しはこれで） */
  account?: string;
  branch?: BranchFacts;
  /** push を止める設定（あれば push しない） */
  blockers?: string[];
}

export interface PublishTargets {
  accounts: Array<{ login: string; owners: PublishOwner[]; orgsError?: string; error?: string }>;
  /** 先に選ぶアカウント（台帳が覚えているもの、か1つならそれ） */
  preselected?: string;
}

export type PublishStepKey = "create" | "origin" | "ledger" | "push";

export interface PublishJobView {
  id: string;
  path: string;
  displayPath: string;
  state: "running" | "done" | "failed" | "cancelled";
  target: { owner: string; name: string; private: boolean; htmlUrl: string };
  steps: Array<{ key: PublishStepKey; state: "waiting" | "running" | "done" | "failed" | "skipped" }>;
  branch?: string;
  account: string;
  progress?: CloneProgress;
  /** GitHub にリポジトリができている（押す前の確かめで断ったのでなければ、いつも true） */
  created: boolean;
  /** コミットが無いので push はしなかった */
  noCommits?: boolean;
  error?: { message: string; step: PublishStepKey };
}

interface PublishJob extends PublishJobView {
  abort: AbortController;
  finishedAt?: number;
}

export interface PublisherDeps {
  store: LedgerStore;
  dataDir: string;
  accounts: GithubAccounts;
  vault: VaultAccess;
  github: GithubApi;
  endpoints: GithubEndpoints;
  home?: string;
}

const KEEP_FINISHED_MS = 10 * 60_000;

/** push の失敗を、次の手を選べる言い方に。**相手の言葉（`remote:` の行）は見ない** */
function explainPush(own: string): string {
  if (/could not read Username|Authentication failed|Invalid username or token|terminal prompts disabled|\b401\b/i.test(own)) {
    return "資格情報が通りませんでした（トークンの期限・権限を確かめてください）";
  }
  if (/\b403\b|Permission to .* denied|denied to /i.test(own)) {
    return "このアカウントには、このリポジトリへ push する権限がありません（GitHub App なら Contents の Read and write が要ります）";
  }
  if (/Permission denied \(publickey/i.test(own)) return "SSH 鍵が受け付けられませんでした（その鍵を GitHub に登録してあるか確かめてください）";
  if (/Host key verification failed/i.test(own)) return "GitHub の SSH の鍵を確かめられませんでした";
  if (/\[rejected\]|non-fast-forward|fetch first/i.test(own)) return "GitHub 側に別のコミットがあります（押し返されました）";
  if (/Could not resolve host|Connection refused|Connection timed out|unable to access|Network is unreachable/i.test(own)) return "GitHub に繋がりませんでした";
  return "";
}

export class Publisher {
  private readonly jobs = new Map<string, PublishJob>();
  /** 公開・push の最中のフォルダ（同じフォルダで2つ走らせない） */
  private readonly busy = new Set<string>();

  constructor(private readonly deps: PublisherDeps) {}

  private get home() {
    return this.deps.home ?? homedir();
  }

  /**
   * 公開する台帳の行を決める。`path` があればその行。無ければ**呼び出しの刻印の Project**（host が刻む `forProject`
   * ——画面の申告ではない）の Root を含む行（いちばん深いもの）
   */
  async resolveFolder(input: { path?: string; forProject?: string }, lookup: ProjectsLookup): Promise<string> {
    if (input.path) return input.path;
    if (!input.forProject) throw new Error("Project の画面の中で開くか、リポジトリの一覧から開いてください");
    if (!lookup.ok) throw new Error(`この Project の Root を引けませんでした：${lookup.error}`);
    const project = lookup.projects.find((p) => p.id === input.forProject);
    if (!project) throw new Error("この Project が見つかりません");
    // Root の**リポジトリの一番上**を git に聞き、台帳の行と一致するものだけ（パスの前方一致では、台帳にある外側の
    // リポジトリや、名前の似た隣を拾いうる）。readFolder は realpath を取る
    const root = project.root.length > 1 ? project.root.replace(/\/+$/, "") : project.root;
    let top: string | undefined;
    try {
      const facts = await readFolder(root);
      top = facts.kind === "repo" ? facts.path : facts.kind === "inside" ? facts.top : facts.kind === "worktree" ? await realpath(root) : undefined;
    } catch (err) {
      throw new Error(`この Project の Root（${displayPath(project.root, this.home)}）を読めません：${(err as Error).message}`);
    }
    const match = top ? (await this.deps.store.entries()).find((e) => e.path === top) : undefined;
    if (!match) {
      throw new Error(`この Project の Root（${displayPath(project.root, this.home)}）はリポジトリの一覧にありません——一覧の「フォルダを Import」で足してから公開してください`);
    }
    return match.path;
  }

  async inspect(path: string): Promise<PublishInspection> {
    const base = { path, displayPath: displayPath(path, this.home), name: basename(path) };
    const entry = (await this.deps.store.entries()).find((e) => e.path === path);
    if (!entry) return { ...base, refusal: "一覧に無いフォルダは公開しません（リポジトリの一覧で Import してから）" };
    const account = entry.account ? { account: entry.account } : {};
    let facts;
    try {
      facts = await readFolder(path);
    } catch (err) {
      return { ...base, ...account, refusal: `読めません（${(err as Error).message}）` };
    }
    if (facts.kind === "missing") return { ...base, ...account, refusal: "フォルダが見つかりません" };
    if (facts.kind === "worktree") {
      return { ...base, ...account, refusal: `worktree からは公開しません——本体（${displayPath(facts.main, this.home)}）の行から公開してください（worktree と本体は origin を共有します）` };
    }
    if (facts.kind !== "repo") return { ...base, ...account, refusal: "git のリポジトリの一番上ではありません" };
    if (facts.remote.kind === "elsewhere") {
      return {
        ...base,
        ...account,
        refusal: `origin が GitHub の外（${facts.remote.url}）を指しています。公開すると origin を書き換えることになるので、ここからはしません`,
      };
    }
    let branch: BranchFacts;
    let blockers: string[];
    try {
      branch = await branchFacts(path);
      blockers = await pushBlockers(path);
    } catch (err) {
      return { ...base, ...account, refusal: (err as Error).message };
    }
    const github = facts.remote.kind === "github" ? { github: { owner: facts.remote.owner, name: facts.remote.name } } : {};
    const view = { ...base, ...account, ...github, branch, ...(blockers.length ? { blockers } : {}) };
    if (!branch.branch) return { ...view, refusal: "いまブランチの上にいません（detached HEAD）——ブランチに移ってから公開してください" };
    if (blockers.length > 0) {
      return {
        ...view,
        refusal: `このリポジトリの設定に、push の送り先や TLS を変える設定があります（${blockers.join("・")}）——資格情報を別の場所へ送りうるので、ここからは push しません。要らなければ git config --unset で外してから、もう一度開いてください`,
      };
    }
    if (facts.remote.kind === "none") return { ...view, state: "local" };
    return { ...view, state: branch.unborn || branch.onOrigin ? "published" : "needs-push" };
  }

  /** 公開に使えるアカウントと、それぞれの持ち主（自分・Organization）にリポジトリを作れそうか */
  async targets(path: string | undefined, callId?: string): Promise<PublishTargets> {
    const { accounts } = await this.deps.accounts.list();
    const remembered = path ? (await this.deps.store.entries()).find((e) => e.path === path)?.account : undefined;
    const out: PublishTargets["accounts"] = [];
    for (const a of accounts) {
      try {
        const token = await this.deps.accounts.tokenFor(a.login, callId);
        const owners = await this.deps.github.publishOwners(token, a.login, a.credential.kind);
        out.push({ login: a.login, owners: owners.owners, ...(owners.orgsError ? { orgsError: owners.orgsError } : {}) });
      } catch (err) {
        out.push({ login: a.login, owners: [], error: (err as Error).message });
      }
    }
    // 書けるアカウントだけを先に選ぶ（どの持ち主にも作れないと分かっているものは選ばない）
    const usable = out.filter((a) => a.owners.some((o) => o.create !== "no"));
    const pre = usable.find((a) => remembered && a.login.toLowerCase() === remembered.toLowerCase()) ?? (usable.length === 1 ? usable[0] : undefined);
    return { accounts: out, ...(pre ? { preselected: pre.login } : {}) };
  }

  /** その名前が使えるか。GitHub に同じ名前があれば断り、空いている名前（`-2`…）を出す */
  async checkName(input: { login: string; owner: string; name: string }, callId?: string): Promise<{ invalid?: string; taken?: boolean; suggestion?: string }> {
    if (!isValidRepoName(input.name)) return { invalid: "使えるのは英数字と - _ . だけです（100字まで）" };
    const token = await this.tokenOf(input.login, callId);
    if (!(await this.deps.github.repoExists(token, input.owner, input.name))) return {};
    for (let n = 2; n <= 6; n += 1) {
      const candidate = `${input.name}-${n}`;
      if (!isValidRepoName(candidate)) break;
      if (!(await this.deps.github.repoExists(token, input.owner, candidate))) return { taken: true, suggestion: candidate };
    }
    return { taken: true };
  }

  private async tokenOf(login: string, callId?: string): Promise<string> {
    const account = (await this.deps.accounts.list()).accounts.find((a) => a.login.toLowerCase() === login.toLowerCase());
    if (!account) throw new Error(`@${login} は登録されていません`);
    return this.deps.accounts.tokenFor(account.login, callId);
  }

  /** origin に書く URL（資格情報は入れない）。SSH 鍵のアカウントなら ssh、そうでなければ https */
  private remoteUrl(ssh: boolean, owner: string, name: string): string {
    if (ssh) return `git@${this.deps.endpoints.ssh ?? new URL(this.deps.endpoints.web).hostname}:${owner}/${name}.git`;
    return `${this.deps.endpoints.web.replace(/\/+$/, "")}/${owner}/${name}.git`;
  }

  /**
   * push の資格情報を用意する（押した呼び出しの中で。Vault・GitHub の口はここで使い終える）。SSH 鍵のアカウントなら
   * ssh-agent、そうでなければ一度きりの窓口（相手は GitHub の host——URL は作られた持ち主・名前から後で組む）
   */
  private async credentialFor(login: string, callId?: string): Promise<{ ssh: boolean; credential: GitCredential; window?: CredentialWindow }> {
    const account = (await this.deps.accounts.list()).accounts.find((a) => a.login.toLowerCase() === login.toLowerCase());
    if (!account) throw new Error(`@${login} は登録されていません`);
    if (account.ssh) {
      const socket = (await this.deps.vault.startSshAgent(account.ssh, callId)).socketPath;
      const knownHosts = await writeGithubKnownHosts(this.deps.dataDir, this.deps.endpoints);
      sshCommandFor(socket, knownHosts);
      return { ssh: true, credential: { kind: "ssh-agent", socket, knownHosts } };
    }
    const token = await this.deps.accounts.tokenFor(account.login, callId);
    const web = new URL(this.deps.endpoints.web);
    const window = await openCredentialWindow({ protocol: web.protocol.replace(/:$/, ""), host: web.host, username: account.login, password: token });
    return { ssh: false, credential: { kind: "helper", command: window.helperCommand }, window };
  }

  /**
   * 公開する。**押した呼び出しの中で、判断を読み直し・GitHub に作り**、origin と push は背景で
   */
  async start(
    input: { path: string; login: string; owner: string; name: string; private: boolean; description?: string },
    callId?: string,
  ): Promise<PublishJobView> {
    if (this.busy.has(input.path)) throw new Error("このフォルダは、いま公開しています");
    this.busy.add(input.path);
    let handed = false;
    let window: CredentialWindow | undefined;
    try {
      const ins = await this.inspect(input.path);
      if (ins.refusal) throw new Error(ins.refusal);
      if (ins.state !== "local") throw new Error("もう GitHub にあります（origin があります）");
      if (!isValidRepoName(input.name)) throw new Error("名前に使えるのは英数字と - _ . だけです（100字まで）");
      if (!OWNER.test(input.owner)) throw new Error("持ち主の名前として読めません");
      const description = input.description?.trim();
      if (description && description.length > 350) throw new Error("説明は 350 字までです");
      const account = (await this.deps.accounts.list()).accounts.find((a) => a.login.toLowerCase() === input.login.toLowerCase());
      if (!account) throw new Error(`@${input.login} は登録されていません`);
      const org = input.owner.toLowerCase() === account.login.toLowerCase() ? undefined : input.owner;
      const branch = ins.branch!;
      // 資格情報（push するときだけ）→ GitHub に作る。作ったあとで資格情報を用意できない、を作らない
      let credential: GitCredential | undefined;
      let ssh = !!account.ssh;
      if (!branch.unborn) {
        const c = await this.credentialFor(account.login, callId);
        credential = c.credential;
        window = c.window;
        ssh = c.ssh;
      }
      const token = await this.deps.accounts.tokenFor(account.login, callId);
      let created;
      try {
        created = await this.deps.github.createRepo(token, { ...(org ? { org } : {}), name: input.name, private: input.private, ...(description ? { description } : {}) });
      } catch (err) {
        // 送ったあとに切れた・時間切れ——作られているかもしれない。「名前が使われている」に流して -2 を作らせない
        if (err instanceof GithubError && (err.code === "network" || /^5\d\d$/.test(err.code))) {
          const url = this.remoteUrl(ssh, input.owner, input.name);
          throw new Error(
            `GitHub に作れたかどうか分かりません（${err.message}）。GitHub で ${input.owner}/${input.name} を確かめてください——あれば ` +
              `git remote add origin ${url} で origin に足し、一覧の「…」→「GitHub への push」から push できます。無ければ、もう一度押してください`,
          );
        }
        throw err;
      }
      // **origin の URL は GitHub の返事から組む**（入力からではない——GitHub が名前を直したときも、作られた場所に向く）
      const url = this.remoteUrl(ssh, created.owner, created.name);
      const job: PublishJob = {
        id: randomUUID(),
        path: input.path,
        displayPath: ins.displayPath,
        state: "running",
        target: { owner: created.owner, name: created.name, private: created.private, htmlUrl: created.htmlUrl },
        steps: [
          { key: "create", state: "done" },
          { key: "origin", state: "running" },
          { key: "ledger", state: "waiting" },
          { key: "push", state: branch.unborn ? "skipped" : "waiting" },
        ],
        branch: branch.branch!,
        account: account.login,
        created: true,
        ...(branch.unborn ? { noCommits: true } : {}),
        abort: new AbortController(),
      };
      this.jobs.set(job.id, job);
      // **頼んだ公開範囲で作られたか**——違えば origin も push もしない（非公開のつもりで公開のリポジトリに履歴を上げない）
      if (created.private !== input.private) {
        job.state = "failed";
        for (const st of job.steps) if (st.key !== "create") st.state = "skipped";
        job.error = {
          step: "create",
          message:
            `GitHub は ${created.owner}/${created.name} を${created.private ? "非公開" : "公開"}で作りました（頼んだのは${input.private ? "非公開" : "公開"}）。` +
            `origin も push もしていません——GitHub で公開範囲を直してから、git remote add origin ${url} で足し、一覧の「…」→「GitHub への push」から push してください`,
        };
        job.finishedAt = Date.now();
        return this.view(job);
      }
      handed = true;
      void this.run(job, url, credential, window, { addOrigin: true });
      return this.view(job);
    } finally {
      if (!handed) {
        await window?.close().catch(() => undefined);
        this.busy.delete(input.path);
      }
    }
  }

  /** push だけやり直す（GitHub の origin はあるが、いまのブランチが GitHub にまだ無い）。台帳が覚えているアカウントで */
  async retryPush(input: { path: string }, callId?: string): Promise<PublishJobView> {
    if (this.busy.has(input.path)) throw new Error("このフォルダは、いま公開しています");
    this.busy.add(input.path);
    let handed = false;
    let window: CredentialWindow | undefined;
    try {
      const ins = await this.inspect(input.path);
      if (ins.refusal) throw new Error(ins.refusal);
      if (ins.state !== "needs-push" || !ins.github) throw new Error(ins.state === "published" ? "いまのブランチは、もう GitHub にあります" : "まだ GitHub にありません（公開から）");
      if (!ins.account) throw new Error("どのアカウントで push するかが決まっていません——一覧の行の「…」→「アカウントを選ぶ」で選んでから");
      // **origin の方式（ssh／https）とアカウントの方式が合っているか**——合わないまま push すると、資格情報が渡らずに
      // 「資格情報が通りませんでした」という嘘の失敗になる
      const account = (await this.deps.accounts.list()).accounts.find((a) => a.login.toLowerCase() === ins.account!.toLowerCase());
      if (!account) throw new Error(`@${ins.account} は登録が外れています——一覧の行の「…」→「アカウントを選ぶ」で選び直してから`);
      const expected = this.remoteUrl(!!account.ssh, ins.github.owner, ins.github.name);
      const actual = await pushUrls(input.path);
      if (actual.length !== 1 || actual[0] !== expected) {
        const sshOrigin = actual.length === 1 && /^(?:ssh:\/\/|[^/:]+@[^/:]+:)/.test(actual[0]!);
        throw new Error(
          actual.length === 1 && sshOrigin && !account.ssh
            ? `origin は ssh の URL（${actual[0]}）ですが、@${account.login} は SSH 鍵を登録していません——SSH 鍵を足すか、origin を ${expected} にしてから`
            : actual.length === 1 && !sshOrigin && account.ssh
              ? `origin は https の URL（${actual[0]}）ですが、@${account.login} は SSH 鍵で push するアカウントです——origin を ${expected} にしてから`
              : `origin の push 先（${actual.join("・") || "無し"}）が github.com/${ins.github.owner}/${ins.github.name} の ${expected} と違うので、push しません`,
        );
      }
      const c = await this.credentialFor(account.login, callId);
      window = c.window;
      const job: PublishJob = {
        id: randomUUID(),
        path: input.path,
        displayPath: ins.displayPath,
        state: "running",
        target: { owner: ins.github.owner, name: ins.github.name, private: false, htmlUrl: "" },
        steps: [{ key: "push", state: "running" }],
        branch: ins.branch!.branch!,
        account: ins.account,
        created: true,
        abort: new AbortController(),
      };
      this.jobs.set(job.id, job);
      handed = true;
      void this.run(job, expected, c.credential, window, { addOrigin: false });
      return this.view(job);
    } finally {
      if (!handed) {
        await window?.close().catch(() => undefined);
        this.busy.delete(input.path);
      }
    }
  }

  private step(job: PublishJob, key: PublishStepKey, state: PublishJobView["steps"][number]["state"]) {
    const s = job.steps.find((x) => x.key === key);
    if (s) s.state = state;
  }

  private async run(job: PublishJob, url: string, credential: GitCredential | undefined, window: CredentialWindow | undefined, opts: { addOrigin: boolean }): Promise<void> {
    const where = `github.com/${job.target.owner}/${job.target.name}`;
    const fail = (step: PublishStepKey, message: string, state: PublishJobView["state"] = "failed") => {
      this.step(job, step, state === "cancelled" ? "waiting" : "failed");
      job.state = state;
      job.error = { step, message };
    };
    try {
      if (opts.addOrigin) {
        try {
          await gitRemoteAdd(job.path, url);
        } catch (err) {
          return fail("origin", `GitHub にはできています（${where}）。${(err as Error).message}——git remote add origin ${url} で足してください`);
        }
        this.step(job, "origin", "done");
        // 台帳にリモートの場所とアカウントを書く（origin を読み直して——台帳は origin を正とする）。落ちたら push の失敗と
        // 混ぜずに「一覧に書けなかった」と言う
        this.step(job, "ledger", "running");
        try {
          const facts = await readFolder(job.path);
          await this.deps.store.update((entries) => ({
            entries: entries.map((e) => {
              if (e.path !== job.path) return e;
              const { readOnly: _r, ...rest }: LedgerEntry = syncWithOrigin(e, facts).entry;
              return { ...rest, account: job.account };
            }),
            result: undefined,
          }));
        } catch (err) {
          return fail(
            "ledger",
            `GitHub にはでき、origin も足しました（${where}）が、一覧に書けませんでした：${(err as Error).message}——push はしていません。一覧を開き直すと origin から読み直します（アカウントは「…」→「アカウントを選ぶ」で）`,
          );
        }
        this.step(job, "ledger", "done");
      }
      if (!credential) {
        job.state = "done";
        return;
      }
      await PUBLISH_HOOKS.beforePush?.(job.path, job.id);
      // origin を足している間に「やめる」が押されていたら、push しない
      if (job.abort.signal.aborted) return fail("push", `push をやめました。GitHub にはできています（${where}）。push だけやり直せます`, "cancelled");
      // **push の直前に読み直す**（押した時点の確かめのあとに、`.git/config` が書き換えられうる——Project の Root は
      // コンテナに mount され、中の AI が書ける）。送り先・TLS を変える設定が無く、push 先が作った URL の1つだけであること
      const blockers = await pushBlockers(job.path);
      const targets = await pushUrls(job.path);
      if (blockers.length > 0 || targets.length !== 1 || targets[0] !== url) {
        return fail(
          "push",
          `push の直前に設定を読み直したら、` +
            (blockers.length > 0 ? `push の送り先や TLS を変える設定がありました（${blockers.join("・")}）` : `origin の push 先が ${url} の1つではありませんでした（${targets.join("・") || "無し"}）`) +
            `——push していません。GitHub にはできています（${where}）。設定を直してから、push だけやり直せます`,
        );
      }
      this.step(job, "push", "running");
      const result = await gitPush({ path: job.path, branch: job.branch!, credential, signal: job.abort.signal, onProgress: (p) => (job.progress = p) });
      if (result.ok) {
        this.step(job, "push", "done");
        job.state = "done";
        return;
      }
      const why = result.kind === "failed" ? explainPush(result.own ?? "") : "";
      fail(
        "push",
        (result.kind === "cancelled" ? `push をやめました。` : `push できませんでした：${why ? `${why}——` : ""}${result.message}。`) +
          `GitHub にはできています（${where}）。push だけやり直せます`,
        result.kind === "cancelled" ? "cancelled" : "failed",
      );
    } catch (err) {
      const at = job.steps.find((s) => s.state === "running")?.key ?? "push";
      fail(at, `${(err as Error).message}（GitHub にはできています：${where}）`);
    } finally {
      await window?.close().catch(() => undefined);
      this.busy.delete(job.path);
      job.finishedAt = Date.now();
      for (const [id, j] of this.jobs) if (j.finishedAt && Date.now() - j.finishedAt > KEEP_FINISHED_MS) this.jobs.delete(id);
    }
  }

  private view(job: PublishJob): PublishJobView {
    const { abort: _a, finishedAt: _f, ...rest } = job;
    return { ...rest, steps: job.steps.map((s) => ({ ...s })), ...(job.progress ? { progress: { ...job.progress } } : {}) };
  }

  status(id: string): PublishJobView {
    const job = this.jobs.get(id);
    if (!job) throw new Error("この公開はもう覚えていません。開き直してください");
    return this.view(job);
  }

  cancel(id: string): PublishJobView {
    const job = this.jobs.get(id);
    if (!job) throw new Error("この公開はもう覚えていません");
    if (job.state === "running") job.abort.abort();
    return this.view(job);
  }
}
