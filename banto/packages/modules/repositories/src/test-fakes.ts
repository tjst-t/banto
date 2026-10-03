// 試験のための偽物：**偽の GitHub（本物の HTTP で立てる）**・Vault・受信箱。試験からだけ使う（index から出さない）。
//
// 偽の GitHub は本物と同じ話し方をする——form で受け、`{error}` を 200 で返し、refresh token は**1回使うと無効**
// （回る）。同時に2本が同じ鍵で更新すると、片方は `bad_refresh_token` で負ける（本物と同じ）。

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  /** デバイスフローの問いへの返事を遅らせる（聞いている間にやめる試験） */
  pollDelayMs: number;
  /** 更新を断らせる（`bad_refresh_token` 等） */
  refreshError: string | undefined;
  refreshCalls: number;
  /**
   * リポジトリ（`owner/name` の小文字 → 非公開か・読める login）。中身は `gitRoot` の bare リポジトリで、
   * **本物の git が HTTP で clone できる**（`git http-backend` を CGI で動かす）
   */
  repos: Map<string, RepoOpts>;
  gitRoot: string;
  /** git の要求（パスと Authorization の見出し）——資格情報が渡ったかを試験が見る */
  gitRequests: Array<{ path: string; authorization?: string }>;
  /** git の要求への返事を遅らせる（clone の最中を試験が見るため） */
  gitDelayMs: number;
  /** classic PAT の scope（`X-OAuth-Scopes` で返す）。無いトークンは fine-grained PAT か GitHub App のもの */
  tokenScopes: Map<string, string>;
  /**
   * GitHub App のトークン（`ghu_` で始まる——デバイスフローで出したもの）の login → App が入っている先と Administration の権限。
   * 無ければ、その login 自身に Administration（write）で入っている
   */
  installations: Map<string, Array<{ account: string; administration?: "read" | "write" }>>;
  /** fine-grained PAT で Administration の権限が無いもの（作ると 403） */
  noAdministration: Set<string>;
  /** Organization（小文字 → login・メンバーの役割・メンバーが作れるか） */
  orgs: Map<string, FakeOrg>;
  /** push を断るリポジトリ（`owner/name` の小文字。push の失敗の試験） */
  rejectPush: Set<string>;
  /** 頼まれた公開範囲を無視して公開で作る（作られた範囲の食い違いの試験） */
  forcePublic: boolean;
  /** 作ったあと、返事を返さずに接続を切る（作れたか分からない、の試験） */
  dropAfterCreate: boolean;
  /** 作ったリポジトリ（`owner/name`。試験が見る） */
  created: Array<{ owner: string; name: string; private: boolean; description?: string; by: string }>;
  /** リポジトリを作る（1コミット入り） */
  addRepo(owner: string, name: string, opts?: { private?: boolean; readers?: string[]; writers?: string[]; files?: Record<string, string>; redirectTo?: string }): void;
  close(): Promise<void>;
}

export interface FakeOrg {
  login: string;
  /** login の小文字 → 役割 */
  members: Map<string, "admin" | "member">;
  membersCanCreate: boolean;
}

interface RepoOpts {
  private: boolean;
  readers: string[];
  /** 持ち主のほかに書ける login */
  writers?: string[];
  /** git の要求を、別の相手（`<base>`）の同じパスへ 302 で送る（リダイレクトの先に資格情報を渡さないかを見る） */
  redirectTo?: string;
}

