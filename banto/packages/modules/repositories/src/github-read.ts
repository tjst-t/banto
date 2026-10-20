// **読むだけの GitHub の tool**（追加・2026-10-20、Backlog #424。アーキ仕様 §4.4「土台：読むだけの印」の最後の項）。
//
// 見回り（読むだけの回）が外の出来事（Issue・PR・CI）を見るための道具。AI に見せる（可視性 `agent`）唯一の tool で、
// 同梱の Module として `dev.banto/effect: "read"` を名乗る。読むだけの3つの条件をここで守る：
//
// 1. **環境を変えない**——GitHub へは GET だけ。ログインの取り直しと Vault への書き戻しは、この Module が自分の資格情報を
//    使える形に保つ仕事で、環境を変えるものに数えない（§4.4 の「写しを追いつかせる」と同じ扱い）
// 2. **宛先を AI が選べない**——リポジトリは呼んだ Project の根で決まる（host に聞く。台帳の行の GitHub の場所と、フォルダの
//    origin が同じものだけ）。引数は状態・番号・件数だけで、決めた欄の外（owner・repo・URL・検索語）は受けずに断る。
//    宛先はそのリポジトリの GitHub の API の決まった場所だけ
// 3. **秘密を返さない**——トークンは GitHub への見出しにだけ使い、返事には入れない
//
// 返すのは決めた欄だけ（人・本文・ラベル・状態・時刻）。本文は外の人が書いた文なので長さを切る（中身は見回りが読む）。

import type { GithubAccounts } from "./accounts.js";
import { ledgerEntryFor } from "./branch-sync.js";
import { readFolder } from "./git.js";
import { GithubError, type GithubApi } from "./github.js";
import type { LedgerStore } from "./ledger.js";
import { sameGithubLocation, type GithubLocation } from "./remote.js";
import type { ProjectSummary } from "./repositories.js";

/** 本文・コメントの長さの上限（字）。超えたら切って `truncated` を立てる */
export const BODY_LIMIT = 4000;
/** 一覧の件数の既定と上限 */
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;
/** 1件の中身に添えるコメントの数 */
const COMMENT_LIMIT = 20;

const STATES = ["open", "closed", "all"] as const;
/** GitHub Actions の実行の状態（`GET /actions/runs` の `status` に渡せるもののうち、見回りに要るもの） */
const RUN_STATUSES = ["queued", "in_progress", "completed", "success", "failure", "cancelled"] as const;

const limitSchema = { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: `件数（既定 ${DEFAULT_LIMIT}、最大 ${MAX_LIMIT}）` };
const stateSchema = { type: "string", enum: [...STATES], description: "状態（既定 open）" };
const numberSchema = { type: "integer", minimum: 1 };

/** 読むだけの tool の定義（可視性と印は server.ts が付ける）。引数は決めた欄だけ */
export const GITHUB_READ_TOOLS = [
  {
    name: "listIssues",
    description: "この Project のリポジトリの GitHub の Issue の一覧（PR は含めない。新しく更新されたものから）",
    properties: { state: stateSchema, limit: limitSchema },
    required: [] as string[],
  },
  {
    name: "getIssue",
    description: "この Project のリポジトリの GitHub の Issue 1件の中身とコメント",
    properties: { number: numberSchema },
    required: ["number"],
  },
  {
    name: "listPullRequests",
    description: "この Project のリポジトリの GitHub の PR の一覧（新しく更新されたものから）",
    properties: { state: stateSchema, limit: limitSchema },
    required: [] as string[],
  },
  {
    name: "getPullRequest",
    description: "この Project のリポジトリの GitHub の PR 1件の中身・コメント・その head の CI（GitHub Actions）の実行",
    properties: { number: numberSchema },
    required: ["number"],
  },
  {
    name: "listCiRuns",
    description: "この Project のリポジトリの GitHub Actions の実行の一覧（新しいものから）",
    properties: { status: { type: "string", enum: [...RUN_STATUSES], description: "状態・結論で絞る" }, limit: limitSchema },
    required: [] as string[],
  },
  {
    name: "getCiRun",
    description: "この Project のリポジトリの GitHub Actions の実行1件と、その job・step の結果",
    properties: { runId: numberSchema },
    required: ["runId"],
  },
] as const;

