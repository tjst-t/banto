import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, createServer, request, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_LOGIN_PATH, ClaudeLoginRelay, hostClaudeCredentialsPath, type ClaudeLoginListener, type ClaudeLoginRelayDeps } from "./relay.js";
import { createRelayListener } from "../relay/relay-listener.js";
import { ClaudeAccountStore } from "./accounts.js";

/** 台帳と最初の1つの置き場（試験の置き場を指す） */
const accountsAt = (dataDir: string, hostCredentialsPath: string, now?: () => Date) =>
  new ClaudeAccountStore({ dataDir, hostCredentialsPath, ...(now ? { now } : {}) });

const CORE: ClaudeLoginListener = { acceptsProject: () => true, bindSource: true, acceptsRunner: true };

// 本体の CLI と同じ順で置き場を決める——E2E・疎通確認は CLAUDE_SECURESTORAGE_CONFIG_DIR で本物を指す
test("本体の資格情報の置き場は、CLI と同じ順で決まる", () => {
  assert.equal(hostClaudeCredentialsPath({ CLAUDE_SECURESTORAGE_CONFIG_DIR: "/s", CLAUDE_CONFIG_DIR: "/c" }), "/s/.credentials.json");
  assert.equal(hostClaudeCredentialsPath({ CLAUDE_CONFIG_DIR: "/c" }), "/c/.credentials.json");
  assert.equal(hostClaudeCredentialsPath({}), join(homedir(), ".claude", ".credentials.json"));
});

