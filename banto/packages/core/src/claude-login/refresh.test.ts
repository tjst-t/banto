import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_CODE_CLIENT_ID, CredentialRefresher, installedAgentSdkVersion, needsRefresh, relayRefreshDecision, VERIFIED_AGENT_SDK_VERSION } from "./refresh.js";
import { symlinkSync } from "node:fs";

const NOW = new Date("2026-10-16T12:00:00Z").getTime();

interface Fx {
  /** 置き場のフォルダの親（古い版の鍵は `<置き場のフォルダ>.lock`＝ここの claude.lock） */
  root: string;
  dir: string;
  path: string;
  calls: Record<string, unknown>[];
  reply: { status: number; body: unknown; before?: () => void };
  refresher: CredentialRefresher;
  read(): Record<string, unknown> & { claudeAiOauth: Record<string, unknown> };
  done(): void;
}

function fx(oauth: Record<string, unknown>, extra: Record<string, unknown> = {}): Fx {
  const root = mkdtempSync(join(tmpdir(), "claude-refresh-"));
  const dir = join(root, "claude");
  mkdirSync(dir);
  const path = join(dir, ".credentials.json");
  writeFileSync(path, JSON.stringify({ claudeAiOauth: oauth, ...extra }), { mode: 0o600 });
  const calls: Fx["calls"] = [];
  const reply: Fx["reply"] = { status: 200, body: { access_token: "A2", refresh_token: "R2", expires_in: 28800 } };
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    reply.before?.();
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const refresher = new CredentialRefresher({ credentialsPath: path, fetch: fakeFetch, now: () => NOW, lockRetryDelayMs: () => 5, log: () => {} });
  return {
    root,
    dir,
    path,
    calls,
    reply,
    refresher,
    read: () => JSON.parse(readFileSync(path, "utf8")),
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

const expiring = { accessToken: "A1", refreshToken: "R1", expiresAt: NOW + 60_000, scopes: ["user:inference"], subscriptionType: "max" };

test("5分の線は CLI と同じ（expiresAt が無いものは切れない扱い）", () => {
  assert.equal(needsRefresh({ expiresAt: NOW + 5 * 60_000 }, NOW), true);
  assert.equal(needsRefresh({ expiresAt: NOW + 5 * 60_000 + 1 }, NOW), false);
  assert.equal(needsRefresh({}, NOW), false);
});

test("まだ切れかけていなければ取り直さない", async () => {
  const f = fx({ ...expiring, expiresAt: NOW + 3_600_000 });
  try {
    assert.deepEqual(await f.refresher.ensureFresh(), { kind: "fresh", accessToken: "A1" });
    assert.equal(f.calls.length, 0);
  } finally {
    f.done();
  }
});

test("切れかけなら取り直し、差し替える欄だけ書き戻す（ほかの欄・ほかの鍵・0600 はそのまま、鍵は放す）", async () => {
  const f = fx({ ...expiring, rateLimitTier: "t" }, { mcpOAuth: { keep: 1 } });
  try {
    assert.deepEqual(await f.refresher.ensureFresh(), { kind: "refreshed", accessToken: "A2" });
    assert.deepEqual(f.calls, [{ grant_type: "refresh_token", refresh_token: "R1", client_id: CLAUDE_CODE_CLIENT_ID, scope: "user:inference" }]);
    const saved = f.read();
    assert.deepEqual(saved.mcpOAuth, { keep: 1 });
    assert.equal(saved.claudeAiOauth.accessToken, "A2");
    assert.equal(saved.claudeAiOauth.refreshToken, "R2");
    assert.equal(saved.claudeAiOauth.expiresAt, NOW + 28_800_000);
    assert.equal(saved.claudeAiOauth.subscriptionType, "max");
    assert.equal(saved.claudeAiOauth.rateLimitTier, "t");
    assert.equal(statSync(f.path).mode & 0o777, 0o600);
    assert.equal(existsSync(join(f.dir, ".oauth_refresh.lock")), false);
    assert.equal(existsSync(join(f.root, "claude.lock")), false);
    assert.equal(existsSync(join(f.dir, ".storage-write.lock")), false);
  } finally {
    f.done();
  }
});

test("置き場に clientId があればそれを使う", async () => {
  const f = fx({ ...expiring, clientId: "custom-client" });
  try {
    await f.refresher.ensureFresh();
    assert.equal(f.calls[0]!.client_id, "custom-client");
  } finally {
    f.done();
  }
});

test("同時に来た要求は、1回の取り直しを待ち合わせる", async () => {
  const f = fx(expiring);
  try {
    const out = await Promise.all([f.refresher.ensureFresh(), f.refresher.ensureFresh(), f.refresher.ensureFresh()]);
    assert.equal(f.calls.length, 1);
    assert.ok(out.every((o) => o.accessToken === "A2"));
  } finally {
    f.done();
  }
});

test("取り直している間に相手（CLI）が先に書いた：書かずに相手のものを採る", async () => {
  const f = fx(expiring);
  try {
    f.reply.before = () => {
      const cur = f.read();
      cur.claudeAiOauth.accessToken = "CLI-A";
      cur.claudeAiOauth.refreshToken = "CLI-R";
      writeFileSync(f.path, JSON.stringify(cur));
    };
    assert.deepEqual(await f.refresher.ensureFresh(), { kind: "adopted", accessToken: "CLI-A" });
    assert.equal(f.read().claudeAiOauth.refreshToken, "CLI-R");
  } finally {
    f.done();
  }
});

test("鍵の中で読み直して、相手が取り直していればそれを使う（取り直さない）", async () => {
  const f = fx(expiring);
  try {
    // 鍵を取る前に読んだのは A1。鍵を取るまでの間に相手が書いた形——seenAccessToken で同じことを作る
    const cur = f.read();
    cur.claudeAiOauth.accessToken = "CLI-A";
    writeFileSync(f.path, JSON.stringify(cur));
    assert.deepEqual(await f.refresher.ensureFresh({ force: true, seenAccessToken: "A1" }), { kind: "adopted", accessToken: "CLI-A" });
    assert.equal(f.calls.length, 0);
  } finally {
    f.done();
  }
});

test("鍵を相手が持っている（新しい）：取り直さず、今のトークンで流す（一時的な失敗）", async () => {
  const f = fx(expiring);
  try {
    mkdirSync(join(f.dir, ".oauth_refresh.lock"));
    const out = await f.refresher.ensureFresh();
    assert.equal(out.kind, "failed");
    assert.equal(out.kind === "failed" && out.needsHuman, false);
    assert.equal(out.accessToken, "A1");
    assert.equal(f.calls.length, 0);
    // 相手の鍵は外さない
    assert.equal(existsSync(join(f.dir, ".oauth_refresh.lock")), true);
  } finally {
    f.done();
  }
});

test("古い版の CLI の鍵（`<置き場のフォルダ>.lock`）が取られていても取り合い中にする", async () => {
  const f = fx(expiring);
  try {
    mkdirSync(join(f.root, "claude.lock"));
    const out = await f.refresher.ensureFresh();
    assert.equal(out.kind, "failed");
    assert.equal(f.calls.length, 0);
    // 新しい鍵は放している
    assert.equal(existsSync(join(f.dir, ".oauth_refresh.lock")), false);
  } finally {
    f.done();
  }
});

test("60秒より古い鍵は持ち主が死んだとみなして外し、取り直す", async () => {
  const f = fx(expiring);
  try {
    const lock = join(f.dir, ".oauth_refresh.lock");
    mkdirSync(lock);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    assert.equal((await f.refresher.ensureFresh()).kind, "refreshed");
    assert.equal(existsSync(lock), false);
  } finally {
    f.done();
  }
});

test("取り直しが断られた（invalid_grant）：人が直すしかない。置き場は触らない", async () => {
  const f = fx(expiring);
  try {
    f.reply.status = 400;
    f.reply.body = { error: "invalid_grant" };
    const out = await f.refresher.ensureFresh();
    assert.equal(out.kind, "failed");
    assert.equal(out.kind === "failed" && out.needsHuman, true);
    assert.match(out.kind === "failed" ? out.reason : "", /400 invalid_grant/);
    assert.equal(f.read().claudeAiOauth.refreshToken, "R1");
  } finally {
    f.done();
  }
});

for (const [status, body] of [
  [503, {}],
  [429, { error: "rate_limited" }],
  [400, { error: "invalid_scope" }],
] as const) {
  test(`取り直しの口が ${status}${"error" in body ? ` ${body.error}` : ""}：一時的（人に知らせない）、今のトークンを返す`, async () => {
    const f = fx(expiring);
    try {
      f.reply.status = status;
      f.reply.body = body;
      const out = await f.refresher.ensureFresh();
      assert.equal(out.kind === "failed" && out.needsHuman, false);
      assert.equal(out.accessToken, "A1");
    } finally {
      f.done();
    }
  });
}

test("401 で線を見ずに取り直すのは 5 分に1回まで（取り直した直後でも断られるなら人に知らせる）", async () => {
  const f = fx({ ...expiring, expiresAt: NOW + 3_600_000 });
  try {
    assert.equal((await f.refresher.ensureFresh({ force: true, seenAccessToken: "A1" })).kind, "refreshed");
    const again = await f.refresher.ensureFresh({ force: true, seenAccessToken: "A2" });
    assert.equal(again.kind, "failed");
    assert.equal(again.kind === "failed" && again.needsHuman, true);
    assert.equal(again.kind === "failed" && again.closeWhen, "authorized");
    assert.equal(f.calls.length, 1);
  } finally {
    f.done();
  }
});

test("invalid_grant は「ログインが壊れた」——閉じるのは refresh token が替わったとき", async () => {
  const f = fx(expiring);
  try {
    f.reply.status = 400;
    f.reply.body = { error: "invalid_grant" };
    const out = await f.refresher.ensureFresh();
    assert.equal(out.kind === "failed" && out.closeWhen, "refresh-token-changed");
  } finally {
    f.done();
  }
});

test("CLI の書き込み用の鍵（.storage-write.lock）が空かなければ書かず、新しいトークンを 0600 の退避ファイルに残す", async () => {
  const f = fx(expiring);
  try {
    mkdirSync(join(f.dir, ".storage-write.lock"));
    const out = await f.refresher.ensureFresh();
    assert.equal(out.kind, "failed");
    assert.equal(out.kind === "failed" && out.needsHuman, true);
    assert.equal(out.accessToken, "A2");
    assert.equal(f.read().claudeAiOauth.refreshToken, "R1");
    const { readdirSync } = await import("node:fs");
    const rescue = readdirSync(f.dir).find((n) => n.startsWith(".credentials.banto-rescue-"))!;
    assert.ok(rescue);
    assert.equal(statSync(join(f.dir, rescue)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(join(f.dir, rescue), "utf8")).claudeAiOauth.refreshToken, "R2");
  } finally {
    f.done();
  }
});

test("置き場が symlink なら取り直さない（今のトークンを返す）", async () => {
  const f = fx(expiring);
  try {
    const real = join(f.root, "real.json");
    writeFileSync(real, readFileSync(f.path));
    rmSync(f.path);
    symlinkSync(real, f.path);
    assert.deepEqual(await f.refresher.ensureFresh(), { kind: "fresh", accessToken: "A1" });
    assert.equal(f.calls.length, 0);
  } finally {
    f.done();
  }
});

test("claude.ai の scope も契約の種類も無いものは取り直さない", async () => {
  const f = fx({ accessToken: "A1", refreshToken: "R1", expiresAt: NOW + 1000, scopes: ["org:create_api_key"] });
  try {
    assert.deepEqual(await f.refresher.ensureFresh(), { kind: "fresh", accessToken: "A1" });
    assert.equal(f.calls.length, 0);
  } finally {
    f.done();
  }
});

test("返事の scope に claude.ai のものが無ければ書かない", async () => {
  const f = fx(expiring);
  try {
    f.reply.body = { access_token: "A2", refresh_token: "R2", expires_in: 3600, scope: "org:create_api_key" };
    const out = await f.refresher.ensureFresh();
    assert.equal(out.kind, "failed");
    assert.equal(f.read().claudeAiOauth.refreshToken, "R1");
  } finally {
    f.done();
  }
});

test("落ちて残った書きかけ（.credentials.json.banto-*.tmp）を消す", async () => {
  const f = fx({ ...expiring, expiresAt: NOW + 3_600_000 });
  try {
    writeFileSync(join(f.dir, ".credentials.json.banto-abc.tmp"), "secret");
    await f.refresher.ensureFresh();
    assert.equal(existsSync(join(f.dir, ".credentials.json.banto-abc.tmp")), false);
  } finally {
    f.done();
  }
});

test("同梱の Agent SDK は取り直しの手順を確かめた版（上げたら CLI の手順を確かめ直してから VERIFIED を上げる）", () => {
  assert.equal(installedAgentSdkVersion(), VERIFIED_AGENT_SDK_VERSION);
});

test("中継が取り直すかの決め方", () => {
  assert.equal(relayRefreshDecision({}, VERIFIED_AGENT_SDK_VERSION).enabled, true);
  assert.equal(relayRefreshDecision({}, "9.9.9").enabled, false);
  assert.equal(relayRefreshDecision({ BANTO_CLAUDE_RELAY_REFRESH: "0" }, VERIFIED_AGENT_SDK_VERSION).enabled, false);
  // 本物を別の道から指す別の banto は回さない。偽物を指す E2E（取り直しの口も差し替える）は回す
  assert.equal(relayRefreshDecision({ CLAUDE_SECURESTORAGE_CONFIG_DIR: "/x" }, VERIFIED_AGENT_SDK_VERSION).enabled, false);
  assert.equal(relayRefreshDecision({ BANTO_CLAUDE_RELAY_CREDENTIALS: "/x", BANTO_CLAUDE_RELAY_TOKEN_URL: "http://t" }, undefined).enabled, true);
});

test("refresh token が無ければ、ふだんはそのまま・force なら人が直すしかない", async () => {
  const f = fx({ accessToken: "A1", expiresAt: NOW + 1000 });
  try {
    assert.deepEqual(await f.refresher.ensureFresh(), { kind: "fresh", accessToken: "A1" });
    const forced = await f.refresher.ensureFresh({ force: true });
    assert.equal(forced.kind === "failed" && forced.needsHuman, true);
  } finally {
    f.done();
  }
});

test("返事に access token か期限が無ければ書かない", async () => {
  const f = fx(expiring);
  try {
    f.reply.body = { refresh_token: "R2" };
    const out = await f.refresher.ensureFresh();
    assert.equal(out.kind, "failed");
    assert.equal(f.read().claudeAiOauth.refreshToken, "R1");
  } finally {
    f.done();
  }
});
