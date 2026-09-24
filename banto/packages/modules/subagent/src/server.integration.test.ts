// Subagent Module を MCP の口から端まで通す——本物の Landlock（banto-landlock-exec）の中で
// 偽の ACP エージェントを起こす。Vault の中継だけは代役。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { listAgents } from "./agents.js";
import { createSubagentServer } from "./server.js";

async function withServer(
  fn: (call: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>, dirs: { project: string; data: string }) => Promise<void>,
  overrides: Partial<Parameters<typeof createSubagentServer>[0]> = {},
) {
  const root = mkdtempSync(join(tmpdir(), "subagent-it-"));
  const project = join(root, "project");
  const data = join(root, "data", "modules", "subagent-p1");
  mkdirSync(project, { recursive: true });
  mkdirSync(data, { recursive: true });
  const resolved: string[] = [];
  const server = createSubagentServer({
    projectRoot: project,
    moduleDataDir: data,
    relayClient: {
      lookupAlias: async (_dir, name) => ({ implementation: "vault-local", name }),
      resolveAlias: async (place) => {
        resolved.push(place.name);
        return `value-of-${place.name}`;
      },
    },
    guard: { dataDir: join(root, "data"), configDir: join(root, "config") },
    pathEntries: (process.env.PATH ?? "").split(":").filter(Boolean),
    agents: listAgents({ BANTO_SUBAGENT_FAKE_AGENT: "1" }),
    ...overrides,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    await fn(
      async (name, args) => {
        const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
        return { text: r.content[0]?.text ?? "", isError: r.isError === true };
      },
      { project, data },
    );
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("一覧：使えるエージェントと、その設定の候補", async () => {
  await withServer(async (call) => {
    const list = JSON.parse((await call("listSubagents", {})).text) as { id: string }[];
    assert.deepEqual(list.map((a) => a.id), ["fake"]);
    const desc = JSON.parse((await call("listSubagents", { agent: "fake" })).text) as {
      agent: { name: string };
      options: { category?: string; values: string[] }[];
    };
    assert.equal(desc.agent.name, "fake-agent");
    assert.deepEqual(desc.options.find((o) => o.category === "model")?.values, ["fake-small", "fake-large"]);
  });
});

test("仕事を頼むと、閉じ込めの中で走って返答が返る（モードは auto が掛かる）", async () => {
  await withServer(async (call, { data }) => {
    const r = await call("runSubagent", { agent: "fake", prompt: "やあ", model: "fake-large" });
    assert.equal(r.isError, false, r.text);
    const result = JSON.parse(r.text) as { text: string; stopReason: string; sessionId: string };
    assert.equal(result.stopReason, "end_turn");
    assert.match(result.text, /受け取った：やあ（model=fake-large effort=low mode=auto）/);
    // 会話はエージェントの専用ホームに残り、ルールセットの写しは残らない
    assert.ok(existsSync(join(data, "agents", "fake", "home", ".fake-agent", `${result.sessionId}.json`)));
    assert.deepEqual(readdirSync(join(data, "run")), []);
  });
});

test("閉じ込め：Project の根には書けて、外には書けない", async () => {
  await withServer(async (call, { project }) => {
    const inside = JSON.parse((await call("runSubagent", { agent: "fake", prompt: "[write inside.txt]" })).text) as { text: string };
    assert.match(inside.text, /書いた：inside\.txt/);
    assert.ok(existsSync(join(project, "inside.txt")));
    const outside = JSON.parse((await call("runSubagent", { agent: "fake", prompt: "[write ../outside.txt]" })).text) as { text: string };
    assert.match(outside.text, /書けなかった：.*(EACCES|permission denied)/i);
    assert.ok(!existsSync(join(project, "..", "outside.txt")));
  });
});

test("資格情報は Vault の alias から env で渡り、host の変数は渡らない", async () => {
  const before = process.env.BANTO_HOST_MCP_TOKEN;
  process.env.BANTO_HOST_MCP_TOKEN = "module-secret";
  try {
    await withServer(async (call) => {
      const withKey = JSON.parse(
        (await call("runSubagent", { agent: "fake", prompt: "[env FAKE_AGENT_TOKEN]", envSecrets: { FAKE_AGENT_TOKEN: "fake-token" } })).text,
      ) as { text: string };
      assert.match(withKey.text, /FAKE_AGENT_TOKEN は渡っている/);
      const host = JSON.parse((await call("runSubagent", { agent: "fake", prompt: "[env BANTO_HOST_MCP_TOKEN]" })).text) as { text: string };
      assert.match(host.text, /BANTO_HOST_MCP_TOKEN は渡っていない/);
      const refused = await call("runSubagent", { agent: "fake", prompt: "x", envSecrets: { BANTO_HOST_MCP_TOKEN: "a" } });
      assert.equal(refused.isError, true);
      assert.match(refused.text, /BANTO_ で始まる名前は使えません/);
    });
  } finally {
    if (before === undefined) delete process.env.BANTO_HOST_MCP_TOKEN;
    else process.env.BANTO_HOST_MCP_TOKEN = before;
  }
});

test("人への確認は、聞く口が無いので断り、断ったことを返り値に書く", async () => {
  await withServer(async (call) => {
    const r = JSON.parse((await call("runSubagent", { agent: "fake", prompt: "[permission]" })).text) as {
      text: string;
      permissions: { title: string; answer: string }[];
    };
    assert.match(r.text, /確認の答え：no/);
    assert.deepEqual(r.permissions, [{ title: "write danger.txt", answer: "reject_once" }]);
  });
});

test("続きから頼める（session id を渡す）", async () => {
  await withServer(async (call) => {
    const first = JSON.parse((await call("runSubagent", { agent: "fake", prompt: "みかんを数えて" })).text) as { sessionId: string };
    const second = JSON.parse(
      (await call("runSubagent", { agent: "fake", prompt: "前に何を頼んだ？", sessionId: first.sessionId })).text,
    ) as { text: string };
    assert.match(second.text, /前に頼まれたこと：みかんを数えて/);
  });
});

test("頼み方の誤りは、理由ごと isError で返す", async () => {
  await withServer(async (call) => {
    const unknown = await call("runSubagent", { agent: "gpt", prompt: "x" });
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /エージェント "gpt" はありません/);
    const badModel = await call("runSubagent", { agent: "fake", prompt: "x", model: "nope" });
    assert.equal(badModel.isError, true);
    assert.match(badModel.text, /"nope" はありません/);
  });
});

// **banto 本体の Claude ログインを共有する**（決定・2026-09-24、ユーザー）——本物のトークンは
// エージェントに入らず、中継だけが上流に差し込む
test("Claude は本体のログインを中継で使う：上流には本物、エージェントには合言葉だけ", async () => {
  const { createServer } = await import("node:http");
  const { writeFileSync } = await import("node:fs");
  const seen: { url: string; auth: string }[] = [];
  const upstream = createServer((req, res) => {
    seen.push({ url: req.url ?? "", auth: req.headers.authorization ?? "" });
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":"upstream"}');
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const port = (upstream.address() as { port: number }).port;
  const credDir = mkdtempSync(join(tmpdir(), "subagent-cred-"));
  const REAL = `real-access-token-${Date.now()}`;
  writeFileSync(join(credDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: REAL, refreshToken: "never-leaves" } }));
  const fake = listAgents({ BANTO_SUBAGENT_FAKE_AGENT: "1" })[0]!;
  try {
    await withServer(
      async (call) => {
        const ok = JSON.parse((await call("runSubagent", { agent: "fake", prompt: "[anthropic /v1/messages?beta=true]" })).text) as { text: string };
        assert.match(ok.text, /anthropic: 200 \{"ok":"upstream"\}/);
        assert.deepEqual(seen, [{ url: "/v1/messages?beta=true", auth: `Bearer ${REAL}` }]);
        // 推論以外は通さない（本体のトークンは会話の履歴やコネクタにも触れる広さを持つ）
        const other = JSON.parse((await call("runSubagent", { agent: "fake", prompt: "[anthropic /api/oauth/profile]" })).text) as { text: string };
        assert.match(other.text, /anthropic: 403 .*推論/);
        assert.equal(seen.length, 1, "推論以外が上流へ出た");
        // エージェントの環境には、本物のトークンも refresh token も無い
        for (const value of [REAL, "never-leaves"]) {
          const r = JSON.parse((await call("runSubagent", { agent: "fake", prompt: `[has ${value}]` })).text) as { text: string };
          assert.match(r.text, /環境に 含まない/, `${value} がエージェントの環境に入っている`);
        }
        // 自分の資格情報を渡したときは、中継を使わない
        const own = JSON.parse(
          (await call("runSubagent", { agent: "fake", prompt: "[env ANTHROPIC_BASE_URL]", envSecrets: { ANTHROPIC_API_KEY: "k" } })).text,
        ) as { text: string };
        assert.match(own.text, /ANTHROPIC_BASE_URL は渡っていない/);
      },
      {
        agents: [{ ...fake, sharesHostClaudeLogin: true, credentialEnv: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] }],
        claudeLogin: { credentialsPath: join(credDir, ".credentials.json"), upstream: `http://127.0.0.1:${port}` },
      },
    );
  } finally {
    upstream.close();
    rmSync(credDir, { recursive: true, force: true });
  }
});

test("本体が Claude にログインしていなければ、エージェントを起こさずに理由を返す", async () => {
  const fake = listAgents({ BANTO_SUBAGENT_FAKE_AGENT: "1" })[0]!;
  await withServer(
    async (call) => {
      const r = await call("runSubagent", { agent: "fake", prompt: "x" });
      assert.equal(r.isError, true);
      assert.match(r.text, /banto 本体が Claude にログインしていません/);
    },
    { agents: [{ ...fake, sharesHostClaudeLogin: true }], claudeLogin: { credentialsPath: "/nonexistent/.credentials.json" } },
  );
});