interface Fixture {
  relay: ClaudeLoginRelay;
  accounts: ClaudeAccountStore;
  /** 中継を載せた待ち受け（core の口と同じ形） */
  url: string;
  seen: { url: string; auth: string; beta: string }[];
  /** 上流に届いた Thread の印（中継が剥がすので、届けば undefined 以外） */
  seenThreadHeader: Array<string | undefined>;
  enabled: Set<string>;
  dir: string;
  unauthorized: string[];
  authorized: { count: number };
  upstreamStatus: { value: number };
  /** 上流が返す見出し（使用率） */
  upstreamHeaders: { value: Record<string, string> };
  /** これを決めると、上流はこのトークンのときだけ 200・ほかは 401（upstreamStatus より優先） */
  upstreamAccepts: { value: string | undefined };
  /** トークンごとの返事（決めたトークンでは upstreamStatus・upstreamHeaders より優先） */
  upstreamByToken: { value: Record<string, { status?: number; headers?: Record<string, string> }> };
  /** 上流が返す前に1回呼ぶ（本体の CLI が途中で書き換えた形を作る） */
  beforeUpstreamReply: { fn: (() => void) | undefined };
  /** 偽の取り直しの口が返すもの（既定は 400 invalid_grant） */
  tokenReply: { status: number; body: unknown };
  tokenCalls: unknown[];
  close(): Promise<void>;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function fixture(
  overrides: Partial<ClaudeLoginRelayDeps> & { credentialsPath?: string } = {},
  listener: ClaudeLoginListener = CORE,
): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "claude-login-relay-"));
  writeFileSync(
    join(dir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "REAL-ACCESS", refreshToken: "never-leaves", subscriptionType: "max", rateLimitTier: "tier-x" } }),
  );
  const seen: Fixture["seen"] = [];
  const seenThreadHeader: Fixture["seenThreadHeader"] = [];
  const upstreamStatus = { value: 200 };
  const upstreamHeaders: Fixture["upstreamHeaders"] = { value: {} };
  const upstreamAccepts: Fixture["upstreamAccepts"] = { value: undefined };
  const beforeUpstreamReply: Fixture["beforeUpstreamReply"] = { fn: undefined };
  const upstreamByToken: Fixture["upstreamByToken"] = { value: {} };
  const upstream = createServer((req, res) => {
    seen.push({ url: req.url ?? "", auth: req.headers.authorization ?? "", beta: String(req.headers["anthropic-beta"] ?? "") });
    seenThreadHeader.push(req.headers["x-banto-thread-id"] as string | undefined);
    const hook = beforeUpstreamReply.fn;
    beforeUpstreamReply.fn = undefined;
    hook?.();
    const byToken = upstreamByToken.value[(req.headers.authorization ?? "").replace(/^Bearer /, "")];
    const status =
      byToken?.status ??
      (upstreamAccepts.value === undefined ? upstreamStatus.value : req.headers.authorization === `Bearer ${upstreamAccepts.value}` ? 200 : 401);
    res.writeHead(status, { "content-type": "application/json", ...(byToken?.headers ?? upstreamHeaders.value) }).end('{"ok":"upstream"}');
  });
  const upstreamUrl = await listen(upstream);
  const tokenReply: Fixture["tokenReply"] = { status: 400, body: { error: "invalid_grant" } };
  const tokenCalls: unknown[] = [];
  const tokenServer = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      tokenCalls.push(JSON.parse(raw));
      res.writeHead(tokenReply.status, { "content-type": "application/json" }).end(JSON.stringify(tokenReply.body));
    });
  });
  const tokenUrl = await listen(tokenServer);
  const authorized = { count: 0 };
  const enabled = new Set(["p1", "p2"]);
  const unauthorized: string[] = [];
  const { credentialsPath, ...rest } = overrides;
  const accounts = accountsAt(dir, credentialsPath ?? join(dir, ".credentials.json"), () => new Date("2026-10-08T00:00:00Z"));
  const relay = new ClaudeLoginRelay({
    accounts,
    secretsPath: join(dir, "secrets.json"),
    upstream: upstreamUrl,
    enabled: (id) => enabled.has(id),
    sourceMatches: async () => true,
    onUpstreamUnauthorized: (id) => unauthorized.push(id),
    onUpstreamAuthorized: () => authorized.count++,
    tokenUrl: `${tokenUrl}/v1/oauth/token`,
    now: () => new Date("2026-10-08T00:00:00Z"),
    ...rest,
  });
  const front = createServer((req, res) => void relay.handle(req, res, listener));
  const url = await listen(front);
  return {
    relay,
    accounts,
    url,
    seen,
    seenThreadHeader,
    enabled,
    dir,
    unauthorized,
    authorized,
    upstreamStatus,
    upstreamHeaders,
    upstreamAccepts,
    upstreamByToken,
    beforeUpstreamReply,
    tokenReply,
    tokenCalls,
    close: async () => {
      front.closeAllConnections();
      upstream.closeAllConnections();
      tokenServer.closeAllConnections();
      await Promise.all([new Promise((r) => front.close(r)), new Promise((r) => upstream.close(r)), new Promise((r) => tokenServer.close(r))]);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const post = (url: string, secret: string, path = "/v1/messages?beta=true", extra: Record<string, string> = {}) =>
  fetch(`${url}${CLAUDE_LOGIN_PATH}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "anthropic-beta": "oauth-2025-04-20", ...extra },
    body: "{}",
  });

/** 決まった接続（agent）で送り、本文を読み切って状態を返す */
function postOn(agent: Agent, url: string, secret: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(`${url}${CLAUDE_LOGIN_PATH}/v1/messages`, { method: "POST", agent, headers: { authorization: `Bearer ${secret}` } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end("{}");
  });
}

test("コンテナの環境：住所・その Project の合言葉・契約の種類。本物のトークンは入らない", async () => {
  const f = await fixture();
  try {
    const env = (await f.relay.envFor("p1", "http://10.0.0.1:4737"))!;
    assert.equal(env.ANTHROPIC_BASE_URL, "http://10.0.0.1:4737/claude-login");
    assert.match(env.CLAUDE_CODE_OAUTH_TOKEN!, /^banto-/);
    assert.equal(env.CLAUDE_CODE_SUBSCRIPTION_TYPE, "max");
    assert.equal(env.CLAUDE_CODE_RATE_LIMIT_TIER, "tier-x");
    assert.doesNotMatch(JSON.stringify(env), /REAL-ACCESS|never-leaves/);
    // Project ごとに別の合言葉
    assert.notEqual((await f.relay.envFor("p2", "http://x"))!.CLAUDE_CODE_OAUTH_TOKEN, env.CLAUDE_CODE_OAUTH_TOKEN);
    // 置き場は本人だけが読める
    assert.equal(statSync(join(f.dir, "secrets.json")).mode & 0o777, 0o600);
  } finally {
    await f.close();
  }
});

test("合言葉は固定：起こし直しても同じ。スイッチを切った時点で無効、入れ直すと新しいもの", async () => {
  const f = await fixture();
  try {
    const first = (await f.relay.envFor("p1", "http://x"))!.CLAUDE_CODE_OAUTH_TOKEN!;
    assert.equal((await f.relay.envFor("p1", "http://x"))!.CLAUDE_CODE_OAUTH_TOKEN, first);
    // banto を起こし直した（置き場から読み直す）——Service がコンテナの起動で勝手に起きても、同じ合言葉で通る
    const again = new ClaudeLoginRelay({
      accounts: accountsAt(f.dir, join(f.dir, ".credentials.json")),
      secretsPath: join(f.dir, "secrets.json"),
      enabled: () => true,
    });
    assert.equal((await again.envFor("p1", "http://x"))!.CLAUDE_CODE_OAUTH_TOKEN, first);

    assert.equal((await post(f.url, first)).status, 200);
    // 切る：環境に入れない・その時点で断る
    f.enabled.delete("p1");
    assert.equal(await f.relay.envFor("p1", "http://x"), undefined);
    assert.equal((await post(f.url, first)).status, 401);
    assert.doesNotMatch(readFileSync(join(f.dir, "secrets.json"), "utf8"), new RegExp(first));
    // 入れ直す：新しい合言葉。古いものは通らない
    f.enabled.add("p1");
    const second = (await f.relay.envFor("p1", "http://x"))!.CLAUDE_CODE_OAUTH_TOKEN!;
    assert.notEqual(second, first);
    assert.equal((await post(f.url, first)).status, 401);
    assert.equal((await post(f.url, second)).status, 200);
  } finally {
    await f.close();
  }
});

test("中継：上流には本物のトークン、beta 見出しはそのまま、推論以外は断る。回数と最終時刻を数える", async () => {
  const f = await fixture();
  try {
    const secret = (await f.relay.envFor("p1", "http://x"))!.CLAUDE_CODE_OAUTH_TOKEN!;
    assert.deepEqual(f.relay.statsFor("p1"), { requests: 0 });
    const ok = await post(f.url, secret);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: "upstream" });
    assert.deepEqual(f.seen, [{ url: "/v1/messages?beta=true", auth: "Bearer REAL-ACCESS", beta: "oauth-2025-04-20" }]);
    assert.equal((await post(f.url, secret, "/v1/messages/count_tokens")).status, 200);
    // 推論以外は上流へ出さない（本体のトークンは会話の履歴やコネクタにも触れる広さを持つ）
    const other = await post(f.url, secret, "/api/oauth/profile");
    assert.equal(other.status, 403);
    assert.match(JSON.stringify(await other.json()), /推論/);
    assert.equal(f.seen.length, 2);
    // 合言葉が違えば 401
    assert.equal((await post(f.url, "nope")).status, 401);
    assert.deepEqual(f.relay.statsFor("p1"), { requests: 2, lastRequestAt: "2026-10-08T00:00:00.000Z" });
    assert.deepEqual(f.relay.statsFor("p2"), { requests: 0 });
  } finally {
    await f.close();
  }
});

test("上流が 401 で、取り直しも断られた：直近の 401 を覚え、理由つきで知らせる（試し直しは1回だけ）", async () => {
  const f = await fixture();
  try {
    const secret = (await f.relay.envFor("p1", "http://x"))!.CLAUDE_CODE_OAUTH_TOKEN!;
    f.upstreamStatus.value = 401;
    assert.equal((await post(f.url, secret)).status, 401);
    assert.deepEqual(f.relay.statsFor("p1"), {
      requests: 1,
      lastRequestAt: "2026-10-08T00:00:00.000Z",
      lastUnauthorizedAt: "2026-10-08T00:00:00.000Z",
    });
    assert.deepEqual(f.unauthorized, ["p1"]);
    // 取り直しを1回だけ頼み（置き場の refresh token・公開の client id）、上流へは1回だけ
    assert.equal(f.tokenCalls.length, 1);
    assert.deepEqual(f.tokenCalls[0], { grant_type: "refresh_token", refresh_token: "never-leaves", client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e" });
    assert.equal(f.seen.length, 1);
  } finally {
    await f.close();
  }
});

test("上流が 401 でも、取り直して1回だけ送り直せば通る：知らせず、置き場に書き戻す", async () => {
  const f = await fixture();
  try {
    const secret = (await f.relay.envFor("p1", "http://x"))!.CLAUDE_CODE_OAUTH_TOKEN!;
    f.upstreamAccepts.value = "NEW-ACCESS";
    f.tokenReply.status = 200;
    f.tokenReply.body = { access_token: "NEW-ACCESS", refresh_token: "NEW-REFRESH", expires_in: 3600 };
    const r = await post(f.url, secret);
    assert.equal(r.status, 200);
    assert.deepEqual(f.seen.map((x) => x.auth), ["Bearer REAL-ACCESS", "Bearer NEW-ACCESS"]);
    assert.deepEqual(f.unauthorized, []);
    const saved = JSON.parse(readFileSync(join(f.dir, ".credentials.json"), "utf8")).claudeAiOauth;
    assert.equal(saved.accessToken, "NEW-ACCESS");
    assert.equal(saved.refreshToken, "NEW-REFRESH");
    // ほかの欄はそのまま
    assert.equal(saved.subscriptionType, "max");
  } finally {
    await f.close();
  }
});

test("上流が 401 でも、置き場のトークンが替わっていれば（本体が取り直した）取り直さずにそれで送り直す", async () => {
  const f = await fixture();
  try {
    const secret = (await f.relay.envFor("p1", "http://x"))!.CLAUDE_CODE_OAUTH_TOKEN!;
    f.upstreamAccepts.value = "CLI-REFRESHED";
    // 1回目が上流に着いたあと、本体の CLI が書き換えた形にする
    const path = join(f.dir, ".credentials.json");
    f.beforeUpstreamReply.fn = () => {
      const orig = JSON.parse(readFileSync(path, "utf8"));
      orig.claudeAiOauth.accessToken = "CLI-REFRESHED";
      writeFileSync(path, JSON.stringify(orig));
    };
    const p = post(f.url, secret);
    assert.equal((await p).status, 200);
    assert.equal(f.tokenCalls.length, 0);
    assert.deepEqual(f.unauthorized, []);
  } finally {
    await f.close();
  }
});

test("切れかけ（5分を切った）なら、流す前に取り直す", async () => {
  const f = await fixture();
  try {
    const path = join(f.dir, ".credentials.json");
    const creds = JSON.parse(readFileSync(path, "utf8"));
    creds.claudeAiOauth.expiresAt = new Date("2026-10-08T00:04:00Z").getTime();
    creds.claudeAiOauth.scopes = ["user:inference", "user:profile"];
    writeFileSync(path, JSON.stringify(creds));
    const secret = (await f.relay.envFor("p1", "http://x"))!.CLAUDE_CODE_OAUTH_TOKEN!;
    f.tokenReply.status = 200;
    f.tokenReply.body = { access_token: "NEW-ACCESS", expires_in: 28800, scope: "user:inference user:profile" };
    assert.equal((await post(f.url, secret)).status, 200);
    assert.deepEqual(f.seen.map((x) => x.auth), ["Bearer NEW-ACCESS"]);
    assert.equal((f.tokenCalls[0] as { scope: string }).scope, "user:inference user:profile");
    const saved = JSON.parse(readFileSync(path, "utf8")).claudeAiOauth;
    // 返事に refresh token が無ければ前のものを残す
    assert.equal(saved.refreshToken, "never-leaves");
    assert.equal(saved.expiresAt, new Date("2026-10-08T08:00:00Z").getTime());
  } finally {
    await f.close();
  }
});

test("取り直しても断られたあと、上流が通ったらカードを閉じる（通るたびには呼ばない）", async () => {
  const f = await fixture();
  try {
    const secret = (await f.relay.envFor("p1", "http://x"))!.CLAUDE_CODE_OAUTH_TOKEN!;
    // 起こし直す前のカードも閉じるため、最初に通ったときは一度呼ぶ
    assert.equal((await post(f.url, secret)).status, 200);
    assert.equal(f.authorized.count, 1);
    assert.equal((await post(f.url, secret)).status, 200);
    assert.equal(f.authorized.count, 1);
    f.upstreamStatus.value = 401;
    f.tokenReply.status = 200;
    f.tokenReply.body = { access_token: "NEW-ACCESS", refresh_token: "NEW-REFRESH", expires_in: 3600 };
    assert.equal((await post(f.url, secret)).status, 401);
    assert.deepEqual(f.unauthorized, ["p1"]);
    f.upstreamStatus.value = 200;
    assert.equal((await post(f.url, secret)).status, 200);
    assert.equal(f.authorized.count, 2);
  } finally {
    await f.close();
  }
});

test("refresh token が無効と分かったカードは、通っても閉じず、置き場の refresh token が替わってから閉じる", async () => {
  const f = await fixture();
  try {
    const secret = (await f.relay.envFor("p1", "http://x"))!.CLAUDE_CODE_OAUTH_TOKEN!;
    assert.equal((await post(f.url, secret)).status, 200);
    assert.equal(f.authorized.count, 1);
    f.upstreamStatus.value = 401; // 既定の取り直しの口は 400 invalid_grant
    assert.equal((await post(f.url, secret)).status, 401);
    assert.deepEqual(f.unauthorized, ["p1"]);
    f.upstreamStatus.value = 200;
    assert.equal((await post(f.url, secret)).status, 200);
    assert.equal(f.authorized.count, 1);
    // 人がログインし直した
    const path = join(f.dir, ".credentials.json");
    const creds = JSON.parse(readFileSync(path, "utf8"));
    creds.claudeAiOauth.refreshToken = "RELOGGED";
    writeFileSync(path, JSON.stringify(creds));
    assert.equal((await post(f.url, secret)).status, 200);
    assert.equal(f.authorized.count, 2);
  } finally {
    await f.close();
  }
});

test("本体がログインしていなければ、理由を返して上流へは出さない", async () => {
  const f = await fixture({ credentialsPath: "/nonexistent/.credentials.json" });
  try {
    const env = (await f.relay.envFor("p1", "http://x"))!;
    // 契約の種類は分からないので入れない（住所と合言葉は入れる——あとでログインすれば通る）
    assert.equal(env.CLAUDE_CODE_SUBSCRIPTION_TYPE, undefined);
    const r = await post(f.url, env.CLAUDE_CODE_OAUTH_TOKEN!);
    assert.equal(r.status, 500);
    assert.match(JSON.stringify(await r.json()), /ログインしていません/);
    assert.equal(f.seen.length, 0);
  } finally {
    await f.close();
  }
});

test("送り元の縛り：その Project のコンテナからでなければ断る。同じ接続では聞き直さない", async () => {
  const asked: string[] = [];
  let match = false;
  const f = await fixture({
    sourceMatches: async (projectId, remote) => {
      asked.push(`${projectId} ${remote}`);
      return match;
    },
  });
  try {
    const secret = (await f.relay.envFor("p1", "http://x"))!.CLAUDE_CODE_OAUTH_TOKEN!;
    const refused = await post(f.url, secret);
    assert.equal(refused.status, 403);
    assert.match(JSON.stringify(await refused.json()), /その Project のコンテナからしか使えません/);
    assert.deepEqual(asked, ["p1 127.0.0.1"]);
    assert.equal(f.seen.length, 0);
    match = true;
    // 接続を1本に絞って続けて送る——2回目は同じ接続なので Incus に聞き直さない
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      for (let i = 0; i < 2; i++) assert.equal(await postOn(agent, f.url, secret), 200);
    } finally {
      agent.destroy();
    }
    assert.equal(asked.length, 2);
  } finally {
    await f.close();
  }
});

// **会話の本体も中継を通す**（§2「Claude のアカウントを複数持つ」の 2.）
test("本体の環境：上流の変数を外し、中継の住所・本体用の合言葉・契約の種類・付随の通信を止める印・Thread の印を足す", async () => {
  const f = await fixture();
  try {
    const outer = {
      PATH: "/usr/bin",
      HOME: "/home/u",
      CLAUDE_CONFIG_DIR: "/home/u/.claude",
      ANTHROPIC_API_KEY: "sk-ant-outer",
      ANTHROPIC_AUTH_TOKEN: "outer",
      ANTHROPIC_UNIX_SOCKET: "/s",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_BASE_URL: "http://outer",
      CLAUDE_CODE_OAUTH_TOKEN: "outer-token",
    };
    const env = await f.relay.runnerEnvFor("p1", "t1", "http://127.0.0.1:4737", outer);
    const secret = env.CLAUDE_CODE_OAUTH_TOKEN!;
    assert.match(secret, /^banto-runner-/);
    assert.deepEqual(env, {
      PATH: "/usr/bin",
      HOME: "/home/u",
      CLAUDE_CONFIG_DIR: "/home/u/.claude",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4737/claude-login",
      CLAUDE_CODE_OAUTH_TOKEN: secret,
      CLAUDE_CODE_SUBSCRIPTION_TYPE: "max",
      CLAUDE_CODE_RATE_LIMIT_TIER: "tier-x",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ANTHROPIC_CUSTOM_HEADERS: "x-banto-thread-id: t1",
    });
    // Project ごとに1つ（Thread が替わっても同じ）。コンテナ用とは別のもの。置き場には書かない
    assert.equal((await f.relay.runnerEnvFor("p1", "t2", "http://x", {})).CLAUDE_CODE_OAUTH_TOKEN, secret);
    assert.notEqual((await f.relay.runnerEnvFor("p2", "t3", "http://x", {})).CLAUDE_CODE_OAUTH_TOKEN, secret);
    const container = (await f.relay.envFor("p1", "http://x"))!.CLAUDE_CODE_OAUTH_TOKEN!;
    assert.notEqual(container, secret);
    assert.doesNotMatch(readFileSync(join(f.dir, "secrets.json"), "utf8"), new RegExp(secret));
  } finally {
    await f.close();
  }
});

test("中継が取り直せない banto では、本体は中継を通さない（今の環境に付随の通信を止める印だけ）", async () => {
  const f = await fixture({ refreshEnabled: false });
  try {
    const env = await f.relay.runnerEnvFor("p1", "t1", "http://127.0.0.1:4737", { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-outer" });
    assert.deepEqual(env, { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-outer", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
  } finally {
    await f.close();
  }
});

test("本体用の合言葉：host の loopback から通り、Thread の印は上流へ流さない。スイッチと revoke に依らず、観測は別に数える", async () => {
  const asked: string[] = [];
  const f = await fixture({
    sourceMatches: async (projectId, remote) => {
      asked.push(`${projectId} ${remote}`);
      return false;
    },
  });
  try {
    const secret = (await f.relay.runnerEnvFor("p1", "t1", "http://x", {})).CLAUDE_CODE_OAUTH_TOKEN!;
    const ok = await post(f.url, secret, "/v1/messages?beta=true", { "x-banto-thread-id": "t1" });
    assert.equal(ok.status, 200);
    assert.deepEqual(f.seen, [{ url: "/v1/messages?beta=true", auth: "Bearer REAL-ACCESS", beta: "oauth-2025-04-20" }]);
    assert.deepEqual(f.seenThreadHeader, [undefined]);
    // 本体用の要求では Incus に送り元を聞かない
    assert.deepEqual(asked, []);
    // 「Claude のログインを使わせる」を切っても本体は止まらない（それはコンテナの中だけを決める）
    f.enabled.delete("p1");
    f.relay.revoke("p1");
    assert.equal((await post(f.url, secret)).status, 200);
    // 推論以外は断るのは同じ
    assert.equal((await post(f.url, secret, "/api/oauth/profile")).status, 403);
    assert.deepEqual(f.relay.runnerStatsFor("p1"), { requests: 2, lastRequestAt: "2026-10-08T00:00:00.000Z" });
    // コンテナの観測（Project 設定の今の表示）には数えない
    assert.deepEqual(f.relay.statsFor("p1"), { requests: 0 });
  } finally {
    await f.close();
  }
});

test("取り違えた合言葉は断る：本体用をコンテナの口・別のサーバの待ち受けへ、コンテナ用を本体の口（loopback）へ", async () => {
  // 送り元はコンテナのアドレスと比べる（本番と同じ——コンテナは loopback にならない）
  const f = await fixture({ sourceMatches: async (_projectId, remote) => remote === "10.99.0.5" });
  const dedicated = createRelayListener({
    relayEndpoint: { handleRequest: async (_req, res) => void res.writeHead(500).end() },
    claudeLogin: f.relay,
    acceptsProject: () => true,
    readJsonBody: async () => ({}),
  });
  const dedicatedUrl = await listen(dedicated);
  // core の口と同じく 0.0.0.0 で待ち受け、loopback 以外の自分のアドレスから届ける（コンテナから来たのと同じ形）
  const wide = createServer((req, res) => void f.relay.handle(req, res, CORE));
  await new Promise<void>((r) => wide.listen(0, "0.0.0.0", r));
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
  try {
    const runner = (await f.relay.runnerEnvFor("p1", "t1", "http://x", {})).CLAUDE_CODE_OAUTH_TOKEN!;
    const container = (await f.relay.envFor("p1", "http://x"))!.CLAUDE_CODE_OAUTH_TOKEN!;
    // コンテナ用を host の loopback から（本体の口）：コンテナではないので断る
    const swapped = await post(f.url, container);
    assert.equal(swapped.status, 403);
    assert.match(JSON.stringify(await swapped.json()), /その Project のコンテナからしか使えません/);
    // 本体用を別のサーバの専用の待ち受けへ：送り元が 127.0.0.1 でも断る
    const viaTunnel = await post(dedicatedUrl, runner);
    assert.equal(viaTunnel.status, 403);
    assert.match(JSON.stringify(await viaTunnel.json()), /banto 本体の会話からしか使えません/);
    // 本体用をコンテナの口（loopback 以外の送り元）へ
    if (lan) {
      const port = (wide.address() as { port: number }).port;
      const fromLan = await post(`http://${lan}:${port}`, runner);
      assert.equal(fromLan.status, 403);
      assert.match(JSON.stringify(await fromLan.json()), new RegExp(`banto 本体の会話からしか使えません（送り元 ${lan.replace(/\./g, "\\.")}）`));
    } else {
      console.warn("loopback 以外の IPv4 が無いので、本体用の合言葉を loopback 以外から送る確かめは飛ばしました");
    }
    assert.equal(f.seen.length, 0);
    assert.deepEqual(f.relay.runnerStatsFor("p1"), { requests: 0 });
    assert.deepEqual(f.relay.statsFor("p1"), { requests: 0 });
  } finally {
    dedicated.closeAllConnections();
    wide.closeAllConnections();
    await Promise.all([new Promise((r) => dedicated.close(r)), new Promise((r) => wide.close(r))]);
    await f.close();
  }
});

