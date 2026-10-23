// 一覧のブランチを origin へ送る・origin から取ってくる（§4.4「push」）。
//
// **まず Repositories に頼む**（中継の `push_branch`・`fetch_branch`）——Backlog は Project のコンテナの中で動き、そこの git
// には資格情報が無い（origin が https だと `could not read Username`）。資格情報（リポジトリごとの GitHub のアカウント）を
// 持つのは banto 本体で動く Repositories で、clone と同じ渡し方で送る。Repositories が無い・引き受けない（台帳に無い・
// アカウントが無い・GitHub の外）ときは、**リポジトリ自身の git の設定のまま**試す。
//
// **Vault の SSH 鍵で送る**（追加・2026-10-14、§4.4、Backlog #296）——別のサーバの Project は Repositories が引き受けず、
// 向こうの git には鍵が無い。設定で鍵（Vault の ssh-identity の alias）を選んであれば、自分の git で試す前に Vault に
// 中継で ssh-agent を立ててもらい、その窓口を `SSH_AUTH_SOCK` にして送る（Shell の sshIdentity と同じ口。秘密鍵は
// Vault の外に出ない）。https の origin には効かないので、鍵を借りずに、送れなかった理由へ ssh の URL にする案内を添える。
//
// 失敗は値で返す——書き込みは止めない。呼ぶ側（店）が「まだ送っていない」と理由を画面と listItems に出す。

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { CALL_ID_META_KEY } from "@banto/module-contract";
import { GIT_TIMEOUTS, runGit } from "./git.js";

export type SyncOutcome =
  /** `absent`——取ってこようとしたら origin にそのブランチがまだ無かった */
  | { ok: true; via: string; absent?: boolean }
  | { ok: false; via: string; message: string };

/** 送る・取ってくる口（店が使う。試験では偽物を渡す） */
export interface BranchRemote {
  push(branch: string, callId?: string): Promise<SyncOutcome>;
  fetch(branch: string, callId?: string): Promise<SyncOutcome>;
}

/** host の中継を1本呼ぶ口。返るのは宛先の返事の文字列。断られたら投げる */
export type RelayCall = (name: string, args: Record<string, unknown>, callId?: string) => Promise<{ text: string; isError: boolean }>;

const REPOSITORIES_ROLE = "repositories";

/** Repositories の `branch_target` の答え（別のサーバの Project の送り先とアカウント） */
type BranchTarget =
  | { remote: false }
  | { remote: true; handled: false; reason?: string; ok?: undefined }
  | { remote: true; handled: true; ok: false; message?: string }
  | { remote: true; repository: string; account: string; pinned: boolean; handled?: undefined; ok?: undefined };
const VAULT_DIRECTORY_ROLE = "vault-directory";

/** git が言ったことの最後の数行（長すぎるものは切る） */
function tail(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !/^hint:/.test(l));
  const joined = lines.slice(-4).join("\n");
  return joined.length > 600 ? `${joined.slice(0, 600)}…` : joined;
}

/** リポジトリ自身の git の設定のまま送る（force しない・upstream は付けない） */
export async function ownPush(root: string, branch: string, env: Record<string, string> = {}): Promise<SyncOutcome> {
  const r = await runGit(root, ["push", "--porcelain", "origin", `refs/heads/${branch}:refs/heads/${branch}`], { timeoutMs: GIT_TIMEOUTS.network, env });
  if (r.ok) return { ok: true, via: "git" };
  const why = /could not read Username|terminal prompts disabled|Authentication failed/i.test(r.stderr)
    ? "このリポジトリの git の設定では資格情報がありません"
    : /\[rejected\]|non-fast-forward|fetch first|behind its remote/i.test(r.stderr)
      ? "origin のブランチが先に進んでいます"
      : "";
  return { ok: false, via: "git", message: `${why ? `${why}——` : ""}${tail(r.stderr)}` };
}

