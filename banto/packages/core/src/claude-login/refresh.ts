// **本体の Claude ログインを、中継が取り直す**（決定・2026-10-16、ユーザー。`docs/specs/v4-security.md` §2
// 「中継も、切れかけたら取り直す」）。
//
// 以前は中継は取り直さず、access token が切れてから本体の会話（Runner）が次に動くまでの間、コンテナからの呼び出しが
// 全部 401 になっていた。取り直すのは本体の Claude Code と**同じ手順・同じ鍵**——回る refresh token を二者が同時に
// 使うと片方の鍵が死ぬ・CLI の書き込みと重なると新しい refresh token が消えるので、CLI と同じ鍵を取り、鍵の中で
// 読み直し、書き戻すときは CLI の書き込み用の鍵の中で「投げた refresh token（か空）がまだ置き場にあるときだけ」書く
// （先を越されたら相手の結果を採る）。手順は CLI 2.1.281 の中身を読んで確かめた（`Rd`・`wbo`・`HAr`・`aie`・`fBn`・
// `BM`・`vOr`）。確かめた版と違う CLI が同梱されていたら取り直さない（`VERIFIED_AGENT_SDK_VERSION`）。

import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/** CLI の本番の取り直しの口（`TOKEN_URL`） */
export const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
/** Claude Code の公開の client id（置き場に `clientId` が無いときに CLI が使うもの） */
export const CLAUDE_CODE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/**
 * **この手順を確かめた Agent SDK の版**（同梱の CLI 2.1.281）。SDK を上げたら CLI の取り直しの手順・鍵・保存先が
 * 変わっていないか確かめ直してからここを上げる（単体テストが同梱の版と比べて落ちる）
 */
export const VERIFIED_AGENT_SDK_VERSION = "0.3.281";
/** 切れる何ミリ秒前から取り直すか（CLI の `BM` と同じ 5 分） */
export const REFRESH_MARGIN_MS = 5 * 60_000;
/**
 * **401 で線を見ずに取り直すのは、この間隔に1回まで**——取り直した直後のトークンでも 401 が続く（期限切れ以外の
 * 理由）とき、要求のたびに refresh token を回さない
 */
const FORCED_REFRESH_MIN_INTERVAL_MS = 5 * 60_000;
const TOKEN_TIMEOUT_MS = 30_000;
/** claude.ai のログインの印になる scope（CLI の `_N`）。これも契約の種類も無いものは取り直さない */
const CLAUDE_AI_SCOPE = "user:inference";

/** 鍵の決まり：proper-lockfile と同じ形（mkdir で取る・持っている間は更新時刻を進める・古いものは外す） */
interface LockSpec {
  stale: number;
  update: number;
  /** 取れなかったときの取り直し（回数と待ち） */
  retries: number;
  delay: () => number;
}

export interface OauthFields {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  clientId?: string;
  subscriptionType?: string;
  rateLimitTier?: string;
  refreshTokenExpiresAt?: number;
  [k: string]: unknown;
}

/**
 * 人に知らせたカードを、いつ自動で閉じてよいか。`authorized`＝上流が通ったら。`refresh-token-changed`＝置き場の
 * refresh token が替わったら（人がログインし直した・次の取り直しが成功した）——ログインが壊れたままなのに、手元の
 * access token でたまたま通っただけでは閉じない
 */
export type CloseWhen = "authorized" | "refresh-token-changed";

export type RefreshOutcome =
  /** 取り直す必要が無かった・取り直さないもの */
  | { kind: "fresh"; accessToken: string }
  /** 自分で取り直して書き戻した */
  | { kind: "refreshed"; accessToken: string }
  /** 相手（CLI・ほかの banto）が取り直していたので、それを使う */
  | { kind: "adopted"; accessToken: string }
  /**
   * 取り直せなかった。`needsHuman`＝人が直すしかない（refresh token が無効・置き場が読めない・書き戻せなかった）——
   * `closeWhen` で閉じ方を添える。そうでなければ一時的（通信の失敗・5xx・429・鍵の取り合い）で、`accessToken` が
   * あればそれで流してよい
   */
  | { kind: "failed"; reason: string; needsHuman: boolean; closeWhen?: CloseWhen; accessToken?: string };

export class CredentialsError extends Error {
  override name = "CredentialsError";
}

