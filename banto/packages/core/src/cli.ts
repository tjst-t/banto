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
  assertRulesetIsSafe,
  type ConfinementProfile,
} from "@banto/landlock";
import { loadOrCreateBootstrapConfig, resolveBootstrapConfigPath } from "./config/bootstrap.js";
import { EventLog } from "./event-store/log.js";
import { ProjectThreadStore } from "./project-thread/store.js";
import { RuntimeConfigStore } from "./config/runtime.js";
import { GlobalMemoryStore } from "./global-memory/store.js";
import { InboxStore } from "./inbox/store.js";
import { PendingApprovalRegistry } from "./inbox/pending-approvals.js";
import { RelayRegistry, HostRelayEndpoint } from "./relay/host-relay-endpoint.js";
import { AgentRelayEndpoint } from "./relay/agent-relay-endpoint.js";
import { RelayGrantStore } from "./relay/grants.js";
import { ModuleCallTracker } from "./relay/module-calls.js";
import { ElicitationRouter } from "./relay/elicitation-router.js";
import { createRelayApprovalGate } from "./relay/approval-gate.js";
import { TurnEventBus } from "./http/turn-events.js";
import { createApp } from "./http/app.js";
import { createSandboxServer } from "./http/sandbox-server.js";
import type { ModuleEndpoint } from "./http/turn-runner.js";
import {
  expandLaunch,
  loadModuleDeclarations,
  repairDeclarationMeta,
  type LaunchContext,
  type ParsedModuleDeclaration,
} from "./modules/declaration.js";
import { readSelfReportedMeta } from "./modules/selfreport.js";
import { SingleFlight } from "./modules/single-flight.js";
import {
  assertAllVisibilityExplicit,
  assertVisibilityValues,
  classifyMetaDifference,
} from "@banto/module-contract";

const __dirname = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = join(__dirname, "..", "..", "..");

/** その Module が名乗っている tool・resource（可視性の検査に渡す形）。 */
async function listVisibilityEntries(
  client: Client,
): Promise<Array<{ name: string; meta?: Record<string, unknown> }>> {
  const tools = await client.listTools();
  const resources = await client.listResources().catch(() => ({ resources: [] }));
  return [
    ...tools.tools.map((t) => ({ name: t.name, meta: t._meta as Record<string, unknown> | undefined })),
    ...resources.resources.map((r) => ({
      name: r.uri,
      meta: r._meta as Record<string, unknown> | undefined,
    })),
  ];
}