/** リポジトリ自身の git の設定のまま、そのブランチだけを `refs/remotes/origin/<branch>` に取ってくる */
export async function ownFetch(root: string, branch: string, env: Record<string, string> = {}): Promise<SyncOutcome> {
  const r = await runGit(
    root,
    ["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
    { timeoutMs: GIT_TIMEOUTS.network, env },
  );
  if (r.ok) return { ok: true, via: "git" };
  if (/couldn't find remote ref|could not find remote ref/i.test(r.stderr)) return { ok: true, via: "git", absent: true };
  const why = /could not read Username|terminal prompts disabled|Authentication failed/i.test(r.stderr) ? "このリポジトリの git の設定では資格情報がありません" : "";
  return { ok: false, via: "git", message: `${why ? `${why}——` : ""}${tail(r.stderr)}` };
}

/** origin の URL（`git remote get-url`。無い・読めないなら undefined——送る側の失敗の文言に任せる） */
async function originUrl(root: string): Promise<string | undefined> {
  const r = await runGit(root, ["remote", "get-url", "origin"]);
  return r.ok ? r.stdout.trim() : undefined;
}

/**
 * https の origin のとき、送れなかった理由に添える案内（鍵は ssh の URL にしか効かない）。https でなければ undefined。
 * 書き換える先は `git@<host>:<path>`（GitHub なら `git@github.com:<owner>/<name>.git`）
 */
export function httpsOriginHint(url: string, identity: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
  let path = u.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  if (u.hostname === "github.com" && path && !path.endsWith(".git")) path = `${path}.git`;
  const ssh = `git@${u.hostname}:${path || "<owner>/<name>.git"}`;
  return `origin が https なので SSH 鍵 ${identity} は使っていません——origin を ssh の URL（${ssh}）にすると、設定した鍵で送れます`;
}

/** 中継の返事（text）を JSON で読む。宛先が失敗を返したら、その理由で投げる */
async function relayJson<T>(relay: RelayCall, name: string, args: Record<string, unknown>, callId: string | undefined, what: string): Promise<T> {
  const r = await relay(name, args, callId);
  if (r.isError) throw new Error(r.text || `${what}が失敗しました`);
  return JSON.parse(r.text) as T;
}

/** 呼んでよい相手のうち、その役割を名乗る Module の名前（居なければ undefined） */
async function moduleWithRole(relay: RelayCall, role: string, callId: string | undefined): Promise<string | undefined> {
  const targets = await relayJson<Array<{ name: string; roles: string[] }>>(relay, "relayListTargets", {}, callId, "呼べる相手の一覧");
  return targets.find((t) => t.roles.includes(role))?.name;
}

/**
 * その SSH 鍵を持った ssh-agent の窓口（ソケットのパス）。窓口（vault-directory）に在りかを引き、その金庫の
 * `startSshAgent` を呼ぶ——Shell の sshIdentity と同じ口。別のサーバでは、host が転送した向こうのパスが返る
 */
export async function borrowSshAgent(relay: RelayCall, identity: string, callId?: string): Promise<string> {
  const directory = await moduleWithRole(relay, VAULT_DIRECTORY_ROLE, callId);
  if (!directory) throw new Error("Vault の窓口を呼べません（繋がっていません）");
  const place = await relayJson<{ implementation?: unknown; name?: unknown; group?: unknown }>(
    relay,
    "relayCallTool",
    { targetModule: directory, name: "lookupAlias", arguments: { name: identity } },
    callId,
    `${identity} の在りか引き`,
  );
  // 在りかが分からないまま既定の金庫へ落とすと、別の金庫の同名を開けてしまう（規則2）
  if (typeof place.implementation !== "string" || typeof place.name !== "string") throw new Error(`${identity} の在りかが分かりません`);
  const started = await relayJson<{ socketPath?: unknown }>(
    relay,
    "relayCallTool",
    {
      targetModule: place.implementation,
      name: "startSshAgent",
      arguments: { identity: place.name, ...(typeof place.group === "string" ? { group: place.group } : {}) },
    },
    callId,
    `${identity} の ssh-agent`,
  );
  if (typeof started.socketPath !== "string" || started.socketPath === "") throw new Error(`${identity} の ssh-agent の窓口が返ってきませんでした`);
  return started.socketPath;
}

/**
 * Vault の目録（`vault://aliases`、この Project から引けるものだけ。名前はそのまま引ける名前）のうち、kind がそのどれかの
 * もの。読めていない金庫があれば `warning`（一覧が全部ではない）
 */
async function listAliasesOfKinds(relay: RelayCall | undefined, kinds: readonly string[], callId?: string): Promise<{ names: string[]; warning?: string }> {
  if (!relay) throw new Error("Vault への中継が渡されていません");
  const directory = await moduleWithRole(relay, VAULT_DIRECTORY_ROLE, callId);
  if (!directory) throw new Error("Vault の窓口を呼べません（繋がっていません）");
  const read = await relayJson<{ contents?: Array<{ text?: string }> }>(
    relay,
    "relayReadResource",
    { targetModule: directory, uri: "vault://aliases" },
    callId,
    "Vault の目録",
  );
  const body = JSON.parse(read.contents?.[0]?.text ?? "{}") as { aliases?: Array<{ name?: unknown; kind?: unknown }>; warning?: unknown };
  const names = (body.aliases ?? [])
    .filter((a) => typeof a.kind === "string" && kinds.includes(a.kind) && typeof a.name === "string")
    .map((a) => a.name as string);
  return { names, ...(typeof body.warning === "string" ? { warning: body.warning } : {}) };
}

/** 設定で選べる SSH 鍵——Vault の目録のうち kind が ssh-identity のもの */
export function listSshIdentities(relay: RelayCall | undefined, callId?: string): Promise<{ names: string[]; warning?: string }> {
  return listAliasesOfKinds(relay, ["ssh-identity"], callId);
}

/**
 * 設定で選べる Gist のトークン——Vault の目録のうち、文字列を1つ返すもの（`secret`——人が貼った PAT 等・`oauth-token`
 * ——Repositories のブラウザログイン。持ち主でない呼び元には access token の文字列が渡る）
 */
export function listTokenAliases(relay: RelayCall | undefined, callId?: string): Promise<{ names: string[]; warning?: string }> {
  return listAliasesOfKinds(relay, ["secret", "oauth-token"], callId);
}

/**
 * その alias の値（文字列）を引く——窓口（vault-directory）に在りかを引き、その金庫の `resolveAlias` を直接呼ぶ（Shell の
 * envSecrets と同じ口）。コンテナの中からは、alias ごとに初回だけ人に聞かれる（v4-security.md「コンテナの中から値を返す口を呼ぶ」）
 */
export async function resolveSecret(relay: RelayCall | undefined, alias: string, callId?: string): Promise<string> {
  if (!relay) throw new Error("Vault への中継が渡されていません");
  const directory = await moduleWithRole(relay, VAULT_DIRECTORY_ROLE, callId);
  if (!directory) throw new Error("Vault の窓口を呼べません（繋がっていません）");
  const place = await relayJson<{ implementation?: unknown; name?: unknown; group?: unknown }>(
    relay,
    "relayCallTool",
    { targetModule: directory, name: "lookupAlias", arguments: { name: alias } },
    callId,
    `${alias} の在りか引き`,
  );
  // 在りかが分からないまま既定の金庫へ落とすと、別の金庫の同名を開けてしまう（規則2）
  if (typeof place.implementation !== "string" || typeof place.name !== "string") throw new Error(`${alias} の在りかが分かりません`);
  const r = await relay(
    "relayCallTool",
    { targetModule: place.implementation, name: "resolveAlias", arguments: { name: place.name, ...(typeof place.group === "string" ? { group: place.group } : {}) } },
    callId,
  );
  if (r.isError) throw new Error(r.text || `${alias} を引けませんでした`);
  const value = r.text.trim();
  if (value === "") throw new Error(`${alias} の値が空です`);
  return value;
}

/**
 * Repositories（あれば）→ リポジトリ自身の git、の順に試す。Repositories が引き受けて断ったもの（送り先を変える設定が
 * ある等）は、自分では試し直さない——Repositories が見て止めたものを、横から通さない。
 *
 * 自分の git で試すとき、設定に SSH 鍵（`sshIdentity`、毎回読む）があれば Vault から借りる。借りられなければ（中継が
 * 断った等）鍵無しで試し、失敗の理由に借りられなかったことを添える
 */
export class RelayingRemote implements BranchRemote {
  constructor(
    private readonly root: string,
    private readonly relay: RelayCall | undefined,
    private readonly sshIdentity: () => string | undefined = () => undefined,
  ) {}

  push(branch: string, callId?: string): Promise<SyncOutcome> {
    return this.run("push_branch", branch, callId, (env) => ownPush(this.root, branch, env));
  }

  fetch(branch: string, callId?: string): Promise<SyncOutcome> {
    return this.run("fetch_branch", branch, callId, (env) => ownFetch(this.root, branch, env));
  }

  private async run(
    tool: string,
    branch: string,
    callId: string | undefined,
    own: (env: Record<string, string>) => Promise<SyncOutcome>,
  ): Promise<SyncOutcome> {
    const notes: string[] = [];
    if (this.relay) {
      try {
        const target = await moduleWithRole(this.relay, REPOSITORIES_ROLE, callId);
        if (target) {
          // **別のサーバの Project は、先に送り先とアカウントを引いて名乗る**（§2.4「別のサーバの Project」）——名乗った引数が
          // 承認のカードに出る。引き受けない・断ると分かれば、送る口は呼ばない（場所の無いカードを出さない）
          const where = await relayJson<BranchTarget>(this.relay, "relayCallTool", { targetModule: target, name: "branch_target", arguments: {} }, callId, `${target} の branch_target`);
          let decided: { handled: boolean; ok?: boolean; absent?: boolean; message?: string; reason?: string } | undefined;
          if (where.remote && where.handled === false) decided = { handled: false, ...(where.reason ? { reason: where.reason } : {}) };
          else if (where.remote && where.ok === false) decided = { handled: true, ok: false, ...(where.message ? { message: where.message } : {}) };
          else {
            const args = { branch, ...(where.remote ? { repository: where.repository, account: where.account } : {}) };
            const r = await this.relay("relayCallTool", { targetModule: target, name: tool, arguments: args }, callId);
            if (r.isError) throw new Error(r.text || `${target} の ${tool} が失敗しました`);
            decided = JSON.parse(r.text) as typeof decided;
          }
          const answer = decided!;
          if (answer.handled) {
            return answer.ok
              ? { ok: true, via: "repositories", ...(answer.absent ? { absent: true } : {}) }
              : { ok: false, via: "repositories", message: answer.message ?? "Repositories が断りました" };
          }
          notes.push(`Repositories は引き受けませんでした（${answer.reason ?? "理由なし"}）`);
        }
      } catch (err) {
        // 中継が断った（承認されなかった等）・繋がらない——理由を添えて、自分の git で試す
        notes.push(`Repositories に頼めませんでした（${(err as Error).message}）`);
      }
    }
    const env: Record<string, string> = {};
    const identity = this.sshIdentity();
    if (identity) {
      const url = await originUrl(this.root);
      const hint = url ? httpsOriginHint(url, identity) : undefined;
      if (hint) notes.unshift(hint);
      else if (!this.relay) notes.unshift(`SSH 鍵 ${identity} を借りられませんでした（Vault への中継が渡されていません）`);
      else {
        try {
          env.SSH_AUTH_SOCK = await borrowSshAgent(this.relay, identity, callId);
        } catch (err) {
          notes.unshift(`SSH 鍵 ${identity} を借りられませんでした（${(err as Error).message}）`);
        }
      }
    }
    const result = await own(env);
    if (result.ok || notes.length === 0) return result;
    return { ...result, message: `${result.message}${notes.map((n) => `（${n}）`).join("")}` };
  }
}

/**
 * **繋ぎ直すべき失敗か**——接続そのものが壊れたときだけ（追加・2026-10-05、docs/notes/2026-10-05-relay-stale-card.md）。
 * host が返事として返した失敗（中継が断った・宛先が失敗した）は、接続は生きている。以前は何でも繋ぎ直していたので、
 * 1本の書き込みの中継が断られると、**同じ接続で並んで人の承認を待っていた別の書き込みの中継まで切れ**、host にはその
 * 承認のカードだけが残った（答えても届く先が無い）
 */
function connectionBroken(err: unknown): boolean {
  return !(err instanceof McpError) || err.code === ErrorCode.ConnectionClosed;
}

/**
 * host の中継を呼ぶ口。**呼び出しの印（`dev.banto/callId`）を添える**——どの Project・どのターンの仕事かを host が1件ずつ
 * 引き、承認のカードもそのターンに出る。人の承認を待つ間は進捗が来るので、待つ上限を延ばす。接続が壊れたら次は繋ぎ直す
 */
export function hostRelayCall(url: string, token: string): RelayCall {
  let client: Promise<Client> | undefined;
  const connect = () => {
    if (!client) {
      const c = new Client({ name: "banto-module-backlog", version: "0.1.0" });
      client = c
        .connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
        .then(() => c);
    }
    return client;
  };
  return async (name, args, callId) => {
    try {
      const c = await connect();
      const result = await c.callTool(
        { name, arguments: args, ...(callId ? { _meta: { [CALL_ID_META_KEY]: callId } } : {}) },
        undefined,
        { resetTimeoutOnProgress: true, onprogress: () => undefined },
      );
      return { text: (result.content as { type: string; text: string }[])[0]?.text ?? "", isError: result.isError === true };
    } catch (err) {
      if (connectionBroken(err)) {
        const old = client;
        client = undefined;
        void old?.then((c) => c.close()).catch(() => undefined);
      }
      throw err;
    }
  };
}