test("送り元が分からない（Incus が答えない）は通さず、理由を返す", async () => {
  const f = await fixture({
    sourceMatches: async () => {
      throw new Error("Incus に繋がりません");
    },
  });
  try {
    const secret = (await f.relay.envFor("p1", "http://x"))!.CLAUDE_CODE_OAUTH_TOKEN!;
    const r = await post(f.url, secret);
    assert.equal(r.status, 502);
    assert.match(JSON.stringify(await r.json()), /Incus に繋がりません/);
    assert.equal(f.seen.length, 0);
  } finally {
    await f.close();
  }
});

test("合言葉の置き場が壊れていたら止まる（黙って全部の合言葉を替えない）", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-login-relay-"));
  try {
    writeFileSync(join(dir, "secrets.json"), JSON.stringify({ p1: 3 }));
    assert.throws(
      () => new ClaudeLoginRelay({ accounts: accountsAt(dir, "/x"), secretsPath: join(dir, "secrets.json"), enabled: () => true }),
      /壊れています/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// **待ち受けは複数持てる**（2026-10-08、別のサーバ用）。専用の待ち受けは /relay と Claude の中継だけを受け、送り元を縛らず、
// その実行場所の Project の合言葉だけを通す
test("専用の待ち受け：中継だけを受け、送り元の代わりに受ける Project で絞る", async () => {
  const f = await fixture({
    sourceMatches: async () => {
      throw new Error("専用の待ち受けでは送り元を聞かない");
    },
  });
  const relayCalls: string[] = [];
  let accepted: Array<boolean | undefined> = [];
  const dedicated = createRelayListener({
    relayEndpoint: {
      handleRequest: async (_req, res, body, accepts) => {
        relayCalls.push(JSON.stringify(body));
        const meta = {} as never; // 絞り込みは projectId しか見ない
        accepted = [
          accepts?.({ moduleName: "shell", projectId: "p1", meta }),
          accepts?.({ moduleName: "shell", projectId: "p2", meta }),
          accepts?.({ moduleName: "vault-local", meta }),
        ];
        res.writeHead(200).end("relay");
      },
    },
    claudeLogin: f.relay,
    acceptsProject: (id) => id === "p1",
    readJsonBody: async (req) => {
      let text = "";
      for await (const chunk of req) text += String(chunk);
      return JSON.parse(text) as unknown;
    },
  });
  const url = await listen(dedicated);
  try {
    const p1 = (await f.relay.envFor("p1", "http://x"))!.CLAUDE_CODE_OAUTH_TOKEN!;
    const p2 = (await f.relay.envFor("p2", "http://x"))!.CLAUDE_CODE_OAUTH_TOKEN!;
    assert.equal((await post(url, p1)).status, 200);
    // 別の実行場所の Project の合言葉は、正しくても断る
    assert.equal((await post(url, p2)).status, 401);
    assert.equal(f.seen.length, 1);
    // host 中継はそのまま渡す
    const relayed = await fetch(`${url}/relay`, { method: "POST", body: '{"a":1}' });
    assert.equal(await relayed.text(), "relay");
    assert.deepEqual(relayCalls, ['{"a":1}']);
    // host 中継も、その実行場所の Project の Module の合言葉だけ（別の Project・banto 全体の Module は断る）
    assert.deepEqual(accepted, [true, false, false]);
    // ほかの口は無い
    assert.equal((await fetch(`${url}/api/projects`)).status, 404);
    assert.equal((await fetch(`${url}/agent-relay/shell`)).status, 404);
  } finally {
    dedicated.closeAllConnections();
    await new Promise((r) => dedicated.close(r));
    await f.close();
  }
});

// **アカウント1つ＝置き場1つ＝取り直し役1つ＝カード1枚**（§2「Claude のアカウントを複数持つ」の 3.・7.）
test("アカウントが2つ：それぞれの置き場で取り直し、書き戻す先も別々", async () => {
  const f = await fixture();
  try {
    const hostPath = join(f.dir, ".credentials.json");
    const soon = new Date("2026-10-08T00:04:00Z").getTime();
    const host = JSON.parse(readFileSync(hostPath, "utf8"));
    host.claudeAiOauth.expiresAt = soon;
    writeFileSync(hostPath, JSON.stringify(host));
    const b = f.accounts.add({
      email: "b@example.com",
      subscriptionType: "pro",
      oauth: { accessToken: "B-ACCESS", refreshToken: "B-REFRESH", expiresAt: soon, subscriptionType: "pro", rateLimitTier: "tier-b" },
    });
    const secret = (await f.relay.envFor("p1", "http://x"))!.CLAUDE_CODE_OAUTH_TOKEN!;
    f.tokenReply.status = 200;

    // 既定の並びの先頭（最初の1つ）
    f.tokenReply.body = { access_token: "HOST-NEW", expires_in: 3600 };
    assert.equal((await post(f.url, secret)).status, 200);
    // 先頭を B にすると B の置き場で取り直す
    f.accounts.setDefaultOrder([b.id, "host"]);
    assert.equal((await f.relay.envFor("p1", "http://x"))!.CLAUDE_CODE_SUBSCRIPTION_TYPE, "pro");
    f.tokenReply.body = { access_token: "B-NEW", expires_in: 3600 };
    assert.equal((await post(f.url, secret)).status, 200);

    assert.deepEqual(f.tokenCalls.map((c) => (c as { refresh_token: string }).refresh_token), ["never-leaves", "B-REFRESH"]);
    assert.deepEqual(f.seen.map((x) => x.auth), ["Bearer HOST-NEW", "Bearer B-NEW"]);
    assert.equal(JSON.parse(readFileSync(hostPath, "utf8")).claudeAiOauth.accessToken, "HOST-NEW");
    const bPath = f.accounts.credentialsPathOf(b.id);
    assert.equal(JSON.parse(readFileSync(bPath, "utf8")).claudeAiOauth.accessToken, "B-NEW");
    // 取り直しても置き場は本人だけが読める
    assert.equal(statSync(bPath).mode & 0o777, 0o600);
  } finally {
    await f.close();
  }
});

test("片方のアカウントの 401 のカードは、もう片方が通っても閉じない（閉じるのはそのアカウントで通ったとき）", async () => {
  const unauthorized: string[] = [];
  const authorized: string[] = [];
  const f = await fixture({
    onUpstreamUnauthorized: (_p, _reason, accountId) => unauthorized.push(accountId),
    onUpstreamAuthorized: (accountId) => authorized.push(accountId),
  });
  try {
    const b = f.accounts.add({ email: "b@example.com", oauth: { accessToken: "B-ACCESS", refreshToken: "B-REFRESH", subscriptionType: "pro" } });
    const secret = (await f.relay.envFor("p1", "http://x"))!.CLAUDE_CODE_OAUTH_TOKEN!;
    // 最初の1つで通る（起こし直す前のカードを閉じるので1回）
    assert.equal((await post(f.url, secret)).status, 200);
    assert.deepEqual(authorized, ["host"]);
    // 最初の1つが 401、取り直しも invalid_grant（人が直すしかない）→ そのアカウントのカード
    f.upstreamAccepts.value = "B-ACCESS";
    assert.equal((await post(f.url, secret)).status, 401);
    assert.deepEqual(unauthorized, ["host"]);
    // B に切り替えて通る——閉じるのは B の分だけ（最初の1回）。最初の1つのカードは閉じない
    f.accounts.setDefaultOrder([b.id, "host"]);
    assert.equal((await post(f.url, secret)).status, 200);
    assert.equal((await post(f.url, secret)).status, 200);
    assert.deepEqual(authorized, ["host", b.id]);
    // 最初の1つに戻してログインし直す（refresh token が替わる）と、そこで閉じる
    f.accounts.setDefaultOrder(["host", b.id]);
    f.upstreamAccepts.value = undefined;
    const hostPath = join(f.dir, ".credentials.json");
    const creds = JSON.parse(readFileSync(hostPath, "utf8"));
    creds.claudeAiOauth.refreshToken = "RELOGGED";
    writeFileSync(hostPath, JSON.stringify(creds));
    assert.equal((await post(f.url, secret)).status, 200);
    assert.deepEqual(authorized, ["host", b.id, "host"]);
    assert.deepEqual(unauthorized, ["host"]);
  } finally {
    await f.close();
  }
});

test("返事の見出しの使用率を、使ったアカウントにだけ覚える", async () => {
  const f = await fixture();
  try {
    const b = f.accounts.add({ email: "b@example.com", oauth: { accessToken: "B-ACCESS" } });
    const secret = (await f.relay.envFor("p1", "http://x"))!.CLAUDE_CODE_OAUTH_TOKEN!;
    // 見出しの無い返事では何も覚えない
    assert.equal((await post(f.url, secret)).status, 200);
    assert.equal(f.accounts.get("host")!.usage, undefined);
    const reset5h = Date.parse("2026-10-08T03:00:00Z") / 1000;
    f.upstreamHeaders.value = {
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-reset": String(reset5h),
      "anthropic-ratelimit-unified-5h-utilization": "0.42",
      "anthropic-ratelimit-unified-5h-reset": String(reset5h),
      "anthropic-ratelimit-unified-5h-status": "allowed",
    };
    assert.equal((await post(f.url, secret)).status, 200);
    assert.deepEqual(f.accounts.get("host")!.usage, {
      fiveHour: { utilization: 0.42, resetsAt: "2026-10-08T03:00:00.000Z", status: "allowed" },
      status: "allowed",
      statusResetsAt: "2026-10-08T03:00:00.000Z",
      readAt: "2026-10-08T00:00:00.000Z",
    });
    assert.equal(f.accounts.get(b.id)!.usage, undefined);
  } finally {
    await f.close();
  }
});

test("並びで一番早いリセット：断っているアカウントの -reset のうち一番早いもの。断っていなければ・取り直せない banto では無し", async () => {
  const f = await fixture();
  try {
    const b = f.accounts.add({ email: "b@example.com", oauth: { accessToken: "B-ACCESS" } });
    assert.equal(f.relay.earliestResetFor("p1"), undefined);
    const headers = (status: string, reset: string) =>
      new Headers({ "anthropic-ratelimit-unified-status": status, "anthropic-ratelimit-unified-reset": String(Date.parse(reset) / 1000) });
    f.accounts.recordUsage("host", headers("rejected", "2026-10-08T05:00:00Z"));
    f.accounts.recordUsage(b.id, headers("rejected", "2026-10-08T02:00:00Z"));
    assert.equal(f.relay.earliestResetFor("p1"), Date.parse("2026-10-08T02:00:00Z"));
    // 断っていないアカウントの時刻は使わない（使えるので、待つ時刻ではない）
    f.accounts.recordUsage(b.id, headers("allowed", "2026-10-08T01:00:00Z"));
    assert.equal(f.relay.earliestResetFor("p1"), Date.parse("2026-10-08T05:00:00Z"));
    const off = new ClaudeLoginRelay({ accounts: f.accounts, secretsPath: join(mkdtempSync(join(tmpdir(), "claude-login-relay-")), "s.json"), enabled: () => true, refreshEnabled: false });
    assert.equal(off.earliestResetFor("p1"), undefined);
  } finally {
    await f.close();
  }
});

// **閾値で切り替える・429 で送り直す・切り替えの記録・全部越えのカード**（§2「Claude のアカウントを複数持つ」の 5.・6.）

/** 使用率の見出し（5時間の率とリセット、全体の status とリセット） */
const limitHeaders = (fiveHour: number, resetAt: Date, status = "allowed"): Record<string, string> => ({
  "anthropic-ratelimit-unified-status": status,
  "anthropic-ratelimit-unified-reset": String(Math.floor(resetAt.getTime() / 1000)),
  "anthropic-ratelimit-unified-5h-utilization": String(fiveHour),
  "anthropic-ratelimit-unified-5h-reset": String(Math.floor(resetAt.getTime() / 1000)),
});

test("閾値を越えたら次の要求から次のアカウント、リセットを過ぎたら前へ戻る。切り替えは Thread の印つきで知らせる", async () => {
  let clock = new Date("2026-10-08T00:00:00Z");
  const switches: unknown[] = [];
  const f = await fixture({ now: () => clock, onAccountSwitched: (c) => switches.push(c) });
  try {
    const b = f.accounts.add({ email: "b@example.com", oauth: { accessToken: "B-ACCESS" } });
    const runner = (await f.relay.runnerEnvFor("p1", "t1", "http://x", {})).CLAUDE_CODE_OAUTH_TOKEN!;
    const reset = new Date("2026-10-08T01:00:00Z");
    f.upstreamByToken.value = { "REAL-ACCESS": { headers: limitHeaders(0.96, reset) } };
    // 1回目は host（起こしてから最初なので切り替えではない）。返事で 96% と分かる
    assert.equal((await post(f.url, runner, "/v1/messages", { "x-banto-thread-id": "t1" })).status, 200);
    assert.deepEqual(switches, []);
    // 2回目から B。Thread の印は本体の要求のときだけ渡す
    assert.equal((await post(f.url, runner, "/v1/messages", { "x-banto-thread-id": "t1" })).status, 200);
    assert.deepEqual(f.seen.map((x) => x.auth), ["Bearer REAL-ACCESS", "Bearer B-ACCESS"]);
    assert.deepEqual(switches, [
      { projectId: "p1", threadId: "t1", from: "host", to: b.id, reason: { kind: "threshold", window: "5h", utilization: 0.96, resetsAt: reset.toISOString() } },
    ]);
    assert.equal(f.relay.currentAccountOf("p1"), b.id);
    // 契約の種類の env もいま選ばれるものから
    assert.equal(f.relay.currentAccountOf("p2"), undefined);
    // リセットを過ぎたら host へ戻る
    clock = new Date("2026-10-08T01:00:01Z");
    f.upstreamByToken.value = {};
    assert.equal((await post(f.url, runner, "/v1/messages", { "x-banto-thread-id": "t1" })).status, 200);
    assert.equal(f.seen.at(-1)!.auth, "Bearer REAL-ACCESS");
    assert.deepEqual(switches.at(-1), { projectId: "p1", threadId: "t1", from: b.id, to: "host", reason: { kind: "recovered" } });

    // コンテナからの要求の Thread の印は読まない
    const container = (await f.relay.envFor("p1", "http://x"))!.CLAUDE_CODE_OAUTH_TOKEN!;
    f.upstreamByToken.value = { "REAL-ACCESS": { headers: limitHeaders(0.99, new Date("2026-10-08T05:00:00Z")) } };
    assert.equal((await post(f.url, container, "/v1/messages", { "x-banto-thread-id": "t1" })).status, 200);
    assert.equal((await post(f.url, container, "/v1/messages", { "x-banto-thread-id": "t1" })).status, 200);
    assert.deepEqual(switches.at(-1), { projectId: "p1", from: "host", to: b.id, reason: { kind: "threshold", window: "5h", utilization: 0.99, resetsAt: "2026-10-08T05:00:00.000Z" } });
  } finally {
    await f.close();
  }
});

test("Project の並びがあればそれで選ぶ（既定の並びとは別）", async () => {
  const f = await fixture();
  try {
    const b = f.accounts.add({ email: "b@example.com", oauth: { accessToken: "B-ACCESS", subscriptionType: "pro" } });
    f.accounts.setProjectOrder("p2", [b.id]);
    const p1 = (await f.relay.envFor("p1", "http://x"))!;
    const p2 = (await f.relay.envFor("p2", "http://x"))!;
    assert.equal(p1.CLAUDE_CODE_SUBSCRIPTION_TYPE, "max");
    assert.equal(p2.CLAUDE_CODE_SUBSCRIPTION_TYPE, "pro");
    assert.equal((await post(f.url, p1.CLAUDE_CODE_OAUTH_TOKEN!)).status, 200);
    assert.equal((await post(f.url, p2.CLAUDE_CODE_OAUTH_TOKEN!)).status, 200);
    assert.deepEqual(f.seen.map((x) => x.auth), ["Bearer REAL-ACCESS", "Bearer B-ACCESS"]);
  } finally {
    await f.close();
  }
});

test("上限の 429（rejected）は並びの次へ順に送り直し、3つ目で通る。全部断ったら 429 を見出しごと返し x-should-retry: false", async () => {
  const switches: Array<{ from: string; to: string; reason: { kind: string } }> = [];
  const f = await fixture({ onAccountSwitched: (c) => switches.push(c) });
  try {
    const b = f.accounts.add({ email: "b@example.com", oauth: { accessToken: "B-ACCESS" } });
    const c = f.accounts.add({ email: "c@example.com", oauth: { accessToken: "C-ACCESS" } });
    const secret = (await f.relay.runnerEnvFor("p1", "t1", "http://x", {})).CLAUDE_CODE_OAUTH_TOKEN!;
    assert.equal((await post(f.url, secret)).status, 200);
    const reset = new Date("2026-10-08T02:00:00Z");
    const rejected = { status: 429, headers: limitHeaders(0.5, reset, "rejected") };
    f.upstreamByToken.value = { "REAL-ACCESS": rejected, "B-ACCESS": rejected };
    const through = await post(f.url, secret);
    assert.equal(through.status, 200);
    assert.equal(through.headers.get("x-should-retry"), null);
    assert.deepEqual(f.seen.slice(1).map((x) => x.auth), ["Bearer REAL-ACCESS", "Bearer B-ACCESS", "Bearer C-ACCESS"]);
    // 同じ本文を送り直している
    assert.deepEqual(switches, [{ projectId: "p1", from: "host", to: c.id, reason: { kind: "rejected", resetsAt: reset.toISOString() } }]);
    // 次の要求は C から（host と B は rejected と覚えている）
    assert.equal((await post(f.url, secret)).status, 200);
    assert.equal(f.seen.at(-1)!.auth, "Bearer C-ACCESS");
    assert.equal(f.seen.length, 5);

    // 全部が断る：上流の 429 を見出しごと返し、試し直さない旗を付ける
    f.upstreamByToken.value = { "REAL-ACCESS": rejected, "B-ACCESS": rejected, "C-ACCESS": rejected };
    const refused = await post(f.url, secret);
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get("x-should-retry"), "false");
    assert.equal(refused.headers.get("anthropic-ratelimit-unified-status"), "rejected");
    // C（rejected と分かった）→ 残りも全部 rejected と覚えているが、この要求ではまだ試していないものは試す
    assert.deepEqual(f.seen.slice(5).map((x) => x.auth), ["Bearer C-ACCESS", "Bearer REAL-ACCESS", "Bearer B-ACCESS"]);
    // 断られた返事では切り替えを知らせない
    assert.equal(switches.length, 1);
    assert.equal(b.id !== c.id, true);
  } finally {
    await f.close();
  }
});

test("見出しの無い 429（上限ではない）は送り直さず、旗も付けずにそのまま返す", async () => {
  const f = await fixture();
  try {
    f.accounts.add({ email: "b@example.com", oauth: { accessToken: "B-ACCESS" } });
    const secret = (await f.relay.runnerEnvFor("p1", "t1", "http://x", {})).CLAUDE_CODE_OAUTH_TOKEN!;
    f.upstreamByToken.value = { "REAL-ACCESS": { status: 429, headers: {} } };
    const r = await post(f.url, secret);
    assert.equal(r.status, 429);
    assert.equal(r.headers.get("x-should-retry"), null);
    assert.equal(f.seen.length, 1);
  } finally {
    await f.close();
  }
});

test("並びの全部が閾値を越えたら一番早くリセットされるもので続け、カードは並びごとに1回。どれかが戻ったら閉じる（要求が来なくても）", async () => {
  let clock = new Date("2026-10-08T00:00:00Z");
  const events: string[] = [];
  const f = await fixture({
    now: () => clock,
    onAllOverThreshold: (info) => events.push(`open ${info.key} ${info.projectId} using=${info.using}`),
    onBackUnderThreshold: (key) => events.push(`close ${key}`),
  });
  try {
    const b = f.accounts.add({ email: "b@example.com", oauth: { accessToken: "B-ACCESS" } });
    const secret = (await f.relay.runnerEnvFor("p1", "t1", "http://x", {})).CLAUDE_CODE_OAUTH_TOKEN!;
    const key = `host,${b.id}`;
    // まだ見ていない並びは開いている扱い——最初に選んだときに（起こし直す前の）カードを閉じに行く
    assert.equal((await post(f.url, secret)).status, 200);
    assert.deepEqual(events, [`close ${key}`]);
    // host は1時間後、B は 50ms 後に戻る
    f.upstreamByToken.value = {
      "REAL-ACCESS": { headers: limitHeaders(0.97, new Date("2026-10-08T01:00:00Z")) },
      "B-ACCESS": { headers: limitHeaders(0.98, new Date(clock.getTime() + 2_000)) },
    };
    assert.equal((await post(f.url, secret)).status, 200); // host が 97% と分かる
    assert.equal((await post(f.url, secret)).status, 200); // B が 98% と分かる
    assert.equal((await post(f.url, secret)).status, 200); // 全部越え：B（早く戻る）で続ける
    assert.equal((await post(f.url, secret)).status, 200); // 開いている間は出さない
    assert.deepEqual(f.seen.slice(-2).map((x) => x.auth), ["Bearer B-ACCESS", "Bearer B-ACCESS"]);
    assert.deepEqual(events, [`close ${key}`, `open ${key} p1 using=${b.id}`]);
    // 同じ並びの別の Project でも増やさない
    const other = (await f.relay.runnerEnvFor("p2", "t2", "http://x", {})).CLAUDE_CODE_OAUTH_TOKEN!;
    assert.equal((await post(f.url, other)).status, 200);
    assert.equal(events.length, 2);
    // B のリセットを過ぎる——要求が来なくても、時計が見直して閉じる
    clock = new Date(clock.getTime() + 3_000);
    await new Promise((r) => setTimeout(r, 3_200));
    assert.deepEqual(events, [`close ${key}`, `open ${key} p1 using=${b.id}`, `close ${key}`]);
  } finally {
    f.relay.close();
    await f.close();
  }
});

// **設定を開いたときの読み直し**（§2 の 7.）：使っていないアカウントも、そのアカウントのトークンで `/api/oauth/usage` を直に
test("使用率の読み直し：アカウントごとのトークンで usage の口を呼び台帳に覚える。読めなかったものは理由を返す。いま使っている Project も返す", async () => {
  const usage = createServer((req, res) => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (token === "REAL-ACCESS") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ five_hour: { utilization: 41, resets_at: "2026-10-08T03:00:00Z" }, seven_day: { utilization: 0, resets_at: null } }),
      );
      return;
    }
    res.writeHead(500).end();
  });
  const usageUrl = await listen(usage);
  const f = await fixture({ usageUrl: `${usageUrl}/api/oauth/usage` });
  try {
    const b = f.accounts.add({ email: "b@example.com", oauth: { accessToken: "B-ACCESS" } });
    assert.equal(f.relay.lastUsageReadAt(), undefined);
    const { readAt, failures } = await f.relay.readUsage();
    assert.equal(readAt, "2026-10-08T00:00:00.000Z");
    assert.equal(f.relay.lastUsageReadAt(), readAt);
    assert.deepEqual(f.accounts.get("host")!.usage, { fiveHour: { utilization: 0.41, resetsAt: "2026-10-08T03:00:00.000Z" }, readAt });
    assert.deepEqual(failures, [{ accountId: b.id, reason: "使用率の口が 500 を返しました" }]);
    // 中継を通っていない（上流には何も来ない）
    assert.deepEqual(f.seen, []);
    assert.deepEqual([...f.relay.currentAccounts()], []);
    const secret = (await f.relay.envFor("p1", "http://x"))!.CLAUDE_CODE_OAUTH_TOKEN!;
    assert.equal((await post(f.url, secret)).status, 200);
    assert.deepEqual([...f.relay.currentAccounts()], [["p1", "host"]]);
  } finally {
    await f.close();
    usage.closeAllConnections();
    await new Promise((r) => usage.close(r));
  }
});
