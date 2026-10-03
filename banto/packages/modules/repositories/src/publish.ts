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
// - **push の送り先・TLS を変える設定がリポジトリにあれば push しない**（`pushBlockers`）
// - **作れたのに push で失敗したら、作ったリポジトリは消さない**（人のものを勝手に消さない）。「GitHub にはできて
//   います」と言い、push だけやり直せる（`retryPush`）。やり直せる状態は**フォルダから導く**——origin が GitHub で、
//   いまのブランチが origin にまだ無い（「push に失敗した」という印は持たない、規則3）
// - GitHub に作るのは押した呼び出しの中（Vault・GitHub の口はそこで使い終える）。origin を足すのと push は背景の仕事で、
//   画面が進み具合を聞きに来る。push はやめられる

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, sep } from "node:path";
import type { GithubAccounts } from "./accounts.js";
import { writeGithubKnownHosts } from "./clone.js";
import { openCredentialWindow, type CredentialWindow } from "./credential-server.js";
import {
  branchFacts,
  gitPush,
  gitRemoteAdd,
  pushBlockers,
  readFolder,
  sshCommandFor,
  type BranchFacts,
  type CloneProgress,
  type GitCredential,
} from "./git.js";
import type { GithubApi, GithubEndpoints, PublishOwner } from "./github.js";
import { syncWithOrigin, type LedgerEntry, type LedgerStore } from "./ledger.js";
import { displayPath } from "./paths.js";
import type { ProjectsLookup } from "./repositories.js";
import type { VaultAccess } from "./vault.js";

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** GitHub のリポジトリ名に使えるか（英数字と - _ .、100字まで。`.`・`..` は不可） */
export function isValidRepoName(name: string): boolean {
  return REPO_NAME.test(name) && name !== "." && name !== "..";
}

const isInside = (child: string, parent: string) => child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

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

export type PublishStepKey = "create" | "origin" | "push";

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
    const entries = await this.deps.store.entries();
    const match = entries
      .filter((e) => project.root === e.path || isInside(project.root, e.path))
      .sort((a, b) => b.path.length - a.path.length)[0];
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
        const owners = await this.deps.github.publishOwners(token, a.login);
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
   * ssh の URL と ssh-agent、そうでなければ https の URL と一度きりの窓口
   */
  private async credentialFor(login: string, owner: string, name: string, callId?: string): Promise<{ url: string; credential: GitCredential; window?: CredentialWindow }> {
    const account = (await this.deps.accounts.list()).accounts.find((a) => a.login.toLowerCase() === login.toLowerCase());
    if (!account) throw new Error(`@${login} は登録されていません`);
    if (account.ssh) {
      const socket = (await this.deps.vault.startSshAgent(account.ssh, callId)).socketPath;
      const knownHosts = await writeGithubKnownHosts(this.deps.dataDir, this.deps.endpoints);
      sshCommandFor(socket, knownHosts);
      return { url: this.remoteUrl(true, owner, name), credential: { kind: "ssh-agent", socket, knownHosts } };
    }
    const url = this.remoteUrl(false, owner, name);
    const token = await this.deps.accounts.tokenFor(account.login, callId);
    const web = new URL(url);
    const window = await openCredentialWindow({ protocol: web.protocol.replace(/:$/, ""), host: web.host, username: account.login, password: token });
    return { url, credential: { kind: "helper", command: window.helperCommand }, window };
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
      const description = input.description?.trim();
      if (description && description.length > 350) throw new Error("説明は 350 字までです");
      const account = (await this.deps.accounts.list()).accounts.find((a) => a.login.toLowerCase() === input.login.toLowerCase());
      if (!account) throw new Error(`@${input.login} は登録されていません`);
      const org = input.owner.toLowerCase() === account.login.toLowerCase() ? undefined : input.owner;
      const branch = ins.branch!;
      // 資格情報（push するときだけ）→ GitHub に作る。作ったあとで資格情報を用意できない、を作らない
      let url: string;
      let credential: GitCredential | undefined;
      if (branch.unborn) {
        // push しない——origin に書く URL だけ（そのアカウントで後から push するときと同じ形）
        url = this.remoteUrl(!!account.ssh, input.owner, input.name);
      } else {
        const c = await this.credentialFor(account.login, input.owner, input.name, callId);
        url = c.url;
        credential = c.credential;
        window = c.window;
      }
      const token = await this.deps.accounts.tokenFor(account.login, callId);
      const created = await this.deps.github.createRepo(token, { ...(org ? { org } : {}), name: input.name, private: input.private, ...(description ? { description } : {}) });
      const job: PublishJob = {
        id: randomUUID(),
        path: input.path,
        displayPath: ins.displayPath,
        state: "running",
        target: { owner: created.owner, name: created.name, private: created.private, htmlUrl: created.htmlUrl },
        steps: [
          { key: "create", state: "done" },
          { key: "origin", state: "running" },
          { key: "push", state: branch.unborn ? "skipped" : "waiting" },
        ],
        branch: branch.branch!,
        account: account.login,
        created: true,
        ...(branch.unborn ? { noCommits: true } : {}),
        abort: new AbortController(),
      };
      this.jobs.set(job.id, job);
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
      const c = await this.credentialFor(ins.account, ins.github.owner, ins.github.name, callId);
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
      void this.run(job, c.url, c.credential, window, { addOrigin: false });
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
    try {
      if (opts.addOrigin) {
        try {
          await gitRemoteAdd(job.path, url);
        } catch (err) {
          this.step(job, "origin", "failed");
          job.state = "failed";
          job.error = { step: "origin", message: `GitHub にはできています（${where}）。${(err as Error).message}——git remote add origin ${url} で足してください` };
          return;
        }
        this.step(job, "origin", "done");
        // 台帳にリモートの場所とアカウントを書く（origin を読み直して——台帳は origin を正とする）
        const facts = await readFolder(job.path);
        await this.deps.store.update((entries) => ({
          entries: entries.map((e) => {
            if (e.path !== job.path) return e;
            const { readOnly: _r, ...rest }: LedgerEntry = syncWithOrigin(e, facts).entry;
            return { ...rest, account: job.account };
          }),
          result: undefined,
        }));
      }
      if (!credential) {
        job.state = "done";
        return;
      }
      this.step(job, "push", "running");
      const result = await gitPush({ path: job.path, branch: job.branch!, credential, signal: job.abort.signal, onProgress: (p) => (job.progress = p) });
      if (result.ok) {
        this.step(job, "push", "done");
        job.state = "done";
        return;
      }
      this.step(job, "push", result.kind === "cancelled" ? "waiting" : "failed");
      job.state = result.kind === "cancelled" ? "cancelled" : "failed";
      const why = result.kind === "failed" ? explainPush(result.own ?? "") : "";
      job.error = {
        step: "push",
        message:
          (result.kind === "cancelled" ? `push をやめました。` : `push できませんでした：${why ? `${why}——` : ""}${result.message}。`) +
          `GitHub にはできています（${where}）。push だけやり直せます`,
      };
    } catch (err) {
      job.state = "failed";
      const at = job.steps.find((s) => s.state === "running")?.key ?? "push";
      this.step(job, at, "failed");
      job.error = { step: at, message: `${(err as Error).message}（GitHub にはできています：${where}）` };
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
