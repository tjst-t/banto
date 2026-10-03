// この Module が GitHub に繋ぐ口（docs/specs/v4-modules.md §2.4「アカウント」）。**ここ1枚だけが GitHub を知る**
// ——試験は偽の GitHub（HTTP）に向ける。差し替えるのは行き先（`GithubEndpoints`）だけで、話し方は本物と同じ。
//
// - **デバイスフロー**（GitHub App。`gh auth login` と同じ方式）：コードをもらい、人が許可するまで interval どおりに待つ
// - **更新**：GitHub App のユーザーのトークンは8時間で切れる。refresh token で取り直す（refresh token も回る）。
//   デバイスフローで得たものは client secret 無しで更新できる（GitHub の文書「Refreshing user access tokens」）
// - **`GET /user`**：資格情報が誰のものかを確かめる（PAT でも）
//
// **秘密を文言に入れない**——失敗の理由は GitHub の `error`・`error_description`・状態番号だけで作る。

export interface GithubEndpoints {
  /** ログインの口・HTTPS の clone の口（`https://github.com`） */
  web: string;
  /** API（`https://api.github.com`） */
  api: string;
  /** SSH で clone するときの相手（`github.com`）。無ければ web の host */
  ssh?: string;
}

export const GITHUB_COM: GithubEndpoints = { web: "https://github.com", api: "https://api.github.com", ssh: "github.com" };

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** 秒 */
  expiresIn: number;
  /** 秒——これより短い間隔で聞くと断られる */
  interval: number;
}

/** 取れたトークンの組。時刻は ms（epoch）。期限を切っていない App なら期限も refresh token も無い */
export interface TokenSet {
  accessToken: string;
  expiresAt?: number;
  refreshToken?: string;
  refreshTokenExpiresAt?: number;
}

export type DevicePoll =
  | { kind: "pending" }
  /** 聞くのが早すぎた——間隔を延ばす（GitHub が新しい間隔を返す） */
  | { kind: "slow-down"; interval: number }
  /** コードの期限が切れた */
  | { kind: "expired" }
  /** 人が GitHub の画面で断った */
  | { kind: "denied" }
  | { kind: "authorized"; tokens: TokenSet };

export interface GithubUser {
  login: string;
}

/** GitHub が理由つきで断った。`code` は GitHub の `error`（無ければ HTTP の状態番号） */
export class GithubError extends Error {
  override name = "GithubError";
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface GithubApi {
  requestDeviceCode(clientId: string): Promise<DeviceCode>;
  pollDeviceToken(clientId: string, deviceCode: string): Promise<DevicePoll>;
  refresh(clientId: string, refreshToken: string): Promise<TokenSet>;
  currentUser(token: string): Promise<GithubUser>;
  /** そのトークンから `owner/name` が見えるか（無い・見えないは false。それ以外の断りは投げる） */
  repoExists(token: string, owner: string, name: string): Promise<boolean>;
  /** そのトークンでの `owner/name` への権限（見えなければ `visible: false`。それ以外の断りは投げる） */
  repoAccess(token: string, owner: string, name: string): Promise<{ visible: false } | { visible: true; push: boolean; admin: boolean }>;
}

const TIMEOUT_MS = 15_000;
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** GitHub の `error` を、人が次の手を選べる言い方に。知らないものは GitHub の文言のまま */
function explain(code: string, description: string | undefined): string {
  switch (code) {
    case "device_flow_disabled":
      return "この GitHub App はデバイスフローが有効になっていません（App の設定で「Enable Device Flow」に印を入れてください）";
    case "incorrect_client_credentials":
      return "GitHub がこの client ID を知りません（GitHub App の設定の client ID を写し直してください）";
    case "bad_refresh_token":
      return "GitHub が更新の鍵（refresh token）を受け付けませんでした（期限切れか、取り消されています）。もう一度ログインしてください";
    case "unsupported_grant_type":
    case "incorrect_device_code":
      return `GitHub がこの手順を受け付けませんでした（${code}）`;
    default:
      return description ? `${description}（${code}）` : code;
  }
}

function seconds(v: unknown, name: string): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0) throw new GithubError(`GitHub の返事に ${name} がありません`, "malformed");
  return n;
}

function tokenSet(body: Record<string, unknown>, now: number): TokenSet {
  if (typeof body.access_token !== "string" || body.access_token === "") {
    throw new GithubError("GitHub の返事にトークンがありません", "malformed");
  }
  return {
    accessToken: body.access_token,
    ...(body.expires_in !== undefined ? { expiresAt: now + seconds(body.expires_in, "expires_in") * 1000 } : {}),
    ...(typeof body.refresh_token === "string" && body.refresh_token !== "" ? { refreshToken: body.refresh_token } : {}),
    ...(body.refresh_token_expires_in !== undefined
      ? { refreshTokenExpiresAt: now + seconds(body.refresh_token_expires_in, "refresh_token_expires_in") * 1000 }
      : {}),
  };
}