export interface CredentialRefresherDeps {
  credentialsPath: string;
  tokenUrl?: string;
  /** 取り直すか（切れば今までどおり読むだけ）。既定はする */
  enabled?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  /** 鍵が取れなかったときの待ち（試験で縮める） */
  lockRetryDelayMs?: () => number;
  log?: (message: string) => void;
}

/** 置き場を丸ごと読む（ほかの鍵——MCP のログイン等——も書き戻すときに残すため） */
export async function readCredentialsFile(path: string): Promise<{ whole: Record<string, unknown>; oauth: OauthFields | undefined }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new CredentialsError(`banto 本体が Claude にログインしていません（${path} がありません）`);
  }
  let whole: unknown;
  try {
    whole = JSON.parse(raw);
  } catch {
    throw new CredentialsError(`banto 本体の Claude ログインの置き場が読めません（${path} が JSON ではありません）`);
  }
  if (typeof whole !== "object" || whole === null) throw new CredentialsError(`banto 本体の Claude ログインの置き場が壊れています（${path}）`);
  const oauth = (whole as { claudeAiOauth?: unknown }).claudeAiOauth;
  return { whole: whole as Record<string, unknown>, oauth: typeof oauth === "object" && oauth !== null ? (oauth as OauthFields) : undefined };
}

/** 5 分を切っているか（CLI の `BM`）。`expiresAt` が無いものは切れない扱い */
export function needsRefresh(oauth: OauthFields, now: number): boolean {
  return typeof oauth.expiresAt === "number" && now + REFRESH_MARGIN_MS >= oauth.expiresAt;
}

/** claude.ai のログインとして取り直せるものか（CLI の `not_refreshable` の裏） */
function refreshable(oauth: OauthFields): boolean {
  return (Array.isArray(oauth.scopes) && oauth.scopes.includes(CLAUDE_AI_SCOPE)) || typeof oauth.subscriptionType === "string";
}

interface HeldLock {
  release(): Promise<void>;
  /** 持っている間に、ほかの者に外された・更新時刻が書き換えられた（proper-lockfile の compromised） */
  isCompromised(): boolean;
  signal: AbortSignal;
}

/**
 * **鍵を1つ取る**（proper-lockfile 互換）：`mkdir` で作れたら自分のもの。あれば更新時刻を見て、`stale` より古ければ
 * 持ち主が死んだとみなして外し作り直す。持っている間は `update` ごとに更新時刻を進め、外されていたり自分が書いた
 * 時刻と違っていたら「奪われた」にする
 */
async function acquireLock(lockPath: string, spec: LockSpec): Promise<HeldLock | "busy"> {
  for (let attempt = 0; attempt <= spec.retries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, spec.delay()));
    const got = await tryMkdirLock(lockPath, spec);
    if (got !== "busy") return got;
  }
  return "busy";
}

