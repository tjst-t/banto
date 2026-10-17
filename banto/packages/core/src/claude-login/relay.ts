// **banto 本体の Claude ログインを、トークンを渡さずに Project のコンテナに使わせる中継**
// （決定・2026-09-24、ユーザー。core に常設・2026-09-27、`docs/specs/v4-security.md` §2「banto 本体の Claude ログインは、
// 中継で共有する」）。
//
// コンテナに入れるのは `ANTHROPIC_BASE_URL`＝この中継と、`CLAUDE_CODE_OAUTH_TOKEN`＝**その Project の合言葉**。
// 中継は合言葉から Project を引き、Authorization を本体の access token に差し替えて api.anthropic.com へ流す。
// **本物のトークン（と refresh token）はコンテナに入らない**——中では AI が root で何でも読めるので、渡さないのが
// 唯一の守り方。
//
// 合言葉は Project ごとに1つで固定（Service がコンテナの起動で勝手に起きても、古い合言葉にならない）。替わるのは
// Project 設定の「Claude のログインを使わせる」を切ったときだけ（切った時点で消し、次に要るときに新しく出す）。
//
// 待ち受けは複数持てる（`ClaudeLoginListener`）。core の口ではコンテナのアドレスで送り元を縛り、別のサーバ用の
// 専用の待ち受け（`relay-listener.ts`）では、待ち受けそのものが送り元の代わりになる（§2、2026-10-08）。
//
// 資格情報で認証を差し込む中継は既知の形（規則12——サンドボックスの外で鍵を足す egress proxy）。
// 実測（poc/08-subagent-acp/proxy-probe.mjs）：Claude Code が中継に投げたのは `/v1/messages` だけ。

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { Socket } from "node:net";
import { join } from "node:path";
import { Readable } from "node:stream";
import { CredentialRefresher, type CloseWhen, type RefreshOutcome } from "./refresh.js";

const UPSTREAM = "https://api.anthropic.com";
/**
 * **試し直すために本文を持つ上限**（API の要求の上限 32 MB）。超えるものは持たずに流し、401 でも送り直さない
 */
const RETRY_BODY_LIMIT = 32 * 1024 * 1024;
/** 同時に抱える本文の合計の上限（要求の数だけ重なるので。超えたら持たずに流す） */
const RETRY_BODY_TOTAL_LIMIT = 64 * 1024 * 1024;
/** core の HTTP サーバの上の口。`ANTHROPIC_BASE_URL` はここまで（CLI が `/v1/messages` を足す） */
export const CLAUDE_LOGIN_PATH = "/claude-login";
/**
 * **この Project に Claude のログインを使わせるか**（Project ごとの設定、決定・2026-09-27、ユーザー）。既定はオン
 * ——その Project の会話の本体（Runner）はすでに同じログインで動いている
 */
export const CLAUDE_LOGIN_ENABLED_KEY = "claudeLogin.enabled";
/**
 * **通すのは推論だけ**。本体のトークンは会話の履歴・claude.ai のコネクタ・ファイルの
 * 送り込みまで触れる広さを持つ——コンテナに要るのは推論だけなので、他は断る
 */
const ALLOWED_PATH = /^\/v1\/messages(\/count_tokens)?(\?|$)/;
const HOP_BY_HOP = ["host", "connection", "content-length", "authorization", "x-api-key", "keep-alive", "transfer-encoding"];

/**
 * 本体（main の Runner）が使っている資格情報の置き場。CLI と同じ順で決める——
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR`（E2E・疎通確認が本物を指すのに使う）→ `CLAUDE_CONFIG_DIR` → `~/.claude`
 */
export function hostClaudeCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  // CLI と同じく、CLAUDE_SECURESTORAGE_CONFIG_DIR が空文字なら ~/.claude（CLI の `rw`）
  const secure = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const dir = secure !== undefined ? secure || join(homedir(), ".claude") : env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(dir, ".credentials.json");
}

