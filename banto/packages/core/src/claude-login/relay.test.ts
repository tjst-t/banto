import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, createServer, request, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_LOGIN_PATH, ClaudeLoginRelay, hostClaudeCredentialsPath, type ClaudeLoginListener, type ClaudeLoginRelayDeps } from "./relay.js";
import { createRelayListener } from "../relay/relay-listener.js";

const CORE: ClaudeLoginListener = { acceptsProject: () => true, bindSource: true };

// 本体の CLI と同じ順で置き場を決める——E2E・疎通確認は CLAUDE_SECURESTORAGE_CONFIG_DIR で本物を指す
test("本体の資格情報の置き場は、CLI と同じ順で決まる", () => {
  assert.equal(hostClaudeCredentialsPath({ CLAUDE_SECURESTORAGE_CONFIG_DIR: "/s", CLAUDE_CONFIG_DIR: "/c" }), "/s/.credentials.json");
  assert.equal(hostClaudeCredentialsPath({ CLAUDE_CONFIG_DIR: "/c" }), "/c/.credentials.json");
  assert.equal(hostClaudeCredentialsPath({}), join(homedir(), ".claude", ".credentials.json"));
});

interface Fixture {
  relay: ClaudeLoginRelay;
  /** 中継を載せた待ち受け（core の口と同じ形） */
  url: string;
  seen: { url: string; auth: string; beta: string }[];
  enabled: Set<string>;
  dir: string;
  unauthorized: string[];
  authorized: { count: number };
  upstreamStatus: { value: number };
  /** これを決めると、上流はこのトークンのときだけ 200・ほかは 401（upstreamStatus より優先） */
  upstreamAccepts: { value: string | undefined };
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

async function fixture(overrides: Partial<ClaudeLoginRelayDeps> = {}, listener: ClaudeLoginListener = CORE): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "claude-login-relay-"));
  writeFileSync(
    join(dir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "REAL-ACCESS", refreshToken: "never-leaves", subscriptionType: "max", rateLimitTier: "tier-x" } }),
  );
  const seen: Fixture["seen"] = [];
  const upstreamStatus = { value: 200 };
  const upstreamAccepts: Fixture["upstreamAccepts"] = { value: undefined };
  const beforeUpstreamReply: Fixture["beforeUpstreamReply"] = { fn: undefined };
  const upstream = createServer((req, res) => {
    seen.push({ url: req.url ?? "", auth: req.headers.authorization ?? "", beta: String(req.headers["anthropic-beta"] ?? "") });
    const hook = beforeUpstreamReply.fn;
    beforeUpstreamReply.fn = undefined;
    hook?.();
    const status =
      upstreamAccepts.value === undefined ? upstreamStatus.value : req.headers.authorization === `Bearer ${upstreamAccepts.value}` ? 200 : 401;
    res.writeHead(status, { "content-type": "application/json" }).end('{"ok":"upstream"}');
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
  const relay = new ClaudeLoginRelay({
    credentialsPath: join(dir, ".credentials.json"),
    secretsPath: join(dir, "secrets.json"),
    upstream: upstreamUrl,
    enabled: (id) => enabled.has(id),
    sourceMatches: async () => true,
    onUpstreamUnauthorized: (id) => unauthorized.push(id),
    onUpstreamAuthorized: () => authorized.count++,
    tokenUrl: `${tokenUrl}/v1/oauth/token`,
    now: () => new Date("2026-10-08T00:00:00Z"),
    ...overrides,
  });
  const front = createServer((req, res) => void relay.handle(req, res, listener));
  const url = await listen(front);
  return {
    relay,
    url,
    seen,
    enabled,
    dir,
    unauthorized,
    authorized,
    upstreamStatus,
    upstreamAccepts,
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

const post = (url: string, secret: string, path = "/v1/messages?beta=true") =>
  fetch(`${url}${CLAUDE_LOGIN_PATH}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "anthropic-beta": "oauth-2025-04-20" },
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
      credentialsPath: join(f.dir, ".credentials.json"),
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
      () => new ClaudeLoginRelay({ credentialsPath: "/x", secretsPath: join(dir, "secrets.json"), enabled: () => true }),
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
