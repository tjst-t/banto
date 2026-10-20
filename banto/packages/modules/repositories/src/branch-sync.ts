// **1本のブランチを origin へ送る・origin から取ってくる口**（docs/specs/v4-modules.md §2.4「ブランチを送る口」・§4.4 Backlog）。
//
// Backlog は一覧を専用のブランチ（既定 `backlog`）に積み、変更のたびに origin へ送る。Backlog は Project のコンテナの中で
// 動き、そこの git には資格情報が無い（origin が https だと `could not read Username`）。資格情報を持つのはこの Module
// なので、**送る・取ってくるだけをここで引き受ける**（clone・公開と同じ渡し方——一度きりの窓口か ssh-agent）。
//
// 呼ぶのは中継で、**呼び出し元の Project の根がそのリポジトリであることを host に確かめる**（`relayCallerProject`
// ——どの Project のための呼び出しかは host の台帳が決める。呼び出し元は名乗れない）。コンテナの中では AI が root で、
// 中継の合言葉も読める——だから引数で選べるのはブランチ名だけで、リポジトリは選べない。ブランチごとの承認は
// 中継のゲートが聞く（`branch` を識別子として名乗る——`AUDIT_ARGS_META_KEY`）。
//
// **引き受けないもの**は `handled: false` と理由で返す（台帳に無い・origin が GitHub の外・アカウントが無い）——
// 呼び出し元はそのリポジトリ自身の git の設定のまま試す。引き受けたうえで断ったもの（送り先を変える設定がある等）は
// `handled: true`——呼び出し元は自分で試し直さない。
//
// **別のサーバの Project**（追加・2026-10-20、Backlog #466、§2.4「別のサーバの Project」）：根は向こうのパスで、この機械には
// 無い。**資格情報は向こうへ出さない**——core の口（`ProjectGitAccess`。実行場所の接続の上で、向こうの中のユーザーの git が
// bundle を作る・取り込む）で中身だけを運び、ここの使い捨ての bare リポジトリから、host で決めた GitHub の URL へ送る・取ってくる。
// 送り先は向こうの `remote.origin.url`（申告）から GitHub の場所を読んで決め、アカウントは clone の記録 → 台帳の同じ場所の行 →
// 持ち主と同じ login の順に決める（`accountForRemote`）。**最初に引き受けたときに、場所とアカウントを Project ごとに覚え**
// （`LedgerStore.pinRemoteTarget`）、以降は origin がその場所と違えば断る——中の AI は origin も中継の合言葉も書ける・読めるので、
// origin の書き換えで別のリポジトリ・別のアカウントを選ばせない。頼む側（Backlog）は先に `branch_target` で送り先と
// アカウントを引き、`push_branch`・`fetch_branch` の引数（`repository`・`account`）に載せる——中継のゲートが名乗った引数として
// 承認のカードに出し、承認の鍵にも入れる（違う場所・違うアカウントは聞き直す）。ここはその名乗りが、いま決まる送り先と同じとき
// だけ引き受ける

import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_GIT_BUNDLE_MAX_BYTES, isSafeBranchName, type ProjectGitOrigin } from "@banto/module-contract";
import type { GithubAccounts } from "./accounts.js";
import {
  fetchUrls,
  gitBundleBranch,
  gitFetchBranch,
  gitFetchBundle,
  gitInitBare,
  gitPushBranch,
  gitResolveBranch,
  pushUrls,
  readFolder,
  syncBlockers,
  type CloneResult,
} from "./git.js";
import type { GithubEndpoints } from "./github.js";
import type { LedgerEntry, LedgerStore } from "./ledger.js";
import { gitCredentialFor, githubRemoteUrl } from "./publish.js";
import { parseRemoteUrl, sameGithubLocation, type GithubLocation } from "./remote.js";
import type { ProjectSummary } from "./repositories.js";
import type { VaultAccess } from "./vault.js";

export type BranchSyncResult =
  /** 引き受けない——呼び出し元は自分の git の設定で試す */
  | { handled: false; reason: string }
  /** `absent`——取ってこようとしたら origin にそのブランチがまだ無かった（失敗ではない） */
  | { handled: true; ok: true; message: string; absent?: true }
  | { handled: true; ok: false; message: string };

/**
 * **別のサーバの Project の根の git に、1本のブランチの中身を出し入れする口**（core の中継の `relayProjectGit*`）。どの Project
 * かは host の台帳が呼び出しの印（`callId`）で決める——ここから選べない
 */