async function tryMkdirLock(lockPath: string, spec: LockSpec): Promise<HeldLock | "busy"> {
  for (let i = 0; i < 2; i++) {
    try {
      await mkdir(lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let mtimeMs: number;
      try {
        mtimeMs = (await stat(lockPath)).mtimeMs;
      } catch (statErr) {
        if ((statErr as NodeJS.ErrnoException).code === "ENOENT") continue; // ちょうど外れた
        throw statErr;
      }
      if (Date.now() - mtimeMs <= spec.stale) return "busy";
      await rmdir(lockPath).catch((rmErr: NodeJS.ErrnoException) => {
        if (rmErr.code !== "ENOENT") throw rmErr;
      });
      continue;
    }
    return holdLock(lockPath, spec);
  }
  return "busy";
}

async function holdLock(lockPath: string, spec: LockSpec): Promise<HeldLock> {
  const abort = new AbortController();
  let compromised = false;
  let released = false;
  let lastSet = (await stat(lockPath)).mtimeMs;
  const markCompromised = () => {
    compromised = true;
    abort.abort(new Error("取り直しの鍵がほかの者に外されました"));
  };
  const timer = setInterval(() => {
    void (async () => {
      if (released || compromised) return;
      try {
        // 自分が最後に書いた時刻のままか（ファイルシステムの丸めを見込んで 1 秒まで許す）
        const now = (await stat(lockPath)).mtimeMs;
        if (Math.abs(now - lastSet) > 1000) return markCompromised();
        const t = new Date();
        await utimes(lockPath, t, t);
        lastSet = (await stat(lockPath)).mtimeMs;
      } catch {
        if (!released) markCompromised();
      }
    })();
  }, spec.update);
  timer.unref();
  return {
    isCompromised: () => compromised,
    signal: abort.signal,
    release: async () => {
      released = true;
      clearInterval(timer);
      // 奪われていたら相手のものなので外さない
      if (!compromised) await rmdir(lockPath).catch(() => {});
    },
  };
}

export class CredentialRefresher {
  private readonly tokenUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly enabled: boolean;
  /** 同じ banto の中で同時に来た要求は、1回の取り直しを待ち合わせる */
  private inFlight: Promise<RefreshOutcome> | undefined;
  /** 最後に 401 で線を見ずに取り直した時刻 */
  private lastForcedAt: number | undefined;
  private warnedSymlink = false;
  private cleanedTmp = false;

  constructor(private readonly deps: CredentialRefresherDeps) {
    this.tokenUrl = deps.tokenUrl ?? CLAUDE_TOKEN_URL;
    this.fetchFn = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((m) => console.warn(`[claude-login] ${m}`));
    this.enabled = deps.enabled ?? true;
  }

  private get dir(): string {
    return dirname(this.deps.credentialsPath);
  }

  /**
   * **使えるトークンを返す**。5 分を切っていれば（`force` なら線を見ずに）取り直す。`seenAccessToken`＝上流に
   * 断られたトークン——置き場のものがそれと違えば、もう誰かが取り直したのでそれを使う
   */
  async ensureFresh(opts: { force?: boolean; seenAccessToken?: string } = {}): Promise<RefreshOutcome> {
    if (!this.cleanedTmp) {
      this.cleanedTmp = true;
      await this.cleanLeftovers();
    }
    let first: OauthFields | undefined;
    try {
      first = (await readCredentialsFile(this.deps.credentialsPath)).oauth;
    } catch (err) {
      return { kind: "failed", reason: (err as Error).message, needsHuman: true, closeWhen: "authorized" };
    }
    if (!first?.accessToken) {
      return { kind: "failed", reason: `banto 本体の Claude ログインにトークンがありません（${this.deps.credentialsPath}）`, needsHuman: true, closeWhen: "authorized" };
    }
    if (opts.seenAccessToken !== undefined && first.accessToken !== opts.seenAccessToken) {
      return { kind: "adopted", accessToken: first.accessToken };
    }
    if (!opts.force && !needsRefresh(first, this.now())) return { kind: "fresh", accessToken: first.accessToken };
    if (!this.enabled || !(await this.mayRewrite())) return { kind: "fresh", accessToken: first.accessToken };
    if (!first.refreshToken || !refreshable(first)) {
      return opts.force
        ? { kind: "failed", reason: "本体の Claude ログインは取り直せる形ではありません（refresh token か claude.ai の scope がありません）", needsHuman: true, closeWhen: "refresh-token-changed", accessToken: first.accessToken }
        : { kind: "fresh", accessToken: first.accessToken };
    }
    if (typeof first.refreshTokenExpiresAt === "number" && this.now() >= first.refreshTokenExpiresAt) {
      return { kind: "failed", reason: "本体の Claude ログインの refresh token の期限が切れています", needsHuman: true, closeWhen: "refresh-token-changed", accessToken: first.accessToken };
    }
    if (opts.force) {
      if (this.lastForcedAt !== undefined && this.now() - this.lastForcedAt < FORCED_REFRESH_MIN_INTERVAL_MS) {
        return { kind: "failed", reason: "取り直した直後のトークンでも断られました（401）", needsHuman: true, closeWhen: "authorized", accessToken: first.accessToken };
      }
    }
    if (!this.inFlight) {
      const force = opts.force === true;
      if (force) this.lastForcedAt = this.now();
      this.inFlight = this.refreshLocked(first.accessToken, force).finally(() => {
        this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  /** 置き場が symlink なら書き換えない（rename で symlink が普通のファイルに替わり、指す先が古いまま残る） */
  private async mayRewrite(): Promise<boolean> {
    try {
      if ((await lstat(this.deps.credentialsPath)).isSymbolicLink()) {
        if (!this.warnedSymlink) this.log(`${this.deps.credentialsPath} が symlink なので、中継は取り直しません`);
        this.warnedSymlink = true;
        return false;
      }
    } catch {
      return false;
    }
    return true;
  }

  /** 落ちて残った書きかけ（中身は秘密）を消す */
  private async cleanLeftovers(): Promise<void> {
    const prefix = `${basename(this.deps.credentialsPath)}.banto-`;
    const names = await readdir(this.dir).catch(() => [] as string[]);
    for (const n of names) if (n.startsWith(prefix) && n.endsWith(".tmp")) await rm(join(this.dir, n), { force: true }).catch(() => {});
  }

  private oauthLockSpec(): LockSpec {
    return { stale: 60_000, update: 5_000, retries: 5, delay: () => this.deps.lockRetryDelayMs?.() ?? 1000 + Math.random() * 1000 };
  }

  private async refreshLocked(entryAccessToken: string, force: boolean): Promise<RefreshOutcome> {
    const dir = this.dir;
    const spec = this.oauthLockSpec();
    // 古い版の CLI の鍵：`${realpath(設定フォルダ)}.lock`（CLI の `wbo`。realpath が失敗したらそのままの道）
    const legacyPath = `${await realpath(dir).catch(() => dir)}.lock`;
    let held: HeldLock | undefined;
    let legacy: HeldLock | undefined;
    for (let i = 0; i <= spec.retries && !held; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, spec.delay()));
      let got: HeldLock | "busy";
      try {
        got = await tryMkdirLock(join(dir, ".oauth_refresh.lock"), spec);
      } catch (err) {
        return { kind: "failed", reason: `取り直しの鍵を取れませんでした：${(err as Error).message}`, needsHuman: false, accessToken: entryAccessToken };
      }
      if (got === "busy") continue;
      // 古い鍵が取られていたら新しい鍵も放して取り合い中にする。ほかの理由で取れないだけなら新しい鍵だけで進める
      let legacyGot: HeldLock | "busy" | undefined;
      try {
        legacyGot = await tryMkdirLock(legacyPath, spec);
      } catch {
        legacyGot = undefined;
      }
      if (legacyGot === "busy") {
        await got.release();
        continue;
      }
      held = got;
      legacy = legacyGot;
    }
    if (!held) {
      // 相手が取り直している。今のトークンで流す（相手が書けば次の読みで拾う）
      const current = await readCredentialsFile(this.deps.credentialsPath).then((c) => c.oauth?.accessToken, () => undefined);
      if (current && current !== entryAccessToken) return { kind: "adopted", accessToken: current };
      return { kind: "failed", reason: "ほかのプロセスが取り直している最中で、鍵が空きませんでした", needsHuman: false, accessToken: current ?? entryAccessToken };
    }
    try {
      return await this.refreshHoldingLock(entryAccessToken, force, held);
    } finally {
      await legacy?.release();
      await held.release();
    }
  }

  private async refreshHoldingLock(entryAccessToken: string, force: boolean, lock: HeldLock): Promise<RefreshOutcome> {
    let current: OauthFields | undefined;
    try {
      current = (await readCredentialsFile(this.deps.credentialsPath)).oauth;
    } catch (err) {
      return { kind: "failed", reason: (err as Error).message, needsHuman: true, closeWhen: "authorized" };
    }
    if (!current?.accessToken || !current.refreshToken) {
      return { kind: "failed", reason: "本体の Claude ログインに refresh token が無く、取り直せません", needsHuman: true, closeWhen: "refresh-token-changed", ...(current?.accessToken ? { accessToken: current.accessToken } : {}) };
    }
    // 鍵の中で読み直す：替わっていれば相手が取り直した
    if (current.accessToken !== entryAccessToken) return { kind: "adopted", accessToken: current.accessToken };
    if (!force && !needsRefresh(current, this.now())) return { kind: "fresh", accessToken: current.accessToken };
    // 投げる前に、鍵がまだ自分のものか（奪われていたら相手が同じ refresh token を投げているかもしれない）
    if (lock.isCompromised()) {
      return { kind: "failed", reason: "取り直しの鍵がほかの者に外されたので、取り直しをやめました", needsHuman: false, accessToken: current.accessToken };
    }

    const postedRefreshToken = current.refreshToken;
    const body: Record<string, unknown> = {
      grant_type: "refresh_token",
      refresh_token: postedRefreshToken,
      client_id: current.clientId ?? CLAUDE_CODE_CLIENT_ID,
    };
    if (Array.isArray(current.scopes) && current.scopes.length > 0) body.scope = current.scopes.join(" ");
    let res: Response;
    try {
      res = await this.fetchFn(this.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        // 鍵を奪われたら投げている途中でも切る（CLI と同じ）
        signal: AbortSignal.any([AbortSignal.timeout(TOKEN_TIMEOUT_MS), lock.signal]),
      });
    } catch (err) {
      return { kind: "failed", reason: `取り直しの口に届きませんでした：${(err as Error).message}`, needsHuman: false, accessToken: current.accessToken };
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      const code = oauthErrorCode(text);
      // 人の手が要るのは refresh token が死んでいると分かるときだけ（CLI の `lie`：400/401 の invalid_grant）。
      // 429・408・5xx・invalid_scope 等は一時的として扱う
      const dead = (res.status === 400 || res.status === 401) && code === "invalid_grant";
      return {
        kind: "failed",
        reason: dead
          ? `本体の Claude ログインの refresh token が無効になっています（${res.status} ${code}）`
          : `取り直しが断られました（${res.status}${code ? ` ${code}` : ""}）`,
        needsHuman: dead,
        ...(dead ? { closeWhen: "refresh-token-changed" as const } : {}),
        accessToken: current.accessToken,
      };
    }
    let data: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown; refresh_token_expires_in?: unknown };
    try {
      data = JSON.parse(text) as typeof data;
    } catch {
      return { kind: "failed", reason: "取り直しの返事が JSON ではありません", needsHuman: false, accessToken: current.accessToken };
    }
    const scopes = typeof data.scope === "string" && data.scope.trim() !== "" ? data.scope.trim().split(/\s+/) : undefined;
    if (typeof data.access_token !== "string" || typeof data.expires_in !== "number" || (scopes && !scopes.includes(CLAUDE_AI_SCOPE))) {
      // 欄が足りない・claude.ai の scope が無い返事は書かない（CLI も書かない）。新しい refresh token を投げ捨てることに
      // なるかもしれないので、人に知らせる
      this.log("取り直しの返事が足りないので書き戻しませんでした（access token・期限・claude.ai の scope のどれかが無い）");
      return { kind: "failed", reason: "取り直しの返事が足りず、書き戻しませんでした", needsHuman: true, closeWhen: "refresh-token-changed", accessToken: current.accessToken };
    }
    const now = this.now();
    const fresh: OauthFields = {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === "string" && data.refresh_token !== "" ? data.refresh_token : postedRefreshToken,
      expiresAt: now + data.expires_in * 1000,
      ...(scopes ? { scopes } : {}),
      ...(typeof data.refresh_token_expires_in === "number" ? { refreshTokenExpiresAt: now + data.refresh_token_expires_in * 1000 } : {}),
    };
    return this.writeBack(postedRefreshToken, fresh);
  }

  /**
   * **書き戻す（compare-and-swap）**：CLI の書き込み用の鍵（`.storage-write`、CLI の `vOr`）の中で置き場をもう一度読み、
   * refresh token が投げたもの（か空）のままのときだけ書く。ほかの欄・ほかの鍵はそのまま。同じフォルダの別名に 0600 で
   * 書いて rename で置き換える。書けないときも**新しいトークンは捨てず**、0600 の退避ファイルに残す
   */
  private async writeBack(postedRefreshToken: string, fresh: OauthFields): Promise<RefreshOutcome> {
    const path = this.deps.credentialsPath;
    // proper-lockfile の既定の道（`<対象>.lock`）。CLI は stale 15 秒・取れなければ 10 回まで 0.1〜1 秒置く
    const storageLock = await acquireLock(join(this.dir, ".storage-write.lock"), {
      stale: 15_000,
      update: 7_500,
      retries: 10,
      delay: () => this.deps.lockRetryDelayMs?.() ?? 100 + Math.random() * 900,
    }).catch((err: unknown) => err as Error);
    if (storageLock === "busy" || storageLock instanceof Error) {
      const why = storageLock === "busy" ? "CLI の書き込み用の鍵が空きませんでした" : storageLock.message;
      return this.rescue(fresh, `取り直したトークンを書き戻せませんでした（${why}）`);
    }
    try {
      let lastErr = "";
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 100 * attempt));
        let whole: Record<string, unknown>;
        let oauth: OauthFields | undefined;
        try {
          ({ whole, oauth } = await readCredentialsFile(path));
        } catch (err) {
          lastErr = (err as Error).message;
          continue;
        }
        if (!oauth || (oauth.refreshToken !== postedRefreshToken && oauth.refreshToken !== "")) {
          // 先を越された——相手の書いたものを採る（自分の取り直した分は捨てる。CLI の adopted_sibling と同じ）
          if (oauth?.accessToken) return { kind: "adopted", accessToken: oauth.accessToken };
          return { kind: "failed", reason: "取り直している間に本体のログインが消えました", needsHuman: true, closeWhen: "refresh-token-changed" };
        }
        const next = { ...whole, claudeAiOauth: { ...oauth, ...fresh } };
        const tmp = join(this.dir, `${basename(path)}.banto-${randomBytes(6).toString("hex")}.tmp`);
        try {
          await writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
          await chmod(tmp, 0o600);
          await rename(tmp, path);
          return { kind: "refreshed", accessToken: fresh.accessToken! };
        } catch (err) {
          await rm(tmp, { force: true }).catch(() => {});
          lastErr = (err as Error).message;
        }
      }
      return this.rescue(fresh, `取り直したトークンを書き戻せませんでした（${lastErr}）`);
    } finally {
      await storageLock.release();
    }
  }

  /** 書き戻せなかった新しいトークンを 0600 の退避ファイルに残す（人が戻せるように） */
  private async rescue(fresh: OauthFields, reason: string): Promise<RefreshOutcome> {
    const rescuePath = join(this.dir, `.credentials.banto-rescue-${new Date(this.now()).toISOString().replace(/[:.]/g, "-")}.json`);
    let where = "";
    try {
      await writeFile(rescuePath, JSON.stringify({ claudeAiOauth: fresh }), { mode: 0o600 });
      where = `。新しいトークンは ${rescuePath} に退避しました`;
    } catch (err) {
      where = `。退避もできませんでした（${(err as Error).message}）`;
    }
    this.log(`${reason}${where}——本体のログインが古い refresh token のまま残っています`);
    return { kind: "failed", reason: `${reason}${where}`, needsHuman: true, closeWhen: "refresh-token-changed", accessToken: fresh.accessToken! };
  }

  /** いまの置き場の refresh token（閉じる判定に使う。読めなければ undefined） */
  async currentRefreshToken(): Promise<string | undefined> {
    return readCredentialsFile(this.deps.credentialsPath).then((c) => c.oauth?.refreshToken, () => undefined);
  }
}

