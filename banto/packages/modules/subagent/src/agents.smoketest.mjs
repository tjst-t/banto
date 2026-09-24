// **本物のエージェントとの疎通確認**（`npm run check:agents -w @banto/module-subagent`）。
// core の `check:agent-sdk` と同じ扱い——実際のモデルを呼ぶ（課金される）ので自動の試験には
// 含めない。**claude-agent-acp・opencode-ai を上げたら必ず回す**——E2E は偽のエージェントなので、
// 本物の振る舞いの変化はここでしか捕まらない。
//
// Module のコードそのもの（`createSubagentServer`）を MCP の口から呼ぶ。Vault の中継だけ代役：
//   - Claude Code：**本番と同じく banto 本体のログイン（~/.claude）を中継で共有する**——envSecrets は渡さない
//   - OpenCode：~/.local/share/opencode/auth.json の opencode-go の鍵をメモリに読み、OPENCODE_API_KEY に
// **人の ~/.claude・~/.config/opencode には書かない**——エージェントは Module の専用ホーム
// （使い捨ての置き場）で動く。
//
// 見るもの：
//   1. 設定の候補（モデル）が返る
//   2. 閉じ込めの中で仕事をし、Project の根にファイルを書ける。既定のモードが掛かる
//   3. 人への確認が来たら断り、返り値に書く（来なければ空）
//   4. 別プロセスで続きから頼める（前の仕事を覚えている）
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const { createSubagentServer } = await import("../dist/server.js");

const wanted = process.argv.slice(2);
const secrets = {
  "opencode-go": () => JSON.parse(readFileSync(join(homedir(), ".local/share/opencode/auth.json"), "utf8"))["opencode-go"].key,
};
const cases = [
  { agent: "claude-code", model: "sonnet", envSecrets: {} },
  { agent: "opencode", model: "opencode-go/qwen3.6-plus", envSecrets: { OPENCODE_API_KEY: "opencode-go" } },
].filter((c) => wanted.length === 0 || wanted.includes(c.agent));

let failed = false;
function check(ok, label, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
}

const root = mkdtempSync(join(tmpdir(), "banto-check-agents-"));
try {
  const project = join(root, "project");
  mkdirSync(project);
  const server = createSubagentServer({
    projectRoot: project,
    moduleDataDir: join(root, "data", "modules", "subagent-check"),
    relayClient: {
      // 設定の鍵は使わない（この確認は、渡したものだけで走る）
      listAliases: async () => [],
      lookupAlias: async (_dir, name) => ({ implementation: "local", name }),
      resolveAlias: async (place) => secrets[place.name](),
    },
    guard: { dataDir: join(root, "data"), configDir: join(root, "config") },
    pathEntries: (process.env.PATH ?? "").split(":").filter(Boolean),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "check-agents", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
    return { text: r.content[0]?.text ?? "", isError: r.isError === true };
  };

  for (const c of cases) {
    console.log(`\n== ${c.agent}`);
    const desc = await call("listSubagents", { agent: c.agent, envSecrets: c.envSecrets });
    check(!desc.isError, "設定の候補を聞ける", desc.isError ? desc.text.slice(0, 300) : "");
    if (desc.isError) continue;
    const parsed = JSON.parse(desc.text);
    const models = parsed.options.find((o) => o.category === "model")?.values ?? [];
    check(models.includes(c.model), `モデル ${c.model} が候補にある`, `${models.length}件：${models.slice(0, 8).join(", ")}`);
    console.log(`     ${parsed.agent.name} ${parsed.agent.version ?? ""}／設定項目：${parsed.options.map((o) => `${o.id}(${o.category ?? "-"})`).join(" ")}`);

    const file = `hello-${c.agent}.txt`;
    const started = Date.now();
    const r1 = await call("runSubagent", {
      agent: c.agent,
      model: c.model,
      envSecrets: c.envSecrets,
      prompt: `いまのフォルダに ${file} というファイルを作り、中身をちょうど hi にして。終わったら「できた」とだけ言って。`,
    });
    check(!r1.isError, "仕事が返る", r1.isError ? r1.text.slice(0, 500) : `${Math.round((Date.now() - started) / 1000)}秒`);
    if (r1.isError) continue;
    const res1 = JSON.parse(r1.text);
    console.log(`     stopReason=${res1.stopReason} tools=${JSON.stringify(res1.toolCalls)} permissions=${JSON.stringify(res1.permissions)} notes=${JSON.stringify(res1.notes)}`);
    console.log(`     usage=${JSON.stringify(res1.usage ?? null)} cost=${JSON.stringify(res1.cost ?? null)} context=${JSON.stringify(res1.context ?? null)}`);
    const written = existsSync(join(project, file)) ? readFileSync(join(project, file), "utf8").trim() : null;
    check(written === "hi", "閉じ込めの中から Project の根に書けた", `中身=${JSON.stringify(written)} 返答=${JSON.stringify(res1.text.slice(0, 80))}`);

    const r2 = await call("runSubagent", {
      agent: c.agent,
      model: c.model,
      envSecrets: c.envSecrets,
      sessionId: res1.sessionId,
      prompt: `さっき ${file} に書いた中身は何？ 中身だけを答えて。ファイルは読まずに、覚えていることで答えて。`,
    });
    const res2 = r2.isError ? undefined : JSON.parse(r2.text);
    check(!r2.isError && /\bhi\b/.test(res2.text), "別プロセスで続きから頼める", r2.isError ? r2.text.slice(0, 300) : JSON.stringify(res2.text.slice(0, 80)));
  }
  await client.close();
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
