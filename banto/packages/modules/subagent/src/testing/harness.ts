// 試験の代役と起動の手順（単体・結合試験が共有する）。偽の ACP エージェントで、Vault の中継だけを代役にする。
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { listAgents } from "../agents.js";
import { createSubagentServer } from "../server.js";
import { createSubagentSettingsServer } from "../settings-server.js";

export type Call = (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;

export const sha = (v: string) => createHash("sha256").update(v).digest("hex");

async function connect(server: { connect: (t: InMemoryTransport) => Promise<void> }): Promise<{ call: Call; close: () => Promise<void> }> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    call: async (name, args) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: r.content[0]?.text ?? "", isError: r.isError === true };
    },
    close: () => client.close(),
  };
}

/** Vault の代役（名前 → 値）。窓口と同じ口だけを持つ */
export function fakeVault(initial: Record<string, string> = {}, opts: { unreadableVault?: boolean } = {}) {
  const store = new Map(Object.entries(initial));
  const calls: string[] = [];
  return {
    store,
    calls,
    relay: {
      listAliases: async () => [...store.keys()].map((name) => ({ name, implementation: "vault-local" })),
      // 窓口と同じく、既定の鍵の名前で無いものは「どの Vault にも無い」
      lookupAlias: async (_dir: string, name: string) => {
        calls.push(`lookup ${name}`);
        if (name.startsWith("subagent.") && !store.has(name)) {
          throw new Error(
            opts.unreadableVault
              ? `MCP error -32603: alias "${name}" は見つかりませんでしたが、読めていない Vault があります：vault-infisical（設定が足りません）`
              : `alias "${name}" はどの Vault にもありません`,
          );
        }
        return { implementation: "vault-local", name };
      },
      resolveAlias: async (place: { name: string }) => store.get(place.name) ?? `value-of-${place.name}`,
      createAlias: async (_dir: string, a: { name: string; value: string }) => {
        calls.push(`create ${a.name}`);
        if (store.has(a.name)) throw new Error(`${a.name} は既にあります`);
        store.set(a.name, a.value);
      },
      deleteAlias: async (_dir: string, place: { name: string }) => {
        calls.push(`delete ${place.name}`);
        if (!store.delete(place.name)) throw new Error(`${place.name} はありません`);
      },
    },
  };
}

export async function withServer(
  fn: (call: Call, dirs: { project: string; data: string }) => Promise<void>,
  overrides: Partial<Parameters<typeof createSubagentServer>[0]> = {},
) {
  const root = mkdtempSync(join(tmpdir(), "subagent-it-"));
  const project = join(root, "project");
  const data = join(root, "data", "modules", "subagent-p1");
  mkdirSync(project, { recursive: true });
  mkdirSync(data, { recursive: true });
  const server = createSubagentServer({
    projectRoot: project,
    moduleDataDir: data,
    relayClient: fakeVault().relay,
    agents: listAgents({ BANTO_SUBAGENT_FAKE_AGENT: "1" }),
    // 試験は本物の環境を読まない（core が中継の変数を入れていない形）
    claudeLoginEnv: {},
    ...overrides,
  });
  const conn = await connect(server);
  try {
    await fn(conn.call, { project, data });
  } finally {
    await conn.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/** banto 全体の設定の Module（`settings-server.ts`）を立てる */
export async function withSettings(fn: (call: Call) => Promise<void>, overrides: Partial<Parameters<typeof createSubagentSettingsServer>[0]> = {}) {
  const conn = await connect(
    createSubagentSettingsServer({
      relayClient: fakeVault().relay,
      agents: listAgents({ BANTO_SUBAGENT_FAKE_AGENT: "1" }),
      ...overrides,
    }),
  );
  try {
    await fn(conn.call);
  } finally {
    await conn.close();
  }
}