/** 試験の https の偽物のための、その場限りの自己署名の証明書（127.0.0.1・localhost） */
export function makeTlsCert(dir: string): { key: string; cert: string; certPath: string } {
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
  return { key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8"), certPath: cert };
}

/** HTTP の Basic の見出しから password を取り出す */
function basicPassword(header: string | undefined): string | undefined {
  const m = (header ?? "").match(/^Basic (.+)$/);
  if (!m) return undefined;
  const decoded = Buffer.from(m[1]!, "base64").toString("utf8");
  return decoded.slice(decoded.indexOf(":") + 1);
}

export const FAKE_CLIENT_ID = "Iv23liFAKECLIENT";

export async function startFakeGithub(opts: { gitRoot?: string; tls?: { key: string; cert: string } } = {}): Promise<FakeGithub> {
  let seq = 0;
  const gitRoot = opts.gitRoot ?? mkdtempSync(join(tmpdir(), "banto-fake-github-git-"));
  const repos = new Map<string, RepoOpts>();
  const state: Omit<FakeGithub, "endpoints" | "close" | "addRepo"> = {
    repos,
    gitRoot,
    gitRequests: [],
    gitDelayMs: 0,
    requests: [],
    script: ["pending", "authorized"],
    loginForDevice: "tjst-t",
    accessTokenTtl: 8 * 3600,
    users: new Map(),
    refreshTokens: new Map(),
    refreshDelayMs: 0,
    pollDelayMs: 0,
    refreshError: undefined,
    refreshCalls: 0,
    tokenScopes: new Map(),
    installations: new Map(),
    noAdministration: new Set(),
    orgs: new Map(),
    rejectPush: new Set(),
    forcePublic: false,
    dropAfterCreate: false,
    created: [],
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

  const handler = (req: IncomingMessage, res: ServerResponse) => {
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
            if (state.pollDelayMs > 0) await new Promise((r) => setTimeout(r, state.pollDelayMs));
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
          const add = (patch as { addRepo?: { owner: string; name: string; private?: boolean; readers?: string[]; writers?: string[] } }).addRepo;
          if (add) addRepo(add.owner, add.name, add);
          const org = (patch as { addOrg?: { login: string; members: Record<string, "admin" | "member">; membersCanCreate: boolean } }).addOrg;
          if (org) {
            state.orgs.set(org.login.toLowerCase(), {
              login: org.login,
              members: new Map(Object.entries(org.members).map(([k, v]) => [k.toLowerCase(), v])),
              membersCanCreate: org.membersCanCreate,
            });
          }
          const reject = (patch as { rejectPush?: { repo: string; on: boolean } }).rejectPush;
          if (reject) {
            if (reject.on) state.rejectPush.add(reject.repo.toLowerCase());
            else state.rejectPush.delete(reject.repo.toLowerCase());
          }
          // 作ったリポジトリも返す（E2E が、頼んだ公開範囲・持ち主で作られたかを見る）
          return send(200, { refreshCalls: state.refreshCalls, created: state.created });
        }
        // ── git（smart HTTP）。GitHub と同じく、資格情報が無ければ 401、見えなければ 404 ──
        const gitPath = url.pathname.match(/^\/([^/]+)\/([^/]+?)\.git(\/.*)$/);
        if (gitPath) {
          state.gitRequests.push({ path: url.pathname, ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) });
          if (state.gitDelayMs > 0) await new Promise((r) => setTimeout(r, state.gitDelayMs));
          const key = `${gitPath[1]}/${gitPath[2]}`.toLowerCase();
          const repo = repos.get(key);
          if (repo?.redirectTo) {
            res.writeHead(302, { location: `${repo.redirectTo}${url.pathname}${url.search}` });
            return res.end();
          }
          const password = basicPassword(req.headers.authorization);
          const login = password ? state.users.get(password) : undefined;
          // push（receive-pack）はいつも資格情報が要り、書ける login（持ち主・writers）だけ
          const pushing = url.searchParams.get("service") === "git-receive-pack" || gitPath[3] === "/git-receive-pack";
          if (pushing) {
            if (!login) {
              res.writeHead(401, { "www-authenticate": 'Basic realm="GitHub"' });
              return res.end();
            }
            const canWrite = !!repo && (gitPath[1]!.toLowerCase() === login.toLowerCase() || (repo.writers ?? []).some((w) => w.toLowerCase() === login.toLowerCase()));
            if (!repo || !canWrite || state.rejectPush.has(key)) {
              res.writeHead(403, { "content-type": "text/plain" });
              return res.end(`Permission to ${gitPath[1]}/${gitPath[2]}.git denied to ${login}.`);
            }
          }
          if (!repo || repo.private) {
            if (!password) {
              res.writeHead(401, { "www-authenticate": 'Basic realm="GitHub"' });
              return res.end();
            }
            if (!login) {
              res.writeHead(401, { "www-authenticate": 'Basic realm="GitHub"' });
              return res.end("Invalid username or token.");
            }
            if (!repo || !repo.readers.some((r) => r.toLowerCase() === login.toLowerCase())) {
              res.writeHead(404, { "content-type": "text/plain" });
              return res.end("Repository not found.");
            }
          }
          const cgi = spawn("git", ["http-backend"], {
            env: {
              PATH: process.env.PATH ?? "",
              GIT_PROJECT_ROOT: gitRoot,
              GIT_HTTP_EXPORT_ALL: "1",
              PATH_INFO: `/${gitPath[1]}/${gitPath[2]}.git${gitPath[3]}`,
              QUERY_STRING: url.search.slice(1),
              REQUEST_METHOD: req.method ?? "GET",
              CONTENT_TYPE: req.headers["content-type"] ?? "",
              ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"]) } : {}),
              ...(req.headers["git-protocol"] ? { GIT_PROTOCOL: String(req.headers["git-protocol"]) } : {}),
              REMOTE_ADDR: "127.0.0.1",
              // http-backend は REMOTE_USER があるときだけ push を受ける（上で確かめた login）
              ...(pushing && login ? { REMOTE_USER: login } : {}),
            },
            stdio: ["pipe", "pipe", "ignore"],
          });
          cgi.stdin.end(Buffer.concat(chunks));
          const out: Buffer[] = [];
          cgi.stdout.on("data", (c: Buffer) => out.push(c));
          cgi.on("close", () => {
            const all = Buffer.concat(out);
            const split = all.indexOf("\r\n\r\n");
            const head = all.subarray(0, split).toString("utf8").split("\r\n");
            const headers: Record<string, string> = {};
            let status = 200;
            for (const line of head) {
              const at = line.indexOf(":");
              const k = line.slice(0, at).trim();
              const v = line.slice(at + 1).trim();
              if (k.toLowerCase() === "status") status = Number.parseInt(v, 10);
              else if (k) headers[k] = v;
            }
            res.writeHead(status, headers);
            res.end(all.subarray(split + 4));
          });
          return;
        }
        if (url.pathname.startsWith("/repos/") && req.method === "GET") {
          const [, , owner, name] = url.pathname.split("/");
          const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
          const login = state.users.get(token);
          if (!login) return send(401, { message: "Bad credentials" });
          const repo = repos.get(`${owner}/${name}`.toLowerCase());
          const visible = repo && (!repo.private || repo.readers.some((r) => r.toLowerCase() === login.toLowerCase()));
          if (!visible) return send(404, { message: "Not Found" });
          // 書けるのは持ち主と writers（GitHub の permissions と同じ形）
          const push = owner!.toLowerCase() === login.toLowerCase() || (repo.writers ?? []).some((w) => w.toLowerCase() === login.toLowerCase());
          return send(200, { full_name: `${owner}/${name}`, private: repo.private, permissions: { admin: push, push, pull: true } });
        }
        if (url.pathname === "/user" && req.method === "GET") {
          const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
          const login = state.users.get(token);
          if (!login) return send(401, { message: "Bad credentials" });
          // classic PAT だけが scope の見出しを返す（本物と同じ）
          const scopes = state.tokenScopes.get(token);
          res.writeHead(200, { "content-type": "application/json", ...(scopes !== undefined ? { "x-oauth-scopes": scopes } : {}) });
          return res.end(JSON.stringify({ login, id: 1 }));
        }
        // ── 公開（段階5）：持ち主の候補と、リポジトリを作る ──
        const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
        const me = state.users.get(bearer);
        const isApp = bearer.startsWith("ghu_");
        const installationsOf = (login: string) => state.installations.get(login.toLowerCase()) ?? [{ account: login, administration: "write" as const }];
        if (url.pathname === "/user/installations" && req.method === "GET") {
          if (!me) return send(401, { message: "Bad credentials" });
          if (!isApp) return send(403, { message: "Resource not accessible by personal access token" });
          return send(200, {
            total_count: installationsOf(me).length,
            installations: installationsOf(me).map((i) => ({ account: { login: i.account }, permissions: i.administration ? { administration: i.administration } : {} })),
          });
        }
        if (url.pathname === "/user/orgs" && req.method === "GET") {
          if (!me) return send(401, { message: "Bad credentials" });
          return send(200, [...state.orgs.values()].filter((o) => o.members.has(me.toLowerCase())).map((o) => ({ login: o.login })));
        }
        const membership = url.pathname.match(/^\/user\/memberships\/orgs\/([^/]+)$/);
        if (membership && req.method === "GET") {
          if (!me) return send(401, { message: "Bad credentials" });
          const org = state.orgs.get(decodeURIComponent(membership[1]!).toLowerCase());
          const role = org?.members.get(me.toLowerCase());
          if (!org || !role) return send(404, { message: "Not Found" });
          return send(200, { state: "active", role, organization: { login: org.login } });
        }
        const orgInfo = url.pathname.match(/^\/orgs\/([^/]+)$/);
        if (orgInfo && req.method === "GET") {
          if (!me) return send(401, { message: "Bad credentials" });
          const org = state.orgs.get(decodeURIComponent(orgInfo[1]!).toLowerCase());
          if (!org || !org.members.has(me.toLowerCase())) return send(404, { message: "Not Found" });
          return send(200, { login: org.login, members_can_create_repositories: org.membersCanCreate });
        }
        const orgRepos = url.pathname.match(/^\/orgs\/([^/]+)\/repos$/);
        if ((url.pathname === "/user/repos" || orgRepos) && req.method === "POST") {
          if (!me) return send(401, { message: "Bad credentials" });
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { name?: string; private?: boolean; description?: string; auto_init?: boolean };
          let owner = me;
          if (orgRepos) {
            const org = state.orgs.get(decodeURIComponent(orgRepos[1]!).toLowerCase());
            const role = org?.members.get(me.toLowerCase());
            if (!org || !role) return send(404, { message: "Not Found" });
            owner = org.login;
            if (role !== "admin" && !org.membersCanCreate) {
              return send(403, { message: "You need admin access to the organization before adding a repository to it." });
            }
          }
          if (isApp) {
            const inst = installationsOf(me).find((i) => i.account.toLowerCase() === owner.toLowerCase());
            if (!inst || inst.administration !== "write") return send(403, { message: "Resource not accessible by integration" });
          } else if (state.tokenScopes.has(bearer)) {
            const scopes = state.tokenScopes.get(bearer)!;
            if (!/\brepo\b/.test(scopes) && !(scopes.includes("public_repo") && !body.private)) return send(404, { message: "Not Found" });
          } else if (state.noAdministration.has(bearer)) {
            return send(403, { message: "Resource not accessible by personal access token" });
          }
          const name = body.name ?? "";
          const key = `${owner}/${name}`.toLowerCase();
          if (repos.has(key)) {
            return send(422, {
              message: "Repository creation failed.",
              errors: [{ resource: "Repository", code: "custom", field: "name", message: "name already exists on this account" }],
            });
          }
          // 空のリポジトリ（README 等は作らない）——本物の git が push できる
          mkdirSync(join(gitRoot, owner), { recursive: true });
          execFileSync("git", ["init", "-q", "--bare", join(gitRoot, owner, `${name}.git`)], { stdio: "ignore" });
          const isPrivate = body.private === true && !state.forcePublic;
          repos.set(key, { private: isPrivate, readers: [owner, me], writers: [me] });
          state.created.push({ owner, name, private: isPrivate, ...(body.description ? { description: body.description } : {}), by: me });
          if (state.dropAfterCreate) {
            req.socket.destroy();
            return;
          }
          return send(201, {
            name,
            full_name: `${owner}/${name}`,
            owner: { login: owner },
            private: isPrivate,
            html_url: `https://github.com/${owner}/${name}`,
          });
        }
        send(404, { message: "Not Found" });
      })();
    });
  };
  const server: Server = opts.tls ? createHttpsServer(opts.tls, handler) : createServer(handler);
  function addRepo(owner: string, name: string, o: { private?: boolean; readers?: string[]; writers?: string[]; files?: Record<string, string>; redirectTo?: string } = {}): void {
    const bare = join(gitRoot, owner, `${name}.git`);
    const work = mkdtempSync(join(tmpdir(), "banto-fake-github-work-"));
    const g = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.name=fake", "-c", "user.email=fake@example.com", "-c", "init.defaultBranch=main", ...args], {
        cwd,
        stdio: "ignore",
      });
    g(work, "init", "-q");
    writeFileSync(join(work, "README.md"), `# ${owner}/${name}\n`);
    for (const [f, body] of Object.entries(o.files ?? {})) writeFileSync(join(work, f), body);
    g(work, "add", ".");
    g(work, "commit", "-q", "-m", "first");
    mkdirSync(join(gitRoot, owner), { recursive: true });
    g(work, "clone", "-q", "--bare", work, bare);
    repos.set(`${owner}/${name}`.toLowerCase(), {
      private: o.private ?? false,
      readers: o.readers ?? [owner],
      ...(o.writers ? { writers: o.writers } : {}),
      ...(o.redirectTo ? { redirectTo: o.redirectTo } : {}),
    });
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `${opts.tls ? "https" : "http"}://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return Object.assign(state, {
    endpoints: { web: base, api: base },
    addRepo,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}

/** Vault の偽物。**置いた値は `values` にだけある**——ほかの場所（返り値・台帳）に出ていないかを試験が照らす */
export class MemoryVault implements VaultAccess {
  readonly aliases: Array<AliasEntry & { note?: string }> = [];
  readonly values = new Map<string, string>();
  readonly calls: Array<{ op: string; callId?: string }> = [];
  failPut: string | undefined;
  /** 読めない Vault（目録の `failures` に出す） */
  readonly failures: Array<{ implementation: string; error: string }> = [];

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
    return {
      aliases: this.aliases.filter((a) => !this.failures.some((f) => f.implementation === a.implementation)).map(({ note: _n, ...a }) => a),
      failures: [...this.failures],
    };
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
  /** ssh-agent の窓口を頼まれた鍵（試験が見る） */
  readonly agents: AliasPlace[] = [];
  agentSocket = "/tmp/banto-fake-agent.sock";
  async startSshAgent(place: AliasPlace, callId?: string) {
    this.calls.push({ op: "startSshAgent", ...(callId ? { callId } : {}) });
    if (!this.find(place)) throw new Error(`identity "${place.name}" not found`);
    this.agents.push(place);
    return { socketPath: this.agentSocket };
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
