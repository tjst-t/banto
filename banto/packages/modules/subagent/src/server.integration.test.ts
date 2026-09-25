// Subagent Module を MCP の口から端まで通す——偽の ACP エージェントを起こす。Vault の中継だけは代役。
// 閉じ込めは Project のコンテナ（決定・2026-09-25）なので、ここでは確かめない——E2E（subagent.spec.ts）が
// コンテナの中で確かめる
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAgents } from "./agents.js";
import { localClaudeLogin } from "./claude-login-access.js";
import { fakeVault, sha, withServer } from "./testing/harness.js";

test("一覧：使えるエージェントと、その設定の候補", async () => {
  await withServer(async (call) => {
    const list = JSON.parse((await call("listSubagents", {})).text) as { id: string; credentials: string }[];
    assert.deepEqual(list.map((a) => a.id), ["fake", "fake-host"]);
    // 何を書かずに使えるかも返す
    assert.match(list[0]!.credentials, /banto 全体の設定の「サブエージェント」で入れた鍵を使う/);
    assert.match(list[1]!.credentials, /使えない：banto 本体が Claude にログインしていません/);
    const desc = JSON.parse((await call("listSubagents", { agent: "fake" })).text) as {
      agent: { name: string };
      options: { category?: string; values: string[] }[];
    };
    assert.equal(desc.agent.name, "fake-agent");
    assert.deepEqual(desc.options.find((o) => o.category === "model")?.values, ["fake-small", "fake-large"]);
  });
});

test("仕事を頼むと、返答が返る（モードは auto が掛かる）", async () => {
  await withServer(async (call, { data }) => {
    const r = await call("runSubagent", { agent: "fake", prompt: "やあ", model: "fake-large" });
    assert.equal(r.isError, false, r.text);
    const result = JSON.parse(r.text) as { text: string; stopReason: string; sessionId: string };
    assert.equal(result.stopReason, "end_turn");
    assert.match(result.text, /受け取った：やあ（model=fake-large effort=low mode=auto）/);
    // 会話はエージェントの専用ホームに残る
    assert.ok(existsSync(join(data, "agents", "fake", "home", ".fake-agent", `${result.sessionId}.json`)));
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
        claudeLogin: localClaudeLogin({ credentialsPath: join(credDir, ".credentials.json"), upstream: `http://127.0.0.1:${port}` }),
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
    { agents: [{ ...fake, sharesHostClaudeLogin: true }], claudeLogin: localClaudeLogin({ credentialsPath: "/nonexistent/.credentials.json" }) },
  );
});

test("会話からは目録を引かない：既定の鍵は名前で直接引き、無ければ読み飛ばす", async () => {
  const vault = fakeVault();
  await withServer(
    async (call) => {
      const r = JSON.parse((await call("runSubagent", { agent: "fake", prompt: "[env FAKE_AGENT_TOKEN]" })).text) as { text: string };
      assert.match(r.text, /FAKE_AGENT_TOKEN は渡っていない/);
      assert.deepEqual(vault.calls, ["lookup subagent.fake.FAKE_AGENT_TOKEN"]);
      await call("listSubagents", {});
      assert.deepEqual(vault.calls, ["lookup subagent.fake.FAKE_AGENT_TOKEN"], "一覧で Vault を引いている");
    },
    { relayClient: vault.relay },
  );
});

test("既定の鍵が在るか分からない（読めていない Vault がある）ときは、仕事は止めず、注記に書く", async () => {
  const vault = fakeVault({}, { unreadableVault: true });
  await withServer(
    async (call) => {
      const r = await call("runSubagent", { agent: "fake", prompt: "[env FAKE_AGENT_TOKEN]" });
      assert.equal(r.isError, false, r.text);
      const result = JSON.parse(r.text) as { text: string; notes: string[] };
      assert.match(result.text, /FAKE_AGENT_TOKEN は渡っていない/);
      assert.equal(result.notes.length, 1);
      assert.match(result.notes[0]!, /FAKE_AGENT_TOKEN：設定の鍵を確かめられませんでした（alias "subagent\.fake\.FAKE_AGENT_TOKEN" は見つかりませんでしたが、読めていない Vault があります/);
    },
    { relayClient: vault.relay },
  );
});

test("本体のログインを使うエージェントには、契約の種類を渡して既定を本体と揃える", async () => {
  const credDir = mkdtempSync(join(tmpdir(), "subagent-cred-"));
  writeFileSync(
    join(credDir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "t", subscriptionType: "max", rateLimitTier: "tier-x" } }),
  );
  try {
    await withServer(
      async (call) => {
        for (const [name, value] of [["CLAUDE_CODE_SUBSCRIPTION_TYPE", "max"], ["CLAUDE_CODE_RATE_LIMIT_TIER", "tier-x"]] as const) {
          const r = JSON.parse((await call("runSubagent", { agent: "fake-host", prompt: `[sha ${name}]` })).text) as { text: string };
          assert.match(r.text, new RegExp(sha(value)), `${name} が届いていない`);
        }
        // 本体のログインの状態は、一覧にも出る
        const list = JSON.parse((await call("listSubagents", {})).text) as { id: string; credentials: string }[];
        assert.match(list.find((a) => a.id === "fake-host")!.credentials, /banto 本体の Claude ログインを使う（契約：max/);
      },
      { claudeLogin: localClaudeLogin({ credentialsPath: join(credDir, ".credentials.json") }) },
    );
  } finally {
    rmSync(credDir, { recursive: true, force: true });
  }
});