export type GithubReadToolName = (typeof GITHUB_READ_TOOLS)[number]["name"];

export function isGithubReadTool(name: string): name is GithubReadToolName {
  return GITHUB_READ_TOOLS.some((t) => t.name === name);
}

export interface GithubReadDeps {
  store: LedgerStore;
  accounts: GithubAccounts;
  github: GithubApi;
}

type Raw = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const login = (v: unknown): string | undefined => str((v as Raw | null | undefined)?.login);

function text(v: unknown): { body: string; truncated?: true } {
  const s = str(v) ?? "";
  return s.length > BODY_LIMIT ? { body: s.slice(0, BODY_LIMIT), truncated: true } : { body: s };
}

function labels(v: unknown): string[] {
  return Array.isArray(v) ? v.map((l) => (typeof l === "string" ? l : str((l as Raw | null)?.name))).filter((l): l is string => !!l) : [];
}

function list(v: unknown, what: string): Raw[] {
  if (!Array.isArray(v)) throw new GithubError(`GitHub の ${what} の返事の形が違います（配列ではありません）`, "malformed");
  return v.filter((x): x is Raw => typeof x === "object" && x !== null);
}

function obj(v: unknown, what: string): Raw {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new GithubError(`GitHub の ${what} の返事の形が違います`, "malformed");
  return v as Raw;
}

function issueSummary(i: Raw) {
  return {
    number: num(i.number),
    title: str(i.title) ?? "",
    state: str(i.state),
    author: login(i.user),
    labels: labels(i.labels),
    comments: num(i.comments),
    createdAt: str(i.created_at),
    updatedAt: str(i.updated_at),
    ...(str(i.closed_at) ? { closedAt: str(i.closed_at) } : {}),
    url: str(i.html_url),
  };
}

function pullSummary(p: Raw) {
  return {
    number: num(p.number),
    title: str(p.title) ?? "",
    state: str(p.state),
    draft: p.draft === true,
    merged: typeof p.merged_at === "string",
    author: login(p.user),
    labels: labels(p.labels),
    head: str((p.head as Raw | undefined)?.ref),
    base: str((p.base as Raw | undefined)?.ref),
    createdAt: str(p.created_at),
    updatedAt: str(p.updated_at),
    url: str(p.html_url),
  };
}

function runSummary(r: Raw) {
  return {
    id: num(r.id),
    name: str(r.name) ?? str(r.display_title) ?? "",
    title: str(r.display_title),
    event: str(r.event),
    status: str(r.status),
    conclusion: str(r.conclusion) ?? null,
    branch: str(r.head_branch),
    headSha: str(r.head_sha),
    runNumber: num(r.run_number),
    attempt: num(r.run_attempt),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    url: str(r.html_url),
  };
}

function commentOf(c: Raw) {
  return { author: login(c.user), createdAt: str(c.created_at), ...text(c.body) };
}

/** 引数を決めた欄だけに絞る。**欄の外が来たら断る**——黙って捨てると、AI は別のリポジトリを読めたと思い込む */
function parseArgs(tool: GithubReadToolName, args: Record<string, unknown>) {
  const def = GITHUB_READ_TOOLS.find((t) => t.name === tool)!;
  const allowed = Object.keys(def.properties);
  const extra = Object.keys(args).filter((k) => !allowed.includes(k));
  if (extra.length > 0) {
    throw new Error(
      `${tool} が受けるのは ${allowed.join("・")} だけです（${extra.join("・")} は受けません）。読めるのは、この Project のリポジトリだけで、リポジトリ・URL・検索語は選べません`,
    );
  }
  const positive = (key: string): number => {
    const v = args[key];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) throw new Error(`${key} は1以上の整数で指定してください`);
    return v;
  };
  const limit = (): number => {
    if (args.limit === undefined) return DEFAULT_LIMIT;
    const v = positive("limit");
    if (v > MAX_LIMIT) throw new Error(`limit は ${MAX_LIMIT} までです`);
    return v;
  };
  const oneOf = <T extends string>(key: string, values: readonly T[], fallback: T | undefined): T | undefined => {
    const v = args[key];
    if (v === undefined) return fallback;
    if (typeof v !== "string" || !(values as readonly string[]).includes(v)) throw new Error(`${key} は ${values.join("・")} のどれかです`);
    return v as T;
  };
  return { positive, limit, oneOf };
}

