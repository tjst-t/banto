// 中継の上での温め直し（§3.1「温め直し（中継）」）：本体の要求の usage を読む口・温め直しの送り方・送り直さないこと・固定の寿命
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_LOGIN_PATH, ClaudeLoginRelay, type ClaudeLoginListener } from "./relay.js";
import { ClaudeAccountStore, type ClaudeAccountMode } from "./accounts.js";

const CORE: ClaudeLoginListener = { acceptsProject: () => true, bindSource: true, acceptsRunner: true };
const MIN = 60_000;
const T0 = Date.parse("2026-10-20T00:00:00Z");

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

interface Seen {
  auth: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
  raw: string;
}

/** 上流の返事：stream なら SSE で message_start の usage、でなければ JSON の usage */
interface Reply {
  status?: number;
  usage?: { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
  headers?: Record<string, string>;
}

async function fixture(opts: { mode?: ClaudeAccountMode; warmable?: () => boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "claude-keep-alive-"));
  writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "REAL-ACCESS", refreshToken: "r" } }));
  const seen: Seen[] = [];
  const replies: { byToken: Record<string, Reply>; next: Reply[] } = { byToken: {}, next: [] };
  const upstream = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      const auth = req.headers.authorization ?? "";
      seen.push({ auth, headers: req.headers, body, raw });
      const r = replies.next.shift() ?? replies.byToken[auth.replace(/^Bearer /, "")] ?? {};
      const usage = r.usage ?? { input_tokens: 10, cache_read_input_tokens: 79_990, cache_creation_input_tokens: 0 };
      if ((r.status ?? 200) !== 200) {
        res.writeHead(r.status!, { "content-type": "application/json", ...r.headers }).end('{"type":"error"}');
        return;
      }
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", ...r.headers });
        res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m", usage } })}\n\n`);
        res.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json", ...r.headers }).end(JSON.stringify({ id: "m", type: "message", content: [], usage }));
    });
  });
  const upstreamUrl = await listen(upstream);
  const clock = { now: T0 };
  const accounts = new ClaudeAccountStore({ dataDir: dir, hostCredentialsPath: join(dir, ".credentials.json"), now: () => new Date(clock.now) });
  accounts.setMode(opts.mode ?? "ordered");
  const switches: unknown[] = [];
  const relay = new ClaudeLoginRelay({
    accounts,
    secretsPath: join(dir, "secrets.json"),
    upstream: upstreamUrl,
    enabled: () => true,
    sourceMatches: async () => true,
    refreshEnabled: false,
    onAccountSwitched: (c) => switches.push(c),
    ...(opts.warmable ? { keepAliveWarmable: opts.warmable } : {}),
    now: () => new Date(clock.now),
  });
  // 本体用の合言葉（refreshEnabled: false の banto は本体が中継を通らないので、合言葉だけ作る）
  (relay as unknown as { runnerSecrets: Map<string, string> }).runnerSecrets.set("p1", "RUNNER-SECRET");
  const front = createServer((req, res) => void relay.handle(req, res, CORE));
  const url = await listen(front);
  /** 本体の CLI と同じ形で1回送る（stream・Thread の印・セッションの印） */
  const send = async (session: string, content: string, extra: Record<string, unknown> = {}) => {
    const res = await fetch(`${url}${CLAUDE_LOGIN_PATH}/v1/messages?beta=true`, {
      method: "POST",
      headers: {
        authorization: "Bearer RUNNER-SECRET",
        "content-type": "application/json",
        accept: "text/event-stream",
        "anthropic-beta": "oauth-2025-04-20",
        "x-banto-thread-id": "t1",
        "x-claude-code-session-id": session,
      },
      body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 128000, stream: true, thinking: { type: "adaptive" }, messages: [{ role: "user", content }], ...extra }),
    });
    const text = await res.text();
    return { status: res.status, text };
  };
  return {
    relay,
    accounts,
    seen,
    replies,
    clock,
    switches,
    send,
    url,
    closeUpstream: async () => {
      upstream.closeAllConnections();
      await new Promise((r) => upstream.close(r));
    },
    at: async (minutes: number) => {
      clock.now = T0 + minutes * MIN;
      await relay.keepAlive.runDue();
    },
    close: async () => {
      relay.close();
      front.closeAllConnections();
      upstream.closeAllConnections();
      await Promise.all([new Promise((r) => front.close(r)), new Promise((r) => upstream.close(() => r(undefined)))]);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const TICKET = { sessionId: "s1", fingerprint: "fp" };

test("中継は本体の要求の message_start の usage を読み（流れはそのまま返す）、温め直しは同じアカウントへ max_tokens 0・stream 無しで送る", async () => {
  const f = await fixture();
  try {
    f.relay.keepAlive.turnStarted("t1");
    const first = await f.send("s1", "hello");
    assert.equal(first.status, 200);
    // 応答は変えずに返している
    assert.match(first.text, /message_start/);
    assert.match(first.text, /message_stop/);
    f.relay.keepAlive.turnEnded("t1", TICKET);
    assert.equal(f.relay.keepAlive.warmingCount(), 1);
    assert.equal(f.relay.keepAlive.cacheOf("t1")!.lastHitAt, T0);

    await f.at(49);
    assert.equal(f.seen.length, 1);
    await f.at(55);
    assert.equal(f.seen.length, 2);
    const warm = f.seen[1]!;
    assert.equal(warm.auth, "Bearer REAL-ACCESS");
    assert.equal(warm.body.max_tokens, 0);
    assert.equal("stream" in warm.body, false);
    // キャッシュの前方一致に入るもの（messages・思考の設定）は同じ
    assert.deepEqual(warm.body.messages, [{ role: "user", content: "hello" }]);
    assert.deepEqual(warm.body.thinking, { type: "adaptive" });
    // Thread の印は上流へ付けない。セッションの印と beta はそのまま。長さは付け直す。stream を求めない
    assert.equal(warm.headers["x-banto-thread-id"], undefined);
    assert.equal(warm.headers["x-claude-code-session-id"], "s1");
    assert.equal(warm.headers["anthropic-beta"], "oauth-2025-04-20");
    assert.equal(Number(warm.headers["content-length"]), Buffer.byteLength(warm.raw));
    assert.doesNotMatch(String(warm.headers.accept), /event-stream/);
    assert.equal(f.relay.keepAlive.cacheOf("t1")!.lastHitAt, T0 + 55 * MIN);
  } finally {
    await f.close();
  }
});

test("温め直しは送り直さない：429 でも並びの次のアカウントへ送らず、固定を移さず、切り替えを記録せず、その会話の温め直しをやめる", async () => {
  for (const status of [429, 401, 500]) {
    const f = await fixture();
    try {
      f.accounts.add({ email: "b@example.com", oauth: { accessToken: "B-ACCESS" } });
      f.relay.keepAlive.turnStarted("t1");
      assert.equal((await f.send("s1", "hello")).status, 200);
      f.relay.keepAlive.turnEnded("t1", TICKET);
      f.replies.next.push({
        status,
        headers: status === 429 ? { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": String(T0 / 1000 + 3600) } : {},
      });
      await f.at(55);
      await f.at(105);
      assert.deepEqual(
        f.seen.map((s) => s.auth),
        ["Bearer REAL-ACCESS", "Bearer REAL-ACCESS"],
        `status ${status}`,
      );
      assert.deepEqual(f.switches, []);
      assert.match(f.relay.keepAlive.cacheOf("t1")!.abandoned ?? "", new RegExp(`${status}`));
      if (status === 429) {
        // 使用率は台帳に覚える（次の選びが古い値にならないように）
        assert.equal(f.accounts.usageOf("host")?.status, "rejected");
      }
    } finally {
      await f.close();
    }
  }
});

test("上流に届かなければ送り直さずにやめる", async () => {
  const f = await fixture();
  try {
    f.relay.keepAlive.turnStarted("t1");
    assert.equal((await f.send("s1", "hello")).status, 200);
    f.relay.keepAlive.turnEnded("t1", TICKET);
    await f.closeUpstream();
    await f.at(55);
    assert.match(f.relay.keepAlive.cacheOf("t1")!.abandoned ?? "", /届きませんでした/);
  } finally {
    await f.close();
  }
});

test("均す：温め直しは固定の寿命を延ばす（4時間の間に固定が切れて別のアカウントに選ばれない）", async () => {
  const f = await fixture({ mode: "balance" });
  try {
    f.accounts.add({ email: "b@example.com", oauth: { accessToken: "B-ACCESS" } });
    f.relay.keepAlive.turnStarted("t1");
    assert.equal((await f.send("s1", "hello")).status, 200);
    f.relay.keepAlive.turnEnded("t1", TICKET);
    assert.equal(f.relay.pinnedAccountOfThread("t1"), "host");
    await f.at(55);
    await f.at(105);
    // 最後の本物の要求から 110 分——温め直しが無ければ1時間で切れている
    f.clock.now = T0 + 110 * MIN;
    assert.equal(f.relay.pinnedAccountOfThread("t1"), "host");
  } finally {
    await f.close();
  }
});

test("余白：固定のアカウントの5時間の使用率が閾値（95%）より15ポイント下でなければ送らない", async () => {
  const f = await fixture();
  try {
    const reset = String(T0 / 1000 + 5 * 3600);
    f.replies.byToken["REAL-ACCESS"] = { headers: { "anthropic-ratelimit-unified-5h-utilization": "0.81", "anthropic-ratelimit-unified-5h-reset": reset } };
    f.relay.keepAlive.turnStarted("t1");
    assert.equal((await f.send("s1", "hello")).status, 200);
    f.relay.keepAlive.turnEnded("t1", TICKET);
    await f.at(55);
    assert.equal(f.seen.length, 1);
    assert.match(f.relay.keepAlive.cacheOf("t1")!.abandoned ?? "", /5時間 81%/);

    // 80% ちょうどなら送る
    f.replies.byToken["REAL-ACCESS"] = { headers: { "anthropic-ratelimit-unified-5h-utilization": "0.8", "anthropic-ratelimit-unified-5h-reset": reset } };
    f.relay.keepAlive.turnStarted("t1");
    assert.equal((await f.send("s1", "again")).status, 200);
    f.relay.keepAlive.turnEnded("t1", TICKET);
    await f.at(110);
    assert.equal(f.seen.length, 3);
  } finally {
    await f.close();
  }
});

test("host が温めてよくないと言ったら（モデルを変えた等）送らない。stream でない要求の usage も読む", async () => {
  let warmable = true;
  const f = await fixture({ warmable: () => warmable });
  try {
    f.relay.keepAlive.turnStarted("t1");
    assert.equal((await f.send("s1", "hello", { stream: false })).status, 200);
    f.relay.keepAlive.turnEnded("t1", TICKET);
    assert.equal(f.relay.keepAlive.warmingCount(), 1);
    warmable = false;
    await f.at(55);
    assert.equal(f.seen.length, 1);
    assert.equal(f.relay.keepAlive.warmingCount(), 0);
  } finally {
    await f.close();
  }
});

test("コンテナからの要求・count_tokens・Thread の印の無い要求は候補にしない", async () => {
  const f = await fixture();
  try {
    const container = (await f.relay.envFor("p1", "http://x"))!.CLAUDE_CODE_OAUTH_TOKEN!;
    const body = JSON.stringify({ model: "m", max_tokens: 10, stream: true, messages: [{ role: "user", content: "x" }] });
    const post = (secret: string, path: string, headers: Record<string, string>) =>
      fetch(`${f.url}${CLAUDE_LOGIN_PATH}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", "x-claude-code-session-id": "s1", ...headers },
        body,
      }).then((r) => r.text());
    f.relay.keepAlive.turnStarted("t1");
    // コンテナの合言葉（Thread の印を付けても読まない）
    await post(container, "/v1/messages", { "x-banto-thread-id": "t1" });
    // 本体でも count_tokens
    await post("RUNNER-SECRET", "/v1/messages/count_tokens", { "x-banto-thread-id": "t1" });
    // 本体でも Thread の印が無い
    await post("RUNNER-SECRET", "/v1/messages", {});
    assert.equal(f.seen.length, 3);
    f.relay.keepAlive.turnEnded("t1", TICKET);
    assert.equal(f.relay.keepAlive.warmingCount(), 0);
  } finally {
    await f.close();
  }
});
