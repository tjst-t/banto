// banto 全体の設定の Module（`settings-server.ts`）を MCP の口から通す。Vault は代役を共有し、
// 置いた鍵が Project ごとの Module（`server.ts`）の仕事に実際に届くところまで見る。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAgents } from "./agents.js";
import { fakeVault, sha, withServer, withSettings } from "./testing/harness.js";

test("取り込むと Vault に置かれ、envSecrets を書かなくても仕事に届く。値は状態に出ない", async () => {
  const dir = mkdtempSync(join(tmpdir(), "subagent-import-"));
  const IMPORTED = `imported-${Date.now()}`;
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ fake: { type: "api", key: IMPORTED }, other: { type: "oauth", key: "x" } }));
  const vault = fakeVault();
  const agents = listAgents({ BANTO_SUBAGENT_FAKE_AGENT: "1", BANTO_SUBAGENT_FAKE_IMPORT_FILE: join(dir, "auth.json") });
  try {
    await withSettings(
      async (settings) => {
        const before = JSON.parse((await settings("getCredentials", {})).text) as {
          agents: { id: string; importLabel?: string; keys?: { env: string; set: boolean; importable: boolean }[] }[];
        };
        const fake = before.agents.find((a) => a.id === "fake")!;
        assert.equal(fake.importLabel, "試験用の設定ファイル");
        assert.deepEqual(fake.keys, [{ env: "FAKE_AGENT_TOKEN", alias: "subagent.fake.FAKE_AGENT_TOKEN", set: false, importable: true }]);
        assert.doesNotMatch(JSON.stringify(before), new RegExp(IMPORTED));

        const imported = await settings("importCredential", { agent: "fake", env: "FAKE_AGENT_TOKEN" });
        assert.equal(imported.isError, false, imported.text);
        assert.equal(vault.store.get("subagent.fake.FAKE_AGENT_TOKEN"), IMPORTED);
        const after = JSON.parse((await settings("getCredentials", {})).text) as { agents: { id: string; keys?: { set: boolean }[] }[] };
        assert.equal(after.agents.find((a) => a.id === "fake")!.keys![0]!.set, true);
      },
      { relayClient: vault.relay, agents },
    );
    await withServer(
      async (call) => {
        // envSecrets を書かなくても、設定の鍵が届く（値そのものが届いたかを sha で見る）
        const r = JSON.parse((await call("runSubagent", { agent: "fake", prompt: "[sha FAKE_AGENT_TOKEN]" })).text) as { text: string };
        assert.match(r.text, new RegExp(`FAKE_AGENT_TOKEN の sha256：${sha(IMPORTED)}`));
        // envSecrets で渡したほうが勝つ
        const explicit = JSON.parse(
          (await call("runSubagent", { agent: "fake", prompt: "[sha FAKE_AGENT_TOKEN]", envSecrets: { FAKE_AGENT_TOKEN: "given" } })).text,
        ) as { text: string };
        assert.match(explicit.text, new RegExp(sha("value-of-given")));
      },
      { relayClient: vault.relay, agents },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("貼った鍵は置き換えられ、消せる", async () => {
  const vault = fakeVault();
  await withSettings(
    async (settings) => {
      assert.equal((await settings("setCredential", { agent: "fake", env: "FAKE_AGENT_TOKEN", value: "  first  " })).isError, false);
      assert.equal(vault.store.get("subagent.fake.FAKE_AGENT_TOKEN"), "first");
      assert.equal((await settings("setCredential", { agent: "fake", env: "FAKE_AGENT_TOKEN", value: "second" })).isError, false);
      assert.equal(vault.store.get("subagent.fake.FAKE_AGENT_TOKEN"), "second");
      // 置き換えは、消してから作り直す（Vault の値を置き換える口は oauth-token にしか無い）
      assert.deepEqual(vault.calls, ["create subagent.fake.FAKE_AGENT_TOKEN", "delete subagent.fake.FAKE_AGENT_TOKEN", "create subagent.fake.FAKE_AGENT_TOKEN"]);

      assert.equal((await settings("deleteCredential", { agent: "fake", env: "FAKE_AGENT_TOKEN" })).isError, false);
      assert.equal(vault.store.has("subagent.fake.FAKE_AGENT_TOKEN"), false);
      const again = await settings("deleteCredential", { agent: "fake", env: "FAKE_AGENT_TOKEN" });
      assert.equal(again.isError, true);
      assert.match(again.text, /設定されていません/);
    },
    { relayClient: vault.relay },
  );
});

test("置けないものは理由ごと断る：空・知らない変数・本体のログインを使うエージェント・取り込み元が無い", async () => {
  const vault = fakeVault();
  await withSettings(
    async (settings) => {
      assert.match((await settings("setCredential", { agent: "fake", env: "FAKE_AGENT_TOKEN", value: "  " })).text, /鍵が空です/);
      assert.match((await settings("setCredential", { agent: "fake", env: "OTHER", value: "x" })).text, /OTHER はありません/);
      const host = await settings("setCredential", { agent: "fake-host", env: "ANTHROPIC_API_KEY", value: "x" });
      assert.equal(host.isError, true);
      assert.match(host.text, /banto 本体のログインを使います/);
      assert.match((await settings("importCredential", { agent: "fake", env: "FAKE_AGENT_TOKEN" })).text, /鍵が見つかりません/);
      assert.match((await settings("setCredential", { agent: "gpt", env: "X", value: "x" })).text, /エージェント "gpt" はありません/);
      assert.equal(vault.store.size, 0);
    },
    { relayClient: vault.relay },
  );
});

test("本体のログインの状態（契約の種類）を出す。読めなければ理由を出す", async () => {
  const credDir = mkdtempSync(join(tmpdir(), "subagent-cred-"));
  writeFileSync(
    join(credDir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "t", subscriptionType: "max", rateLimitTier: "tier-x" } }),
  );
  try {
    await withSettings(
      async (settings) => {
        const status = JSON.parse((await settings("getCredentials", {})).text) as { agents: { id: string; hostLogin?: unknown }[] };
        assert.deepEqual(status.agents.find((a) => a.id === "fake-host")!.hostLogin, {
          loggedIn: true,
          subscriptionType: "max",
          rateLimitTier: "tier-x",
        });
        // トークンは出さない
        assert.doesNotMatch(JSON.stringify(status), /"t"|accessToken/);
      },
      { claudeCredentialsPath: join(credDir, ".credentials.json") },
    );
    await withSettings(async (settings) => {
      const status = JSON.parse((await settings("getCredentials", {})).text) as { agents: { id: string; hostLogin?: { loggedIn: boolean; reason?: string } }[] };
      const h = status.agents.find((a) => a.id === "fake-host")!.hostLogin!;
      assert.equal(h.loggedIn, false);
      assert.match(h.reason!, /banto 本体が Claude にログインしていません/);
    });
  } finally {
    rmSync(credDir, { recursive: true, force: true });
  }
});

