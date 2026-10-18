// ブラウザでログインして Claude のアカウントを足す・ログインし直す・外す（`docs/specs/v4-security.md` §2「Claude の
// アカウントを複数持つ」の 4.）。認可・token・profile の口は偽物（127.0.0.1 の HTTP）で確かめる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { ClaudeAccountStore, HOST_ACCOUNT_ID } from "./accounts.js";
import {
  CLAUDE_AUTHORIZE_URL,
  CLAUDE_MANUAL_REDIRECT_URI,
  ClaudeAccountLogin,
  ClaudeAccountLoginError,
  LOGIN_TTL_MS,
} from "./account-login.js";
import { CLAUDE_CODE_CLIENT_ID } from "./refresh.js";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore } from "../project-thread/store.js";
import { GlobalMemoryStore } from "../global-memory/store.js";
import { InboxStore } from "../inbox/store.js";
import { HostRelayEndpoint, RelayRegistry } from "../relay/host-relay-endpoint.js";
import { AgentRelayEndpoint } from "../relay/agent-relay-endpoint.js";
import { PendingApprovalRegistry } from "../inbox/pending-approvals.js";
import { createApp } from "../http/app.js";
import { AuthStore } from "../auth/store.js";
import { AuthService, SESSION_COOKIE } from "../auth/service.js";
import { writeLoginLink } from "../auth/login-links.js";

/** 偽の token の口と profile の口。どのコードにどのメールアドレスを返すかを試験が決める */
interface FakeOauth {
  base: string;
  /** コード → メールアドレス・契約 */
  codes: Map<string, { email: string; orgType?: string; tier?: string }>;
  /** token の口に来た本文 */
  tokenBodies: Record<string, unknown>[];
  /** 次の token の口の返事を壊す */
  failNext?: number;
  close(): Promise<void>;
}