export class GithubRead {
  constructor(private readonly deps: GithubReadDeps) {}

  /**
   * 呼び出し元の Project のリポジトリと、読むのに使うトークン。**台帳の行の GitHub の場所と、フォルダの origin が同じもの
   * だけ**——コンテナの中から origin を書き換えて、別のリポジトリをこのアカウントで読ませることはできない（食い違えば断る）
   */
  private async target(project: ProjectSummary, callId?: string): Promise<{ where: GithubLocation; token?: string; account?: string }> {
    // 別のサーバの Project の根は向こうのパスで、この機械の同じ文字列のフォルダは別物（ブランチを送る口と同じ線）
    if (project.runtime !== undefined && project.runtime !== "host-container") {
      throw new Error("この Project は別のサーバで動いています（Repositories の一覧のリポジトリと結びつけられません）");
    }
    const entry = await ledgerEntryFor(this.deps.store, project);
    if ("reason" in entry) throw new Error(`${entry.reason}（GitHub を読めるのは、Repositories の一覧にあるリポジトリを根にした Project だけです）`);
    if (!entry.github) throw new Error("このリポジトリは GitHub にありません（Repositories の一覧の origin が GitHub の外か、ありません）");
    const facts = await readFolder(entry.path);
    if (facts.kind !== "repo") throw new Error("台帳のフォルダがリポジトリの一番上ではありません");
    if (facts.remote.kind !== "github" || !sameGithubLocation(facts.remote, entry.github)) {
      const now = facts.remote.kind === "github" ? `github.com/${facts.remote.owner}/${facts.remote.name}` : facts.remote.kind === "elsewhere" ? facts.remote.url : "無し";
      throw new Error(
        `フォルダの origin（${now}）が Repositories の一覧の github.com/${entry.github.owner}/${entry.github.name} と違うので読みません（Repositories の一覧を開くと origin に合わせて直します）`,
      );
    }
    if (!entry.account) return { where: entry.github };
    const account = (await this.deps.accounts.list()).accounts.find((a) => a.login.toLowerCase() === entry.account!.toLowerCase());
    if (!account) throw new Error(`このリポジトリを扱うアカウント @${entry.account} は登録が外れています（Repositories の設定で登録し直してください）`);
    let token: string;
    try {
      token = await this.deps.accounts.tokenFor(account.login, callId);
    } catch (err) {
      throw new Error(`@${account.login} の GitHub の資格情報を使えませんでした：${(err as Error).message}`);
    }
    return { where: entry.github, token, account: account.login };
  }

