#!/usr/bin/env node
// banto本体の起動プロセス（host）。ここまで作った全パッケージを実際に配線する。
// これがPhase 0/1の完了条件を実測する対象そのもの。

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  checkAbi,
  deriveProjectRuleset,
  writeRulesetFile,
  wrapCommand,
  assertLauncherAvailable,
  type ConfinementProfile,
} from "@banto/landlock";
import { parseModuleMeta, type BantoModuleMeta } from "@banto/module-contract";
import { loadOrCreateBootstrapConfig } from "./config/bootstrap.js";
import { EventLog } from "./event-store/log.js";
import { ProjectThreadStore } from "./project-thread/store.js";
import { RuntimeConfigStore } from "./config/runtime.js";
import { InboxStore } from "./inbox/store.js";
import { PendingApprovalRegistry } from "./inbox/pending-approvals.js";
import { RelayRegistry, HostRelayEndpoint } from "./relay/host-relay-endpoint.js";
import { AgentRelayEndpoint } from "./relay/agent-relay-endpoint.js";
import { createApp } from "./http/app.js";
import type { ModuleEndpoint } from "./http/turn-runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = join(__dirname, "..", "..", "..");

async function connectStdioModule(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<Client> {
  const transport = new StdioClientTransport({ command, args, env: env as Record<string, string> });
  // elicitation を宣言しないと、Module側の server.elicitInput() が
  // 「Client does not support form elicitation」で即エラーになる
  // （agent-proxy.ts のelicitation転送の前提）。
  const client = new Client({ name: "banto-host", version: "0.1.0" }, { capabilities: { elicitation: {} } });
  await client.connect(transport);
  return client;
}

async function main(): Promise<void> {
  const bootstrap = loadOrCreateBootstrapConfig();
  console.log(`[host] dataDir=${bootstrap.dataDir} port=${bootstrap.port}`);

  const abi = checkAbi();
  console.log(`[host] Landlock ABI check: ${JSON.stringify(abi)}`);

  const eventLog = new EventLog(bootstrap.dataDir);
  await eventLog.init();

  const projectThread = new ProjectThreadStore(bootstrap.dataDir, eventLog);
  await projectThread.load();
  const runtimeConfig = new RuntimeConfigStore(bootstrap.dataDir, eventLog);
  await runtimeConfig.load();
  const inbox = new InboxStore(bootstrap.dataDir, eventLog);
  await inbox.load();
  const pendingApprovals = new PendingApprovalRegistry();

  const registry = new RelayRegistry();
  const relayUrl = `http://127.0.0.1:${bootstrap.port}/relay`;
  const agentRelayEndpoint = new AgentRelayEndpoint(bootstrap.authToken, {
    onRelay: (r) => console.log("[agent-relay]", JSON.stringify(r)),
  });
  const agentRelayHeaders = { authorization: `Bearer ${bootstrap.authToken}` };

  // Vault はinstance単位で1本、常に接続しておく（Landlock対象ではない）。
  const vaultEntry = join(monorepoRoot, "packages", "modules", "vault", "dist", "server.js");
  const vaultClient = await connectStdioModule(process.execPath, [vaultEntry], {
    ...process.env,
    BANTO_VAULT_DATA_DIR: join(bootstrap.dataDir, "vault"),
  });
  const vaultConn = {
    name: "vault",
    client: vaultClient,
    meta: parseModuleMeta({ satisfies: ["vault"], dependsOn: [], isolation: "subprocess" }, "vault"),
  };
  registry.registerModule(vaultConn);
  agentRelayEndpoint.registerModule(vaultConn);
  console.log("[host] vault connected");

  // Shell/FileSystemはProject単位——Landlockは一度掛けたら緩められないため、
  // Projectごとに別プロセスを持つ（docs/specs/v4-security.md「Projectの根は
  // Module起動時に確定させる」）。最初に要求されたときに立てて使い回す。
  const projectModules = new Map<string, { shell?: Client; filesystem?: Client }>();

  async function spawnProjectScopedModule(
    kind: "shell" | "filesystem",
    project: { id: string; root: string },
  ): Promise<Client> {
    assertLauncherAvailable();
    const profile: ConfinementProfile = kind === "shell" ? "exec" : "files-only";
    const { ruleset, omitted } = deriveProjectRuleset({
      projectRoot: project.root,
      pathEntries: (process.env.PATH ?? "").split(":").filter(Boolean),
      profile,
      nodeExecPath: process.execPath,
      moduleInstallDirs: [monorepoRoot],
    });
    if (omitted.length > 0) {
      console.warn(`[host] ${kind} ruleset omitted paths:`, omitted);
    }
    const connName = `${kind}-${project.id}`;
    const runDir = join(bootstrap.dataDir, "run");
    const rulesetFile = writeRulesetFile(runDir, connName, ruleset);
    const entry = join(monorepoRoot, "packages", "modules", kind, "dist", "server.js");
    const wrapped = wrapCommand(rulesetFile, { command: process.execPath, args: [entry] });

    const token = registry.issueToken({
      moduleName: connName,
      meta: parseModuleMeta(
        { satisfies: [kind], dependsOn: kind === "shell" ? [{ role: "vault", required: true }] : [], isolation: "subprocess" },
        connName,
      ),
    });

    const client = await connectStdioModule(wrapped.command, wrapped.args, {
      ...process.env,
      BANTO_PROJECT_ROOT: project.root,
      BANTO_HOST_MCP_URL: relayUrl,
      BANTO_HOST_MCP_TOKEN: token,
    });
    const conn = {
      name: connName,
      client,
      meta: parseModuleMeta({ satisfies: [kind], dependsOn: [], isolation: "subprocess" }, connName),
    };
    registry.registerModule(conn);
    agentRelayEndpoint.registerModule(conn);
    console.log(`[host] ${kind} connected for project ${project.id} (root ${project.root})`);
    return client;
  }

  async function resolveModulesForThread(threadId: string): Promise<ModuleEndpoint[]> {
    const thread = projectThread.getThread(threadId);
    if (!thread) return [];
    const project = projectThread.getProject(thread.projectId);
    if (!project) return [];

    const endpoints: ModuleEndpoint[] = [
      {
        name: "vault",
        url: `http://127.0.0.1:${bootstrap.port}/agent-relay/vault`,
        headers: agentRelayHeaders,
      },
    ];

    const cached = projectModules.get(project.id) ?? {};
    projectModules.set(project.id, cached);

    for (const kind of ["shell", "filesystem"] as const) {
      if (!cached[kind]) {
        cached[kind] = await spawnProjectScopedModule(kind, project);
      }
      // Runnerに見せる名前（mcp__<name>__...）は役割名のまま——
      // どのProjectか、という区別はURL側（agent-relay内部の登録名）だけに閉じる。
      endpoints.push({
        name: kind,
        url: `http://127.0.0.1:${bootstrap.port}/agent-relay/${kind}-${project.id}`,
        headers: agentRelayHeaders,
      });
    }

    return endpoints;
  }

  const relayEndpoint = new HostRelayEndpoint({
    registry,
    onAudit: (r) => console.log("[relay-audit]", JSON.stringify(r)),
  });

  const app = createApp({
    projectThread,
    inbox,
    pendingApprovals,
    relayEndpoint,
    agentRelayEndpoint,
    authToken: bootstrap.authToken,
    resolveModulesForThread,
  });

  // mock/と同じ運用（決定・2026-09-03）——サンドボックスの外部公開はポートを
  // 0.0.0.0で待ち受けることで行う。/agent-relayに認証を足したのはこの変更に
  // 対応するため（このファイル冒頭のagentRelayEndpoint初期化を参照）。
  app.listen(bootstrap.port, "0.0.0.0", () => {
    console.log(`[host] listening on http://0.0.0.0:${bootstrap.port}/ (token=${bootstrap.authToken})`);
  });
}

main().catch((err) => {
  console.error("[host] fatal:", err);
  process.exit(1);
});