export interface HostClaudeAccount {
  /** 契約の種類と上限の段——**トークンではない**。コンテナに渡すと、既定のモデルと文脈の上限が
   *  本体と揃う（env のトークンのとき CLI はここから読む。実測：既定が Opus 5.5・文脈100万になった） */
  subscriptionType?: string;
  rateLimitTier?: string;
}

export type HostLoginStatus = ({ loggedIn: true } & HostClaudeAccount) | { loggedIn: false; reason: string };

export class ClaudeLoginError extends Error {
  override name = "ClaudeLoginError";
}

/** 毎回読み直す——本体の CLI が更新したトークンを、そのまま拾う（写しを持たない・規則3） */
async function readAccessToken(path: string): Promise<{ token: string; account: HostClaudeAccount }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new ClaudeLoginError(`banto 本体が Claude にログインしていません（${path} がありません）`);
  }
  const oauth = (
    JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string; subscriptionType?: string; rateLimitTier?: string } }
  ).claudeAiOauth;
  if (!oauth?.accessToken) throw new ClaudeLoginError(`banto 本体の Claude ログインにトークンがありません（${path}）`);
  return {
    token: oauth.accessToken,
    account: {
      ...(oauth.subscriptionType ? { subscriptionType: oauth.subscriptionType } : {}),
      ...(oauth.rateLimitTier ? { rateLimitTier: oauth.rateLimitTier } : {}),
    },
  };
}

