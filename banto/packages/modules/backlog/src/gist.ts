// 一覧を GitHub Gist（非公開）に置く店（§4.4「Gist の置き場」。2本目のバックエンド、Backlog #535）。
//
// 形（`banto-backlog/1`）・検証・1件1コミット・書く操作の1本の列は、一覧のブランチの店（`store.ts`）と同じ。違うのは置き場だけ：
// - **正本は Gist**——Gist はそれ自体が小さな git のリポジトリ（`https://gist.github.com/<id>.git`）。手元には Module の置き場
//   （`BANTO_MODULE_DATA_DIR/gists/<id>.git`、bare）に**取ってきた写し**を持つだけで、作業ツリーも index も無い
// - **楽観ロックは Gist の git への push**——読んだときの Gist のコミットを親にしたコミットを、force せずに送る。先を越されて
//   いれば git が fast-forward でないと断る（＝compare-and-swap）ので、取ってきて読み直してやり直す。REST の PATCH には
//   「この版のままなら」という条件つきの書き方が無く、読んでから書くまでの間の書き込みを消してしまうので使わない
// - **書けたら終わり**——送るのが書き込みそのもの。「まだ送っていない」は無い。取ってこれない・書けないなら書かずに理由を言う
// - 取ってくるのは**書く前・画面を開いたとき・この Module が起きて最初に読むとき**だけ（ブランチの店と同じく、毎回の読み直しでは
//   取ってこない——画面の3秒ごとの読み直しで GitHub を叩かない）
// - 資格情報は Vault の alias（設定の `gistToken`）から、中継で**使うたびに**引く（覚えない——ログインのトークンは期限が切れる）
// - Gist にほかのファイル（README 等）があれば残す。tasks.json が無ければ一覧は空で、最初の書き込みで作る
//
// Gist を新しく作るのは REST API（`POST /gists`、`public: false`）——git では作れないため。

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { GIT_TIMEOUTS, TASKS_FILE, commitTasksKeeping, gitFailure, readTasksBlob, resolveRef, runGit, swapRef, type GitResult } from "./git.js";
import {
  BacklogError,
  emptyDocument,
  parseDocument,
  serializeDocument,
  validateDocument,
  type BacklogDocument,
  type Change,
} from "./model.js";
import { SWAP_ATTEMPTS, type BacklogBackend, type GistPlace, type MutateResult, type Snapshot, type SyncState } from "./store.js";

/** 資格情報を渡す環境変数（git の credential helper が読む）。`GIT_` で始めない——runGit が落とす */
const TOKEN_ENV = "BANTO_GIST_TOKEN";

/** Gist には origin が無い——送り残しは起きないので、ブランチの店の「origin との様子」はいつも空 */
const NO_SYNC: SyncState = { origin: false, ahead: 0, behind: 0, diverged: false };

/**
 * Gist の id として受け付けるか。id（16進数）か、Gist の URL（`https://gist.github.com/<owner>/<id>`・`….git`）から id を取る。
 * コマンドの引数と URL に入れるので、16進数以外は断る
 */
export function checkGistId(raw: string): string {
  let text = raw.trim();
  if (text === "") throw new BacklogError("Gist の id が空です");
  if (/^https?:\/\//i.test(text)) {
    let u: URL;
    try {
      u = new URL(text);
    } catch {
      throw new BacklogError("Gist の URL として読めません");
    }
    if (u.hostname !== "gist.github.com") throw new BacklogError("Gist の URL は gist.github.com のものだけ受け付けます");
    text = u.pathname.split("/").filter(Boolean).pop() ?? "";
  }
  text = text.replace(/\.git$/, "");
  if (!/^[0-9a-f]{20,64}$/i.test(text)) throw new BacklogError("Gist の id は16進数です（URL の最後の部分）");
  return text.toLowerCase();
}

export function gistPlace(id: string): GistPlace {
  return { id, url: `https://gist.github.com/${id}` };
}

export interface GistStoreDeps {
  /** 取ってきた写しの置き場（Module の置き場。Project の中ではない） */
  dataDir: string;
  gistId: string;
  /** 資格情報（GitHub のトークン）。使うたびに呼ぶ。引けなければ理由つきで投げる */
  token: (callId?: string) => Promise<string>;
  /** Gist の git の URL。**試験で差し替える穴**（既定は `https://gist.github.com/<id>.git`） */
  remoteUrl?: string;
}

/** 送る・取ってくる git に資格情報を渡す——このリポジトリの外の credential helper は使わない */
export function credentialArgs(): string[] {
  return [
    "-c",
    "credential.helper=",
    "-c",
    `credential.helper=!f() { test "$1" = get && printf 'username=x-access-token\\npassword=%s\\n' "$${TOKEN_ENV}"; }; f`,
  ];
}

/** git が言ったことの最後の数行（長すぎるものは切る） */
function tail(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !/^hint:/.test(l));
  const joined = lines.slice(-4).join("\n");
  return joined.length > 600 ? `${joined.slice(0, 600)}…` : joined;
}

