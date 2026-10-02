// 試験のための偽物：**偽の GitHub（本物の HTTP で立てる）**・Vault・受信箱。試験からだけ使う（index から出さない）。
//
// 偽の GitHub は本物と同じ話し方をする——form で受け、`{error}` を 200 で返し、refresh token は**1回使うと無効**
// （回る）。同時に2本が同じ鍵で更新すると、片方は `bad_refresh_token` で負ける（本物と同じ）。

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { GithubEndpoints } from "./github.js";
import type { NoticeSink } from "./relay-client.js";
import type { AliasEntry, AliasPlace, VaultAccess } from "./vault.js";

export type PollStep = "pending" | "slow_down" | "expired_token" | "access_denied" | "device_flow_disabled" | "authorized";

export interface FakeGithub {
  endpoints: GithubEndpoints;
  /** 受けた要求（パスと form。トークンを含む——試験が「漏れていないか」を照らす元） */
  requests: Array<{ path: string; form: Record<string, string>; authorization?: string }>;
  /** そのデバイスコードに、聞かれるたびに返す順（最後のものを繰り返す） */
  script: PollStep[];
  /** 許可したときに誰になるか */
  loginForDevice: string;
  /** 出すアクセストークンの寿命（秒）。undefined なら期限なし（refresh token も出さない） */
  accessTokenTtl: number | undefined;
  /** 有効なトークン → login */
  users: Map<string, string>;
  /** 有効な refresh token（使うと消える） */
  refreshTokens: Map<string, string>;
  /** 更新の口を、遅らせる（同時更新の試験） */
  refreshDelayMs: number;
  /** 更新を断らせる（`bad_refresh_token` 等） */
  refreshError: string | undefined;
  refreshCalls: number;
  close(): Promise<void>;
}

export const FAKE_CLIENT_ID = "Iv23liFAKECLIENT";

