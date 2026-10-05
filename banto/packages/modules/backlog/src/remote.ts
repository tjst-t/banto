// 一覧のブランチを origin へ送る・origin から取ってくる（§4.4「push」）。
//
// **まず Repositories に頼む**（中継の `push_branch`・`fetch_branch`）——Backlog は Project のコンテナの中で動き、そこの git
// には資格情報が無い（origin が https だと `could not read Username`）。資格情報（リポジトリごとの GitHub のアカウント）を
// 持つのは banto 本体で動く Repositories で、clone と同じ渡し方で送る。Repositories が無い・引き受けない（台帳に無い・
// アカウントが無い・GitHub の外）ときは、**リポジトリ自身の git の設定のまま**試す。
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

/** git が言ったことの最後の数行（長すぎるものは切る） */
function tail(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !/^hint:/.test(l));
  const joined = lines.slice(-4).join("\n");
  return joined.length > 600 ? `${joined.slice(0, 600)}…` : joined;
}

/** リポジトリ自身の git の設定のまま送る（force しない・upstream は付けない） */
export async function ownPush(root: string, branch: string): Promise<SyncOutcome> {
  const r = await runGit(root, ["push", "--porcelain", "origin", `refs/heads/${branch}:refs/heads/${branch}`], { timeoutMs: GIT_TIMEOUTS.network });
  if (r.ok) return { ok: true, via: "git" };
  const why = /could not read Username|terminal prompts disabled|Authentication failed/i.test(r.stderr)
    ? "このリポジトリの git の設定では資格情報がありません"
    : /\[rejected\]|non-fast-forward|fetch first|behind its remote/i.test(r.stderr)
      ? "origin のブランチが先に進んでいます"
      : "";
  return { ok: false, via: "git", message: `${why ? `${why}——` : ""}${tail(r.stderr)}` };
}

/** リポジトリ自身の git の設定のまま、そのブランチだけを `refs/remotes/origin/<branch>` に取ってくる */
export async function ownFetch(root: string, branch: string): Promise<SyncOutcome> {
  const r = await runGit(
    root,
    ["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
    { timeoutMs: GIT_TIMEOUTS.network },
  );
  if (r.ok) return { ok: true, via: "git" };
  if (/couldn't find remote ref|could not find remote ref/i.test(r.stderr)) return { ok: true, via: "git", absent: true };
  const why = /could not read Username|terminal prompts disabled|Authentication failed/i.test(r.stderr) ? "このリポジトリの git の設定では資格情報がありません" : "";
  return { ok: false, via: "git", message: `${why ? `${why}——` : ""}${tail(r.stderr)}` };
}

/**
 * Repositories（あれば）→ リポジトリ自身の git、の順に試す。Repositories が引き受けて断ったもの（送り先を変える設定が
 * ある等）は、自分では試し直さない——Repositories が見て止めたものを、横から通さない
 */
export class RelayingRemote implements BranchRemote {
  constructor(
    private readonly root: string,
    private readonly relay: RelayCall | undefined,
  ) {}

  push(branch: string, callId?: string): Promise<SyncOutcome> {
    return this.run("push_branch", branch, callId, () => ownPush(this.root, branch));
  }

  fetch(branch: string, callId?: string): Promise<SyncOutcome> {
    return this.run("fetch_branch", branch, callId, () => ownFetch(this.root, branch));
  }

  private async run(tool: string, branch: string, callId: string | undefined, own: () => Promise<SyncOutcome>): Promise<SyncOutcome> {
    let note = "";
    if (this.relay) {
      try {
        const target = await this.repositoriesModule(callId);
        if (target) {
          const r = await this.relay("relayCallTool", { targetModule: target, name: tool, arguments: { branch } }, callId);
          if (r.isError) throw new Error(r.text || `${target} の ${tool} が失敗しました`);
          const answer = JSON.parse(r.text) as { handled: boolean; ok?: boolean; absent?: boolean; message?: string; reason?: string };
          if (answer.handled) {
            return answer.ok
              ? { ok: true, via: "repositories", ...(answer.absent ? { absent: true } : {}) }
              : { ok: false, via: "repositories", message: answer.message ?? "Repositories が断りました" };
          }
          note = `Repositories は引き受けませんでした（${answer.reason ?? "理由なし"}）`;
        }
      } catch (err) {
        // 中継が断った（承認されなかった等）・繋がらない——理由を添えて、自分の git で試す
        note = `Repositories に頼めませんでした（${(err as Error).message}）`;
      }
    }
    const result = await own();
    if (result.ok || !note) return result;
    return { ...result, message: `${result.message}（${note}）` };
  }

  /** Repositories 役割の Module の名前（呼んでよい相手の中に無ければ undefined） */
  private async repositoriesModule(callId: string | undefined): Promise<string | undefined> {
    const listed = await this.relay!("relayListTargets", {}, callId);
    if (listed.isError) throw new Error(listed.text || "中継が相手の一覧を返しませんでした");
    const targets = JSON.parse(listed.text) as Array<{ name: string; roles: string[] }>;
    return targets.find((t) => t.roles.includes(REPOSITORIES_ROLE))?.name;
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