export interface ProjectGitAccess {
  origin(callId?: string): Promise<ProjectGitOrigin>;
  /** そのブランチの bundle。向こうにそのブランチが無ければ undefined */
  bundle(branch: string, callId?: string): Promise<Buffer | undefined>;
  /** bundle のそのブランチを、向こうの `refs/remotes/origin/<branch>` に取り込む */
  unbundle(branch: string, bundle: Buffer, callId?: string): Promise<void>;
  /** 向こうの `refs/remotes/origin/<branch>` を、向こうにもうあるコミットに合わせる（送り終えたあと） */
  track(branch: string, commit: string, callId?: string): Promise<void>;
}

export interface BranchSyncDeps {
  store: LedgerStore;
  accounts: GithubAccounts;
  vault: VaultAccess;
  dataDir: string;
  endpoints: GithubEndpoints;
  /** 別のサーバの Project の git に届く口。無ければ別のサーバの Project は引き受けない */
  projectGit?: ProjectGitAccess;
}

/** 別のサーバの Project で、どのアカウントで送るか（決めた理由つき——返事の文言に出す）。`refused` は引き受けて断る */
type RemoteAccount = { login: string; via: string } | { reason: string } | { refused: string };

/** 承認のカードに出す送り先の書き方（`branch_target` が返し、Backlog が `repository` に載せる） */
export function repositoryLabel(at: GithubLocation): string {
  return `github.com/${at.owner}/${at.name}`;
}

/**
 * **別のサーバの Project のブランチを扱うアカウント**（まだ覚えていないとき）。向こうのリポジトリは台帳に無いので、人が決めた
 * ものから順に引く：
 * 1. その Project を core の「clone」のタブで作ったときに選んだアカウント。**clone した場所と origin が違えば断る**——次の段へ
 *    進むと、origin を書き換えるだけで持ち主と同じ login のアカウントが選ばれる
 * 2. 台帳で同じ GitHub の場所を扱うアカウント（この機械に同じリポジトリを置いている。行どうしで違えば決めない）
 * 3. 登録したアカウントのうち、origin の持ち主と同じ login（Import のときと同じ決まり）
 */
export function accountForRemote(
  project: ProjectSummary,
  at: GithubLocation,
  entries: readonly LedgerEntry[],
  logins: readonly string[],
): RemoteAccount {
  const cloned = project.clonedFrom;
  if (cloned) {
    const from = parseRemoteUrl(cloned.url);
    if (from.kind !== "github" || !sameGithubLocation(from, at)) {
      return {
        refused: `この Project は ${from.kind === "github" ? repositoryLabel(from) : cloned.url} から clone しましたが、origin が ${repositoryLabel(at)} になっています——clone した場所でないリポジトリへは、Repositories は送りません`,
      };
    }
    if (cloned.account) return { login: cloned.account, via: "clone したときのアカウント" };
  }
  const inLedger = [...new Set(entries.filter((e) => e.account && sameGithubLocation(e.github, at)).map((e) => e.account!.toLowerCase()))];
  if (inLedger.length > 1) {
    return { reason: `リポジトリの一覧で ${repositoryLabel(at)} を扱うアカウントが1つに決まりません（${inLedger.map((l) => `@${l}`).join("・")}）` };
  }
  if (inLedger.length === 1) {
    const login = entries.find((e) => e.account?.toLowerCase() === inLedger[0])!.account!;
    return { login, via: "リポジトリの一覧のアカウント" };
  }
  const owner = logins.find((l) => l.toLowerCase() === at.owner.toLowerCase());
  if (owner) return { login: owner, via: "持ち主と同じアカウント" };
  return { reason: `${repositoryLabel(at)} を扱うアカウントが決まっていません（clone したときの記録・リポジトリの一覧・持ち主と同じ login のどれも無い）` };
}

/**
 * 別のサーバの Project の送り先の決まり方。`target` は引き受ける（`pinned`——もう覚えている）、`refused` は引き受けて断る、
 * `not-handled` は引き受けない
 */
export type RemoteTargetDecision =
  | { kind: "not-handled"; reason: string }
  | { kind: "refused"; message: string }
  | { kind: "target"; at: GithubLocation; login: string; via: string; pinned: boolean; ssh: boolean };

/** `push_branch`・`fetch_branch` に頼む側が名乗った送り先（`branch_target` で引いたもの） */
export interface ClaimedTarget {
  repository?: string;
  account?: string;
}

