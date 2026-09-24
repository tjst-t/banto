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
