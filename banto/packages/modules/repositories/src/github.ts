// この Module が GitHub に繋ぐ口（docs/specs/v4-modules.md §2.4「アカウント」）。**ここ1枚だけが GitHub を知る**
// ——試験は偽の GitHub（HTTP）に向ける。差し替えるのは行き先（`GithubEndpoints`）だけで、話し方は本物と同じ。
//
// - **デバイスフロー**（GitHub App。`gh auth login` と同じ方式）：コードをもらい、人が許可するまで interval どおりに待つ
// - **更新**：GitHub App のユーザーのトークンは8時間で切れる。refresh token で取り直す（refresh token も回る）。
//   デバイスフローで得たものは client secret 無しで更新できる（GitHub の文書「Refreshing user access tokens」）
// - **`GET /user`**：資格情報が誰のものかを確かめる（PAT でも）
// - **公開**（段階5）：行き先にできる持ち主（自分・属する Organization）とそこに作れそうか、空のリポジトリを作る
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
  /** 公開の行き先にできる持ち主（自分と、属する Organization）と、そこにリポジトリを作れそうか（段階5） */
  publishOwners(token: string, login: string, kind: "app" | "pat"): Promise<PublishOwners>;
  /** 空のリポジトリを作る（README 等は作らない）。`org` があれば Organization に（段階5） */
  createRepo(token: string, input: { org?: string; name: string; private: boolean; description?: string }): Promise<CreatedRepo>;
}

/**
 * 持ち主にリポジトリを作れそうか。**`unknown` は作ってみるまで分からない**（fine-grained PAT は権限を問い合わせる口が
 * 無い）——作れないと言い切れるものだけ `no` にして、理由と次の手を添える
 */
export interface PublishOwner {
  login: string;
  kind: "user" | "org";
  create: "yes" | "no" | "unknown";
  /** `no`・`unknown` の理由と次の手。`yes` でも条件があれば（公開のものだけ等） */
  note?: string;
  /** 公開（public）のものしか作れない（classic PAT の public_repo だけ） */
  publicOnly?: boolean;
}

export interface PublishOwners {
  owners: PublishOwner[];
  /** Organization の一覧が読めなかった理由（自分の分は出す） */
  orgsError?: string;
}

export interface CreatedRepo {
  owner: string;
  name: string;
  private: boolean;
  /** ブラウザで開く場所 */
  htmlUrl: string;
}

/** GitHub App にリポジトリを作る権限が足りないときの次の手（App の設定で何を足すか） */
export const APP_ADMINISTRATION_HINT =
  "GitHub App の設定（github.com/settings/apps → この App → Permissions & events）で Repository permissions の「Administration」を「Read and write」にし、インストール先（Settings → Applications → Installed GitHub Apps）で新しい権限を承認してください";