/** 本物の GitHub（と、同じ話し方の偽物）に HTTP で繋ぐ */
export function httpGithub(endpoints: GithubEndpoints = GITHUB_COM, now: () => number = Date.now): GithubApi {
  const web = endpoints.web.replace(/\/+$/, "");
  const api = endpoints.api.replace(/\/+$/, "");

  /** ログインの口に form で送る。GitHub は失敗も 200 と `{error}` で返すことがある——どちらも読む */
  async function oauthPost(path: string, form: Record<string, string>): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(`${web}${path}`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": "banto" },
        body: new URLSearchParams(form),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new GithubError(`GitHub に繋がりませんでした（${(err as Error).message}）`, "network");
    }
    const text = await res.text();
    let body: Record<string, unknown> | undefined;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = undefined;
    }
    if (body && typeof body.error === "string") return body;
    if (!res.ok) throw new GithubError(`GitHub が断りました（HTTP ${res.status}）`, String(res.status));
    if (!body) throw new GithubError("GitHub の返事が読めませんでした", "malformed");
    return body;
  }

  return {
    async requestDeviceCode(clientId) {
      const body = await oauthPost("/login/device/code", { client_id: clientId });
      if (typeof body.error === "string") {
        throw new GithubError(explain(body.error, body.error_description as string | undefined), body.error);
      }
      if (typeof body.device_code !== "string" || typeof body.user_code !== "string" || typeof body.verification_uri !== "string") {
        throw new GithubError("GitHub の返事にコードがありません", "malformed");
      }
      return {
        deviceCode: body.device_code,
        userCode: body.user_code,
        verificationUri: body.verification_uri,
        expiresIn: seconds(body.expires_in, "expires_in"),
        interval: seconds(body.interval ?? 5, "interval"),
      };
    },

    async pollDeviceToken(clientId, deviceCode) {
      const body = await oauthPost("/login/oauth/access_token", {
        client_id: clientId,
        device_code: deviceCode,
        grant_type: DEVICE_GRANT,
      });
      switch (body.error) {
        case undefined:
          return { kind: "authorized", tokens: tokenSet(body, now()) };
        case "authorization_pending":
          return { kind: "pending" };
        case "slow_down":
          return { kind: "slow-down", interval: seconds(body.interval, "interval") };
        case "expired_token":
          return { kind: "expired" };
        case "access_denied":
          return { kind: "denied" };
        default:
          throw new GithubError(explain(String(body.error), body.error_description as string | undefined), String(body.error));
      }
    },

    async refresh(clientId, refreshToken) {
      const body = await oauthPost("/login/oauth/access_token", {
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      });
      if (typeof body.error === "string") {
        throw new GithubError(explain(body.error, body.error_description as string | undefined), body.error);
      }
      return tokenSet(body, now());
    },

    async currentUser(token) {
      let res: Response;
      try {
        res = await fetch(`${api}/user`, {
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "x-github-api-version": "2022-11-28",
            "user-agent": "banto",
          },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        throw new GithubError(`GitHub に繋がりませんでした（${(err as Error).message}）`, "network");
      }
      const body = (await res.json().catch(() => undefined)) as { login?: unknown; message?: unknown } | undefined;
      if (res.status === 401) {
        throw new GithubError("GitHub がこの資格情報を受け付けませんでした（401 Bad credentials——違う・期限切れ・取り消し済み）", "401");
      }
      if (!res.ok) {
        const why = typeof body?.message === "string" ? `：${body.message}` : "";
        throw new GithubError(`GitHub がユーザーを返しませんでした（HTTP ${res.status}${why}）`, String(res.status));
      }
      if (typeof body?.login !== "string" || body.login === "") throw new GithubError("GitHub の返事に login がありません", "malformed");
      return { login: body.login };
    },

    async repoAccess(token, owner, name) {
      let res: Response;
      try {
        res = await fetch(`${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
          headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28", "user-agent": "banto" },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        throw new GithubError(`GitHub に繋がりませんでした（${(err as Error).message}）`, "network");
      }
      if (res.status === 404) {
        await res.body?.cancel();
        return { visible: false };
      }
      if (res.status === 401) throw new GithubError("GitHub がこの資格情報を受け付けませんでした（401）", "401");
      if (!res.ok) throw new GithubError(`GitHub が答えませんでした（HTTP ${res.status}）`, String(res.status));
      const body = (await res.json().catch(() => undefined)) as { permissions?: { push?: unknown; admin?: unknown } } | undefined;
      // permissions が無い（公開のものを、権限の無いトークンで見た）なら、書けないと読む
      return { visible: true, push: body?.permissions?.push === true, admin: body?.permissions?.admin === true };
    },

    async repoExists(token, owner, name) {
      let res: Response;
      try {
        res = await fetch(`${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "x-github-api-version": "2022-11-28",
            "user-agent": "banto",
          },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        throw new GithubError(`GitHub に繋がりませんでした（${(err as Error).message}）`, "network");
      }
      await res.body?.cancel();
      if (res.status === 200) return true;
      if (res.status === 404) return false;
      if (res.status === 401) throw new GithubError("GitHub がこの資格情報を受け付けませんでした（401）", "401");
      throw new GithubError(`GitHub が答えませんでした（HTTP ${res.status}）`, String(res.status));
    },
  };
}