// **本体の Claude ログインの中継は、banto 全体の設定の Module が持つ**（決定・2026-09-25）。サブエージェントの
// Module は Project のコンテナの中にいて、本体のログインは中に無い——中継を開いてもらい、住所と合言葉だけを受け取る
test("Claude の中継：状態は値を返さず、自分のアドレスでだけ開き、合言葉で通り、閉じたら使えない", async () => {
  const credDir = mkdtempSync(join(tmpdir(), "subagent-settings-claude-"));
  const REAL = `real-access-${Date.now()}`;
  writeFileSync(join(credDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: REAL, refreshToken: "never-leaves", subscriptionType: "max" } }));
  // 上流の代役：受け取った Authorization をそのまま返す
  const { createServer } = await import("node:http");
  const upstream = createServer((req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ auth: req.headers.authorization })));
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const port = (upstream.address() as { port: number }).port;
  try {
    await withSettings(
      async (settings) => {
        const status = await settings("claudeLoginStatus", {});
        assert.equal(status.isError, false, status.text);
        assert.deepEqual(JSON.parse(status.text), { loggedIn: true, subscriptionType: "max" });
        assert.doesNotMatch(status.text, new RegExp(REAL));

        // 自分のアドレス以外では待ち受けない（外から届く口にしない）
        const refused = await settings("openClaudeLoginProxy", { listenHost: "0.0.0.0" });
        assert.equal(refused.isError, true);
        assert.match(refused.text, /自分のアドレスでしか待ち受けません/);

        const opened = await settings("openClaudeLoginProxy", { listenHost: "127.0.0.1" });
        assert.equal(opened.isError, false, opened.text);
        assert.doesNotMatch(opened.text, new RegExp(REAL), "本物のトークンを渡している");
        const p = JSON.parse(opened.text) as { proxyId: string; url: string; secret: string; subscriptionType?: string };
        assert.equal(p.subscriptionType, "max");
        const through = await fetch(`${p.url}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${p.secret}` }, body: "{}" });
        assert.deepEqual(await through.json(), { auth: `Bearer ${REAL}` }, "中継が本体のトークンに差し替えていない");
        const wrong = await fetch(`${p.url}/v1/messages`, { method: "POST", headers: { authorization: "Bearer nope" }, body: "{}" });
        assert.equal(wrong.status, 401);

        const closed = await settings("closeClaudeLoginProxy", { proxyId: p.proxyId });
        assert.deepEqual(JSON.parse(closed.text), { upstreamAuthFailures: 0 });
        await assert.rejects(fetch(`${p.url}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${p.secret}` }, body: "{}" }));
      },
      { claudeCredentialsPath: join(credDir, ".credentials.json"), claudeUpstream: `http://127.0.0.1:${port}` },
    );
  } finally {
    upstream.close();
    rmSync(credDir, { recursive: true, force: true });
  }
});