async function connectStdioModule(
  command: string,
  args: string[],
  /** Project ごとの Module のときだけ渡る。**渡さないと banto の起動場所を見る**。 */
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<Client> {
  const transport = new StdioClientTransport({ command, args, cwd, env: env as Record<string, string> });
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
  // Module 間中継の許可と記録（アーキ仕様 §2.5）。**許可は Event Store に残す**
  // ——プロセスメモリに置くと、host を再起動するたびに人が承認し直すことになる
  const relayGrants = new RelayGrantStore(bootstrap.dataDir, eventLog);
  await relayGrants.load();
  // どの Module が、いま、どのターンの仕事をしているか（承認をどの会話に出すか）
  const moduleCalls = new ModuleCallTracker();
  // ターンの外で起きた判断待ちを、走行中の SSE へ差し込む口
  const turnEvents = new TurnEventBus();

  const registry = new RelayRegistry();
  const relayUrl = `http://127.0.0.1:${bootstrap.port}/relay`;
  // Module からの問い（Elicitation）を、正しいターンへ届けるための宛先表
  // ——1本の接続にハンドラを付け替えると、並行ターンで別の会話に出る（決定・2026-09-10）
  const elicitations = new ElicitationRouter(moduleCalls);
  const agentRelayEndpoint = new AgentRelayEndpoint(bootstrap.authToken, {
    onRelay: (r) => console.log("[agent-relay]", JSON.stringify(r)),
    moduleCalls,
    elicitations,
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
  /** 回収のための台帳（決定・2026-09-10、`relay-lifecycle-and-elicitation`）
   *  ——**Project を畳んだら、その Project のために立てたものは全部落とす**。 */
  const moduleTokens = new Map<string, string>();
  const projectConnections = new Map<string, Set<string>>();
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

  /**
   * **繋げなかったことを覚えておく**（決定・2026-09-07、ユーザー報告）。
   *
   * 以前は失敗を残していなかったので、**人が発言するたびに同じ起動を試して
   * 同じように落ち**、会話に毎ターン同じエラーが出ていた。しかも一覧を組み立てる
   * 途中で例外になるため、**1本の設定ミスでその Project の会話が丸ごと止まった**。
   *
   * 覚える鍵は宣言の中身（指紋）。**宣言が変われば、また試す**——人が直したのに
   * 「壊れている」と言い続けないため。安全側（繋がない・黙って緩めない）は
   * そのまま：失敗した Module は**繋がない**。
   */
  const moduleFailures = new Map<string, { fingerprint: string; reason: string }>();

  function declarationFingerprint(declaration: ParsedModuleDeclaration): string {
    return JSON.stringify({ launch: declaration.launch, meta: declaration.meta });
  }

  /**
   * 繋ぐ。**繋がらなくても投げない**——呼び出し側は「繋がったものだけ」で進める。
   * 繋がらなかったことは状態に残し、人には受信箱のお知らせで1回だけ伝える。
   */
  async function connectDeclaredModule(
    declaration: ParsedModuleDeclaration,
    forProject?: { id: string; root: string },
  ): Promise<string | undefined> {
    const connName =
      declaration.meta.scope === "project" && forProject
        ? `${declaration.name}-${forProject.id}`
        : declaration.name;
    const fingerprint = declarationFingerprint(declaration);
    const failed = moduleFailures.get(connName);
    if (failed && failed.fingerprint === fingerprint) return undefined;
    if (failed) moduleFailures.delete(connName); // 宣言が変わった——もう一度試す

    try {
      return await spawnDeclaredModule(declaration, forProject);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      moduleFailures.set(connName, { fingerprint, reason });
      console.warn(`[host] ${connName} を繋げませんでした: ${reason}`);
      // **人が気づける場所を1つ作る**（規則2——黙って機能を減らさない）。
      // 会話には出さない（毎ターン混ざるのを止めるのがこの作業の目的）
      void inbox
        .raiseNotice({
          projectId: declaration.meta.scope === "project" ? forProject?.id : undefined,
          dedupeKey: `module-connect:${connName}`,
          title: `${declaration.name} を繋げませんでした`,
          detail: reason,
        })
        .catch((noticeErr: unknown) => {
          console.warn("[host] お知らせを出せませんでした:", noticeErr);
        });
      return undefined;
    }
  }

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
    // **承認の粒度は宣言の名前と Project**（アーキ仕様 §2.5）。プロセスの名前
    // （`shell-<projectId>`）は、どのターンの仕事かを引くときにだけ使う
    const token = registry.issueToken({
      moduleName: declaration.name,
      connName,
      projectId: project?.id,
      meta: declaration.meta,
    });
    const context: LaunchContext = {
      ...launchContextBase,
      hostRelayToken: token,
      projectRoot: project?.root,
      // Module ごとに1つ。**その Module の分だけ**書けるようにする（決定・2026-09-07）
      moduleDataDir: join(bootstrap.dataDir, "modules", connName),
    };
    mkdirSync(context.moduleDataDir, { recursive: true, mode: 0o700 });
    const launch = expandLaunch(declaration.launch, context);

    // **外から繋いだコードを、閉じ込め無しで立てない**（追加・2026-09-15、
    // レビューで発覚。`docs/specs/v4-security.md`）。
    //
    // 閉じ込めは `scope: "project"` でしか宣言できない（Landlock の根が
    // Project の根だから）。つまり **`scope: "instance"` の第三者 Module は
    // 構造上まったく閉じ込められない**——`~/.claude/.credentials.json`・
    // banto の中継の合言葉・全 Project の会話を素で読める。
    //
    // そして「`${projectRoot}` を書かない」という**いちばん楽な道**が、
    // ちょうどそこへ落ちる。**楽な道が危ない結果に落ちてはいけない**ので、
    // ここで止める（規則2——黙って通さない。受信箱に理由が1件出る）。
    //
    // **同梱は対象外**——banto 自身のコードで、閉じ込めの外に置くと決めてある
    // （Vault は秘密の置き場を持つので Project の根に閉じ込められない）。
    if (declaration.meta.origin !== "bundled" && !declaration.meta.confinement) {
      throw new Error(
        `${connName}: 外から繋いだ Module を閉じ込め無しでは起動できません` +
          "（Project ごとに立てて閉じ込めるか、同梱の実装を使ってください）",
      );
    }

    // 閉じ込めが宣言されていれば Landlock で包む——**どの profile を使うかも宣言から**
    // （以前は「shell なら exec、それ以外は files-only」とコードで場合分けしていた）。
    let command = launch.command;
    let args = launch.args;
    if (declaration.meta.confinement) {
      if (!project) {
        throw new Error(`${connName}: 閉じ込めを宣言した Module は Project 単位でしか起動できません`);
      }
      assertLauncherAvailable();
      // **広さは宣言が持つ**（訂正・2026-09-15、レビューで発覚）。以前は
      // `satisfies.includes("shell")` から決めていたので、**`shell` を名乗るだけで
      // 広いほう（PATH の実行を許す）を取れた**——自己申告が閉じ込めの強さを
      // 決めてしまっていた
      const profile: ConfinementProfile = declaration.meta.confinement?.profile ?? "files-only";
      const { ruleset, omitted } = deriveProjectRuleset({
        projectRoot: project.root,
        pathEntries: (process.env.PATH ?? "").split(":").filter(Boolean),
        profile,
        nodeExecPath: process.execPath,
        moduleDataDir: context.moduleDataDir,
        moduleInstallDirs: [monorepoRoot],
      });
      if (omitted.length > 0) console.warn(`[host] ${connName} ruleset omitted paths:`, omitted);
      // **書き出す前の最後の防波堤**（`@banto/landlock` の guard）。人が Project の根に
      // home を指定した、導出が静かに広がった、といったときに**起動を止める**
      // ——弱いまま閉じ込めたことにしない（規則2）。ここで投げると、その Module は
      // 繋がらず、受信箱に理由つきのお知らせが1件出る（§5.4-0）
      assertRulesetIsSafe(ruleset, {
        dataDir: bootstrap.dataDir,
        configDir: dirname(resolveBootstrapConfigPath()),
        // **人が選んだ根は通す**（改訂・2026-09-11、ユーザー決定）——広い根を
        // 選べば閉じ込めは効かないが、それは選ぶ前に画面で伝える
        projectRoot: project.root,
      });
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
    // **Project ごとの Module には、その Project の根を作業ディレクトリとして渡す**
    // （追加・2026-09-15、レビューで発覚）。以前は `cwd` を渡していなかったので、
    // **cwd 基準で動くサーバは banto の起動場所を見ていた**——閉じ込めが効いて
    // いれば読めはしないが、「どこを見ているか」が人の意図とずれる
    const client = await connectStdioModule(command, args, project?.root, {
      ...process.env,
      BANTO_MODULE_DATA_DIR: context.moduleDataDir,
      // **自分の宣言上の名前**（追加・2026-09-15）。同じ実装を2本以上立てる
      // ことがある（Vault を自前ホストと Cloud で並べるなど）——そのとき
      // Module 自身が「自分はどの1本か」を知らないと、**画面に同じ名前が並び**、
      // **環境変数の既定が全部の写しに効いてしまう**。host が必ず渡す
      // （`BANTO_MODULE_DATA_DIR` と同じ理由——宣言の写しに持たせない）
      BANTO_MODULE_NAME: declaration.name,
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
        const stricter = pick(reported as unknown as Record<string, unknown>, diff.stricter);
        const merged = { ...declaration, meta: { ...declaration.meta, ...stricter } };
        // **直すのは Module 固有の事実であって、その Project の事情ではない**
        // （決定・2026-09-10）。既定は既定として読み直して書き戻す
        // ——Project の上書きを混ぜたまま既定へ保存すると、その Project の設定が
        // 全 Project に漏れ、当の Project は直らないまま食い違い続ける（規則3）
        const repaired = await repairDeclarations(() =>
          repairDeclarationMeta(runtimeConfig, {
            name: declaration.name,
            projectId: project?.id,
            stricter,
          }),
        );
        console.warn(
          `[host] ${connName}: Module の申告のほうが厳しかったので宣言を直して起動し直します` +
            `（${diff.stricter.join(", ")}／直した先: ${repaired.writtenTo}）`,
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

    // **可視性の宣言を、繋ぐ前に検査する**（決定・2026-09-10）。
    //  ① 値が語彙の外（`"modle"` 等）なら繋がない——黙って狭い側で動かすと、
    //     書いた人は自分の意図どおりだと思い続ける
    //  ② 秘密を扱うと自己申告した Module は、**全 tool/resource に明示的な
    //     visibility が要る**（`docs/specs/v4-modules.md` §2.1 の決定。
    //     書き忘れた1つから秘密が漏れるのを構造で防ぐ）
    const declared = await listVisibilityEntries(client);
    assertVisibilityValues(declared, connName);
    if (declaration.meta.handlesSecrets) assertAllVisibilityExplicit(declared, connName);

    // **いま何のコードが動いているかを台帳に載せる**（追加・2026-09-15）。
    // 外から繋いだ Module への承認は、この印に縛られる（`grantKey`）
    // **いま何のコードが動いているかを台帳に載せる**（追加・2026-09-15）。
    // 外から繋いだ Module への承認は、この印に縛られる（`grantKey`）
    const conn = {
      name: connName,
      client,
      meta: declaration.meta,
      codeId: declarationFingerprint(declaration),
    };
    registry.registerModule(conn);
    agentRelayEndpoint.registerModule(conn);
    connectedModules.set(connName, client);
    moduleTokens.set(connName, token);
    if (project) {
      const forThisProject = projectConnections.get(project.id) ?? new Set<string>();
      forThisProject.add(connName);
      projectConnections.set(project.id, forThisProject);
    }
    console.log(
      `[host] ${declaration.name} connected${project ? ` for project ${project.id} (root ${project.root})` : ""}`,
    );
    return connName;
  }

  /**
   * **Project を畳んだら、その Project のために立てたものを落とす**
   * （決定・2026-09-10）。Module のプロセス・中継の合言葉・代理サーバの
   * セッション——放っておくと増える一方で、鍵を持ったプロセス（Vault の
   * ssh-agent 等）まで生き残る。**寿命の設計（§5.4-0・v4-security.md）は
   * 決まっていたのに、畳む側が書かれていなかった。**
   *
   * **instance に1本の Module（Vault 等）は落とさない**——それは Project の
   * ものではない（他の Project がまだ使っている）。
   */
  async function releaseProjectModules(projectId: string): Promise<string[]> {
    const names = [...(projectConnections.get(projectId) ?? [])];
    projectConnections.delete(projectId);
    for (const connName of names) {
      const client = connectedModules.get(connName);
      connectedModules.delete(connName);
      moduleFailures.delete(connName);
      retriedAfterSelfReport.delete(connName);
      registry.unregisterModule(connName); // 合言葉もここで失効する
      moduleTokens.delete(connName);
      await agentRelayEndpoint.unregisterModule(connName);
      // **プロセスを落とすのは最後**（先に台帳から外しておけば、落とす途中に
      // 来た要求が死にかけの接続を掴まない）
      await client?.close().catch((err: unknown) => {
        console.warn(`[host] ${connName} を畳むときに例外:`, err);
      });
    }
    if (names.length > 0) console.log(`[host] project ${projectId} を畳んだ: ${names.join(", ")}`);
    return names;
  }

  /**
   * **いま繋がっているか／繋げなかった理由**（`phase1-project-modules-ui` の
   * 追補・2026-09-11、ユーザー報告）。設定の一覧は「この Project で使う」を
   * 出していたが、**使うと言っても立たない Module がある**——閉じ込めが成立
   * しない根（home）等。**立っていないことと、その理由を画面に出す**（規則13）。
   *
   * **ここでは起こさない**——一覧を見ただけで全部を起動しない（規則2の裏返しで、
   * 「見ただけで副作用」を作らない）。分かるのは、いま持っている事実だけ。
   */
  function moduleStatusForProject(projectId: string): Array<{
    name: string;
    connected: boolean;
    error?: string;
  }> {
    const project = projectThread.getProject(projectId);
    if (!project) return [];
    return loadModuleDeclarations(runtimeConfig, projectId).map((declaration) => {
      const connName =
        declaration.meta.scope === "project" ? `${declaration.name}-${projectId}` : declaration.name;
      const failure = moduleFailures.get(connName);
      return {
        name: declaration.name,
        connected: connectedModules.has(connName),
        ...(failure ? { error: failure.reason } : {}),
      };
    });
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
    const endpoints: Array<ModuleEndpoint | undefined> = await Promise.all(
      loadModuleDeclarations(runtimeConfig, project.id).map(async (declaration) => {
        const connName = await connectDeclaredModule(declaration, project);
        // **繋がらなかったものは黙って落とす**のではなく、繋がったものだけで進める
        // ——落ちた事実は moduleFailures と受信箱のお知らせに残っている
        if (!connName) return undefined;
        // Runnerに見せる名前（mcp__<name>__...）は宣言の名前のまま——
        // どのProjectか、という区別はURL側（agent-relay内部の登録名）だけに閉じる。
        return {
          name: declaration.name,
          url: `http://127.0.0.1:${bootstrap.port}/agent-relay/${connName}`,
          // **どのターンの接続か**を host 自身が渡す（中継の承認を正しい会話に
          // 出すため、relay/module-calls.ts）——Module に自己申告させない
          // **どの Project のターンか**も渡す（追加・2026-09-13）。Vault の
          // アクセス制限の根拠になる——Module に自己申告させない
          headers: {
            ...agentRelayHeaders,
            "x-banto-thread-id": threadId,
            "x-banto-project-id": project.id,
          },
        };
      }),
    );
    return endpoints.filter((e): e is ModuleEndpoint => e !== undefined);
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
        const connName = await connectDeclaredModule(declaration, project);
        // 名前は宣言のもの——画面から見える名前が Project ごとにぶれない。
        // scope も返す——**設定をどちらの画面に出すかは Module の scope が決める**
        // （instance に1本の Module の設定を Project ごとに出すのはおかしい、
        // 決定・2026-09-07、ユーザー指摘）
        return {
          name: declaration.name,
          // プロセスの名前も返す——画面からの呼び出しが中継を使うとき、
          // 「どのターンの仕事か」の台帳に置くのに要る（app.ts の ui-tool-call）
          connName: connName ?? undefined,
          client: connName ? connectedModules.get(connName) : undefined,
          scope: declaration.meta.scope,
        };
      }),
    );
    return spawned.filter(
      (c): c is { name: string; connName: string; client: Client; scope: "instance" | "project" } =>
        c.client !== undefined,
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
          const connName = await connectDeclaredModule(declaration);
          return {
            name: declaration.name,
            // プロセスの名前も返す——画面からの呼び出しの出所を台帳に置くのに要る
            // （app.ts の instance 版 ui-tool-call、追加・2026-09-12）
            connName: connName ?? undefined,
            client: connName ? connectedModules.get(connName) : undefined,
            scope: "instance" as const,
          };
        }),
    );
    return spawned.filter(
      (c): c is { name: string; connName: string; client: Client; scope: "instance" } =>
        c.client !== undefined,
    );
  }

  const relayEndpoint = new HostRelayEndpoint({
    registry,
    // 出所（人の画面か、AI のターンか）を引くための台帳。承認の要否がここで分かれる
    moduleCalls,
    gate: createRelayApprovalGate({
      grants: relayGrants,
      inbox,
      pendingApprovals,
      moduleCalls,
      onJudgmentRaised: (threadId, judgment) => {
        turnEvents.publish(threadId, {
          type: "judgment",
          judgmentId: judgment.id,
          kind: "approval",
          serverName: judgment.serverName,
          toolInput: judgment.toolInput,
          message: judgment.message,
        });
      },
    }),
    onAudit: async ({ allowed, reason, ok, ts, ...call }) => {
      // **記録は Event Store が本体**（アーキ仕様 §2.5）。console はおまけ。
      // 時刻はイベント自身が持つので payload には入れない（規則3）
      console.log("[relay-audit]", JSON.stringify({ ...call, allowed, reason, ok, ts }));
      await relayGrants.recordCall(call, { allowed, reason, ok });
    },
  });

  const app = createApp({
    projectThread,
    globalMemory,
    inbox,
    pendingApprovals,
    runtimeConfig,
    turnEvents,
    moduleCalls,
    relayEndpoint,
    agentRelayEndpoint,
    authToken: bootstrap.authToken,
    releaseProjectModules,
    resolveModulesForThread,
    moduleStatusForProject,
    dataDir: bootstrap.dataDir,
    configDir: dirname(resolveBootstrapConfigPath()),
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
    await Promise.all([
      projectThread.save(),
      globalMemory.save(),
      inbox.save(),
      runtimeConfig.save(),
      relayGrants.save(),
    ]);
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

  // **banto 全体で1本の Module は、起動したときに繋ぐ**（決定・2026-09-07、ユーザー）。
  // 以前は「最初に必要になった要求」まで待っていたので、繋がらないことに気づくのが
  // 人が何かを打った後になっていた。口を開けてから繋ぐ——繋がらなくても host は動く
  // （繋がった Module だけで進む・お知らせは受信箱に出る）。
  void resolveInstanceModuleClients().catch((err: unknown) => {
    console.warn("[host] instance の Module を用意できませんでした:", err);
  });
}

main().catch((err) => {
  console.error("[host] fatal:", err);
  process.exit(1);
});
