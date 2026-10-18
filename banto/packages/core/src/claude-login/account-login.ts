// **ブラウザでログインして Claude のアカウントを足す・ログインし直す**（決定・2026-10-18、ユーザー。
// `docs/specs/v4-security.md` §2「Claude のアカウントを複数持つ」の 4.）。
//
// CLI の `claude auth login` の手書きの写しの形（OAuth 2.0 の認可コード＋PKCE、規則12——既知の答え）：
// 1. core が `code_verifier` と `state` を作ってメモリに10分持ち、認可の URL を返す。人は別のタブで開いてログインする
// 2. 向こうの画面に出た `<コード>#<state>` を人が banto に貼る。`#` で分けて state を比べ、合えば token の口で交換し、
//    `/api/oauth/profile` でメールアドレスと契約の種類を読む
// 3. 同じメールアドレスの足したアカウントがあれば、足さずにそのトークンで置き換える（ログインし直し）
//
// URL・client id・scope・profile の読み方は同梱の CLI（Agent SDK 0.3.281 の CLI 2.1.281）で確かめた
// （`CLAUDE_AI_AUTHORIZE_URL`・`MANUAL_REDIRECT_URL`・authorization_code の本文・`PMe`・`hUn` の `_F`）。scope は CLI の
// 既定の組ではなく推論とプロフィールだけ（#397 で token・profile・usage・messages が通るのを確かめた）。
// **SDK を上げたら確かめ直す**（`VERIFIED_AGENT_SDK_VERSION`——取り直しの手順と同じ版に結びつける）。

import { createHash, randomBytes } from "node:crypto";
import type { ClaudeAccount, ClaudeAccountStore } from "./accounts.js";
import { CLAUDE_CODE_CLIENT_ID, CLAUDE_TOKEN_URL, type OauthFields } from "./refresh.js";

/** claude.ai のログインの認可の口（CLI の `CLAUDE_AI_AUTHORIZE_URL`） */
export const CLAUDE_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
/** 手書きの写しの戻り先——向こうの画面が `<コード>#<state>` を出す（CLI の `MANUAL_REDIRECT_URL`） */
export const CLAUDE_MANUAL_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
/** 要る分だけ（推論とプロフィール）。CLI の既定の組の `org:create_api_key` 等は取らない——漏れたときの幅を狭める */
export const CLAUDE_LOGIN_SCOPES = ["user:inference", "user:profile"] as const;
/** メールアドレスと契約の種類を読む口（CLI の `PMe`） */
export const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
/** `code_verifier` と `state` をメモリに持つ時間 */
export const LOGIN_TTL_MS = 10 * 60_000;
/** 期限切れの手続きを「期限切れ」と言えるように覚えておく時間（秘密は10分で消す） */
const EXPIRED_MEMORY_MS = 24 * 60 * 60_000;
const HTTP_TIMEOUT_MS = 30_000;
/** organization_type から契約の種類へ（CLI の `_F` と同じ） */
const SUBSCRIPTION_OF_ORG_TYPE: Record<string, string> = {
  claude_max: "max",
  claude_pro: "pro",
  claude_enterprise: "enterprise",
  claude_team: "team",
};

/** 画面が分けて出す失敗 */
export type ClaudeLoginFailure =
  /** 知らない手続き（もう使った・起こし直した） */
  | "unknown"
  /** 10分を過ぎた */
  | "expired"
  /** 貼られたものが `<コード>#<state>` の形でない */
  | "malformed"
  /** state が合わない（別のタブ・別の手続きの写し）——交換に行かない */
  | "state-mismatch"
  /** token の口・profile の口が断った・届かない */
  | "exchange-failed"
  /** 「ログインし直す」で、そのアカウントとは違うアカウントが返ってきた（トークンは捨てる） */
  | "account-mismatch";

export class ClaudeAccountLoginError extends Error {
  override name = "ClaudeAccountLoginError";
  constructor(
    readonly code: ClaudeLoginFailure,
    message: string,
  ) {
    super(message);
  }
}

export interface ClaudeAccountLoginDeps {
  accounts: ClaudeAccountStore;
  /** token の口（試験・E2E で差し替える） */
  tokenUrl?: string;
  profileUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** ログインし直した——そのアカウントの「取り直せなかった」カードを閉じるため */
  onReplaced?(account: ClaudeAccount): void;
  /** 外した——取り直し役・開いているカードを片付けるため */
  onRemoved?(accountId: string): void;
}