function oauthErrorCode(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
    if (parsed.error && typeof parsed.error === "object" && typeof (parsed.error as { type?: unknown }).type === "string") {
      return (parsed.error as { type: string }).type;
    }
  } catch {
    /* 本文が JSON でなければ状態だけ */
  }
  return undefined;
}

/** 同梱の Agent SDK の版（読めなければ undefined） */
export function installedAgentSdkVersion(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const pkgPath = join(dirname(req.resolve("@anthropic-ai/claude-agent-sdk")), "package.json");
    return (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/**
 * **中継が取り直すか**（§2「中継も、切れかけたら取り直す」）。切るのは：`BANTO_CLAUDE_RELAY_REFRESH=0`、同梱の
 * SDK が確かめた版でない（CLI の手順・保存先が変わったかもしれない）、本物の資格情報を既定と別の道から指している
 * （E2E・疎通確認の別の banto に本物を回させない。偽物を指す E2E は取り直しの口も差し替えるので入れる）
 */
export function relayRefreshDecision(env: NodeJS.ProcessEnv, sdkVersion: string | undefined): { enabled: boolean; why?: string } {
  if (env.BANTO_CLAUDE_RELAY_REFRESH === "0") return { enabled: false, why: "BANTO_CLAUDE_RELAY_REFRESH=0" };
  if (env.BANTO_CLAUDE_RELAY_TOKEN_URL) return { enabled: true };
  if (env.BANTO_CLAUDE_RELAY_CREDENTIALS || env.CLAUDE_SECURESTORAGE_CONFIG_DIR) {
    return { enabled: env.BANTO_CLAUDE_RELAY_REFRESH === "1", why: "資格情報を既定と別の置き場から指しているため" };
  }
  if (sdkVersion !== VERIFIED_AGENT_SDK_VERSION) {
    return { enabled: false, why: `同梱の Agent SDK ${sdkVersion ?? "（不明）"} は取り直しの手順を確かめた版（${VERIFIED_AGENT_SDK_VERSION}）ではないため` };
  }
  return { enabled: true };
}