test("Project ごとの Module は鍵の設定の口を持たない（banto 全体の設定の Module が持つ）", async () => {
  await withServer(async (call) => {
    for (const tool of ["getCredentials", "setCredential", "importCredential", "deleteCredential"]) {
      await assert.rejects(call(tool, {}), /unknown tool/, `${tool} が Project ごとの Module に残っている`);
    }
  });
});

// ---- 頼んだ仕事の記録（launcher の画面が読む。決定・2026-09-24、ユーザー） ------------------------

interface Summary { id: string; status: string; promptHead: string; agentTitle: string; lastProgress?: string; toolCount: number }

test("仕事の記録：終わった仕事は一覧と中身に出る。起こす前に止まったものも「失敗」で残る", async () => {
  await withServer(async (call) => {
    const r = JSON.parse((await call("runSubagent", { agent: "fake", prompt: "[write memo.txt] メモを書いて", model: "fake-large" })).text) as { sessionId: string };
    const bad = await call("runSubagent", { agent: "fake", prompt: "モデル違い", model: "nope" });
    assert.equal(bad.isError, true);

    const list = JSON.parse((await call("listRuns", {})).text) as { runs: Summary[] };
    const agents = JSON.parse((await call("listAgents", {})).text) as {
      agents: { id: string; keys?: string[]; hostLogin?: { loggedIn: boolean } }[];
    };
    assert.deepEqual(agents.agents.map((a) => a.id), ["fake", "fake-host"]);
    assert.deepEqual(agents.agents[0]!.keys, []);
    assert.equal(agents.agents[1]!.hostLogin?.loggedIn, false);
    // 新しい順
    assert.deepEqual(list.runs.map((x) => [x.status, x.promptHead]), [["error", "モデル違い"], ["done", "[write memo.txt] メモを書いて"]]);
    assert.equal(list.runs[1]!.toolCount, 1);

    const done = JSON.parse((await call("getRun", { id: list.runs[1]!.id })).text) as {
      status: string; sessionId: string; text: string; toolCalls: string[]; model: string; usage: { outputTokens: number };
      steps: { title: string; kind?: string; at: number }[]; startedAt: number;
    };
    assert.equal(done.sessionId, r.sessionId);
    assert.match(done.text, /書いた：memo\.txt/);
    assert.deepEqual(done.toolCalls, ["write memo.txt"]);
    // 経過：呼んだ順・種類・時刻
    assert.deepEqual(done.steps.map((st) => [st.title, st.kind]), [["write memo.txt", "other"]]);
    assert.ok(done.steps[0]!.at >= done.startedAt);
    assert.equal(done.model, "fake-large");
    assert.equal(done.usage.outputTokens, 20);
    const failed = JSON.parse((await call("getRun", { id: list.runs[0]!.id })).text) as { error: string };
    assert.match(failed.error, /"nope" はありません/);
    assert.match((await call("getRun", { id: "nope" })).text, /仕事 "nope" はありません/);
  });
});