interface PendingLogin {
  /** 期限が過ぎたら消す（秘密はメモリに10分だけ） */
  secret?: { verifier: string; state: string };
  expiresAt: number;
}

export interface ClaudeLoginStart {
  loginId: string;
  url: string;
  expiresAt: string;
}

export class ClaudeAccountLogin {
  private readonly pending = new Map<string, PendingLogin>();
  private readonly tokenUrl: string;
  private readonly profileUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly deps: ClaudeAccountLoginDeps) {
    this.tokenUrl = deps.tokenUrl ?? CLAUDE_TOKEN_URL;
    this.profileUrl = deps.profileUrl ?? CLAUDE_PROFILE_URL;
    this.fetchFn = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  /** **始める**：PKCE の組と state を作り、認可の URL を返す */
  start(): ClaudeLoginStart {
    this.sweep();
    const loginId = randomBytes(16).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + LOGIN_TTL_MS;
    this.pending.set(loginId, { secret: { verifier, state }, expiresAt });
    const url = new URL(CLAUDE_AUTHORIZE_URL);
    for (const [k, v] of [
      ["code", "true"],
      ["client_id", CLAUDE_CODE_CLIENT_ID],
      ["response_type", "code"],
      ["redirect_uri", CLAUDE_MANUAL_REDIRECT_URI],
      ["scope", CLAUDE_LOGIN_SCOPES.join(" ")],
      ["code_challenge", createHash("sha256").update(verifier).digest("base64url")],
      ["code_challenge_method", "S256"],
      ["state", state],
    ] as const) {
      url.searchParams.append(k, v);
    }
    return { loginId, url: url.toString(), expiresAt: new Date(expiresAt).toISOString() };
  }

  /**
   * **貼られたものを確かめて交換する**。足したら `replaced: false`、同じメールアドレスの足したアカウントを置き換えたら
   * `replaced: true`。state が合わないときは手続きを残す（正しい写しを貼り直せる）。交換に行ったら成否によらず使い切る
   * （認可コードは1回きり）。`accountId` を渡すと「そのアカウントにログインし直す」——違うアカウントが返ってきたら
   * 足さずに断る（設定の行の「ログインし直す」、v4-frontend.md §6.46）
   */
  async finish(loginId: string, pasted: string, opts: { accountId?: string } = {}): Promise<{ account: ClaudeAccount; replaced: boolean }> {
    this.sweep();
    const p = this.pending.get(loginId);
    if (!p) throw new ClaudeAccountLoginError("unknown", "このログインの手続きは見つかりません。もう一度「アカウントを足す」から始めてください");
    if (!p.secret || this.now() >= p.expiresAt) {
      this.pending.delete(loginId);
      throw new ClaudeAccountLoginError("expired", "ログインの手続きが期限切れです（10分）。もう一度始めてください");
    }
    const text = pasted.trim();
    const hash = text.indexOf("#");
    const code = hash < 0 ? "" : text.slice(0, hash);
    const gotState = hash < 0 ? "" : text.slice(hash + 1);
    if (!code || !gotState) {
      throw new ClaudeAccountLoginError("malformed", "貼られたものが「<コード>#<state>」の形ではありません。向こうの画面に出た文字列を全部貼ってください");
    }
    if (gotState !== p.secret.state) {
      throw new ClaudeAccountLoginError("state-mismatch", "state が合いません。この手続きで開いたタブに出た文字列を貼ってください");
    }
    const { verifier, state } = p.secret;
    this.pending.delete(loginId);

    const oauth = await this.exchange(code, verifier, state);
    const profile = await this.readProfile(oauth.accessToken!);
    const filled: OauthFields = {
      ...oauth,
      ...(profile.subscriptionType ? { subscriptionType: profile.subscriptionType } : {}),
      ...(profile.rateLimitTier ? { rateLimitTier: profile.rateLimitTier } : {}),
    };
    if (opts.accountId !== undefined) {
      const target = this.deps.accounts.get(opts.accountId);
      if (!target || target.kind !== "banto") throw new ClaudeAccountLoginError("unknown", "ログインし直すアカウントが見つかりません");
      if (target.email?.trim().toLowerCase() !== profile.email.trim().toLowerCase()) {
        throw new ClaudeAccountLoginError(
          "account-mismatch",
          `返ってきたのは ${profile.email} で、${target.email ?? target.label} ではありません。開いたタブで claude.ai をいったんログアウトしてから、もう一度始めてください`,
        );
      }
    }
    const same = this.deps.accounts.findByEmail(profile.email);
    if (same) {
      const account = await this.deps.accounts.replaceLogin(same.id, { ...profile, oauth: filled });
      this.deps.onReplaced?.(account);
      return { account, replaced: true };
    }
    return { account: this.deps.accounts.add({ ...profile, oauth: filled }), replaced: false };
  }

  /** **外す**：置き場を消し、並びから抜く。`~/.claude` のものは外せない（台帳が断る） */
  remove(accountId: string): void {
    this.deps.accounts.remove(accountId);
    this.deps.onRemoved?.(accountId);
  }

  private async exchange(code: string, verifier: string, state: string): Promise<OauthFields> {
    let res: Response;
    try {
      // 本文は CLI の authorization_code と同じ（JSON・state も送る）
      res = await this.fetchFn(this.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: CLAUDE_MANUAL_REDIRECT_URI,
          client_id: CLAUDE_CODE_CLIENT_ID,
          code_verifier: verifier,
          state,
        }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (err) {
      throw new ClaudeAccountLoginError("exchange-failed", `token の口に届きませんでした：${(err as Error).message}`);
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) throw new ClaudeAccountLoginError("exchange-failed", `コードを交換できませんでした（${res.status}${errorCodeOf(text)}）。もう一度始めてください`);
    let data: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown; refresh_token_expires_in?: unknown };
    try {
      data = JSON.parse(text) as typeof data;
    } catch {
      throw new ClaudeAccountLoginError("exchange-failed", "token の口の返事が JSON ではありません");
    }
    if (typeof data.access_token !== "string" || typeof data.refresh_token !== "string" || typeof data.expires_in !== "number") {
      throw new ClaudeAccountLoginError("exchange-failed", "token の口の返事に access token・refresh token・期限のどれかがありません");
    }
    const scopes = typeof data.scope === "string" && data.scope.trim() !== "" ? data.scope.trim().split(/\s+/) : [...CLAUDE_LOGIN_SCOPES];
    // 推論の scope が無いと中継で使えず、取り直し役も取り直さない
    if (!scopes.includes("user:inference")) throw new ClaudeAccountLoginError("exchange-failed", `推論の scope が付きませんでした（${scopes.join(" ")}）`);
    const now = this.now();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: now + data.expires_in * 1000,
      scopes,
      ...(typeof data.refresh_token_expires_in === "number" ? { refreshTokenExpiresAt: now + data.refresh_token_expires_in * 1000 } : {}),
    };
  }

  private async readProfile(accessToken: string): Promise<{ email: string; subscriptionType?: string; rateLimitTier?: string }> {
    let res: Response;
    try {
      res = await this.fetchFn(this.profileUrl, {
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (err) {
      throw new ClaudeAccountLoginError("exchange-failed", `プロフィールを読めませんでした：${(err as Error).message}`);
    }
    if (!res.ok) throw new ClaudeAccountLoginError("exchange-failed", `プロフィールを読めませんでした（${res.status}）`);
    const body = (await res.json().catch(() => undefined)) as
      | { account?: { email?: unknown; email_address?: unknown }; organization?: { organization_type?: unknown; rate_limit_tier?: unknown } }
      | undefined;
    const email = body?.account?.email ?? body?.account?.email_address;
    if (typeof email !== "string" || !email.includes("@")) {
      throw new ClaudeAccountLoginError("exchange-failed", "プロフィールにメールアドレスがありません");
    }
    const orgType = body?.organization?.organization_type;
    const subscriptionType = typeof orgType === "string" ? SUBSCRIPTION_OF_ORG_TYPE[orgType] : undefined;
    const tier = body?.organization?.rate_limit_tier;
    return {
      email,
      ...(subscriptionType ? { subscriptionType } : {}),
      ...(typeof tier === "string" && tier ? { rateLimitTier: tier } : {}),
    };
  }

  /** 10分を過ぎた手続きの秘密を消す。「期限切れ」と言うための印は1日で消す */
  private sweep(): void {
    const now = this.now();
    for (const [id, p] of this.pending) {
      if (now >= p.expiresAt) delete p.secret;
      if (now >= p.expiresAt + EXPIRED_MEMORY_MS) this.pending.delete(id);
    }
  }
}

function errorCodeOf(text: string): string {
  try {
    const e = (JSON.parse(text) as { error?: unknown }).error;
    if (typeof e === "string") return ` ${e}`;
  } catch {
    /* 本文が JSON でなければ状態だけ */
  }
  return "";
}
