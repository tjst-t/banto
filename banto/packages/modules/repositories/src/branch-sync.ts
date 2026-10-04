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

import { realpath } from "node:fs/promises";
import type { GithubAccounts } from "./accounts.js";
import { fetchUrls, gitFetchBranch, gitPushBranch, isSafeBranchName, pushUrls, readFolder, syncBlockers } from "./git.js";
import type { GithubEndpoints } from "./github.js";
import type { LedgerStore } from "./ledger.js";
import { gitCredentialFor } from "./publish.js";
import { parseRemoteUrl } from "./remote.js";
import type { ProjectSummary } from "./repositories.js";
import type { VaultAccess } from "./vault.js";

export type BranchSyncResult =
  /** 引き受けない——呼び出し元は自分の git の設定で試す */
  | { handled: false; reason: string }
  /** `absent`——取ってこようとしたら origin にそのブランチがまだ無かった（失敗ではない） */
  | { handled: true; ok: true; message: string; absent?: true }
  | { handled: true; ok: false; message: string };

export interface BranchSyncDeps {
  store: LedgerStore;
  accounts: GithubAccounts;
  vault: VaultAccess;
  dataDir: string;
  endpoints: GithubEndpoints;
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
  if (direction === "push" && /\[rejected\]|non-fast-forward|fetch first|stale info|behind its remote/i.test(own)) {
    return "origin のブランチが先に進んでいます（取り込んでから送り直します）";
  }
  return "";
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
  async sync(direction: "push" | "fetch", branch: string, project: ProjectSummary, callId?: string): Promise<BranchSyncResult> {
    if (!isSafeBranchName(branch)) throw new Error(`ブランチ名として受け付けられない形です：${JSON.stringify(branch.slice(0, 80))}`);
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
}