/** 資格情報が通らなかったときに添える案内 */
function explain(stderr: string): string {
  if (/could not read Username|terminal prompts disabled|Authentication failed|403|401|Permission to .* denied/i.test(stderr)) {
    return "資格情報が通りません（トークンに Gist の権限——classic は gist、fine-grained は Gists の Read and write——があるか）——";
  }
  if (/not found|Repository not found|does not appear to be a git repository/i.test(stderr)) {
    return "Gist が見つかりません（id か、トークンの持ち主から見えるか）——";
  }
  return "";
}

/** 先を越された（fast-forward でない・ref を取り合った）断り——取ってきてやり直す */
function lostRace(r: Extract<GitResult, { ok: false }>): boolean {
  return /\[rejected\]|non-fast-forward|fetch first|cannot lock ref|failed to update ref|failed to lock/i.test(r.stderr);
}

export class GistStore implements BacklogBackend {
  private queue: Promise<unknown> = Promise.resolve();
  /** Gist の git のブランチ（`HEAD` の指す先）。最初に取ってくるときに聞く */
  private branch?: string;
  private fetchedOnce = false;
  private lastFetchError?: string;
  private readonly repo: string;
  private readonly url: string;
  private readonly place: GistPlace;

  constructor(private readonly deps: GistStoreDeps) {
    this.place = gistPlace(deps.gistId);
    this.repo = join(deps.dataDir, "gists", `${deps.gistId}.git`);
    this.url = deps.remoteUrl ?? `https://gist.github.com/${deps.gistId}.git`;
  }

  private get tracking(): string | undefined {
    return this.branch ? `refs/remotes/gist/${this.branch}` : undefined;
  }

  private async ensureRepo(): Promise<void> {
    if (existsSync(join(this.repo, "HEAD"))) return;
    mkdirSync(this.repo, { recursive: true });
    const r = await runGit(this.repo, ["init", "-q", "--bare"]);
    if (!r.ok) throw gitFailure("Gist の写しの置き場を作れません", r);
  }

  /** 資格情報つきで Gist と話す */
  private async remote(args: string[], callId: string | undefined): Promise<GitResult> {
    let token: string;
    try {
      token = await this.deps.token(callId);
    } catch (err) {
      return { ok: false, code: "token", stderr: `トークンを引けません（${(err as Error).message}）` };
    }
    return runGit(this.repo, [...credentialArgs(), ...args], { timeoutMs: GIT_TIMEOUTS.network, env: { [TOKEN_ENV]: token } });
  }

  /** Gist から取ってくる。失敗は値で返す（理由は人に読める形） */
  private async fetchNow(callId: string | undefined): Promise<{ ok: true } | { ok: false; message: string }> {
    await this.ensureRepo();
    this.fetchedOnce = true;
    if (!this.branch) {
      const listed = await this.remote(["ls-remote", "--symref", this.url, "HEAD"], callId);
      if (!listed.ok) return { ok: false, message: `${explain(listed.stderr)}${tail(listed.stderr)}` };
      const m = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(listed.stdout);
      if (!m) return { ok: false, message: "Gist にコミットがありません" };
      this.branch = m[1]!;
    }
    const r = await this.remote(["fetch", "--no-tags", "--no-write-fetch-head", this.url, `+refs/heads/${this.branch}:${this.tracking!}`], callId);
    if (!r.ok) return { ok: false, message: `${explain(r.stderr)}${tail(r.stderr)}` };
    return { ok: true };
  }

  async refresh(callId?: string): Promise<void> {
    const r = await this.fetchNow(callId);
    this.lastFetchError = r.ok ? undefined : r.message;
  }