/** URL の方式が ssh か（`git@host:o/n`・`ssh://…`） */
function isSshUrl(url: string): boolean {
  return /^(?:ssh:\/\/|[^/:]+@[^/:]+:)/.test(url);
}

/** 送る・取ってくるの失敗を、次の手を選べる言い方に。**相手の言葉（`remote:` の行）は見ない** */
function explain(direction: "push" | "fetch", own: string): string {
  if (/could not read Username|Authentication failed|Invalid username or token|terminal prompts disabled|\b401\b/i.test(own)) {
    return "資格情報が通りませんでした（アカウントのトークンが切れた・権限が無い）";
  }
  if (/\b403\b|permission to .* denied|not allowed to push/i.test(own)) return "このアカウントには書く権限がありません";
  // 「remote contains work」は手元に origin のコミットが無いときの言い方（別のサーバの Project の使い捨ての置き場から送ったとき）
  if (direction === "push" && /\[rejected\]|non-fast-forward|fetch first|stale info|behind its remote|remote contains work/i.test(own)) {
    return "origin のブランチが先に進んでいます（取り込んでから送り直します）";
  }
  return "";
}

/** 別のサーバの Project か（根は向こうのパス） */
export function isRemote(project: ProjectSummary): boolean {
  return project.runtime !== undefined && project.runtime !== "host-container";
}