export async function startFakeGithub(): Promise<FakeGithub> {
  let seq = 0;
  const state: Omit<FakeGithub, "endpoints" | "close"> = {
    requests: [],
    script: ["pending", "authorized"],
    loginForDevice: "tjst-t",
    accessTokenTtl: 8 * 3600,
    users: new Map(),
    refreshTokens: new Map(),
    refreshDelayMs: 0,
    refreshError: undefined,
    refreshCalls: 0,
  };
  const polls = new Map<string, number>();
  const issue = (login: string) => {
    seq += 1;
    const access = `ghu_fake_access_${seq}`;
    state.users.set(access, login);
    const body: Record<string, unknown> = { access_token: access, token_type: "bearer", scope: "" };
    if (state.accessTokenTtl !== undefined) {
      const refresh = `ghr_fake_refresh_${seq}`;
      state.refreshTokens.set(refresh, login);
      Object.assign(body, { expires_in: state.accessTokenTtl, refresh_token: refresh, refresh_token_expires_in: 15897600 });
    }
    return body;
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const url = new URL(req.url ?? "/", "http://fake");
        const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
        state.requests.push({ path: url.pathname, form, ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) });
        const send = (status: number, body: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (url.pathname === "/login/device/code" && req.method === "POST") {
          if (form.client_id !== FAKE_CLIENT_ID) return send(200, { error: "incorrect_client_credentials", error_description: "bad client" });
          seq += 1;
          return send(200, {
            device_code: `dc_${seq}`,
            user_code: "WDJB-MJHT",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 5,
          });
        }
        if (url.pathname === "/login/oauth/access_token" && req.method === "POST") {
          if (form.client_id !== FAKE_CLIENT_ID) return send(200, { error: "incorrect_client_credentials" });
          if (form.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
            const n = polls.get(form.device_code ?? "") ?? 0;
            polls.set(form.device_code ?? "", n + 1);
            const step = state.script[Math.min(n, state.script.length - 1)]!;
            if (step === "authorized") return send(200, issue(state.loginForDevice));
            if (step === "slow_down") return send(200, { error: "slow_down", interval: 10 });
            if (step === "pending") return send(200, { error: "authorization_pending", error_description: "pending" });
            return send(200, { error: step });
          }
          if (form.grant_type === "refresh_token") {
            state.refreshCalls += 1;
            if (state.refreshDelayMs > 0) await new Promise((r) => setTimeout(r, state.refreshDelayMs));
            if (state.refreshError) return send(200, { error: state.refreshError, error_description: "refused by fake" });
            const login = state.refreshTokens.get(form.refresh_token ?? "");
            if (!login) return send(200, { error: "bad_refresh_token", error_description: "The refresh token passed is incorrect or expired." });
            // **回る**——使った鍵は無効になる
            state.refreshTokens.delete(form.refresh_token!);
            return send(200, issue(login));
          }
          return send(200, { error: "unsupported_grant_type" });
        }
        // **試験が外から振る舞いを替える口**（E2E は core と別のプロセスから。偽物にだけある）
        if (url.pathname === "/__fake/state" && req.method === "POST") {
          const patch = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Partial<
            Pick<FakeGithub, "script" | "loginForDevice" | "accessTokenTtl" | "refreshError">
          >;
          if (patch.script) state.script = patch.script;
          if (patch.loginForDevice) state.loginForDevice = patch.loginForDevice;
          if ("accessTokenTtl" in patch) state.accessTokenTtl = patch.accessTokenTtl ?? undefined;
          if ("refreshError" in patch) state.refreshError = patch.refreshError ?? undefined;
          return send(200, { refreshCalls: state.refreshCalls });
        }
        if (url.pathname === "/user" && req.method === "GET") {
          const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
          const login = state.users.get(token);
          if (!login) return send(401, { message: "Bad credentials" });
          return send(200, { login, id: 1 });
        }
        send(404, { message: "Not Found" });
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return Object.assign(state, {
    endpoints: { web: base, api: base },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}

/** Vault の偽物。**置いた値は `values` にだけある**——ほかの場所（返り値・台帳）に出ていないかを試験が照らす */
export class MemoryVault implements VaultAccess {
  readonly aliases: Array<AliasEntry & { note?: string }> = [];
  readonly values = new Map<string, string>();
  readonly calls: Array<{ op: string; callId?: string }> = [];
  failPut: string | undefined;

  private key(p: AliasPlace) {
    return `${p.implementation}|${p.group ?? ""}|${p.name}`;
  }
  private find(p: AliasPlace) {
    return this.aliases.find((a) => this.key(a) === this.key(p));
  }

  /** 試験の準備：人が前から預けていた秘密 */
  seed(entry: AliasEntry, value: string): AliasPlace {
    this.aliases.push(entry);
    this.values.set(this.key(entry), value);
    return { implementation: entry.implementation, name: entry.name, ...(entry.group ? { group: entry.group } : {}) };
  }

  async listAliases(callId?: string) {
    this.calls.push({ op: "listAliases", ...(callId ? { callId } : {}) });
    return { aliases: this.aliases.map(({ note: _n, ...a }) => a), failures: [] };
  }
  async resolve(place: AliasPlace, callId?: string) {
    this.calls.push({ op: "resolve", ...(callId ? { callId } : {}) });
    const v = this.values.get(this.key(place));
    if (v === undefined) throw new Error(`alias "${place.name}" not found`);
    return v;
  }
  async createSecret(input: { name: string; value: string; note: string }, callId?: string) {
    this.calls.push({ op: "createSecret", ...(callId ? { callId } : {}) });
    const place = { implementation: "vault-local", name: input.name, group: "instance" };
    if (this.find(place)) throw new Error(`alias "${input.name}" は既に instance にあります`);
    this.aliases.push({ ...place, kind: "secret", note: input.note });
    this.values.set(this.key(place), input.value);
    return place;
  }
  async putOwned(input: { name: string; value: string; note: string }, place: AliasPlace | undefined, callId?: string) {
    this.calls.push({ op: "putOwned", ...(callId ? { callId } : {}) });
    if (this.failPut) throw new Error(this.failPut);
    const at = place ?? { implementation: "vault-local", name: input.name, group: "instance" };
    const existing = this.find(at);
    if (existing && existing.kind !== "oauth-token") throw new Error(`"${at.name}" は人が預けた秘密です`);
    if (!existing) this.aliases.push({ ...at, kind: "oauth-token", note: input.note });
    this.values.set(this.key(at), input.value);
    return at;
  }
  async remove(place: AliasPlace, callId?: string) {
    this.calls.push({ op: "remove", ...(callId ? { callId } : {}) });
    const at = this.aliases.findIndex((a) => this.key(a) === this.key(place));
    if (at < 0) throw new Error(`alias "${place.name}" はありません`);
    this.aliases.splice(at, 1);
    this.values.delete(this.key(place));
  }
}

export class RecordingNotices implements NoticeSink {
  readonly raised: Array<{ key: string; title: string; detail: string }> = [];
  fail: string | undefined;
  async raiseNotice(input: { key: string; title: string; detail: string }) {
    if (this.fail) throw new Error(this.fail);
    this.raised.push(input);
  }
}