async function fakeOauth(): Promise<FakeOauth> {
  const codes = new Map<string, { email: string; orgType?: string; tier?: string }>();
  const tokenBodies: Record<string, unknown>[] = [];
  const issued = new Map<string, { email: string; orgType?: string; tier?: string }>();
  let n = 0;
  const fake: FakeOauth = { base: "", codes, tokenBodies, close: async () => {} };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (req.url === "/v1/oauth/token" && req.method === "POST") {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        tokenBodies.push(body);
        if (fake.failNext) {
          const status = fake.failNext;
          fake.failNext = undefined;
          return send(status, { error: "invalid_grant" });
        }
        const who = codes.get(String(body.code));
        if (!who) return send(400, { error: "invalid_grant" });
        codes.delete(String(body.code));
        const access = `at-${++n}`;
        issued.set(access, who);
        return send(200, {
          access_token: access,
          refresh_token: `rt-${n}`,
          expires_in: 28800,
          refresh_token_expires_in: 2592000,
          scope: "user:inference user:profile",
          token_type: "Bearer",
        });
      }
      if (req.url === "/api/oauth/profile" && req.method === "GET") {
        const who = issued.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
        if (!who) return send(401, { error: "unauthorized" });
        return send(200, {
          account: { email: who.email },
          organization: { organization_type: who.orgType ?? "claude_max", rate_limit_tier: who.tier ?? "default_claude_max_5x" },
        });
      }
      send(404, { error: "not found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  fake.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise<void>((r) => server.close(() => r()));
  return fake;
}

async function withLogin(fn: (ctx: { dir: string; store: ClaudeAccountStore; login: ClaudeAccountLogin; oauth: FakeOauth; clock: { now: number }; events: string[] }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "claude-account-login-"));
  const oauth = await fakeOauth();
  try {
    const clock = { now: Date.parse("2026-10-18T00:00:00Z") };
    const store = new ClaudeAccountStore({ dataDir: dir, hostCredentialsPath: join(dir, "host", ".credentials.json"), now: () => new Date(clock.now) });
    const events: string[] = [];
    const login = new ClaudeAccountLogin({
      accounts: store,
      tokenUrl: `${oauth.base}/v1/oauth/token`,
      profileUrl: `${oauth.base}/api/oauth/profile`,
      now: () => clock.now,
      onReplaced: (a) => events.push(`replaced:${a.id}`),
      onRemoved: (id) => events.push(`removed:${id}`),
    });
    await fn({ dir, store, login, oauth, clock, events });
  } finally {
    await oauth.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const stateOf = (url: string) => new URL(url).searchParams.get("state")!;

test("認可の URL は CLI と同じ口・client id・手書きの戻り先で、scope は推論とプロフィールだけ。PKCE は S256", () =>
  withLogin(async ({ login, oauth }) => {
    const started = login.start();
    const u = new URL(started.url);
    assert.equal(`${u.origin}${u.pathname}`, CLAUDE_AUTHORIZE_URL);
    assert.equal(u.searchParams.get("client_id"), CLAUDE_CODE_CLIENT_ID);
    assert.equal(u.searchParams.get("redirect_uri"), CLAUDE_MANUAL_REDIRECT_URI);
    assert.equal(u.searchParams.get("scope"), "user:inference user:profile");
    assert.equal(u.searchParams.get("response_type"), "code");
    assert.equal(u.searchParams.get("code"), "true");
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
    assert.equal(started.expiresAt, "2026-10-18T00:10:00.000Z");
    // 交換のときに送る verifier が challenge に合う
    oauth.codes.set("c1", { email: "a@example.com" });
    await login.finish(started.loginId, `c1#${stateOf(started.url)}`);
    const body = oauth.tokenBodies[0]!;
    assert.equal(body.grant_type, "authorization_code");
    assert.equal(body.client_id, CLAUDE_CODE_CLIENT_ID);
    assert.equal(body.redirect_uri, CLAUDE_MANUAL_REDIRECT_URI);
    assert.equal(body.state, stateOf(started.url));
    assert.equal(createHash("sha256").update(String(body.code_verifier)).digest("base64url"), u.searchParams.get("code_challenge"));
  }));

test("足す：交換して profile を読み、台帳と既定の並びの末尾に載る。置き場は CLI と同じ形（トークンは台帳に書かない）", () =>
  withLogin(async ({ dir, store, login, oauth, clock }) => {
    const started = login.start();
    oauth.codes.set("c1", { email: "a@example.com", orgType: "claude_pro", tier: "default_claude_pro" });
    const { account, replaced } = await login.finish(started.loginId, `  c1#${stateOf(started.url)}\n`);
    assert.equal(replaced, false);
    assert.equal(account.kind, "banto");
    assert.equal(account.email, "a@example.com");
    assert.equal(account.label, "a@example.com");
    assert.equal(account.subscriptionType, "pro");
    assert.equal(account.rateLimitTier, "default_claude_pro");
    assert.deepEqual(store.defaultOrder(), [HOST_ACCOUNT_ID, account.id]);
    const saved = JSON.parse(readFileSync(store.credentialsPathOf(account.id), "utf8")) as { claudeAiOauth: Record<string, unknown> };
    assert.deepEqual(saved.claudeAiOauth, {
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: clock.now + 28800 * 1000,
      scopes: ["user:inference", "user:profile"],
      refreshTokenExpiresAt: clock.now + 2592000 * 1000,
      subscriptionType: "pro",
      rateLimitTier: "default_claude_pro",
    });
    assert.doesNotMatch(readFileSync(join(dir, "claude-accounts.json"), "utf8"), /at-1|rt-1/);
    // 使い切り：同じ手続きはもう使えない
    await assert.rejects(login.finish(started.loginId, `c1#${stateOf(started.url)}`), (e: ClaudeAccountLoginError) => e.code === "unknown");
  }));

test("同じメールアドレスなら足さずに置き換える（ログインし直し）。表示名・並びはそのまま", () =>
  withLogin(async ({ store, login, oauth, events }) => {
    const first = login.start();
    oauth.codes.set("c1", { email: "A@example.com" });
    const a = (await login.finish(first.loginId, `c1#${stateOf(first.url)}`)).account;
    const second = login.start();
    oauth.codes.set("c2", { email: "a@example.com", orgType: "claude_max", tier: "default_claude_max_20x" });
    const again = await login.finish(second.loginId, `c2#${stateOf(second.url)}`);
    assert.equal(again.replaced, true);
    assert.equal(again.account.id, a.id);
    assert.equal(again.account.label, "A@example.com");
    assert.equal(again.account.rateLimitTier, "default_claude_max_20x");
    assert.deepEqual(store.list().map((x) => x.id), [HOST_ACCOUNT_ID, a.id]);
    assert.deepEqual(store.defaultOrder(), [HOST_ACCOUNT_ID, a.id]);
    const saved = JSON.parse(readFileSync(store.credentialsPathOf(a.id), "utf8")) as { claudeAiOauth: { accessToken: string; refreshToken: string } };
    assert.equal(saved.claudeAiOauth.accessToken, "at-2");
    assert.equal(saved.claudeAiOauth.refreshToken, "rt-2");
    assert.deepEqual(events, [`replaced:${a.id}`]);
  }));

test("置き換えは置き場のほかの鍵を残す", () =>
  withLogin(async ({ store, login, oauth }) => {
    const first = login.start();
    oauth.codes.set("c1", { email: "a@example.com" });
    const a = (await login.finish(first.loginId, `c1#${stateOf(first.url)}`)).account;
    const path = store.credentialsPathOf(a.id);
    const whole = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...whole, mcpOAuth: { x: 1 } }), { mode: 0o600 });
    const second = login.start();
    oauth.codes.set("c2", { email: "a@example.com" });
    await login.finish(second.loginId, `c2#${stateOf(second.url)}`);
    assert.deepEqual((JSON.parse(readFileSync(path, "utf8")) as { mcpOAuth: unknown }).mcpOAuth, { x: 1 });
  }));

