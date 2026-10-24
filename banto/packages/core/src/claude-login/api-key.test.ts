// **API キーのアカウント**（`docs/specs/v4-distribution.md` §3）の試験：台帳には alias だけ・合言葉は `ANTHROPIC_AUTH_TOKEN`・
// 中継が `x-api-key` を差し込み `oauth-…` を外す・使ったトークンと金額の目安・キーはコンテナの環境に入らない
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_LOGIN_PATH, ClaudeLoginRelay, upstreamHeaders, type ClaudeLoginListener } from "./relay.js";
import { ClaudeAccountStore, HOST_ACCOUNT_ID } from "./accounts.js";
import { costOf, PRICE_TABLE_VERSION } from "./prices.js";

const CORE: ClaudeLoginListener = { acceptsProject: () => true, bindSource: true, acceptsRunner: true };
const KEY = "sk-ant-api-REAL-KEY";
const NOW = new Date("2026-10-24T00:00:00Z");

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

interface Seen {
  auth: string | undefined;
  apiKey: string | undefined;
  beta: string | undefined;
}

async function fixture(opts: { order?: "key-only" | "key-then-host" | "host-then-key"; resolve?: (alias: string) => Promise<string> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "claude-api-key-"));
  writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "HOST-ACCESS", subscriptionType: "max" } }));
  const accounts = new ClaudeAccountStore({ dataDir: dir, hostCredentialsPath: join(dir, ".credentials.json"), now: () => NOW });
  accounts.setMode("ordered");
  const key = accounts.addApiKey({ label: "仕事のキー", keyAlias: "claude-api-key-test" });
  const order = opts.order ?? "key-only";
  accounts.setDefaultOrder(order === "key-only" ? [key.id] : order === "key-then-host" ? [key.id, HOST_ACCOUNT_ID] : [HOST_ACCOUNT_ID, key.id]);
  const seen: Seen[] = [];
  const reply: { status: number; sse: boolean; body?: string } = { status: 200, sse: true };
  const upstream = createServer((req, res) => {
    seen.push({
      auth: req.headers.authorization,
      apiKey: req.headers["x-api-key"] as string | undefined,
      beta: req.headers["anthropic-beta"] as string | undefined,
    });
    req.resume();
    if (reply.status !== 200) {
      res.writeHead(reply.status, { "content-type": "application/json" }).end('{"error":"no"}');
      return;
    }
    if (reply.sse) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            model: "claude-opus-5-5",
            usage: { input_tokens: 1000, output_tokens: 1, cache_creation_input_tokens: 2000, cache_read_input_tokens: 10000, cache_creation: { ephemeral_1h_input_tokens: 500 } },
          },
        })}\n\n`,
      );
      res.write(`event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n`);
      res.end(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 300 } })}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(reply.body ?? JSON.stringify({ model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 20 } }));
  });
  const upstreamUrl = await listen(upstream);
  const unauthorized: string[] = [];
  const resolved: string[] = [];
  const relay = new ClaudeLoginRelay({
    accounts,
    secretsPath: join(dir, "secrets.json"),
    upstream: upstreamUrl,
    enabled: () => true,
    sourceMatches: async () => true,
    resolveApiKey:
      opts.resolve ??
      (async (alias) => {
        resolved.push(alias);
        return KEY;
      }),
    onUpstreamUnauthorized: (_p, reason, accountId) => unauthorized.push(`${accountId}:${reason}`),
    // 外へ出ない（host のトークンは期限が無いので取り直さない。使用率の読み直しは偽の上流へ）
    tokenUrl: `${upstreamUrl}/v1/oauth/token`,
    usageUrl: `${upstreamUrl}/api/oauth/usage`,
    now: () => NOW,
  });
  const front = createServer((req, res) => void relay.handle(req, res, CORE));
  const url = await listen(front);
  return {
    dir,
    accounts,
    keyId: key.id,
    relay,
    url,
    seen,
    reply,
    unauthorized,
    resolved,
    close: async () => {
      relay.close();
      front.closeAllConnections();
      upstream.closeAllConnections();
      await Promise.all([new Promise((r) => front.close(r)), new Promise((r) => upstream.close(r))]);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const post = (url: string, secret: string, beta?: string) =>
  fetch(`${url}${CLAUDE_LOGIN_PATH}/v1/messages?beta=true`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", ...(beta ? { "anthropic-beta": beta } : {}) },
    body: "{}",
  });

test("台帳には alias だけ——キーは書かない。外せば台帳と並びから消え、置き場は持たない", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-api-key-ledger-"));
  try {
    const store = new ClaudeAccountStore({ dataDir: dir, hostCredentialsPath: join(dir, "none.json"), now: () => NOW });
    const a = store.addApiKey({ label: " 仕事 ", keyAlias: "claude-api-key-x" });
    assert.equal(a.kind, "api-key");
    assert.equal(a.label, "仕事");
    assert.equal(a.keyAlias, "claude-api-key-x");
    assert.deepEqual(store.defaultOrder(), [HOST_ACCOUNT_ID, a.id]);
    assert.equal(store.apiKeyAliasOf(a.id), "claude-api-key-x");
    assert.equal(store.apiKeyAliasOf(HOST_ACCOUNT_ID), undefined);
    assert.throws(() => store.credentialsPathOf(a.id), /API キー/);
    const raw = readFileSync(join(dir, "claude-accounts.json"), "utf8");
    assert.ok(!raw.includes("sk-ant"), "台帳にキーが無い");
    // 読み直しても同じ（台帳の検査を通る）
    const again = new ClaudeAccountStore({ dataDir: dir, hostCredentialsPath: join(dir, "none.json"), now: () => NOW });
    assert.equal(again.get(a.id)?.keyAlias, "claude-api-key-x");
    again.remove(a.id);
    assert.equal(again.get(a.id), undefined);
    assert.deepEqual(again.defaultOrder(), [HOST_ACCOUNT_ID]);
    assert.throws(() => again.addApiKey({ label: "x", keyAlias: "" }), /alias/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("alias の無い API キーの行は、壊れた台帳として断る", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-api-key-ledger-"));
  try {
    writeFileSync(
      join(dir, "claude-accounts.json"),
      JSON.stringify({ version: 1, accounts: [{ id: "k", kind: "api-key", label: "x", addedAt: NOW.toISOString() }], defaultOrder: ["k"] }),
    );
    assert.throws(() => new ClaudeAccountStore({ dataDir: dir, hostCredentialsPath: join(dir, "none.json") }), /壊れています/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("使ったトークンを足し、値段の表で金額の目安を出す。表に無いモデルは金額に入れず名前を残す", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-api-key-ledger-"));
  try {
    const store = new ClaudeAccountStore({ dataDir: dir, hostCredentialsPath: join(dir, "none.json"), now: () => NOW });
    const a = store.addApiKey({ label: "k", keyAlias: "a" });
    const t = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheWriteTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0 };
    store.recordTokens(a.id, "claude-sonnet-5", t);
    store.recordTokens(a.id, "unknown-model", t);
    // サブスクのアカウントには足さない
    store.recordTokens(HOST_ACCOUNT_ID, "claude-sonnet-5", t);
    const u = store.get(a.id)!.tokenUsage!;
    assert.equal(u.inputTokens, 2_000_000);
    assert.equal(u.outputTokens, 2_000_000);
    assert.equal(u.costUsd, 12);
    assert.deepEqual(u.unpricedModels, ["unknown-model"]);
    assert.equal(u.priceTable, PRICE_TABLE_VERSION);
    assert.equal(store.get(HOST_ACCOUNT_ID)!.tokenUsage, undefined);
    store.flush();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("値段：頭が合う行を使い、キャッシュの書きは寿命で分け、読みは個別の値段", () => {
  // Opus 5.5：入力 $4・出力 $20・書き 5分 $5・1時間 $8・読み $0.20（100万あたり）
  const cost = costOf("claude-opus-5-5[1m]", { inputTokens: 1e6, outputTokens: 1e6, cacheWriteTokens: 2e6, cacheWrite1hTokens: 1e6, cacheReadTokens: 1e6 });
  assert.ok(Math.abs(cost! - (4 + 20 + 5 + 8 + 0.2)) < 1e-9);
  assert.ok(Math.abs(costOf("claude-opus-5", { inputTokens: 1e6, outputTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0 })! - 5) < 1e-9);
  assert.equal(costOf("gpt-x", { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0 }), undefined);
});

test("上流への見出し：API キーは x-api-key と oauth- の無い beta、サブスクは Bearer と oauth の beta を足す", () => {
  assert.deepEqual(upstreamHeaders({ "anthropic-beta": "oauth-2025-04-20, foo-1", "content-type": "a" }, { kind: "api-key", key: "K" }), {
    "content-type": "a",
    "x-api-key": "K",
    "anthropic-beta": "foo-1",
  });
  assert.deepEqual(upstreamHeaders({ "anthropic-beta": "oauth-2025-04-20" }, { kind: "api-key", key: "K" }), { "x-api-key": "K" });
  assert.deepEqual(upstreamHeaders({ "anthropic-beta": "foo-1" }, { kind: "oauth", token: "T" }), {
    authorization: "Bearer T",
    "anthropic-beta": "foo-1,oauth-2025-04-20",
  });
  assert.deepEqual(upstreamHeaders({ "anthropic-beta": "oauth-2025-04-20" }, { kind: "oauth", token: "T" }), {
    authorization: "Bearer T",
    "anthropic-beta": "oauth-2025-04-20",
  });
});

test("API キーだけの banto：コンテナにも本体にも合言葉は ANTHROPIC_AUTH_TOKEN で渡し、キー・契約の種類は渡さない", async () => {
  const f = await fixture();
  try {
    const env = (await f.relay.envFor("p1", "http://x"))!;
    assert.match(env.ANTHROPIC_AUTH_TOKEN!, /^banto-/);
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(env.CLAUDE_CODE_SUBSCRIPTION_TYPE, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.ok(!Object.values(env).some((v) => v.includes(KEY)), "キーはコンテナに入らない");
    const runner = await f.relay.runnerEnvFor("p1", "t1", { sessionId: "s1" }, "http://x", { ANTHROPIC_API_KEY: "outer", CLAUDE_CODE_OAUTH_TOKEN: "outer", PATH: "/bin" });
    assert.match(runner.ANTHROPIC_AUTH_TOKEN!, /^banto-runner-/);
    assert.equal(runner.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(runner.ANTHROPIC_API_KEY, undefined);
    assert.equal(runner.CLAUDE_CODE_SUBSCRIPTION_TYPE, undefined);
    assert.equal(runner.PATH, "/bin");
    assert.ok(!Object.values(runner).some((v) => v?.includes(KEY)));
  } finally {
    await f.close();
  }
});

test("中継は Authorization を外して x-api-key を差し込み、oauth- の beta を付けない。stream の usage でトークンと金額を足す", async () => {
  const f = await fixture();
  try {
    const secret = (await f.relay.envFor("p1", "http://x"))!.ANTHROPIC_AUTH_TOKEN!;
    const res = await post(f.url, secret, "oauth-2025-04-20,fine-grained-x");
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /message_stop/, "本文はそのまま流れる");
    assert.deepEqual(f.seen, [{ auth: undefined, apiKey: KEY, beta: "fine-grained-x" }]);
    assert.deepEqual(f.resolved, ["claude-api-key-test"]);
    // 流し終わってから足される
    await new Promise((r) => setImmediate(r));
    const u = f.accounts.get(f.keyId)!.tokenUsage!;
    assert.equal(u.inputTokens, 1000);
    assert.equal(u.outputTokens, 300);
    assert.equal(u.cacheWriteTokens, 2000);
    assert.equal(u.cacheReadTokens, 10000);
    // Opus 5.5：入力 1000×4 + 出力 300×20 + 書き5分 1500×5 + 書き1時間 500×8 + 読み 10000×0.2（100万あたり）
    const expected = (1000 * 4 + 300 * 20 + 1500 * 5 + 500 * 8 + 10000 * 0.2) / 1e6;
    assert.ok(Math.abs(u.costUsd - expected) < 1e-12, `${u.costUsd} ≠ ${expected}`);
    // stream でない応答も数える
    f.reply.sse = false;
    assert.equal((await post(f.url, secret)).status, 200);
    await new Promise((r) => setImmediate(r));
    assert.equal(f.accounts.get(f.keyId)!.tokenUsage!.outputTokens, 320);
  } finally {
    await f.close();
  }
});

test("API キーが断られたら（401）送り直さず、そのアカウントのカードを出す", async () => {
  const f = await fixture();
  try {
    f.reply.status = 401;
    const secret = (await f.relay.envFor("p1", "http://x"))!.ANTHROPIC_AUTH_TOKEN!;
    assert.equal((await post(f.url, secret)).status, 401);
    assert.equal(f.seen.length, 1);
    assert.deepEqual(f.unauthorized, [`${f.keyId}:API キーが断られました（401）`]);
  } finally {
    await f.close();
  }
});

test("Vault からキーを引けなければ、並びの次のアカウント（サブスク）へ。サブスクへ出すときは Bearer と oauth の beta", async () => {
  const f = await fixture({
    order: "key-then-host",
    resolve: async () => {
      throw new Error("どの Vault にもありません");
    },
  });
  try {
    const env = (await f.relay.envFor("p1", "http://x"))!;
    // 起こすときの先頭は API キー——合言葉は ANTHROPIC_AUTH_TOKEN（CLI は oauth の beta を付けない）
    const secret = env.ANTHROPIC_AUTH_TOKEN!;
    assert.equal((await post(f.url, secret)).status, 200);
    assert.deepEqual(f.seen, [{ auth: "Bearer HOST-ACCESS", apiKey: undefined, beta: "oauth-2025-04-20" }]);
  } finally {
    await f.close();
  }
});

test("Vault から引けず次も無ければ、理由を返す", async () => {
  const f = await fixture({
    resolve: async () => {
      throw new Error("どの Vault にもありません");
    },
  });
  try {
    const secret = (await f.relay.envFor("p1", "http://x"))!.ANTHROPIC_AUTH_TOKEN!;
    const res = await post(f.url, secret);
    assert.equal(res.status, 500);
    assert.match(await res.text(), /API キー（Vault の claude-api-key-test）を引けませんでした/);
    assert.equal(f.seen.length, 0);
  } finally {
    await f.close();
  }
});

test("サブスクが先頭なら今までどおり CLAUDE_CODE_OAUTH_TOKEN と契約の種類。使用率の読み直しは API キーを読まない", async () => {
  const f = await fixture({ order: "host-then-key" });
  try {
    const env = (await f.relay.envFor("p1", "http://x"))!;
    assert.match(env.CLAUDE_CODE_OAUTH_TOKEN!, /^banto-/);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(env.CLAUDE_CODE_SUBSCRIPTION_TYPE, "max");
    const { failures } = await f.relay.readUsage();
    assert.ok(!failures.some((x) => x.accountId === f.keyId), "API キーには読む口が無い——失敗にしない");
  } finally {
    await f.close();
  }
});