  /** 手元の写しを読む（取ってこない）。`head` は Gist のコミット——tasks.json が無くても在る */
  private async readLocal(): Promise<{ snapshot: Snapshot; head?: string }> {
    const head = this.tracking ? await resolveRef(this.repo, this.tracking) : undefined;
    const notice = this.lastFetchError;
    const version = createHash("sha256").update(JSON.stringify([head ?? "missing", notice ?? ""])).digest("hex").slice(0, 16);
    const base = { branch: this.branch ?? "", version, sync: NO_SYNC, gist: this.place };
    if (!head) {
      const why = `Gist ${this.place.id} を読めません：${notice ?? "まだ取ってきていません"}`;
      return { snapshot: { ...base, state: "missing", unavailable: why } };
    }
    // 取ってこれなかったが写しはある——写しを出し、取ってこれなかったことを上に添える
    const stale = notice ? { sync: { ...NO_SYNC, fetchError: notice } } : {};
    const text = await readTasksBlob(this.repo, head);
    if (text === undefined) return { snapshot: { ...base, ...stale, state: "missing" }, head };
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      const reason = `JSON として読めません（${err instanceof Error ? err.message : String(err)}）`;
      return { snapshot: { ...base, ...stale, state: "refused", head, legacy: false, reason }, head };
    }
    const parsed = parseDocument(raw);
    if (!parsed.ok) return { snapshot: { ...base, ...stale, state: "refused", head, legacy: parsed.legacy, reason: parsed.reason }, head };
    return { snapshot: { ...base, ...stale, state: "ok", head, doc: parsed.doc, problems: validateDocument(parsed.doc) }, head };
  }

  /** いまの一覧（手元の写し）。この Module が起きてまだ一度も取ってきていなければ、先に取ってくる */
  async read(): Promise<Snapshot> {
    await this.ensureRepo();
    if (!this.fetchedOnce) await this.refresh();
    return (await this.readLocal()).snapshot;
  }

  mutate<T>(change: (doc: BacklogDocument) => Change<T>, message: (result: T) => string, callId?: string): Promise<MutateResult<T>> {
    const run = this.queue.then(() => this.mutateNow(change, message, callId));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async mutateNow<T>(
    change: (doc: BacklogDocument) => Change<T>,
    message: (result: T) => string,
    callId: string | undefined,
  ): Promise<MutateResult<T>> {
    let lastWhy = "";
    for (let attempt = 0; attempt < SWAP_ATTEMPTS; attempt += 1) {
      // **書く前に必ず取ってくる**——土台は Gist のいまの版。取ってこれなければ書かない（古い写しの上に書くと必ず断られる）
      const fetched = await this.fetchNow(callId);
      this.lastFetchError = fetched.ok ? undefined : fetched.message;
      if (!fetched.ok) throw new BacklogError(`Gist ${this.place.id} から取ってこれないので、書き込みません：${fetched.message}`);
      const { snapshot, head } = await this.readLocal();
      if (!head) throw new BacklogError(`Gist ${this.place.id} を読めないので、書き込みません`);
      if (snapshot.state === "refused") {
        throw new BacklogError(`Gist ${this.place.id} の ${TASKS_FILE} は読めない形なので、書き込みません：${snapshot.reason}`);
      }
      const before = snapshot.state === "ok" ? snapshot.doc : emptyDocument();
      const known = new Set(snapshot.state === "ok" ? snapshot.problems : []);
      const next = change(before);
      const added = validateDocument(next.doc).filter((p) => !known.has(p));
      if (added.length > 0) throw new BacklogError(`変えられません：${added.join("／")}`);
      const summary = message(next.result);
      const commit = await commitTasksKeeping(this.repo, serializeDocument(next.doc), head, summary);
      // **送るのが compare-and-swap**——force しない。Gist が読んだときの版から進んでいれば git が断る
      const pushed = await this.remote(["push", this.url, `${commit}:refs/heads/${this.branch!}`], callId);
      if (pushed.ok) {
        // 写しを書いたものに合わせる（先に取ってきたもので進んでいても構わない——次に書く前に取ってくる）
        await swapRef(this.repo, this.tracking!, commit, head, summary);
        return {
          result: next.result,
          doc: next.doc,
          before,
          branch: this.branch!,
          created: snapshot.state === "missing",
          commit,
          gist: this.place,
        };
      }
      if (!lostRace(pushed)) throw new BacklogError(`Gist ${this.place.id} に書けませんでした：${explain(pushed.stderr)}${tail(pushed.stderr)}`);
      lastWhy = tail(pushed.stderr);
    }
    throw new BacklogError(`ほかの書き込みに ${SWAP_ATTEMPTS} 回続けて先を越されたので、Gist ${this.place.id} に書けませんでした（${lastWhy}）`);
  }
}

/** GitHub の REST API（Gist を作る）。**試験で差し替える穴** */
export interface GistApi {
  base: string;
  fetch: typeof fetch;
}

export const GITHUB_API: GistApi = { base: "https://api.github.com", fetch: (input, init) => fetch(input, init) };

/**
 * 非公開の Gist を新しく作る（中は空の一覧の tasks.json 1つ）。作った Gist の場所を返す。GitHub が断ったら理由つきで投げる
 */
export async function createGist(token: string, description: string, api: GistApi = GITHUB_API): Promise<GistPlace> {
  let res: Response;
  try {
    res = await api.fetch(`${api.base}/gists`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
      },
      body: JSON.stringify({ description, public: false, files: { [TASKS_FILE]: { content: serializeDocument(emptyDocument()) } } }),
    });
  } catch (err) {
    throw new BacklogError(`GitHub に繋がりませんでした：${(err as Error).message}`);
  }
  const body = (await res.json().catch(() => ({}))) as { id?: unknown; public?: unknown; message?: unknown };
  if (!res.ok) {
    const why = typeof body.message === "string" ? body.message : `HTTP ${res.status}`;
    const hint =
      res.status === 401 || res.status === 403 || res.status === 404
        ? "（トークンに Gist を作る権限——classic は gist、fine-grained は Gists の Read and write——があるか）"
        : "";
    throw new BacklogError(`GitHub が Gist を作りませんでした：${why}${hint}`);
  }
  if (typeof body.id !== "string") throw new BacklogError("GitHub の返事に Gist の id がありません");
  // 頼んだのと違って公開で作られたなら、使わない（人に知らせる——非公開のつもりで書かない）
  if (body.public !== false) throw new BacklogError(`Gist ${body.id} が公開で作られました。使いません——GitHub で確かめてください`);
  return gistPlace(checkGistId(body.id));
}