test("state が違えば交換に行かない。手続きは残り、正しい写しを貼り直せる", () =>
  withLogin(async ({ store, login, oauth }) => {
    const started = login.start();
    oauth.codes.set("c1", { email: "a@example.com" });
    await assert.rejects(login.finish(started.loginId, "c1#not-the-state"), (e: ClaudeAccountLoginError) => e.code === "state-mismatch");
    await assert.rejects(login.finish(started.loginId, "c1"), (e: ClaudeAccountLoginError) => e.code === "malformed");
    assert.equal(oauth.tokenBodies.length, 0);
    assert.equal(store.list().length, 1);
    const ok = await login.finish(started.loginId, `c1#${stateOf(started.url)}`);
    assert.equal(ok.account.email, "a@example.com");
  }));

test("10分を過ぎたら期限切れ（交換に行かない）。ほかの手続きの state では通らない", () =>
  withLogin(async ({ login, oauth, clock }) => {
    const old = login.start();
    const other = login.start();
    clock.now += LOGIN_TTL_MS;
    oauth.codes.set("c1", { email: "a@example.com" });
    await assert.rejects(login.finish(old.loginId, `c1#${stateOf(old.url)}`), (e: ClaudeAccountLoginError) => e.code === "expired");
    // 期限切れを言ったあとは知らない手続き
    await assert.rejects(login.finish(old.loginId, `c1#${stateOf(old.url)}`), (e: ClaudeAccountLoginError) => e.code === "unknown");
    const fresh = login.start();
    await assert.rejects(login.finish(fresh.loginId, `c1#${stateOf(other.url)}`), (e: ClaudeAccountLoginError) => e.code === "state-mismatch");
    assert.equal(oauth.tokenBodies.length, 0);
  }));

test("token の口が断ったら交換の失敗。手続きは使い切り、台帳は変わらない", () =>
  withLogin(async ({ store, login, oauth }) => {
    const started = login.start();
    oauth.codes.set("c1", { email: "a@example.com" });
    oauth.failNext = 400;
    await assert.rejects(login.finish(started.loginId, `c1#${stateOf(started.url)}`), (e: ClaudeAccountLoginError) => e.code === "exchange-failed" && /400 invalid_grant/.test(e.message));
    assert.equal(store.list().length, 1);
    await assert.rejects(login.finish(started.loginId, `c1#${stateOf(started.url)}`), (e: ClaudeAccountLoginError) => e.code === "unknown");
  }));

test("外すと置き場を消し並びから抜く。~/.claude は外せない", () =>
  withLogin(async ({ store, login, oauth, events }) => {
    const started = login.start();
    oauth.codes.set("c1", { email: "a@example.com" });
    const a = (await login.finish(started.loginId, `c1#${stateOf(started.url)}`)).account;
    const path = store.credentialsPathOf(a.id);
    login.remove(a.id);
    assert.equal(existsSync(path), false);
    assert.deepEqual(store.defaultOrder(), [HOST_ACCOUNT_ID]);
    assert.deepEqual(events, [`removed:${a.id}`]);
    assert.throws(() => login.remove(HOST_ACCOUNT_ID), /外せません/);
    assert.deepEqual(store.defaultOrder(), [HOST_ACCOUNT_ID]);
  }));

// ---- HTTP の口（`/api/claude-accounts`）——人のセッションだけ ----

const UI = "http://localhost:4175";
const TOKEN = "machine-token";

