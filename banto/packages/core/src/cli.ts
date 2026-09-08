#!/usr/bin/env node
// banto本体の起動プロセス（host）。ここまで作った全パッケージを実際に配線する。
// これがPhase 0/1の完了条件を実測する対象そのもの。

import { mkdirSync } from "node:fs";
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
import { loadOrCreateBootstrapConfig } from "./config/bootstrap.js";
import { EventLog } from "./event-store/log.js";
import { ProjectThreadStore } from "./project-thread/store.js";
import { RuntimeConfigStore } from "./config/runtime.js";
import { GlobalMemoryStore } from "./global-memory/store.js";
import { InboxStore } from "./inbox/store.js";
import { PendingApprovalRegistry } from "./inbox/pending-approvals.js";
import { RelayRegistry, HostRelayEndpoint } from "./relay/host-relay-endpoint.js";
import { AgentRelayEndpoint } from "./relay/agent-relay-endpoint.js";
import { createApp } from "./http/app.js";
import { createSandboxServer } from "./http/sandbox-server.js";
import type { ModuleEndpoint } from "./http/turn-runner.js";
import {
  expandLaunch,
  loadModuleDeclarations,
  setModuleDeclarations,
  type LaunchContext,
  type ParsedModuleDeclaration,
} from "./modules/declaration.js";
import { readSelfReportedMeta } from "./modules/selfreport.js";
import { SingleFlight } from "./modules/single-flight.js";
import { classifyMetaDifference } from "@banto/module-contract";

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
  const globalMemory = new GlobalMemoryStore(bootstrap.dataDir, eventLog);
  await globalMemory.load();
  const inbox = new InboxStore(bootstrap.dataDir, eventLog);
  await inbox.load();
  // 前のプロセスが抱えていた判断待ちは、もう誰も待っていない（決定・2026-09-06）
  const orphaned = await inbox.expireOrphanedJudgments();
  if (orphaned > 0) console.log(`[host] 前回の走行が抱えていた判断待ち ${orphaned} 件を期限切れにした`);
  const pendingApprovals = new PendingApprovalRegistry();

  const registry = new RelayRegistry();
  const relayUrl = `http://127.0.0.1:${bootstrap.port}/relay`;
  const agentRelayEndpoint = new AgentRelayEndpoint(bootstrap.authToken, {
    onRelay: (r) => console.log("[agent-relay]", JSON.stringify(r)),
  });
  const agentRelayHeaders = { authorization: `Bearer ${bootstrap.authToken}` };

  // **どの Module をどう起動するかは宣言で決まる**（決定・2026-09-06、Phase 1）。
  // 以前はここに vault の dist パス・`"shell" | "filesystem"` のリテラル union・
  // 「node で実行」が直書きされており、4本目を足すには本体を書き換える必要があった。
  // いまは src/modules/declaration.ts の宣言（Configuration で上書き可）だけを見る。
  const launchContextBase = {
    nodeExec: process.execPath,
    monorepoRoot,
    dataDir: bootstrap.dataDir,
    hostRelayUrl: relayUrl,
  };

  /** 起動済みの Module。instance のものは key が名前、Project のものは `<名前>-<projectId>`。 */
  const connectedModules = new Map<string, Client>();
  /** 申告に合わせて宣言を直し、起動し直した相手（無限に繰り返さないため）。 */
  const retriedAfterSelfReport = new Set<string>();
  /**
   * **宣言の直しは1本ずつ**（追加・2026-09-07、Module を同時に起こすようにしたため）。
   *
   * 申告が宣言より厳しかったときは Config を書き直す（下の spawnDeclaredModuleOnce）。
   * 「読んで・直して・書く」なので、2本が同時にやると後の書き込みが前の直しを
   * 消す——同時に起こす形にした以上、ここは順番に通す（規則3——写しを作らない）。
   */
  let configRepairChain: Promise<unknown> = Promise.resolve();
  function repairDeclarations<T>(fn: () => Promise<T>): Promise<T> {
    const run = configRepairChain.then(fn, fn);
    configRepairChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** meta のうち、指定した項目だけを取り出す。 */
  function pick(meta: Record<string, unknown>, fields: string[]): Record<string, unknown> {
    return Object.fromEntries(fields.map((f) => [f, meta[f]]));
  }

  // **Project は常に渡す**——scope が project かどうかは宣言（と、申告で直った宣言）が
  // 決める。呼び出し側で判断すると、申告に合わせて scope を厳しくしたときに
  // Project を渡せず「閉じ込めを宣言したのに Project 単位で起動できない」と
  // 見当違いのエラーになる（実測・2026-09-06）。
  // **同じ Module を二重に起動しない**（決定・2026-09-06、E2E が3回に1回落ちた原因）。
  // 「もう起動済みか」を見てから実際に登録するまでに await が挟まるので、
  // その隙に同じ Module へのもう1本が入ると2つ立ち上がる——Vault は起動時に
  // 鍵を作るため、`identity.txt: file exists` として現れた。
  // 待ちを延ばして誤魔化さない（規則6）——同時に来たものは同じ1本を待つ。
  const moduleSpawns = new SingleFlight<string>();

  async function spawnDeclaredModule(
    declaration: ParsedModuleDeclaration,
    /** instance に1本の Module は Project がなくても起動できる（決定・2026-09-07）。 */
    forProject?: { id: string; root: string },
  ): Promise<string> {
    const project = declaration.meta.scope === "project" ? forProject : undefined;
    if (declaration.meta.scope === "project" && !forProject) {
      throw new Error(`${declaration.name}: Project ごとの Module は Project 抜きでは起動できません`);
    }
    const connName = project ? `${declaration.name}-${project.id}` : declaration.name;
    if (connectedModules.has(connName)) return connName;
    return moduleSpawns.run(connName, () => spawnDeclaredModuleOnce(declaration, forProject, connName, project));
  }

  async function spawnDeclaredModuleOnce(
    declaration: ParsedModuleDeclaration,
    forProject: { id: string; root: string } | undefined,
    connName: string,
    project: { id: string; root: string } | undefined,
  ): Promise<string> {
    // 束ねている間に先の1本が終わっていることがある
    if (connectedModules.has(connName)) return connName;

    // 中継の合言葉は「宣言に書けない値」なので、ここで発行して差し込む
    const token = registry.issueToken({ moduleName: connName, meta: declaration.meta });
    const context: LaunchContext = {
      ...launchContextBase,
      hostRelayToken: token,
      projectRoot: project?.root,
      // Module ごとに1つ。**その Module の分だけ**書けるようにする（決定・2026-09-07）
      moduleDataDir: join(bootstrap.dataDir, "modules", connName),
    };
    mkdirSync(context.moduleDataDir, { recursive: true, mode: 0o700 });
    const launch = expandLaunch(declaration.launch, context);

    // 閉じ込めが宣言されていれば Landlock で包む——**どの profile を使うかも宣言から**
    // （以前は「shell なら exec、それ以外は files-only」とコードで場合分けしていた）。
    let command = launch.command;
    let args = launch.args;
    if (declaration.meta.confinement) {
      if (!project) {
        throw new Error(`${connName}: 閉じ込めを宣言した Module は Project 単位でしか起動できません`);
      }
      assertLauncherAvailable();
      const profile: ConfinementProfile = declaration.meta.satisfies.includes("shell")
        ? "exec"
        : "files-only";
      const { ruleset, omitted } = deriveProjectRuleset({
        projectRoot: project.root,
        pathEntries: (process.env.PATH ?? "").split(":").filter(Boolean),
        profile,
        nodeExecPath: process.execPath,
        moduleDataDir: context.moduleDataDir,
        moduleInstallDirs: [monorepoRoot],
      });
      if (omitted.length > 0) console.warn(`[host] ${connName} ruleset omitted paths:`, omitted);
      const rulesetFile = writeRulesetFile(join(bootstrap.dataDir, "run"), connName, ruleset);
      const wrapped = wrapCommand(rulesetFile, { command, args });
      command = wrapped.command;
      args = wrapped.args;
    }

    // **host が必ず用意する値は、宣言に書かせない**（改訂・2026-09-07、ユーザー報告）。
    // Module ごとのデータ置き場は host が作り、閉じ込めの許可も host が出している
    // ——なのに env として渡すのを宣言まかせにしていたため、**宣言の写しを
    // Config に持っている Project だけが古いまま**になり、設定を保存できなかった
    // （規則3——写しはいつか食い違う）。host が常に渡す。
    const client = await connectStdioModule(command, args, {
      ...process.env,
      BANTO_MODULE_DATA_DIR: context.moduleDataDir,
      ...launch.env,
    });

    // **Module 自身の申告と、宣言（Config）を突き合わせる**（決定・2026-09-06）。
    // 起動の形（Project ごとか・別プロセスか・秘密を扱うか・閉じ込めが要るか）は
    // 起動する瞬間に決まってしまうので、宣言が先。申告は**より厳しくする方向にだけ**
    // 効かせる——Module は他人が書いたものでありうるので、「閉じ込め不要です」を
    // 信じて隔離を外すのは攻撃者に一番都合がよい（運用者の意図＝Config が上位）。
    const reported = await readSelfReportedMeta(client);
    if (reported) {
      const diff = classifyMetaDifference(declaration.meta, reported);
      if (diff.looser.length > 0) {
        // **従わない。繋がずに止める**（規則2——黙って緩い方へ落ちない）
        await client.close();
        throw new Error(
          `${connName}: Module が宣言より緩い形を申告しました（${diff.looser.join(", ")}）。` +
            `banto の隔離を Module の申告で緩めることはできません。宣言を見直してください。`,
        );
      }
      if (diff.stricter.length > 0) {
        await client.close();
        if (retriedAfterSelfReport.has(connName)) {
          throw new Error(`${connName}: 宣言を直して起動し直しても申告と食い違ったままです`);
        }
        retriedAfterSelfReport.add(connName);
        // **Config を実際に直してから起動し直す**——直さずに読み替えるだけだと、
        // 「Config にはこう書いてあるのに実際は別の形で動いている」という
        // 真実が2つある状態になる（規則3）
        const merged = {
          ...declaration,
          meta: { ...declaration.meta, ...pick(reported as unknown as Record<string, unknown>, diff.stricter) },
        };
        await repairDeclarations(async () => {
          const current = loadModuleDeclarations(runtimeConfig, project?.id ?? "");
          await setModuleDeclarations(
            runtimeConfig,
            current.map((d) => (d.name === declaration.name ? merged : d)),
          );
        });
        console.warn(
          `[host] ${connName}: Module の申告のほうが厳しかったので宣言を直して起動し直します（${diff.stricter.join(", ")}）`,
        );
        // **ここは Once を直接呼ぶ**——spawnDeclaredModule 経由だと、
        // いま自分が握っている single-flight の1本を自分で待つことになって止まる。
        // 申告に合わせて scope が変わりうるので、名前も取り直す
        const retryDeclaration = {
          ...declaration,
          meta: merged.meta as ParsedModuleDeclaration["meta"],
        };
        const retryProject = retryDeclaration.meta.scope === "project" ? forProject : undefined;
        const retryConnName = retryProject
          ? `${retryDeclaration.name}-${retryProject.id}`
          : retryDeclaration.name;
        return spawnDeclaredModuleOnce(retryDeclaration, forProject, retryConnName, retryProject);
      }
      if (diff.other.length > 0) {
        console.warn(`[host] ${connName}: 申告と宣言が違う項目（起動の形には影響しない）: ${diff.other.join(", ")}`);
      }
    }

    const conn = { name: connName, client, meta: declaration.meta };
    registry.registerModule(conn);
    agentRelayEndpoint.registerModule(conn);
    connectedModules.set(connName, client);
    console.log(
      `[host] ${declaration.name} connected${project ? ` for project ${project.id} (root ${project.root})` : ""}`,
    );
    return connName;
  }

  async function resolveModulesForThread(threadId: string): Promise<ModuleEndpoint[]> {
    const thread = projectThread.getThread(threadId);
    if (!thread) return [];
    const project = projectThread.getProject(thread.projectId);
    if (!project) return [];

    // **Module は同時に起こす**（改訂・2026-09-07、実測）。以前は1本ずつ
    // 順番に待っており、Project で最初に Module へ触れる操作（＝最初のターン）が
    // 中央値1.5秒・最悪2.2秒かかっていた。Module 同士は起動順に依存しない
    // ——`dependsOn` は中継の宛先を決めるためのもので、起動の前後関係ではない
    return await Promise.all(
      loadModuleDeclarations(runtimeConfig, project.id).map(async (declaration) => {
        const connName = await spawnDeclaredModule(declaration, project);
        // Runnerに見せる名前（mcp__<name>__...）は宣言の名前のまま——
        // どのProjectか、という区別はURL側（agent-relay内部の登録名）だけに閉じる。
        return {
          name: declaration.name,
          url: `http://127.0.0.1:${bootstrap.port}/agent-relay/${connName}`,
          headers: agentRelayHeaders,
        };
      }),
    );
  }

  /** Module の画面（MCP Apps）を出すための経路（決定・2026-09-06、§6.2）。
   *  Runner 向けの中継 URL と違い、**host が直接 Module と話す**
   *  ——画面は人のもので、Runner は通らない。 */
  async function resolveModuleClientsForThread(threadId: string) {
    const thread = projectThread.getThread(threadId);
    if (!thread) return [];
    return resolveModuleClientsForProject(thread.projectId);
  }

  /** Project 単位（設定画面はこちら、決定・2026-09-07）。 */
  async function resolveModuleClientsForProject(projectId: string) {
    const project = projectThread.getProject(projectId);
    if (!project) return [];

    // ここも同時に起こす（上の resolveModulesForThread と同じ理由）
    const spawned = await Promise.all(
      loadModuleDeclarations(runtimeConfig, project.id).map(async (declaration) => {
        const connName = await spawnDeclaredModule(declaration, project);
        // 名前は宣言のもの——画面から見える名前が Project ごとにぶれない。
        // scope も返す——**設定をどちらの画面に出すかは Module の scope が決める**
        // （instance に1本の Module の設定を Project ごとに出すのはおかしい、
        // 決定・2026-09-07、ユーザー指摘）
        return { name: declaration.name, client: connectedModules.get(connName), scope: declaration.meta.scope };
      }),
    );
    return spawned.filter(
      (c): c is { name: string; client: Client; scope: "instance" | "project" } => c.client !== undefined,
    );
  }

  /**
   * banto 全体（instance）で1本の Module（決定・2026-09-07、ユーザー指摘）。
   *
   * **設定をどちらの画面に出すかは、その Module の scope が決める。**
   * instance に1本のもの（Vault 等）は banto 全体の設定に、Project ごとに
   * 立つもの（Shell・FileSystem）は Project の設定に出す——置き場の判断を
   * 別に持たず、既にある scope から導く（規則3）。
   */
  async function resolveInstanceModuleClients() {
    // instance 既定の宣言を読む（Project 上書きは Project 側の話）
    const spawned = await Promise.all(
      loadModuleDeclarations(runtimeConfig, "")
        .filter((declaration) => declaration.meta.scope === "instance")
        .map(async (declaration) => {
          const connName = await spawnDeclaredModule(declaration);
          return { name: declaration.name, client: connectedModules.get(connName), scope: "instance" as const };
        }),
    );
    return spawned.filter(
      (c): c is { name: string; client: Client; scope: "instance" } => c.client !== undefined,
    );
  }

  const relayEndpoint = new HostRelayEndpoint({
    registry,
    onAudit: (r) => console.log("[relay-audit]", JSON.stringify(r)),
  });

  const app = createApp({
    projectThread,
    globalMemory,
    inbox,
    pendingApprovals,
    relayEndpoint,
    agentRelayEndpoint,
    authToken: bootstrap.authToken,
    resolveModulesForThread,
    resolveModuleClientsForThread,
    resolveModuleClientsForProject,
    resolveInstanceModuleClients,
    sandboxPublicUrl: bootstrap.sandboxPublicUrl,
  });

  // mock/と同じ運用（決定・2026-09-03）——サンドボックスの外部公開はポートを
  // 0.0.0.0で待ち受けることで行う。/agent-relayに認証を足したのはこの変更に
  // 対応するため（このファイル冒頭のagentRelayEndpoint初期化を参照）。
  // スナップショットを実際に保存する（決定・2026-09-06、見直し起点）。
  // 版管理もアトミック書き出しも実装してあるのに、本番から一度も呼ばれておらず
  // 起動のたびにログ全体を畳み直していた（起動時間がイベント数に比例して伸びる）。
  // 「有るのに動いていない」を残さない（規則13の精神）。
  const saveSnapshots = async (): Promise<void> => {
    await Promise.all([projectThread.save(), globalMemory.save(), inbox.save(), runtimeConfig.save()]);
  };
  const snapshotTimer = setInterval(() => {
    void saveSnapshots().catch((err) => console.error("[host] スナップショット保存に失敗:", err));
  }, 60_000);
  snapshotTimer.unref();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      void saveSnapshots()
        .catch((err) => console.error("[host] 終了時のスナップショット保存に失敗:", err))
        .finally(() => process.exit(0));
    });
  }

  // Module の Canvas を隔離するサンドボックス（決定・2026-09-06、§6.2）。
  // **画面とは別オリジンでなければならない**ので、別の口で配る。
  const sandbox = createSandboxServer({ allowedEmbedderOrigins: bootstrap.allowedEmbedderOrigins });
  sandbox.listen(bootstrap.sandboxPort, "0.0.0.0", () => {
    console.log(
      `[host] sandbox listening on http://0.0.0.0:${bootstrap.sandboxPort}/ ` +
        `(埋め込みを許す相手: ${bootstrap.allowedEmbedderOrigins.join(", ")})`,
    );
  });

  app.listen(bootstrap.port, "0.0.0.0", () => {
    console.log(`[host] listening on http://0.0.0.0:${bootstrap.port}/ (token=${bootstrap.authToken})`);
  });
}

main().catch((err) => {
  console.error("[host] fatal:", err);
  process.exit(1);
});