/** 設定画面に出す、本体のログインの様子（トークンは読むが返さない） */
export async function readHostClaudeAccount(path: string): Promise<HostLoginStatus> {
  try {
    const { account } = await readAccessToken(path);
    return { loggedIn: true, ...account };
  } catch (err) {
    // 読めなかった理由をそのまま出す（壊れたファイルを「未ログイン」に丸めない）
    return { loggedIn: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * **待ち受け1つ分の決まり**。中継の口は複数の待ち受けに載る（core の口・別のサーバ用の専用の待ち受け）
 */
export interface ClaudeLoginListener {
  /** この待ち受けで受けてよい Project か（専用の待ち受けは、その実行場所の Project だけ） */
  acceptsProject(projectId: string): boolean;
  /**
   * 送り元のアドレスを、その Project のコンテナのアドレスに縛るか。別のサーバからは SSH のトンネルで来るので、
   * 送り元は全部 127.0.0.1——そこでは待ち受けが送り元の代わりになるので縛らない
   */
  bindSource: boolean;
}

/** Project ごとの観測（Project 設定に出す。Event Store には要求ごとに残さない——多すぎる） */
export interface ClaudeLoginStats {
  /** 上流へ流した要求の数（banto を起こしてから） */
  requests: number;
  lastRequestAt?: string;
  /** 上流が 401 を返した最後の時刻（本体のログインの期限切れ） */
  lastUnauthorizedAt?: string;
}

export interface ClaudeLoginRelayDeps {
  credentialsPath: string;
  /** 合言葉の置き場（host のデータの置き場。0600） */
  secretsPath: string;
  /** Project 設定のスイッチ。聞くたびに引く */
  enabled(projectId: string): boolean;
  /**
   * 送り元が、その Project のコンテナか。**分からない（Incus が答えない）は投げる**——黙って通さない・
   * 黙って「違う」にしない
   */
  sourceMatches?(projectId: string, remoteAddress: string): Promise<boolean>;
  /**
   * **本体のログインを中継では直せなかった**（受信箱に1件出すため。改訂・2026-10-16）——取り直して試し直しても上流が
   * 401、または取り直しが断られた・書き戻せなかった。一時的な失敗（通信・5xx・鍵の取り合い）だけでは呼ばない
   */
  onUpstreamUnauthorized?(projectId: string, reason: string): void;
  /** 上流が通った（2xx）——出していたカードを閉じるため。直前に直せなかったことがあるときだけ呼ぶ */
  onUpstreamAuthorized?(): void;
  upstream?: string;
  /** 取り直しの口（試験・E2E で差し替える。既定は本番） */
  tokenUrl?: string;
  /** 取り直し役（試験で差し替える。既定は credentialsPath と tokenUrl から作る） */
  refresher?: CredentialRefresher;
  /** 中継が取り直すか（既定はする。切れば今までどおり読むだけ） */
  refreshEnabled?: boolean;
  now?: () => Date;
}

export class ClaudeLoginRelay {
  private readonly secrets: Map<string, string>;
  private readonly stats = new Map<string, ClaudeLoginStats>();
  /** 送り元を確かめ済みの接続と、その接続で確かめた Project */
  private readonly verifiedSockets = new WeakMap<Socket, Set<string>>();
  private readonly upstream: string;
  private readonly now: () => Date;
  private readonly refresher: CredentialRefresher;
  /**
   * 知らせたカードを閉じる条件（無ければ開いていない）。起こし直す前に出したカードも、最初に通ったときに閉じる
   */
  private openTrouble: { closeWhen: CloseWhen; refreshToken?: string } | undefined = { closeWhen: "authorized" };
  /** いま試し直し用に抱えている本文の合計 */
  private bufferedBytes = 0;

  constructor(private readonly deps: ClaudeLoginRelayDeps) {
    this.upstream = deps.upstream ?? UPSTREAM;
    this.now = deps.now ?? (() => new Date());
    this.refresher =
      deps.refresher ??
      new CredentialRefresher({
        credentialsPath: deps.credentialsPath,
        ...(deps.tokenUrl ? { tokenUrl: deps.tokenUrl } : {}),
        ...(deps.refreshEnabled !== undefined ? { enabled: deps.refreshEnabled } : {}),
        now: () => this.now().getTime(),
      });
    this.secrets = new Map(Object.entries(loadSecrets(deps.secretsPath)));
  }

  /**
   * **その Project のコンテナに入れる環境**。スイッチが切れていれば undefined（入れない）。合言葉が無ければ
   * ここで出し、置き場に書く——以後は切られるまで同じもの
   */
  async envFor(projectId: string, baseUrl: string): Promise<Record<string, string> | undefined> {
    if (!this.deps.enabled(projectId)) {
      this.revoke(projectId);
      return undefined;
    }
    let secret = this.secrets.get(projectId);
    if (!secret) {
      secret = `banto-${randomBytes(32).toString("base64url")}`;
      this.secrets.set(projectId, secret);
      this.save();
    }
    // 契約の種類は秘密ではない。ログインしていなければ入れない（中継に来たときに理由を返す）
    const status = await readHostClaudeAccount(this.deps.credentialsPath);
    return {
      ANTHROPIC_BASE_URL: `${baseUrl}${CLAUDE_LOGIN_PATH}`,
      CLAUDE_CODE_OAUTH_TOKEN: secret,
      ...(status.loggedIn && status.subscriptionType ? { CLAUDE_CODE_SUBSCRIPTION_TYPE: status.subscriptionType } : {}),
      ...(status.loggedIn && status.rateLimitTier ? { CLAUDE_CODE_RATE_LIMIT_TIER: status.rateLimitTier } : {}),
    };
  }

  /** スイッチを切った——その時点で合言葉を無効にする。入れ直すと次の `envFor` で新しいものが出る */
  revoke(projectId: string): void {
    if (this.secrets.delete(projectId)) this.save();
  }

  statsFor(projectId: string): ClaudeLoginStats {
    return { ...(this.stats.get(projectId) ?? { requests: 0 }) };
  }

  hostLogin(): Promise<HostLoginStatus> {
    return readHostClaudeAccount(this.deps.credentialsPath);
  }

  /** `CLAUDE_LOGIN_PATH` の下に来た要求を受ける。どの待ち受けから来たかで、受ける Project と送り元の縛りが変わる */
  async handle(req: IncomingMessage, res: ServerResponse, listener: ClaudeLoginListener): Promise<void> {
    try {
      await this.forward(req, res, listener);
    } catch (err) {
      if (!res.headersSent) refuse(res, 502, `中継できませんでした: ${err instanceof Error ? err.message : String(err)}`);
      else res.destroy();
    }
  }

  private async forward(req: IncomingMessage, res: ServerResponse, listener: ClaudeLoginListener): Promise<void> {
    const path = (req.url ?? "").slice(CLAUDE_LOGIN_PATH.length);
    const projectId = this.projectOf(req.headers.authorization);
    // 合言葉が違う・その待ち受けで受けない Project・切られた Project は、どれも同じ 401（どれに当たったかを外に言わない）
    if (!projectId || !listener.acceptsProject(projectId) || !this.deps.enabled(projectId)) {
      if (projectId && !this.deps.enabled(projectId)) this.revoke(projectId);
      refuse(res, 401, "合言葉が違います");
      return;
    }
    if (listener.bindSource && !this.verifiedSockets.get(req.socket)?.has(projectId)) {
      const remote = normalizeAddress(req.socket.remoteAddress ?? "");
      if (!this.deps.sourceMatches || !(await this.deps.sourceMatches(projectId, remote))) {
        refuse(res, 403, `この合言葉は、その Project のコンテナからしか使えません（送り元 ${remote}）`);
        return;
      }
      // 同じ接続の送り元は変わらない（コンテナが止まれば接続も切れる）——keep-alive の続きでは Incus に聞き直さない
      const verified = this.verifiedSockets.get(req.socket) ?? new Set<string>();
      verified.add(projectId);
      this.verifiedSockets.set(req.socket, verified);
    }
    if (!ALLOWED_PATH.test(path)) {
      refuse(res, 403, `banto の中継は推論（/v1/messages）だけを通します: ${req.method} ${path}`);
      return;
    }
    // 切れかけていれば取り直す（§2「中継も、切れかけたら取り直す」）。トークンも無い＝ログインしていない——理由を返す
    const first = await this.refresher.ensureFresh();
    if (first.kind === "failed" && !first.accessToken) {
      refuse(res, 500, first.reason);
      return;
    }
    let token = first.accessToken!;
    /** 流せても人が直すことが残った（例：取り直したのに書き戻せなかった） */
    let trouble = troubleOf(first);
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    // 試し直すために本文を読み切って持つ（上限を超えたら、読んだ分と残りをつないで流す）
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const room = Math.min(RETRY_BODY_LIMIT, Math.max(0, RETRY_BODY_TOTAL_LIMIT - this.bufferedBytes));
    const body: { buffered?: Buffer; stream?: Readable } = hasBody ? await readBodyUpTo(req, room) : {};
    const held = body.buffered?.length ?? 0;
    this.bufferedBytes += held;
    let upstreamRes: Response;
    try {
      const send = (bearer: string) =>
        fetch(`${this.upstream}${path}`, {
          method: req.method ?? "POST",
          headers: { ...forwardedHeaders(req), authorization: `Bearer ${bearer}` },
          ...(hasBody
            ? body.buffered !== undefined
              ? { body: body.buffered }
              : // Node の fetch で本文を流しながら送るには duplex が要る
                { body: Readable.toWeb(body.stream!) as ReadableStream<Uint8Array>, duplex: "half" }
            : {}),
          signal: abort.signal,
        } as RequestInit);
      upstreamRes = await send(token);
      // 401：置き場を読み直し（替わっていなければ線を見ずに取り直して）、1回だけ送り直す
      if (upstreamRes.status === 401 && (!hasBody || body.buffered !== undefined)) {
        const second = await this.refresher.ensureFresh({ force: true, seenAccessToken: token });
        if (second.accessToken && second.accessToken !== token) {
          await upstreamRes.body?.cancel().catch(() => {});
          token = second.accessToken;
          upstreamRes = await send(token);
          trouble = troubleOf(second) ?? trouble;
          if (upstreamRes.status === 401) trouble ??= { reason: "取り直したトークンでも断られました（401）", closeWhen: "authorized" };
        } else if (second.kind === "failed" && second.needsHuman) {
          trouble = troubleOf(second);
        } else if (second.kind === "failed") {
          // 一時的（取り直しの口に届かない・鍵の取り合い）：知らせず、次の要求でまた試す
          console.warn(`[claude-login] 401 のあと取り直せませんでした（一時的）: ${second.reason}`);
        }
      } else if (upstreamRes.status === 401) {
        console.warn("[claude-login] 上流が 401 を返しました（本文が大きく、試し直しませんでした）");
      }
    } finally {
      this.bufferedBytes -= held;
    }
    const at = this.now().toISOString();
    const s = this.stats.get(projectId) ?? { requests: 0 };
    s.requests++;
    s.lastRequestAt = at;
    if (upstreamRes.status === 401) s.lastUnauthorizedAt = at;
    this.stats.set(projectId, s);
    if (trouble) {
      this.openTrouble = {
        closeWhen: trouble.closeWhen,
        ...(trouble.closeWhen === "refresh-token-changed" ? { refreshToken: await this.refresher.currentRefreshToken() } : {}),
      };
      this.deps.onUpstreamUnauthorized?.(projectId, trouble.reason);
    } else if (upstreamRes.ok && this.openTrouble) {
      // ログインが壊れた知らせは、置き場の refresh token が替わるまで閉じない（手元の access token でたまたま通っただけ）
      const open = this.openTrouble;
      if (open.closeWhen === "authorized" || (await this.refresher.currentRefreshToken()) !== open.refreshToken) {
        this.openTrouble = undefined;
        this.deps.onUpstreamAuthorized?.();
      }
    }
    const headers: Record<string, string> = {};
    // fetch は圧縮を解いて渡すので、長さと符号化の見出しは付け直さない
    upstreamRes.headers.forEach((v, k) => {
      if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) headers[k] = v;
    });
    res.writeHead(upstreamRes.status, headers);
    if (upstreamRes.body) Readable.fromWeb(upstreamRes.body as import("node:stream/web").ReadableStream).pipe(res);
    else res.end();
  }

  private projectOf(authorization: string | undefined): string | undefined {
    const m = /^Bearer (.+)$/.exec(authorization ?? "");
    if (!m) return undefined;
    for (const [projectId, secret] of this.secrets) if (secret === m[1]) return projectId;
    return undefined;
  }

  private save(): void {
    // 書きかけを読ませない（別名に書いて置き換える）。値は記録（Event Store）には残さない
    const tmp = `${this.deps.secretsPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.secrets)), { mode: 0o600 });
    renameSync(tmp, this.deps.secretsPath);
  }
}

function loadSecrets(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  // 壊れていたら止まる（規則2）——黙って空にすると、動いている Service の合言葉が全部替わる
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Object.values(parsed).some((v) => typeof v !== "string")) {
    throw new Error(`Claude のログインの中継の合言葉の置き場が壊れています：${path}`);
  }
  return parsed as Record<string, string>;
}

/** IPv4 を IPv6 の形で受けた待ち受け（`::ffff:10.0.0.2`）でも、コンテナのアドレスと比べられる形に */
function normalizeAddress(address: string): string {
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

/** 人が直すことが残った取り直しの結果ならその理由と閉じ方（一時的な失敗は数えない） */
function troubleOf(outcome: RefreshOutcome): { reason: string; closeWhen: CloseWhen } | undefined {
  return outcome.kind === "failed" && outcome.needsHuman ? { reason: outcome.reason, closeWhen: outcome.closeWhen ?? "authorized" } : undefined;
}

/**
 * 本文を上限まで読み切る。収まれば `buffered`、超えたら読んだ分と残りをつないだ `stream`（試し直せない）
 */
async function readBodyUpTo(req: IncomingMessage, limit: number): Promise<{ buffered: Buffer; stream?: undefined } | { buffered: undefined; stream: Readable }> {
  const chunks: Buffer[] = [];
  let size = 0;
  const iterator = req[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  for (;;) {
    const next = await iterator.next();
    if (next.done) return { buffered: Buffer.concat(chunks) };
    chunks.push(next.value);
    size += next.value.length;
    if (size > limit) {
      const rest = async function* () {
        yield* chunks;
        for (;;) {
          const more = await iterator.next();
          if (more.done) return;
          yield more.value;
        }
      };
      return { buffered: undefined, stream: Readable.from(rest()) };
    }
  }
}

function refuse(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message } }));
}

function forwardedHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || HOP_BY_HOP.includes(k)) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}