test("仕事の記録：走っている仕事は様子が見え、画面から止めると取り消しで返る", async () => {
  await withServer(async (call) => {
    const pending = call("runSubagent", { agent: "fake", prompt: "[slow 30] 長い仕事" });
    let running: Summary | undefined;
    for (let i = 0; i < 50 && !running?.lastProgress?.startsWith("ツール："); i++) {
      await new Promise((r) => setTimeout(r, 100));
      running = (JSON.parse((await call("listRuns", {})).text) as { runs: Summary[] }).runs.find((x) => x.status === "running");
    }
    assert.ok(running, "走っている仕事が一覧に出ない");
    assert.equal(running.lastProgress, "ツール：sleep 30");
    assert.equal(running.toolCount, 1);
    assert.equal((running as Summary & { lastStep?: { title: string } }).lastStep?.title, "sleep 30");

    assert.equal((await call("cancelRun", { id: running.id })).isError, false);
    const result = JSON.parse((await pending).text) as { stopReason: string };
    assert.equal(result.stopReason, "cancelled");
    const after = (JSON.parse((await call("listRuns", {})).text) as { runs: Summary[] }).runs[0]!;
    assert.equal(after.status, "cancelled");
    // もう走っていないものは止められない（と言う）
    assert.match((await call("cancelRun", { id: running.id })).text, /もう走っていません/);
  });
});

test("エージェントの状態：Vault に置いた既定の鍵の有無を返す（値は返さない）", async () => {
  const vault = fakeVault({ "subagent.fake.FAKE_AGENT_TOKEN": "secret-value" });
  await withServer(
    async (call) => {
      const r = await call("listAgents", {});
      assert.doesNotMatch(r.text, /secret-value/);
      const agents = JSON.parse(r.text) as { agents: { id: string; keys?: string[] }[] };
      assert.deepEqual(agents.agents.find((a) => a.id === "fake")!.keys, ["FAKE_AGENT_TOKEN"]);
    },
    { relayClient: vault.relay },
  );
});

test("書きかけの返答は、走っている間の中身に出る", async () => {
  await withServer(async (call) => {
    const pending = call("runSubagent", { agent: "fake", prompt: "[slow 3] [draft] 長い仕事" });
    type Live = { id: string; status: string; text?: string; steps: { title: string }[] };
    let live: Live | undefined;
    for (let i = 0; i < 50 && !live?.text; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const running = (JSON.parse((await call("listRuns", {})).text) as { runs: { id: string; status: string }[] }).runs.find((x) => x.status === "running");
      if (running) live = JSON.parse((await call("getRun", { id: running.id })).text) as Live;
    }
    assert.ok(live, "走っている仕事が一覧に出ない");
    assert.equal(live.status, "running");
    assert.equal(live.text, "書きかけ…");
    assert.deepEqual(live.steps.map((st) => st.title), ["sleep 3"]);
    await pending;
    const done = JSON.parse((await call("getRun", { id: live.id })).text) as { status: string; text: string; model?: string };
    assert.equal(done.status, "done");
    // 指定しなかったモデルも、実際に使ったもの（エージェントの既定）が記録に残る
    assert.equal(done.model, "fake-small");
    assert.match(done.text, /^書きかけ…受け取った：\[slow 3\] \[draft\] 長い仕事/);
  });
});