/** fine-grained PAT に足りないときの次の手 */
export const PAT_ADMINISTRATION_HINT =
  "fine-grained PAT なら Repository permissions の「Administration」を「Read and write」に（Resource owner を作る先にして）作り直し、classic PAT なら repo の権限を付けてください";

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

    async publishOwners(token, login, kind) {
      const headers = { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28", "user-agent": "banto" };
      const get = async (path: string): Promise<{ status: number; body: unknown; scopes: string | null }> => {
        let res: Response;
        try {
          res = await fetch(`${api}${path}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
        } catch (err) {
          throw new GithubError(`GitHub に繋がりませんでした（${(err as Error).message}）`, "network");
        }
        const body = await res.json().catch(() => undefined);
        if (res.status === 401) throw new GithubError("GitHub がこの資格情報を受け付けませんでした（401）", "401");
        return { status: res.status, body, scopes: res.headers.get("x-oauth-scopes") };
      };
      // **資格情報の種類で見る**（段階5のレビュー）——インストールを読めるかで App のトークンかを当てると、読めてしまう
      // fine-grained PAT を「App が入っていない」と誤って断る。PAT は X-OAuth-Scopes（classic）で分かり、無ければ
      // fine-grained で前もって知る口が無い。App のトークンは、どこに入っていて Administration を書けるかで見る
      const me = await get("/user");
      if (me.status !== 200) throw new GithubError(`GitHub がユーザーを返しませんでした（HTTP ${me.status}）`, String(me.status));
      const scopes = kind === "pat" && me.scopes !== null ? me.scopes.split(",").map((x) => x.trim()).filter(Boolean) : undefined;
      let installations: Array<{ account: string; administration?: string }> | undefined;
      if (kind === "app") {
        const inst = await get("/user/installations");
        if (inst.status === 200) {
          const list = (inst.body as { installations?: unknown })?.installations;
          installations = Array.isArray(list)
            ? list.flatMap((i: { account?: { login?: unknown }; permissions?: { administration?: unknown } }) =>
                typeof i?.account?.login === "string"
                  ? [{ account: i.account.login, ...(typeof i.permissions?.administration === "string" ? { administration: i.permissions.administration } : {}) }]
                  : [],
              )
            : [];
        } else {
          throw new GithubError(`GitHub App のインストールを読めませんでした（HTTP ${inst.status}）`, String(inst.status));
        }
      }
      const judge = (owner: string): Pick<PublishOwner, "create" | "note" | "publicOnly"> => {
        if (scopes !== undefined) {
          if (scopes.includes("repo")) return { create: "yes" };
          if (scopes.includes("public_repo")) return { create: "yes", publicOnly: true, note: "この PAT は public_repo だけなので、公開のリポジトリしか作れません" };
          return { create: "no", note: `この PAT にはリポジトリを作る権限（repo）がありません——${PAT_ADMINISTRATION_HINT}` };
        }
        if (installations !== undefined) {
          const at = installations.find((i) => i.account.toLowerCase() === owner.toLowerCase());
          if (!at) return { create: "no", note: `GitHub App が ${owner} に入っていません——App のページの「Install」で ${owner} に入れてください` };
          if (at.administration !== "write") return { create: "no", note: `GitHub App に Administration（Read and write）の権限がありません——${APP_ADMINISTRATION_HINT}` };
          return { create: "yes" };
        }
        return { create: "unknown", note: "作れるかは、作ってみるまで分かりません（fine-grained PAT は Repository permissions の「Administration」が Read and write である必要があります）" };
      };
      const owners: PublishOwner[] = [{ login, kind: "user", ...judge(login) }];
      const orgs = await get("/user/orgs");
      if (orgs.status !== 200 || !Array.isArray(orgs.body)) {
        return { owners, orgsError: `GitHub が Organization の一覧を返しませんでした（HTTP ${orgs.status}）` };
      }
      // Organization ごとの問い合わせは並べて（多い人を順に待たせない）。並びは GitHub の返した順のまま
      const judged = await Promise.all(
        (orgs.body as Array<{ login?: unknown }>)
          .filter((o): o is { login: string } => typeof o?.login === "string")
          .map(async (o): Promise<PublishOwner> => {
            const base = judge(o.login);
            if (base.create === "no") return { login: o.login, kind: "org", ...base };
            // Organization の中の決まり：owner（admin）は作れる。メンバーは、Org がメンバーに作らせているときだけ
            const [membership, org] = await Promise.all([
              get(`/user/memberships/orgs/${encodeURIComponent(o.login)}`),
              get(`/orgs/${encodeURIComponent(o.login)}`),
            ]);
            const role = (membership.body as { role?: unknown } | undefined)?.role;
            if (membership.status === 200 && role === "admin") return { login: o.login, kind: "org", ...base };
            const allowed = (org.body as { members_can_create_repositories?: unknown } | undefined)?.members_can_create_repositories;
            if (org.status === 200 && allowed === false) {
              return { login: o.login, kind: "org", create: "no", note: `${o.login} はメンバーがリポジトリを作れない設定です——Organization の owner に作ってもらうか、設定（Member privileges の Repository creation）を変えてもらってください` };
            }
            if (org.status === 200 && allowed === true) return { login: o.login, kind: "org", ...base };
            return { login: o.login, kind: "org", create: "unknown", note: `${o.login} でメンバーが作れるかを確かめられませんでした（作ってみるまで分かりません）` };
          }),
      );
      owners.push(...judged);
      return { owners };
    },

    async createRepo(token, input) {
      let res: Response;
      try {
        res = await fetch(input.org ? `${api}/orgs/${encodeURIComponent(input.org)}/repos` : `${api}/user/repos`, {
          method: "POST",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-github-api-version": "2022-11-28",
            "user-agent": "banto",
          },
          // 空で作る（README・.gitignore・ライセンスは作らない——手元の履歴をそのまま push する）
          body: JSON.stringify({ name: input.name, private: input.private, auto_init: false, ...(input.description ? { description: input.description } : {}) }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        throw new GithubError(`GitHub に繋がりませんでした（${(err as Error).message}）`, "network");
      }
      const body = (await res.json().catch(() => undefined)) as
        | { name?: unknown; owner?: { login?: unknown }; private?: unknown; html_url?: unknown; message?: unknown; errors?: Array<{ message?: unknown; field?: unknown }> }
        | undefined;
      if (res.status === 201 && typeof body?.name === "string" && typeof body.owner?.login === "string") {
        return { owner: body.owner.login, name: body.name, private: body.private === true, htmlUrl: typeof body.html_url === "string" ? body.html_url : "" };
      }
      const message = typeof body?.message === "string" ? body.message : "";
      const detail = (body?.errors ?? []).map((e) => (typeof e?.message === "string" ? e.message : "")).filter(Boolean).join("・");
      const where = input.org ?? "あなたのアカウント";
      if (res.status === 401) throw new GithubError("GitHub がこの資格情報を受け付けませんでした（401）", "401");
      if (res.status === 422 && /already exists/i.test(detail)) throw new GithubError(`${where}には、もう ${input.name} があります`, "name-taken");
      if (res.status === 403 && /not accessible by integration/i.test(message)) {
        throw new GithubError(`GitHub App にリポジトリを作る権限がありません——${APP_ADMINISTRATION_HINT}`, "app-permission");
      }
      if (res.status === 403 && /not accessible by personal access token/i.test(message)) {
        throw new GithubError(`この PAT にはリポジトリを作る権限がありません——${PAT_ADMINISTRATION_HINT}`, "pat-permission");
      }
      if (res.status === 403 || res.status === 422) {
        // Organization の決まり（メンバーは作れない・非公開は作れないプラン等）——GitHub の言葉をそのまま添える
        throw new GithubError(`GitHub が ${where}に作るのを断りました（HTTP ${res.status}${message ? `：${message}` : ""}${detail ? `・${detail}` : ""}）`, "refused");
      }
      if (res.status === 404) throw new GithubError(`${where}が見つかりません（Organization に入っていないか、App が入っていません）`, "not-found");
      throw new GithubError(`GitHub がリポジトリを作りませんでした（HTTP ${res.status}${message ? `：${message}` : ""}）`, String(res.status));
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