  /** 読むだけの tool を1本処理する。返すのは決めた欄だけの JSON */
  async call(tool: GithubReadToolName, args: Record<string, unknown>, project: ProjectSummary, callId?: string): Promise<Record<string, unknown>> {
    // 引数を先に確かめる——形の違う呼び出しで、Vault の値を引きに行かない
    const a = parseArgs(tool, args);
    const req = (() => {
      switch (tool) {
        case "listIssues":
        case "listPullRequests":
          return { state: a.oneOf("state", STATES, "open")!, limit: a.limit() };
        case "getIssue":
        case "getPullRequest":
          return { number: a.positive("number") };
        case "listCiRuns":
          return { status: a.oneOf("status", RUN_STATUSES, undefined), limit: a.limit() };
        case "getCiRun":
          return { runId: a.positive("runId") };
      }
    })() as { state?: string; limit?: number; number?: number; status?: string; runId?: number };

    const { where, token, account } = await this.target(project, callId);
    const get = (path: string, query?: Record<string, string>) => this.deps.github.repoGet(token, where.owner, where.name, path, query);
    const repository = `${where.owner}/${where.name}`;
    /** 見えないものの断りを、次の手が分かる言い方に。`what` が無ければリポジトリそのもの */
    const notFound = (err: unknown, what?: string): never => {
      if (err instanceof GithubError && err.code === "not-found") {
        const subject = what ? `github.com/${repository} の ${what}` : `github.com/${repository}`;
        throw new Error(
          token
            ? `${subject} が見つかりません（無いか、@${account} からは見えません）`
            : `${subject} が見つかりません（無いか、非公開です——Repositories でこのリポジトリを扱うアカウントを選ぶと読めます）`,
        );
      }
      throw err;
    };

    switch (tool) {
      case "listIssues": {
        // Issue の一覧の口は PR も返す——PR を除く（件数が limit より少なくなりうる）
        const raw = list(await get("/issues", { state: req.state!, per_page: String(req.limit), sort: "updated", direction: "desc" }).catch((e) => notFound(e)), "Issue");
        return { repository, state: req.state, issues: raw.filter((i) => i.pull_request === undefined).map(issueSummary) };
      }
      case "getIssue": {
        const issue = obj(await get(`/issues/${req.number}`).catch((e) => notFound(e, `Issue #${req.number}`)), "Issue");
        if (issue.pull_request !== undefined) throw new Error(`#${req.number} は PR です（getPullRequest で読んでください）`);
        const comments = list(await get(`/issues/${req.number}/comments`, { per_page: String(COMMENT_LIMIT) }), "コメント");
        return { repository, issue: { ...issueSummary(issue), ...text(issue.body) }, comments: comments.map(commentOf) };
      }
      case "listPullRequests": {
        const raw = list(await get("/pulls", { state: req.state!, per_page: String(req.limit), sort: "updated", direction: "desc" }).catch((e) => notFound(e)), "PR");
        return { repository, state: req.state, pullRequests: raw.map(pullSummary) };
      }
      case "getPullRequest": {
        const pull = obj(await get(`/pulls/${req.number}`).catch((e) => notFound(e, `PR #${req.number}`)), "PR");
        const comments = list(await get(`/issues/${req.number}/comments`, { per_page: String(COMMENT_LIMIT) }), "コメント");
        // CI は head の commit の実行（sha は GitHub の返事から取る——AI の引数ではない）
        const sha = str((pull.head as Raw | undefined)?.sha);
        const runs = sha && /^[0-9a-f]{40}$/i.test(sha) ? list(obj(await get("/actions/runs", { head_sha: sha, per_page: String(DEFAULT_LIMIT) }), "CI").workflow_runs, "CI") : [];
        return {
          repository,
          pullRequest: { ...pullSummary(pull), headSha: sha, mergeable: pull.mergeable ?? null, ...text(pull.body) },
          comments: comments.map(commentOf),
          ci: runs.map(runSummary),
        };
      }
      case "listCiRuns": {
        const body = obj(await get("/actions/runs", { per_page: String(req.limit), ...(req.status ? { status: req.status } : {}) }).catch((e) => notFound(e)), "CI");
        return { repository, ...(req.status ? { status: req.status } : {}), runs: list(body.workflow_runs, "CI").map(runSummary) };
      }
      case "getCiRun": {
        const run = obj(await get(`/actions/runs/${req.runId}`).catch((e) => notFound(e, `CI の実行 ${req.runId}`)), "CI");
        const jobs = list(obj(await get(`/actions/runs/${req.runId}/jobs`, { per_page: String(MAX_LIMIT) }), "job").jobs, "job");
        return {
          repository,
          run: runSummary(run),
          jobs: jobs.map((j) => ({
            name: str(j.name) ?? "",
            status: str(j.status),
            conclusion: str(j.conclusion) ?? null,
            startedAt: str(j.started_at),
            completedAt: str(j.completed_at),
            steps: (Array.isArray(j.steps) ? (j.steps as Raw[]) : []).map((s) => ({ name: str(s.name) ?? "", status: str(s.status), conclusion: str(s.conclusion) ?? null })),
          })),
        };
      }
    }
  }
}