/** 運べる大きさを越えた */
function tooLarge(branch: string, bytes: number): string {
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${branch} が大きすぎて、別のサーバとの間で運べません（${mb(bytes)}。上限は ${mb(PROJECT_GIT_BUNDLE_MAX_BYTES)}）`;
}

export class BranchSync {
  constructor(private readonly deps: BranchSyncDeps) {}

  /**
   * 呼び出し元の Project の根から、台帳の行を決める。**根の一番上**（根がリポジトリの下のフォルダでも、worktree でも、
   * ref は本体と同じ——本体の行で引く）。引き受けないなら理由
   */
  private async entryFor(project: ProjectSummary): Promise<{ path: string; account?: string } | { reason: string }> {
    const root = project.root.length > 1 ? project.root.replace(/\/+$/, "") : project.root;
    const facts = await readFolder(root);
    let top: string;
    if (facts.kind === "repo") top = facts.path;
    else if (facts.kind === "inside") top = facts.top;
    else if (facts.kind === "worktree") top = facts.main;
    else return { reason: "この Project の根は git のリポジトリではありません" };
    top = await realpath(top).catch(() => top);
    const entry = (await this.deps.store.entries()).find((e) => e.path === top);
    if (!entry) return { reason: "このリポジトリは Repositories の一覧にありません" };
    return { path: top, ...(entry.account ? { account: entry.account } : {}) };
  }

  /**
   * そのブランチを送る（`push`）か取ってくる（`fetch`）。**リポジトリは呼び出し元の Project の根で決まる**
   * ——引数で選べるのはブランチ名だけ
   */
  async sync(
    direction: "push" | "fetch",
    branch: string,
    project: ProjectSummary,
    callId?: string,
    claimed: ClaimedTarget = {},
  ): Promise<BranchSyncResult> {
    if (!isSafeBranchName(branch)) throw new Error(`ブランチ名として受け付けられない形です：${JSON.stringify(branch.slice(0, 80))}`);
    // **別のサーバの Project**——根は向こうのパスで、この機械の同じ文字列のフォルダは別物。core の口で中身だけを運ぶ
    if (isRemote(project)) return this.syncRemote(direction, branch, project, callId, claimed);
    const entry = await this.entryFor(project);
    if ("reason" in entry) return { handled: false, reason: entry.reason };

    // **送り先・取ってくる先を変える設定があれば、どちらもしない**（トークンを別の場所へ渡しうる——公開と同じ線）。
    // origin を読む前に見る——`insteadOf` は origin の読み方そのものを変える
    const blockers = await syncBlockers(entry.path);
    if (blockers.length > 0) {
      return {
        handled: true,
        ok: false,
        message: `リポジトリの設定に、送り先や TLS を変える設定があります（${blockers.join("・")}）——資格情報を別の場所へ送りうるので、Repositories は ${direction} しません`,
      };
    }
    const repo = await readFolder(entry.path);
    if (repo.kind !== "repo") return { handled: false, reason: "台帳のフォルダがリポジトリの一番上ではありません" };
    if (repo.remote.kind === "none") return { handled: false, reason: "origin がありません" };
    if (repo.remote.kind === "elsewhere") return { handled: false, reason: `origin が GitHub の外です（${repo.remote.url}）` };
    if (!entry.account) return { handled: false, reason: "このリポジトリを扱うアカウントが決まっていません（読むだけ）" };
    const account = (await this.deps.accounts.list()).accounts.find((a) => a.login.toLowerCase() === entry.account!.toLowerCase());
    if (!account) return { handled: false, reason: `@${entry.account} は登録が外れています` };
    const t = { path: entry.path, owner: repo.remote.owner, name: repo.remote.name };
    const where = `github.com/${t.owner}/${t.name}`;

    // origin の URL が台帳の GitHub の場所の1つだけで、方式（ssh／https）がアカウントと合っているか
    const urls = direction === "push" ? await pushUrls(t.path) : await fetchUrls(t.path);
    const url = urls.length === 1 ? urls[0]! : undefined;
    const parsed = url ? parseRemoteUrl(url) : undefined;
    const sameRepo =
      parsed?.kind === "github" && parsed.owner.toLowerCase() === t.owner.toLowerCase() && parsed.name.toLowerCase() === t.name.toLowerCase();
    const sameHost = !url || !sameRepo || isSshUrl(url) || new URL(url).host === new URL(this.deps.endpoints.web).host;
    if (!url || !sameRepo || !sameHost) {
      return { handled: true, ok: false, message: `origin の${direction === "push" ? "送り先" : "取ってくる先"}（${urls.join("・") || "無し"}）が ${where} の1つではないので、${direction} しません` };
    }
    if (isSshUrl(url) !== !!account.ssh) {
      return {
        handled: true,
        ok: false,
        message: isSshUrl(url)
          ? `origin は ssh の URL ですが、@${account.login} は SSH 鍵を登録していません`
          : `origin は https の URL ですが、@${account.login} は SSH 鍵で扱うアカウントです`,
      };
    }

    const c = await gitCredentialFor(this.deps, account.login, callId);
    try {
      const result =
        direction === "push"
          ? await gitPushBranch({ path: t.path, branch, credential: c.credential })
          : await gitFetchBranch({ path: t.path, branch, credential: c.credential });
      if (result.ok) {
        return { handled: true, ok: true, message: direction === "push" ? `${branch} を ${where} に送りました（@${account.login}）` : `${where} の ${branch} を取ってきました（@${account.login}）` };
      }
      if (direction === "fetch" && result.kind === "failed" && /couldn't find remote ref|could not find remote ref/i.test(result.own ?? "")) {
        return { handled: true, ok: true, absent: true, message: `${where} にはまだ ${branch} がありません` };
      }
      const why = result.kind === "failed" ? explain(direction, result.own ?? "") : "";
      return { handled: true, ok: false, message: `${direction} できませんでした：${why ? `${why}——` : ""}${result.message}` };
    } finally {
      await c.window?.close().catch(() => undefined);
    }
  }

  /**
   * **別のサーバの Project の送り先とアカウントを決める**（`branch_target` と、送る・取ってくるの両方が通る——決め方を2つ
   * 持たない）。向こうの origin の設定を読み、覚えた送り先があればそれと突き合わせ、無ければ `accountForRemote` で決める
   */
  async remoteTarget(project: ProjectSummary, callId?: string): Promise<RemoteTargetDecision> {
    const git = this.deps.projectGit;
    if (!git) return { kind: "not-handled", reason: "この Repositories は別のサーバの Project の git に届く口を持っていません" };
    // **origin を読めない（向こうに繋がらない等）は引き受けて断る**——頼む側（Backlog）はその向こうで動き、中継も同じ接続の上を
    // 通る。繋がらないなら自前の git の道でも送れないので、そちらへ落とさない（レビュー M2）
    let origin: ProjectGitOrigin;
    try {
      origin = await git.origin(callId);
    } catch (err) {
      return { kind: "refused", message: `この Project のリポジトリの origin を読めませんでした（${(err as Error).message}）——Repositories は送りも取ってきもしません` };
    }
    if (origin.kind === "not-repo") return { kind: "not-handled", reason: "この Project の根は git のリポジトリではありません" };
    if (origin.urls.length === 0) return { kind: "not-handled", reason: "origin がありません" };
    // **送り先を変える設定があれば、どちらもしない**——向こうの git が送る先と、ここが送る先（url の GitHub の場所）が食い違う。
    // どちらが正しいかは決められない（この機械の Project と同じ線。向こうの http.* 等は、ここの git が読まないので見ない）
    if (origin.redirects.length > 0) {
      return {
        kind: "refused",
        message: `リポジトリの設定に、送り先を変える設定があります（${origin.redirects.join("・")}）——どこへ送る・どこから取ってくるのが正しいか決められないので、Repositories は送りも取ってきもしません`,
      };
    }
    if (origin.urls.length !== 1) return { kind: "refused", message: `origin の URL が1つではない（${origin.urls.join("・")}）ので、Repositories は送りも取ってきもしません` };
    const at = parseRemoteUrl(origin.urls[0]!);
    const pinned = (await this.deps.store.remoteTargets()).get(project.id);
    if (pinned) {
      // **覚えた送り先と違えば断る**——次の段（台帳・持ち主と同じ login）へは進まない
      if (at.kind !== "github" || !sameGithubLocation(at, pinned.github)) {
        return {
          kind: "refused",
          message:
            `この Project の Backlog の送り先は ${repositoryLabel(pinned.github)}（@${pinned.account}）に決めてあります（${pinned.at.slice(0, 10)}）が、` +
            `origin が ${at.kind === "github" ? repositoryLabel(at) : origin.urls[0]} になっているので、Repositories は送りも取ってきもしません——origin を戻してください`,
        };
      }
    }
    if (at.kind !== "github") return { kind: "not-handled", reason: `origin が GitHub の外です（${origin.urls[0]}）` };
    const registered = (await this.deps.accounts.list()).accounts;
    let chosen: { login: string; via: string };
    if (pinned) chosen = { login: pinned.account, via: pinned.via };
    else {
      const decided = accountForRemote(project, at, await this.deps.store.entries(), registered.map((a) => a.login));
      if ("refused" in decided) return { kind: "refused", message: decided.refused };
      if ("reason" in decided) return { kind: "not-handled", reason: decided.reason };
      chosen = decided;
    }
    const account = registered.find((a) => a.login.toLowerCase() === chosen.login.toLowerCase());
    if (!account) return { kind: "not-handled", reason: `@${chosen.login}（${chosen.via}）は登録が外れています` };
    return { kind: "target", at, login: account.login, via: chosen.via, pinned: !!pinned, ssh: !!account.ssh };
  }

  /**
   * **別のサーバの Project**（v4-modules.md §2.4「別のサーバの Project」）。送り先とアカウントを決め、頼む側の名乗り
   * （`repository`・`account`——承認のカードに出たもの）と同じときだけ、使い捨ての bare リポジトリを通して運ぶ。最初に引き受けた
   * ときに送り先を覚える
   */
  private async syncRemote(
    direction: "push" | "fetch",
    branch: string,
    project: ProjectSummary,
    callId: string | undefined,
    claimed: ClaimedTarget,
  ): Promise<BranchSyncResult> {
    const decided = await this.remoteTarget(project, callId);
    if (decided.kind === "not-handled") return { handled: false, reason: decided.reason };
    if (decided.kind === "refused") return { handled: true, ok: false, message: decided.message };
    const { at } = decided;
    const where = repositoryLabel(at);
    // **名乗りが、いま決まる送り先と同じときだけ**——人が承認のカードで見たのは名乗りのほう
    if (claimed.repository === undefined || claimed.account === undefined) {
      return { handled: true, ok: false, message: `送り先とアカウントを名乗っていない呼び出しです（${where}・@${decided.login}）——branch_target で引いて、repository と account に載せてください` };
    }
    if (claimed.repository.toLowerCase() !== where.toLowerCase() || claimed.account.toLowerCase() !== decided.login.toLowerCase()) {
      return {
        handled: true,
        ok: false,
        message: `名乗った送り先（${claimed.repository}・@${claimed.account}）が、いま決まる送り先（${where}・@${decided.login}）と違うので、Repositories は ${direction} しません`,
      };
    }
    let via = decided.via;
    if (!decided.pinned) {
      const kept = await this.deps.store.pinRemoteTarget(project.id, {
        github: { owner: at.owner, name: at.name },
        account: decided.login,
        via: decided.via,
        at: new Date().toISOString(),
      });
      // 同時に別の呼び出しが先に覚えていた——そちらと違えば断る
      if (!sameGithubLocation(kept.github, at) || kept.account.toLowerCase() !== decided.login.toLowerCase()) {
        return { handled: true, ok: false, message: `この Project の送り先は、いま ${repositoryLabel(kept.github)}（@${kept.account}）に決まりました——${where}・@${decided.login} へは送りません` };
      }
      via = `${decided.via}。この Project の送り先として覚えました`;
    }
    const git = this.deps.projectGit!;
    const account = { login: decided.login, ssh: decided.ssh };
    // 送り先は host で組む（方式はアカウントに合わせる——向こうの URL の方式は見ない。トークンは GitHub の host にしか渡らない）
    const url = githubRemoteUrl(this.deps.endpoints, account.ssh, at.owner, at.name);
    const by = `@${account.login}、${via}`;

    // **送り先とアカウントが決まったあとの失敗は、すべて引き受けて断る**（`handled: true`。レビュー M2）——投げると頼む側
    // （Backlog）は自分の git（SSH 鍵の道）で送り直そうとし、上限を越えた・壊れた bundle を別の道で通すことになる
    try {
      return await this.carry(direction, branch, { git, at, where, url, by, login: account.login }, callId);
    } catch (err) {
      return { handled: true, ok: false, message: `${direction} できませんでした：${(err as Error).message}` };
    }
  }

  /** 使い捨ての bare リポジトリを通して運ぶ（送り先とアカウントは決まったもの） */
  private async carry(
    direction: "push" | "fetch",
    branch: string,
    t: { git: ProjectGitAccess; at: GithubLocation; where: string; url: string; by: string; login: string },
    callId: string | undefined,
  ): Promise<BranchSyncResult> {
    const { git, where, url, by } = t;
    const parent = join(this.deps.dataDir, "branch-sync");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const work = await mkdtemp(join(parent, "w-"));
    const repo = join(work, "repo.git");
    const file = join(work, "branch.bundle");
    try {
      await mkdir(repo, { mode: 0o700 });
      await gitInitBare(repo);
      if (direction === "push") {
        const bundle = await git.bundle(branch, callId);
        if (!bundle) return { handled: true, ok: false, message: `この Project のリポジトリに ${branch} がありません` };
        if (bundle.length > PROJECT_GIT_BUNDLE_MAX_BYTES) return { handled: true, ok: false, message: tooLarge(branch, bundle.length) };
        await writeFile(file, bundle, { mode: 0o600 });
        await gitFetchBundle(repo, file, branch);
      }
      const c = await gitCredentialFor(this.deps, t.login, callId);
      let result: CloneResult;
      try {
        result =
          direction === "push"
            ? await gitPushBranch({ path: repo, branch, credential: c.credential, remote: url })
            : await gitFetchBranch({ path: repo, branch, credential: c.credential, remote: url });
      } finally {
        await c.window?.close().catch(() => undefined);
      }
      if (!result.ok) {
        if (direction === "fetch" && result.kind === "failed" && /couldn't find remote ref|could not find remote ref/i.test(result.own ?? "")) {
          return { handled: true, ok: true, absent: true, message: `${where} にはまだ ${branch} がありません` };
        }
        const why = result.kind === "failed" ? explain(direction, result.own ?? "") : "";
        return { handled: true, ok: false, message: `${direction} できませんでした：${why ? `${why}——` : ""}${result.message}` };
      }
      if (direction === "push") {
        // 向こうの追跡の ref も進める（この機械のリポジトリの `git push origin` と同じ——Backlog はこれで「まだ送っていない」を数える）。
        // 進められなくても送れたことは変わらない——投げると、頼んだ側が自分の git で送り直そうとする。理由を添えて返す（次に取って
        // くれば揃う）
        const sent = `${branch} を ${where} に送りました（${by}）`;
        try {
          await git.track(branch, await gitResolveBranch(repo, branch), callId);
        } catch (err) {
          return { handled: true, ok: true, message: `${sent}——ただし、この Project のリポジトリの origin/${branch} を進められませんでした（${(err as Error).message}）` };
        }
        return { handled: true, ok: true, message: sent };
      }
      await gitBundleBranch(repo, file, branch);
      const size = (await stat(file)).size;
      if (size > PROJECT_GIT_BUNDLE_MAX_BYTES) return { handled: true, ok: false, message: tooLarge(branch, size) };
      await git.unbundle(branch, await readFile(file), callId);
      return { handled: true, ok: true, message: `${where} の ${branch} を取ってきました（${by}）` };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}