test("HTTP：人のセッションで足す・同じメールで置き換え・state 違い・期限切れ・外す。機械の合言葉は断る", () =>
  withLogin(async ({ dir, store, login, oauth, clock }) => {
    const log = new EventLog(dir);
    await log.init();
    const projectThread = new ProjectThreadStore(dir, log);
    await projectThread.load();
    const globalMemory = new GlobalMemoryStore(dir, log);
    await globalMemory.load();
    const inbox = new InboxStore(dir, log);
    await inbox.load();
    const authStore = new AuthStore(dir, log, () => clock.now);
    await authStore.load();
    const server = createApp({
      projectThread,
      globalMemory,
      inbox,
      pendingApprovals: new PendingApprovalRegistry(),
      relayEndpoint: new HostRelayEndpoint({ registry: new RelayRegistry() }),
      agentRelayEndpoint: new AgentRelayEndpoint(TOKEN),
      authToken: TOKEN,
      auth: new AuthService({ store: authStore, dataDir: dir, authToken: TOKEN, uiOrigin: UI, apiBaseUrl: "http://localhost:4737", now: () => clock.now }),
      claudeAccounts: { store, login },
      resolveModulesForThread: async () => [],
      dataDir: dir,
      configDir: dir,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const ui = (path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) =>
        fetch(`${base}${path}`, {
          method: init.method ?? "GET",
          headers: { "content-type": "application/json", "x-banto-client": "1", origin: UI, ...(init.cookie ? { cookie: init.cookie } : {}) },
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        });
      const machine = (path: string, method = "GET") => fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}` } });
      const { code } = await writeLoginLink(dir, clock.now);
      const redeemed = await ui("/api/auth/redeem", { method: "POST", body: { code } });
      assert.equal(redeemed.status, 200, await redeemed.clone().text());
      const cookie = redeemed.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!.split(";")[0]!;

      // 機械の合言葉（Module・AI の道）では、読むことも始めることもできない
      assert.equal((await machine("/api/claude-accounts")).status, 403);
      assert.equal((await machine("/api/claude-accounts/login", "POST")).status, 403);
      // ログインしていなければ 401
      assert.equal((await ui("/api/claude-accounts")).status, 401);

      const start = async () => (await (await ui("/api/claude-accounts/login", { method: "POST", cookie })).json()) as { loginId: string; url: string };
      const finish = (loginId: string, pasted: string) => ui(`/api/claude-accounts/login/${loginId}`, { method: "POST", cookie, body: { pasted } });

      // 足す
      const s1 = await start();
      oauth.codes.set("c1", { email: "a@example.com" });
      const added = await finish(s1.loginId, `c1#${stateOf(s1.url)}`);
      assert.equal(added.status, 200, await added.clone().text());
      const addedBody = (await added.json()) as { account: { id: string; email: string; kind: string }; replaced: boolean };
      assert.equal(addedBody.replaced, false);
      assert.equal(addedBody.account.email, "a@example.com");
      const listed = (await (await ui("/api/claude-accounts", { cookie })).json()) as { accounts: { id: string }[]; defaultOrder: string[] };
      assert.deepEqual(listed.accounts.map((a) => a.id), [HOST_ACCOUNT_ID, addedBody.account.id]);
      assert.deepEqual(listed.defaultOrder, [HOST_ACCOUNT_ID, addedBody.account.id]);
      assert.doesNotMatch(JSON.stringify(listed), /at-1|rt-1/);

      // state 違い（400、code で分ける）→ 同じ手続きで正しい写しなら通る（同じメールなので置き換え）
      const s2 = await start();
      oauth.codes.set("c2", { email: "a@example.com" });
      const mismatch = await finish(s2.loginId, "c2#wrong");
      assert.equal(mismatch.status, 400);
      assert.equal(((await mismatch.json()) as { code: string }).code, "state-mismatch");
      const replaced = await finish(s2.loginId, `c2#${stateOf(s2.url)}`);
      assert.equal(replaced.status, 200);
      const replacedBody = (await replaced.json()) as { account: { id: string }; replaced: boolean };
      assert.equal(replacedBody.replaced, true);
      assert.equal(replacedBody.account.id, addedBody.account.id);
      assert.equal(store.list().length, 2);

      // 期限切れ（410）
      const s3 = await start();
      clock.now += LOGIN_TTL_MS + 1;
      oauth.codes.set("c3", { email: "b@example.com" });
      const expired = await finish(s3.loginId, `c3#${stateOf(s3.url)}`);
      assert.equal(expired.status, 410);
      assert.equal(((await expired.json()) as { code: string }).code, "expired");
      assert.equal(oauth.tokenBodies.length, 2);

      // 外す。~/.claude は外せない。知らないものは 404
      assert.equal((await ui(`/api/claude-accounts/${HOST_ACCOUNT_ID}`, { method: "DELETE", cookie })).status, 400);
      assert.equal((await machine(`/api/claude-accounts/${addedBody.account.id}`, "DELETE")).status, 403);
      const removed = await ui(`/api/claude-accounts/${addedBody.account.id}`, { method: "DELETE", cookie });
      assert.equal(removed.status, 200);
      assert.equal((await ui(`/api/claude-accounts/${addedBody.account.id}`, { method: "DELETE", cookie })).status, 404);
      const after = (await (await ui("/api/claude-accounts", { cookie })).json()) as { accounts: { id: string }[]; defaultOrder: string[] };
      assert.deepEqual(after.accounts.map((a) => a.id), [HOST_ACCOUNT_ID]);
      assert.deepEqual(after.defaultOrder, [HOST_ACCOUNT_ID]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }));
