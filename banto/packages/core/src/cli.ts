#!/usr/bin/env node
// banto本体の起動プロセス（host）。ここまで作った全パッケージを実際に配線する。
// これがPhase 0/1の完了条件を実測する対象そのもの。

import { existsSync, mkdirSync } from "node:fs";
import { userInfo } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { BantoOAuthProvider, oauthAliasFor } from "./oauth/provider.js";
import {
  CONTAINER_NODE_PATH,
  ContainerAddressUnavailable,
  ProjectContainers,
  checkContainerPrereqs,
  ensureBaseImage,
  execInContainer,
  hostPrereqDeps,
  instanceContainerId,
  containerNameFor,
  hostResources,
  toContainerLimits,
  runIncus,
} from "@banto/container";
import { loadOrCreateBootstrapConfig, loginOrigins, resolveBootstrapConfigPath } from "./config/bootstrap.js";
import { AuthStore } from "./auth/store.js";
import { AuthService } from "./auth/service.js";
import { EventLog } from "./event-store/log.js";
import { ProjectThreadStore, currentSkillSet } from "./project-thread/store.js";
import {
  discoverSkills,
  isSkillEnabled,
  renderSkillInstructions,
  selectSessionSkills,
  type SessionSkillSet,
} from "./skills/index.js";
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
import { createApp, CONTAINER_NESTING_KEY } from "./http/app.js";
import { describeLimits, limitNumbersFor } from "./container-limits.js";
import { createSandboxServer } from "./http/sandbox-server.js";
import type { ModuleEndpoint } from "./http/turn-runner.js";
import {
  expandLaunch,
  listInstanceModules,
  fillSecrets,
  loadModuleDeclarations,
  secretPlaceholders,
  secretsAllowedFor,
  modulePlacement,
  isRemoteLaunch,
  isEgressAcknowledged,
  type RemoteLaunch,
  type StdioLaunch,
  type ModuleLaunch,
  repairDeclarationMeta,
  type LaunchContext,
  type ParsedModuleDeclaration,
} from "./modules/declaration.js";
import { modulePackageDirOf } from "./modules/registry/install/paths.js";
import { SHELL_HOME_FILES_KEY, shellHomeFiles, syncShellHome, type ShellHomeSync } from "./modules/shell-home.js";
import { readSelfReportedMeta } from "./modules/selfreport.js";
import { SingleFlight } from "./modules/single-flight.js";
import { ConnectBackoff } from "./modules/connect-backoff.js";
import { LIVENESS, LivenessMonitor } from "./modules/liveness.js";
import { ThreadTurns } from "./delivery/thread-turns.js";
import { ReplyHandles } from "./delivery/reply-handles.js";
import { ThreadDeliveries } from "./delivery/thread-deliveries.js";
import { AppEventBus, backgroundItemsOf } from "./http/app-events.js";
import { SelfUpdate } from "./self-update/self-update.js";
import {
  assertAllVisibilityExplicit,
  assertVisibilityValues,
  classifyMetaDifference,
  CALLER_META_KEY,
} from "@banto/module-contract";

const __dirname = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = join(__dirname, "..", "..", "..");

/** Module の置き場の中の、鍵の窓口用のフォルダ（0700）。Unix ソケットのパスは短くないと作れないので名前は短く */
function ensureSocketDir(moduleDataDir: string): string {
  const dir = join(moduleDataDir, "s");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

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

/**
 * **URL に繋ぐ**（追加・2026-09-17、ユーザー指示）。
 *
 * プロセスを起こさないので、閉じ込めも `cwd` も `env` も無い。渡せるのは
 * **ヘッダだけ**——そしてそこに入れてよい banto 由来の値は**金庫の秘密だけ**
 * （`declaration.ts` の `checkRemoteHeader`）。**中継の合言葉は渡さない**
 * ——第三者のサーバに banto の身元を持たせない。
 */
async function connectRemoteModule(
  url: string,
  headers: Record<string, string> | undefined,
  /** OAuth が要る相手のとき。**要らない相手には渡さない**（探索の往復を増やさない）。 */
  authProvider: BantoOAuthProvider | undefined,
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    ...(headers ? { requestInit: { headers } } : {}),
    ...(authProvider ? { authProvider: authProvider as never } : {}),
  });
  const client = new Client({ name: "banto-host", version: "0.1.0" }, { capabilities: { elicitation: {} } });
  await client.connect(transport);
  return client;
}

/**
 * **ログインが要るのか、本当に壊れているのか**を見分ける（規則2）。
 *
 * SDK は認可が要るとき `UnauthorizedError` を投げる。これを「繋がりません」と
 * 一緒くたにすると、**人は押すべきボタンがあることに気付けない**。
 */
function needsLogin(err: unknown): boolean {
  return err instanceof UnauthorizedError || /unauthorized/i.test(String((err as Error)?.message ?? ""));
}

async function main(): Promise<void> {
  const bootstrap = loadOrCreateBootstrapConfig();
  console.log(`[host] dataDir=${bootstrap.dataDir} port=${bootstrap.port}`);

  // **閉じ込めはコンテナ**（決定・2026-09-25、`docs/specs/v4-security.md` §1）。前提が欠けていれば、
  // コンテナで起こす Module（Project の Module・外から足した banto 全体の Module）は起こさず、受信箱で言う
  // （黙って閉じ込め無しで起こさない、規則2）。banto 本体で動く同梱の Module はそのまま立つ
  const containerPrereqs = await checkContainerPrereqs(hostPrereqDeps());
  const containers = new ProjectContainers(runIncus);
  /**
   * **中に渡してよい host の環境変数**（名前をカンマで並べる）。コンテナには host の環境を渡さない——
   * 試験の差し替え（偽のエージェントなど）を中の Module に届ける口。人の banto では使わない
   */
  const containerEnvPassthrough = (process.env.BANTO_CONTAINER_ENV_PASSTHROUGH ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  console.log(
    `[host] コンテナの前提: ${
      containerPrereqs.ok
        ? `そろっている（Incus ${containerPrereqs.serverVersion}）`
        : containerPrereqs.problems.map((p) => `${p.message} 直し方：${p.fix}`).join(" / ")
    }`,
  );

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
  // **人のログイン**（決定・2026-10-03、v4-security.md「人のログイン」）。セッションとパスキーは Event Store に
  const authStore = new AuthStore(bootstrap.dataDir, eventLog);
  await authStore.load();
  await relayGrants.load();
  // どの Module が、いま、どのターンの仕事をしているか（承認をどの会話に出すか）
  const moduleCalls = new ModuleCallTracker();
  // ターンの外で起きた判断待ちを、走行中の SSE へ差し込む口
  const turnEvents = new TurnEventBus();
  // **Thread に届ける**（決定・2026-09-25、アーキ仕様 §4.2）：同じ Thread のターンは1本ずつ・返信用の札・届ける口・
  // host から画面への出来事の流れ
  const threadTurns = new ThreadTurns();
  const replyHandles = new ReplyHandles();
  const appEvents = new AppEventBus();
  const deliveries = new ThreadDeliveries({
    projectThread,
    turns: threadTurns,
    notify: async (n) => {
      await inbox.raiseNotice(n);
    },
  });
  threadTurns.onChange((change) => {
    const projectId = projectThread.getThread(change.threadId)?.projectId;
    // 届いたもので起こしたターンはホップ 1 以上、人が送ったターンは 0
    if (change.type === "started") {
      appEvents.publish({ type: "turn.started", threadId: change.threadId, ...(projectId ? { projectId } : {}), cause: change.hop > 0 ? "delivery" : "human" });
    } else {
      appEvents.publish({ type: "turn.ended", threadId: change.threadId, ...(projectId ? { projectId } : {}) });
    }
    // **ターンが終わったら受信箱にレビュー待ち**（決定・2026-09-27、ユーザー。アーキ仕様 §2.4「レビュー待ち」）
    // ——並行で走らせた Thread（AI が立てた Fork など）が終わったことに、見に行かなくても気づけるように。
    // 人がその Thread で送ったら、その Thread のものは「見た」にする（人がそこにいる）。
    // 開いて見ている画面は、自分で「見た」にする（real-inbox.ts）
    if (change.type === "started" && change.hop === 0) {
      void inbox
        .acknowledgeReviewsFor(change.threadId)
        .catch((err: unknown) => console.warn("[host] レビュー待ちを「見た」にできませんでした:", err));
    } else if (change.type === "ended") {
      void inbox
        .raiseReview({ threadId: change.threadId, summary: turnEndSummary(projectThread.getThread(change.threadId)) })
        .catch((err: unknown) => console.warn("[host] ターンの終わりを受信箱に出せませんでした:", err));
    }
  });
  inbox.onChange(() => appEvents.publish({ type: "inbox.changed" }));
  /**
   * **バックグラウンドの仕事が増えた・減ったら、画面に知らせる**（追加・2026-10-03、v4-frontend.md §6.33）。
   * 真実は Thread の返事待ちの札（Event Store）。その Thread の分を丸ごと送る
   */
  function publishBackground(threadId: string): void {
    const thread = projectThread.getThread(threadId);
    appEvents.publish({
      type: "background.changed",
      threadId,
      ...(thread?.projectId ? { projectId: thread.projectId } : {}),
      items: backgroundItemsOf(thread?.awaitingReplies),
    });
  }

  /**
   * **返事待ちのまま Module が止まった**（決定・2026-09-25、アーキ仕様 §4.2「返事待ちの札は失くさない」）
   * ——host が代わりに「途中で終わりました」を届ける。呼び出し元の AI が来ない返事を待ち続けない（規則2）
   */
  async function deliverLostReply(
    reply: { threadId: string; replyTo: string; moduleName: string; hop: number },
    why: string,
  ): Promise<void> {
    try {
      await deliveries.deliver({
        threadId: reply.threadId,
        from: reply.moduleName,
        title: `${reply.moduleName} の仕事は途中で終わりました`,
        text: `${reply.moduleName} に頼んだ「終わったら届ける」仕事の返事は、もう届きません——${why}。結果が要るなら、頼み直してください。`,
        hop: reply.hop,
      });
    } catch (err) {
      console.warn(`[host] ${reply.threadId} に「途中で終わりました」を届けられませんでした:`, err);
    } finally {
      replyHandles.settle(reply.replyTo);
      await projectThread.settleReply(reply.threadId, reply.replyTo).catch(() => {});
      publishBackground(reply.threadId);
    }
  }
  // 起動し直した：前の走行で返事待ちだったものは、その Module ごと止まっている
  for (const p of projectThread.listProjects()) {
    for (const t of projectThread.listThreadsForProject(p.id)) {
      for (const r of t.awaitingReplies ?? []) {
        await deliverLostReply({ threadId: t.id, replyTo: r.replyTo, moduleName: r.moduleName, hop: r.hop }, "banto を起動し直したため");
      }
    }
  }

  const registry = new RelayRegistry();
  const relayUrl = `http://127.0.0.1:${bootstrap.port}/relay`;
  // Module からの問い（Elicitation）を、正しいターンへ届けるための宛先表
  // ——1本の接続にハンドラを付け替えると、並行ターンで別の会話に出る（決定・2026-09-10）
  const elicitations = new ElicitationRouter(moduleCalls);
  const agentRelayEndpoint = new AgentRelayEndpoint(bootstrap.authToken, {
    onRelay: (r) => console.log("[agent-relay]", JSON.stringify(r)),
    moduleCalls,
    elicitations,
    // **返信用の札**（決定・2026-09-25）。ホップ数は、札を出したターンのもの（人が送ったターン＝0）
    replies: {
      issue: (input) => replyHandles.issue({ ...input, hop: threadTurns.hopOf(input.threadId) ?? 0 }),
      markAwaiting: async (replyTo, waitingOn) => {
        const h = replyHandles.markAwaiting(replyTo, waitingOn);
        if (!h) return;
        await projectThread.recordAwaitingReply({
          threadId: h.threadId,
          replyTo,
          connName: h.connName,
          moduleName: h.moduleName,
          hop: h.hop + 1,
          ...(h.work ? { work: h.work } : {}),
        });
        publishBackground(h.threadId);
      },
    },
    // **効かせた Skill の名前と説明を `instructions` に載せる**（決定・2026-09-23、§5.6）。
    // 集合は会話に刻まれている（`turn-runner.ts` が新しいセッションの最初に刻む）
    // ——ここはそれを読むだけで、設定を見に行かない。**見に行くと、続きのターンで
    // 設定が変わっていたときに記録と違うものを載せてしまう**（モデルには届かないが、
    // 届いたかどうかが Runner の都合で決まる形にしない）
    instructionsFor: (module, threadId) => {
      const thread = threadId ? projectThread.getThread(threadId) : undefined;
      return thread ? renderSkillInstructions(currentSkillSet(thread), module) : undefined;
    },
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
  /**
   * **Shell 専用のホーム**（接続名 → 置き場）。写すものの一覧を人が変えたら、立っている
   * Shell のホームにも写し直す——コマンドは毎回新しく起こすので、再起動は要らない。
   */
  const shellHomes = new Map<string, string>();
  let lastShellHomeSync: ShellHomeSync | undefined;
  // **どこから写すか**は既定で人のホーム。E2E だけが差し替える（本物のホームを試験に使わない）
  const shellHomeSource = process.env.BANTO_SHELL_HOME_SOURCE || undefined;
  async function resyncShellHomes(): Promise<ShellHomeSync | undefined> {
    for (const home of shellHomes.values()) {
      lastShellHomeSync = await syncShellHome(home, shellHomeFiles(runtimeConfig), { sourceHome: shellHomeSource });
    }
    return lastShellHomeSync;
  }
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
   * **Module を起こすコンテナ**（決定・2026-09-25、`docs/specs/v4-security.md` §1）。Project ごとに1台、外から
   * 足した banto 全体の Module 用に1台。起こす前に用意する——無ければ作り、根と設定を合わせ、起こす。
   * 道具を入れた状態は残る。同時に来ても1回にまとめる
   */
  interface ContainerPlacement {
    /** Project の id、または `instanceContainerId(置き場)` */
    id: string;
    /** Project の根（banto 全体用のコンテナには無い） */
    root?: string;
    /** 中で Docker を使うか（Project ごとの設定） */
    nesting: boolean;
  }
  interface ReadyContainer {
    name: string;
    /** 中から host に届くアドレス（ブリッジの host 側）。host は 0.0.0.0 で待ち受けている */
    hostAddress: string;
    root?: string;
    nesting: boolean;
  }
  const readyContainers = new Map<string, ReadyContainer>();
  const containerSpawns = new SingleFlight<ReadyContainer>();
  /** 中で Docker を使うか（Project ごとの設定）。入れ子を許したコンテナだけ `/proc`・`/sys` の保護が外れる */
  const projectNesting = (projectId: string) => runtimeConfig.resolve(CONTAINER_NESTING_KEY, projectId) === true;
  async function ensureContainer(placement: ContainerPlacement): Promise<ReadyContainer> {
    const ready = readyContainers.get(placement.id);
    if (ready && ready.root === placement.root && ready.nesting === placement.nesting) return ready;
    return containerSpawns.run(placement.id, async () => {
      if (!containerPrereqs.ok) {
        throw new Error(
          "コンテナを用意できません——前提が欠けています：" +
            containerPrereqs.problems.map((p) => `${p.message}（直し方：${p.fix}）`).join(" ") +
            " 直したら banto を起動し直してください",
        );
      }
      // gid はユーザーの登録情報から——起動のしかたで主グループが変わっていても、中の同じ番号に揃える
      const { uid, gid } = userInfo();
      const { name } = await containers.ensure({
        projectId: placement.id,
        ...(placement.root ? { root: placement.root } : {}),
        bantoDir: monorepoRoot,
        nodePath: process.execPath,
        nodeVersion: process.version,
        nesting: placement.nesting,
        // banto の機能が頼る道具（git・ssh・curl・node）を入れた土台から作る——無ければ一度だけ作る
        image: await ensureBaseImage(runIncus),
        uid,
        gid,
        owner: bootstrap.dataDir,
        // 資源の上限（決定・2026-10-02）。この host の資源と、banto 全体・Project ごとの設定から計算する
        limits: toContainerLimits(limitNumbersFor(runtimeConfig, hostResources(), placement.id)),
      });
      const r: ReadyContainer = {
        name,
        hostAddress: await containers.hostAddress(name),
        ...(placement.root ? { root: placement.root } : {}),
        nesting: placement.nesting,
      };
      readyContainers.set(placement.id, r);
      return r;
    });
  }
  /** ホストのフォルダを中に見せる口の名前（Incus の装置名。パスから決まる） */
  const diskDeviceName = (dir: string) => `m-${createHash("sha256").update(dir).digest("hex").slice(0, 16)}`;

  /**
   * **繋げなかったことを覚えておく**（決定・2026-09-07、ユーザー報告）。
   *
   * 以前は失敗を残していなかったので、**人が発言するたびに同じ起動を試して
   * 同じように落ち**、会話に毎ターン同じエラーが出ていた。しかも一覧を組み立てる
   * 途中で例外になるため、**1本の設定ミスでその Project の会話が丸ごと止まった**。
   *
   * 覚える鍵は宣言の中身（指紋）。**宣言が変われば、すぐ試す**——人が直したのに
   * 「壊れている」と言い続けないため。安全側（繋がない・黙って緩めない）は
   * そのまま：失敗した Module は**繋がない**。
   *
   * **覚えるのは次に試すまでの間だけ**（改訂・2026-09-30）。以前は宣言が変わるまで二度と試さなかった
   * ので、Incus の再起動中の `Error: Shutting down` のような一時的な失敗でも、host を再起動するまで
   * 戻らなかった。間は続けて失敗するほど伸びる（`connect-backoff.ts`）
   */
  const connectBackoff = new ConnectBackoff();

  /**
   * **Project を畳んだ回数**（追加・2026-10-01）。畳むのと Module の起動が重なると、畳む側がコンテナを止めて
   * 起動を途中で切り、「繋げませんでした」が受信箱に出ていた（E2E で spec の替わり目に Project を畳むようにして
   * 見つかった。人が作ってすぐ畳んでも起きる）。起動のほうが後で終われば、畳んだ Project に Module が繋がったまま
   * 残る。起動の始めにこの数を控え、終わったときに増えていれば、その結果は「畳んだのでやめた」として扱う
   * ——失敗ならお知らせも試し直しの間も記録せず、繋がったならすぐ畳む。畳む側は起動を待たない（待つと、
   * 作ってすぐ畳んだときに画面がその分だけ止まる）
   */
  const projectReleases = new Map<string, number>();

  /**
   * **止まった Module は起こし直す**（決定・2026-09-30、`docs/specs/v4-architecture.md` §5.4-0）。
   *
   * 以前は、繋がった後に止まった Module をそのまま台帳に残していた。`spawnDeclaredModule` は
   * 「もう繋がっている」と見て起こさないので、**host を再起動するまで** `Not connected`・
   * `Request timed out` が続き、Ctrl-K の入口も AI の道具も消えた（2026-09-29：1通 10 MiB を越えた返事で
   * Shell が切れた。2026-09-30：自動更新が incusd を再起動し、コンテナの中の Module が黙った）。
   *
   * 見つけ方は2つ——接続が閉じた（`onclose`）か、`ping` に続けて答えない（`liveness.ts`）。
   * 見つけたら台帳から外し、プロセスを確実に落とし、間を置いて起こし直す（`connect-backoff.ts`）。
   * **畳んだ・止めた Module は起こさない**（畳む側が先に台帳から外すので、ここへは来ない）
   */
  interface ConnectionOrigin {
    /** 起こし直すときに引き直す宣言の名前（宣言そのものは持たない——その間に変わっていれば新しいほうで起こす） */
    declarationName: string;
    fingerprint: string;
    projectId?: string;
    /** コンテナの中で起こしたなら、その置き場の id */
    containerId?: string;
  }
  let stopping = false;
  const connectionOrigins = new Map<string, ConnectionOrigin>();
  const pendingRestarts = new Map<string, { timer: NodeJS.Timeout; origin: ConnectionOrigin }>();
  const liveness = new LivenessMonitor(LIVENESS, (connName, client, reason) => {
    const origin = connectionOrigins.get(connName);
    if (origin) void moduleLost(connName, client as Client, origin, reason);
  });

  function cancelRestart(connName: string): void {
    const pending = pendingRestarts.get(connName);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingRestarts.delete(connName);
  }

  async function moduleLost(connName: string, client: Client, origin: ConnectionOrigin, reason: string): Promise<void> {
    // 畳んだ・起こし直した後の古い接続——もう関係ない（畳む側は先に台帳から外している）
    if (connectedModules.get(connName) !== client) return;
    console.warn(`[host] ${connName} が止まりました（${reason}）`);
    connectedModules.delete(connName);
    // **台帳から外すのと同じ瞬間に、止まったことを記録する**——下の await の間に会話や画面が起こしに来ても、
    // 間を置かずに起こし直しを重ねない（起こすのは下で予約する1本）
    if (!stopping) connectBackoff.recordLost(connName, origin.fingerprint, reason);
    connectionOrigins.delete(connName);
    liveness.unwatch(connName);
    retriedAfterSelfReport.delete(connName);
    registry.unregisterModule(connName); // 合言葉もここで失効する
    moduleTokens.delete(connName);
    shellHomes.delete(connName);
    for (const set of projectConnections.values()) set.delete(connName);
    await agentRelayEndpoint.unregisterModule(connName);
    // 次に起こすときは、コンテナの状態を確かめ直す（止まっていれば起こす）
    if (origin.containerId) readyContainers.delete(origin.containerId);
    // **黙っているだけで、プロセスは残っていることがある**（`incus exec` が incus-user に繋がったまま等）
    // ——確実に落とす。閉じたことでもう一度ここへ来るが、上で台帳から外してあるので素通りする
    await client.close().catch((err: unknown) => {
      console.warn(`[host] ${connName} を落とすときに例外:`, err);
    });
    if (stopping) return;
    scheduleRestart(connName, origin);
  }

  function scheduleRestart(connName: string, origin: ConnectionOrigin): void {
    cancelRestart(connName);
    // 時計の粒度で「まだ早い」と断られないよう、少しだけ後ろにずらす
    const wait = Math.max(0, connectBackoff.retryAt(connName) - Date.now()) + 50;
    const timer = setTimeout(() => {
      pendingRestarts.delete(connName);
      void restartModule(connName, origin);
    }, wait);
    timer.unref();
    pendingRestarts.set(connName, { timer, origin });
    console.log(
      `[host] ${connName} を ${Math.round(wait / 1000)} 秒後に起こし直します（続けて ${connectBackoff.streak(connName)} 回目）`,
    );
  }

  async function restartModule(connName: string, origin: ConnectionOrigin): Promise<void> {
    // 待っている間に、会話や画面が先に起こしていることがある
    if (stopping || connectedModules.has(connName)) return;
    let project: { id: string; root: string } | undefined;
    if (origin.projectId) {
      const found = projectThread.getProject(origin.projectId);
      // 畳んだ Project の Module は起こさない（畳むと台帳から Project ごと消える）
      if (!found || !projectConnections.has(origin.projectId)) {
        connectBackoff.clear(connName);
        return;
      }
      project = found;
    }
    // **宣言は引き直す**——止まっていた間に人が外した・変えたなら、それに従う
    const declaration = loadModuleDeclarations(runtimeConfig, origin.projectId ?? "").find(
      (d) => d.name === origin.declarationName,
    );
    if (!declaration) {
      console.log(`[host] ${connName} は宣言から外れたので、起こし直しません`);
      connectBackoff.clear(connName);
      return;
    }
    if (await connectDeclaredModule(declaration, project)) {
      console.log(`[host] ${connName} を起こし直しました`);
      return;
    }
    // 起こせなかった——間を伸ばしてまた試す（理由は connectDeclaredModule がログとお知らせに出している）
    if (!stopping) scheduleRestart(connName, origin);
  }

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
    // 繋がっているなら、それが答え（試し直しの間の記録より先に見る）
    if (connectedModules.has(connName)) return connName;
    const fingerprint = declarationFingerprint(declaration);
    if (connectBackoff.blocked(connName, fingerprint) !== undefined) return undefined;

    const releaseProjectId = declaration.meta.scope === "project" ? forProject?.id : undefined;
    const releasesAtStart = releaseProjectId ? (projectReleases.get(releaseProjectId) ?? 0) : 0;
    const releasedMeanwhile = () =>
      releaseProjectId !== undefined && (projectReleases.get(releaseProjectId) ?? 0) !== releasesAtStart;
    try {
      const connected = await spawnDeclaredModule(declaration, forProject);
      if (releasedMeanwhile()) {
        // 起動している間に Project が畳まれた——いま繋がったものも畳む（閉じたままならコンテナも止める）
        console.log(`[host] ${connName} は起動中に Project が畳まれたので、繋がったものを畳みます`);
        const stillClosed = projectThread.getProject(releaseProjectId!)?.status === "closed";
        await releaseProjectModules(releaseProjectId!, { stopContainer: stillClosed });
        return undefined;
      }
      return connected;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (releasedMeanwhile()) {
        // 畳む側が途中で切った——壊れているのではない。お知らせも試し直しの間も記録しない
        console.log(`[host] ${connName} は起動中に Project が畳まれたのでやめました: ${reason}`);
        return undefined;
      }
      const notify = connectBackoff.recordFailure(connName, fingerprint, reason);
      const retryIn = Math.round((connectBackoff.retryAt(connName) - Date.now()) / 1000);
      console.warn(`[host] ${connName} を繋げませんでした（${retryIn} 秒たったら、また試します）: ${reason}`);
      // **人が気づける場所を1つ作る**（規則2——黙って機能を減らさない）。
      // 会話には出さない（毎ターン混ざるのを止めるのがこの作業の目的）。
      // **続いた失敗の最初の1回だけ**——試し直すたびに、確認済みのお知らせを出し直さない
      if (notify) void inbox
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

  /**
   * **`${secret:名前}` を、起動の直前に金庫から引く**（決定・2026-09-16）。
   *
   * `mcpServers` の慣習は `env` に API キーを直に書くことだが、**banto の宣言は
   * Event Store に残る**ので、書いた瞬間に記録へ永久に残る。名前だけ書かせて、
   * 値はここで引く——**記録に残るのは名前だけ**。
   *
   * **relay と同じ規律を通す**（レビューで指摘・2026-09-15）。2026-09-13 に
   * 固めた秘密の制限は**すべて relay 経由の呼び出しに掛かる仕組み**なので、
   * ここで素通りさせると**刻印も group 絞りも監査も掛からない第2のドア**になる：
   *
   * - **刻印**：Project ごとの Module は `{project}`、banto 全体に1本の Module は
   *   `{instance: true}`（＝**共通の秘密だけ**。Project が決まらないので広げない）
   * - **監査**：`relay.call_recorded` に残す（何を引いたかの名前まで）
   * - **閉じ込め無しには渡さない**：外から繋いだコードに秘密を手渡す形になるので、
   *   閉じ込めが掛かっていない Module では断る
   */
  async function resolveSecretPlaceholders(
    declaration: ParsedModuleDeclaration,
    projectId: string | undefined,
  ): Promise<ModuleLaunch> {
    const wanted = secretPlaceholders(declaration.launch);
    if (wanted.length === 0) return declaration.launch;

    // **渡してよい相手か**（判断は declaration.ts に出してある——試験できる場所へ）
    const allowed = secretsAllowedFor(declaration.meta, declaration.launch);
    if (!allowed.ok) throw new Error(`${declaration.name}: ${allowed.reason}`);

    const caller = projectId ? { project: projectId } : { instance: true as const };
    const values = new Map<string, string>();
    for (const { alias } of wanted) {
      if (values.has(alias)) continue;
      const call = {
        projectId,
        callerModule: "banto",
        targetModule: "vault-directory",
        kind: "tool" as const,
        name: "resolveAlias",
        identifiers: { name: alias },
      };
      try {
        const value = await resolveSecretThroughVault(alias, caller);
        values.set(alias, value);
        await relayGrants.recordCall(call, { allowed: true, reason: "Module の起動に差し込む秘密" });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await relayGrants.recordCall(call, { allowed: true, reason, ok: false });
        // **引けなかったら起動しない**（空文字で埋めて静かに壊さない・規則2）
        throw new Error(`${declaration.name}: 秘密 "${alias}" を引けませんでした：${reason}`);
      }
    }
    return fillSecrets(declaration.launch, values);
  }

  /**
   * **金庫へ置く**（追加・2026-09-18、OAuth のため）。読みと同じ道・同じ刻印。
   *
   * 置けるのは `oauth-token` 種別だけ（金庫側が種別で区切っている）——
   * **人が預けた秘密には、この口から届かない**。
   */
  async function putSecretThroughVault(
    alias: string,
    value: string,
    caller: { project: string } | { instance: true },
  ): Promise<void> {
    const directory = await ensureVaultDirectory();
    if (!directory) throw new Error("Vault の窓口が繋がっていません");
    const endCall = moduleCalls.begin(
      "vault-directory",
      undefined,
      "host",
      "project" in caller ? caller.project : undefined,
      !("project" in caller),
    );
    try {
      await directory.callTool({
        name: "putSecret",
        arguments: {
          name: alias,
          value,
          note: "banto がログインのときに受け取ったもの",
          ...("project" in caller ? { forProject: caller.project } : {}),
        },
        _meta: { [CALLER_META_KEY]: caller },
      });
    } finally {
      endCall();
    }
    await relayGrants.recordCall(
      {
        projectId: "project" in caller ? caller.project : undefined,
        callerModule: "banto",
        targetModule: "vault-directory",
        kind: "tool",
        name: "putSecret",
        identifiers: { name: alias },
      },
      { allowed: true, reason: "ログイン情報の保管", ok: true },
    );
  }

  /** その Module の OAuth 用に、金庫の読み書きを1組作る。 */
  function oauthVaultFor(caller: { project: string } | { instance: true }) {
    return {
      read: async (alias: string): Promise<string | undefined> => {
        try {
          return await resolveSecretThroughVault(alias, caller);
        } catch {
          // **「まだ無い」と「読めない」は分けたい**が、金庫は同じ形で断る。
          // ここは「無い」として扱う——初回のログイン前は必ずこの道を通る
          return undefined;
        }
      },
      write: (alias: string, value: string) => putSecretThroughVault(alias, value, caller),
    };
  }

  /** 秘密を引くのに要る窓口を、必要になった時点で1本だけ起こす。 */
  async function ensureVaultDirectory(): Promise<Client | undefined> {
    const existing = connectedModules.get("vault-directory");
    if (existing) return existing;
    const declaration = loadModuleDeclarations(runtimeConfig, "").find((d) =>
      d.meta.satisfies.includes("vault-directory"),
    );
    if (!declaration) return undefined;
    const connName = await connectDeclaredModule(declaration);
    return connName ? connectedModules.get(connName) : undefined;
  }

  /** 窓口で在りかを引いてから、その金庫に値を聞く（relay と同じ2段）。 */
  async function resolveSecretThroughVault(
    alias: string,
    caller: { project: string } | { instance: true },
  ): Promise<string> {
    // **窓口を先に起こす**（追加・2026-09-16）。Module は同時に起こしているので、
    // 「窓口より先に、秘密を使う Module が立つ」順序が起きうる——そのとき
    // たまたま落ちる形にしない（規則6——間欠で落ちる形を残さない）
    const directory = await ensureVaultDirectory();
    if (!directory) throw new Error("Vault の窓口が繋がっていません");
    const meta = { [CALLER_META_KEY]: caller };
    // **窓口は金庫へ中継する**——その2段目にも同じ刻印が要る。中継が刻むのは
    // 台帳を見てなので、ここで台帳に載せる（Module に自己申告させない・規則3）
    const endDirectoryCall = moduleCalls.begin(
      "vault-directory",
      undefined,
      "host",
      "project" in caller ? caller.project : undefined,
      !("project" in caller),
    );
    let found: { implementation?: string; name?: string; group?: string };
    try {
      found = JSON.parse(
        ((
          await directory.callTool({ name: "lookupAlias", arguments: { name: alias }, _meta: meta })
        ).content as { text: string }[])[0]!.text,
      ) as { implementation?: string; name?: string; group?: string };
    } finally {
      endDirectoryCall();
    }
    if (!found.implementation || !found.name) throw new Error(`"${alias}" の在りかが分かりません`);
    const backend = connectedModules.get(found.implementation);
    if (!backend) throw new Error(`${found.implementation} が繋がっていません`);
    const text = (
      (
        await backend.callTool({
          name: "resolveAlias",
          arguments: { name: found.name, group: found.group },
          _meta: meta,
        })
      ).content as { text: string }[]
    )[0]?.text;
    if (typeof text !== "string") throw new Error(`"${alias}" の値を受け取れませんでした`);
    return text;
  }

  /**
   * **URL に繋ぐ Module を立てる**（追加・2026-09-17）。
   *
   * stdio とここが決定的に違う：
   *
   * - **閉じ込めが効かない。** プロセスがこちらに無い——コンテナに入れられるのは
   *   自分が起こしたものだけ。だから閉じ込めの代わりに
   *   **「machine の外へ出す」ことへの人の明示の承認**を要る形にする
   * - **中継の合言葉を渡さない。** 第三者のサーバに banto の身元を持たせない
   *   ——つまりリモートは**他の Module を呼べない**（`dependsOn` は parse が断る）
   * - **同梱にならない**（`withOrigin`）。骨格の役割も名乗れない
   */
  async function connectRemoteDeclaredModule(
    declaration: ParsedModuleDeclaration,
    connName: string,
    project: { id: string; root: string } | undefined,
  ): Promise<string> {
    const launch = declaration.launch as RemoteLaunch;
    // **人が「外へ出す」と承知したか。** 承知していなければ繋がない（規則2
    // ——黙って外へ出さない）。承認は URL ごと——URL が変われば聞き直す
    if (!isEgressAcknowledged(runtimeConfig, declaration.name, launch.url)) {
      throw new Error(
        `${connName}: この Module は ${new URL(launch.url).host} へデータを送ります。` +
          "画面から承知のうえで追加し直してください（承認が記録にありません）",
      );
    }
    const withSecrets = await resolveSecretPlaceholders(declaration, project?.id);
    const filled = expandLaunch(withSecrets, {
      ...launchContextBase,
      hostRelayToken: "",
      moduleDataDir: "",
      modulePackageDir: "",
    }) as RemoteLaunch;

    // **ログインが要る相手には、金庫に預けたトークンで繋ぐ**（追加・2026-09-18）。
    // 要らない相手には何も起きない（401 が返ってきて初めて認可が始まる）。
    // ここでは**新しいログインを始めない**——URL を作るのは人が押したときだけ
    // （`/api/modules/:name/oauth/start`）。背景の接続が、人の途中のやり取りを
    // 上書きしてはいけない
    const provider = new BantoOAuthProvider({
      moduleName: declaration.name,
      redirectUrl: oauthRedirectUrl(),
      vault: oauthVaultFor(callerFor(project?.id)),
      onAuthorizationUrl: () => {},
    });
    let client: Client;
    try {
      client = await connectRemoteModule(filled.url, filled.headers, provider);
    } catch (err) {
      if (needsLogin(err)) {
        // **「壊れている」と一緒くたにしない**（規則2）——画面が
        // 「ログインする」を出せるように、そうと分かる形で断る
        throw new Error(
          `${connName}: ${new URL(filled.url).host} へのログインが要ります（設定画面の「ログインする」を押してください）`,
        );
      }
      throw err;
    }
    return finishModuleConnection(declaration, connName, project, client, undefined, undefined);
  }

  /** Project ごとなら `{project}`、banto 全体なら共通だけ（`${secret:…}` と同じ規律）。 */
  function callerFor(projectId: string | undefined): { project: string } | { instance: true } {
    return projectId ? { project: projectId } : { instance: true };
  }

  /** **戻り先は1つだけ**（相手に登録する値なので、導出して写しを持たない・規則3）。 */
  function oauthRedirectUrl(): string {
    return `${bootstrap.publicUrl ?? `http://127.0.0.1:${bootstrap.port}`}/api/oauth/callback`;
  }

  /**
   * **人が「ログインする」を押してから戻ってくるまでの1回分**。
   *
   * PKCE の途中の値（`code_verifier`）はここにしか無い——金庫に書くと、
   * 数分で消える値のために共有の置き場へ書き込みが増える。**host が落ちたら
   * もう一度押してもらう**（規則2——推測で埋めない）。
   */
  const oauthFlows = new Map<
    string,
    { provider: BantoOAuthProvider; moduleName: string; serverUrl: string }
  >();

  /** ログインを始める。押してもらう URL を返す。 */
  async function startOAuth(moduleName: string): Promise<{ url: string }> {
    const declaration = loadModuleDeclarations(runtimeConfig, "").find((d) => d.name === moduleName);
    if (!declaration) throw new Error(`知らない Module です: ${moduleName}`);
    if (!isRemoteLaunch(declaration.launch)) {
      throw new Error(`${moduleName} は URL に繋ぐ形ではありません（ログインの相手がいません）`);
    }
    if (declaration.meta.scope === "project") {
      // **どの Project のログインか決められない**（押した場所が画面の設定面）。
      // 黙って共通に置くと、全 Project が同じアカウントを共有してしまう
      throw new Error(
        `${moduleName} は Project ごとに立つ Module です。ログインはまだ banto 全体のものにしか対応していません`,
      );
    }
    const serverUrl = declaration.launch.url;
    const state = randomUUID();
    let authorizationUrl: URL | undefined;
    const provider = new BantoOAuthProvider({
      moduleName,
      redirectUrl: oauthRedirectUrl(),
      vault: oauthVaultFor({ instance: true }),
      onAuthorizationUrl: (u) => void (authorizationUrl = u),
      state,
    });
    const result = await auth(provider as never, { serverUrl });
    if (result === "AUTHORIZED") {
      // 既に通っている——押す先は無い
      throw new Error(`${moduleName} は既にログイン済みです`);
    }
    if (!authorizationUrl) throw new Error(`${moduleName}: 相手がログインの窓口を示しませんでした`);
    oauthFlows.set(state, { provider, moduleName, serverUrl });
    return { url: authorizationUrl.toString() };
  }

  /** 戻ってきた。**印（state）で引き当てる**——どのログインか推測しない。 */
  async function finishOAuth(state: string, code: string): Promise<{ moduleName: string }> {
    const flow = oauthFlows.get(state);
    if (!flow) {
      throw new Error("このログインの途中の記録がありません（時間が経ったか、banto が再起動しました）");
    }
    await auth(flow.provider as never, { serverUrl: flow.serverUrl, authorizationCode: code });
    oauthFlows.delete(state);
    // **繋ぎ直す**——次のターンを待たずに、押した人がその場で結果を見られる
    await releaseModule(flow.moduleName);
    // **「もう一度試す」条件は宣言が変わったときだけ**（`connectDeclaredModule`）
    // ——ログインは宣言を変えないので、ここで明示的に忘れる。忘れないと
    // **直したのに直らない**（実測・2026-09-18、この試験が3回とも教えた）
    connectBackoff.clear(flow.moduleName);
    return { moduleName: flow.moduleName };
  }

  async function spawnDeclaredModuleOnce(
    declaration: ParsedModuleDeclaration,
    forProject: { id: string; root: string } | undefined,
    connName: string,
    project: { id: string; root: string } | undefined,
  ): Promise<string> {
    // 束ねている間に先の1本が終わっていることがある
    if (connectedModules.has(connName)) return connName;

    // **URL に繋ぐ形は、まったく別の道を通る**（追加・2026-09-17）。
    // 起こすプロセスが無いので、閉じ込めも `cwd` も `env` も合言葉も無い
    if (isRemoteLaunch(declaration.launch)) {
      return connectRemoteDeclaredModule(declaration, connName, project);
    }

    // 中継の合言葉は「宣言に書けない値」なので、ここで発行して差し込む
    // **承認の粒度は宣言の名前と Project**（アーキ仕様 §2.5）。プロセスの名前
    // （`shell-<projectId>`）は、どのターンの仕事かを引くときにだけ使う
    // **どこで起こすか**（決定・2026-09-25、`docs/specs/v4-security.md` §1）：
    //   Project の Module → その Project のコンテナ
    //   外から足した banto 全体の Module → banto 全体用のコンテナ（banto 本体で動くのは banto 自身のコードだけ）
    //   同梱の banto 全体の Module → banto 本体
    // 中からは host の 127.0.0.1 に届かないので、中継の住所はブリッジの host 側にする（host は 0.0.0.0 で待ち受けている）
    const where = modulePlacement(declaration.meta, declaration.launch);
    const placement: ContainerPlacement | undefined =
      where === "project-container" && project
        ? { id: project.id, root: project.root, nesting: projectNesting(project.id) }
        : where === "instance-container"
          ? { id: instanceContainerId(bootstrap.dataDir), nesting: false }
          : undefined;
    // **繋がるまでにどこで時間を使ったかを、繋がった行に添える**（追加・2026-09-26）——新しい Project を
    // 開くのが遅いとき、手元でプローブを書かずに `~/banto-host.log` で内訳が分かるように（規則4）
    const started = performance.now();
    const phases: string[] = [];
    const mark = (what: string, since: number) => phases.push(`${what} ${Math.round(performance.now() - since)}ms`);
    const container = placement ? await ensureContainer(placement) : undefined;
    if (container) mark("コンテナ", started);
    const token = registry.issueToken({
      moduleName: declaration.name,
      connName,
      projectId: project?.id,
      meta: declaration.meta,
      // 中では AI がこの合言葉も読める——値を返す口への承認を、何を指していたかごとに分ける
      ...(container ? { inContainer: true } : {}),
      // **鍵の窓口を立てる場所**（追加・2026-09-27）。Module の置き場はコンテナに同じパスで見せているので、
      // その中なら host の Vault が立てた ssh-agent に中から届く（host の /tmp は中から見えない）
      ...(container ? { socketDir: ensureSocketDir(join(bootstrap.dataDir, "modules", connName)) } : {}),
    });
    const context: LaunchContext = {
      ...launchContextBase,
      ...(container ? { hostRelayUrl: `http://${container.hostAddress}:${bootstrap.port}/relay` } : {}),
      hostRelayToken: token,
      projectRoot: project?.root,
      // Module ごとに1つ。**その Module の分だけ**書けるようにする（決定・2026-09-07）
      moduleDataDir: join(bootstrap.dataDir, "modules", connName),
      // **プログラムの置き場は、状態の置き場と分ける**（追加・2026-09-21）。
      // registry から取ってきたものがここに入り、起動時は**読み取り専用**で渡す
      // **宣言の名前で引く**（プロセス名 `<名前>-<projectId>` ではない）
      // ——入れるときも同じ名前で置いている（`install/paths.ts`、規則3）
      modulePackageDir: modulePackageDirOf(bootstrap.dataDir, declaration.name),
    };
    mkdirSync(context.moduleDataDir, { recursive: true, mode: 0o700 });
    // **中に見せる置き場は、先に頼んでおく**（改訂・2026-09-26、実測）——下の Shell のホームの用意や
    // 金庫の語の解決を待ってから頼むと、並んで起きる他の Module のマウントの束に乗り遅れ、
    // 自分の分だけもう1回待つことになっていた。起こす直前に揃っていればよい
    const mounting = performance.now();
    const mounted = container
      ? Promise.all([
          containers.ensureDisk(container.name, diskDeviceName(context.moduleDataDir), context.moduleDataDir),
          ...(existsSync(context.modulePackageDir)
            ? [containers.ensureDisk(container.name, diskDeviceName(context.modulePackageDir), context.modulePackageDir, { readonly: true })]
            : []),
        ])
      : undefined;
    // 待たずに進むあいだに失敗しても、下で待つまで「誰も読まない拒否」にしない
    mounted?.catch(() => undefined);
    // **Shell 専用のホーム**（決定・2026-09-23、ユーザー）。人のホームは閉じ込めで
    // 読めないので、Project ごとに書けるホームを用意し、人が選んだ設定だけを写す。
    // `shell` は同梱だけが名乗れる役割（RESERVED_ROLES）——**第三者の Module に
    // 人の git の設定を渡さない**
    let shellHome: string | undefined;
    if ((declaration.meta.satisfies as string[]).includes("shell") && declaration.meta.confinement) {
      shellHome = join(context.moduleDataDir, "home");
      const sync = await syncShellHome(shellHome, shellHomeFiles(runtimeConfig), { sourceHome: shellHomeSource });
      shellHomes.set(connName, shellHome);
      lastShellHomeSync = sync;
      if (sync.removedGitKeys.length > 0 || sync.rewrittenGitKeys.length > 0) {
        console.log(
          `[host] ${connName}: Shell のホームへ写した git の設定から外したもの ${JSON.stringify(sync.removedGitKeys)}` +
            `・向け直したもの ${JSON.stringify(sync.rewrittenGitKeys)}`,
        );
      }
    }
    // **金庫の語を先に解く**（追加・2026-09-16）。値はここで初めて現れ、
    // env として子プロセスへ渡るだけ——**記録に残るのは名前だけ**
    const withSecrets = await resolveSecretPlaceholders(declaration, project?.id);
    // ここへ来るのは起動する形だけ（URL に繋ぐ形は上で分かれている）
    const launch = expandLaunch(withSecrets, context) as StdioLaunch;

    // **コンテナの中で起こす**。閉じ込めはコンテナそのもの。中に見せるのは Project の根（作るときに）・
    // banto のコード（読み取り専用、作るときに）・この Module の置き場・取ってきた配布物（読み取り専用）だけ。
    // **host の環境は渡さない**（`incus exec` は引き継がない。渡すのは下の一覧だけ）
    if (container) {
      await mounted;
      mark("マウント", mounting);
      const { uid, gid } = userInfo();
      const passthrough = Object.fromEntries(
        containerEnvPassthrough.flatMap((name) => (process.env[name] !== undefined ? [[name, process.env[name]!]] : [])),
      );
      const inside = execInContainer(
        container.name,
        {
          cwd: project?.root ?? context.moduleDataDir,
          uid,
          gid,
          env: {
            ...passthrough,
            HOME: context.moduleDataDir,
            // コンテナの中で動いていることを Module に知らせる（Shell の説明の言い方が変わる）
            BANTO_IN_CONTAINER: "1",
            // 中から届く host 側のアドレス（サブエージェントが Claude の中継をここで開いてもらう）
            BANTO_HOST_ADDRESS: container.hostAddress,
            BANTO_MODULE_DATA_DIR: context.moduleDataDir,
            // **自分の宣言上の名前**（追加・2026-09-15）。同じ実装を2本以上立てることがある——Module 自身が
            // 「自分はどの1本か」を知らないと、画面に同じ名前が並ぶ。host が必ず渡す
            BANTO_MODULE_NAME: declaration.name,
            ...(shellHome ? { BANTO_SHELL_HOME: shellHome } : {}),
            ...launch.env,
          },
        },
        // node は中の決まった場所に置いてある（ホストと同じ版）
        launch.command === process.execPath ? CONTAINER_NODE_PATH : launch.command,
        launch.args,
      );
      // `incus` 自身はホストで動く——ホストの環境（Incus の設定の置き場など）はこちらに渡す
      const connecting = performance.now();
      const client = await connectStdioModule(inside.command, inside.args, undefined, process.env);
      mark("起動と接続", connecting);
      return finishModuleConnection(declaration, connName, project, client, token, forProject, { started, phases }, placement?.id);
    }

    // **banto 本体で起こす**：同梱の banto 全体の Module（banto 自身のコード——Vault は秘密の置き場を持つ）。
    // **host が必ず用意する値は、宣言に書かせない**（改訂・2026-09-07）——置き場と名前は host が常に渡す
    const client = await connectStdioModule(launch.command, launch.args, undefined, {
      ...process.env,
      BANTO_MODULE_DATA_DIR: context.moduleDataDir,
      BANTO_MODULE_NAME: declaration.name,
      ...launch.env,
    });

    return finishModuleConnection(declaration, connName, project, client, token, forProject, { started, phases });
  }


  /**
   * **繋いだ後にやることは、起動する形でも URL に繋ぐ形でも同じ**
   * （切り出し・2026-09-17）。申告の突き合わせ・可視性の検査・台帳への登録。
   *
   * `token` は中継の合言葉——**URL に繋ぐ形には無い**（渡さないと決めた）。
   */
  async function finishModuleConnection(
    declaration: ParsedModuleDeclaration,
    connName: string,
    project: { id: string; root: string } | undefined,
    client: Client,
    token: string | undefined,
    forProject: { id: string; root: string } | undefined,
    timing?: { started: number; phases: string[] },
    /** コンテナの中で起こしたなら、その置き場の id（`readyContainers` の鍵） */
    containerId?: string,
  ): Promise<string> {
    const checking = performance.now();
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
      // Runner から見える名前（Skill はこれで修飾する、§5.7）
      declaredName: declaration.name,
      client,
      meta: declaration.meta,
      codeId: declarationFingerprint(declaration),
      // 中継で呼べるのは同じ Project の中だけ（決定・2026-09-26）——Project ごとの Module はその Project を持つ
      ...(project ? { projectId: project.id } : {}),
    };
    registry.registerModule(conn);
    agentRelayEndpoint.registerModule(conn);
    connectedModules.set(connName, client);
    connectBackoff.recordConnected(connName, conn.codeId);
    const origin: ConnectionOrigin = {
      declarationName: declaration.name,
      fingerprint: conn.codeId,
      ...(project ? { projectId: project.id } : {}),
      ...(containerId ? { containerId } : {}),
    };
    connectionOrigins.set(connName, origin);
    // **接続の異常を黙って捨てない**（追加・2026-09-30、規則2）。SDK は既定で握りつぶす——1通 10 MiB を
    // 越えた返事で接続が閉じたときも、ログに何も残らなかった
    client.onerror = (err: Error) => {
      console.warn(`[host] ${connName} との接続で異常: ${err.message}`);
    };
    // **Module が止まったら、返事待ちの札に代わりに答える**（決定・2026-09-25）。止め方（畳む・立て直す・落ちる）
    // によらずここを通る。**畳んだのでなければ、起こし直す**（決定・2026-09-30）
    const previousOnClose = client.onclose;
    client.onclose = () => {
      previousOnClose?.();
      for (const [replyTo, h] of replyHandles.awaitingFor(connName)) {
        void deliverLostReply({ threadId: h.threadId, replyTo, moduleName: h.moduleName, hop: h.hop + 1 }, "Module が止まったため");
      }
      void moduleLost(connName, client, origin, "接続が閉じました");
    };
    // **閉じずに黙ることもある**——定期的に確かめる（`liveness.ts`）
    liveness.watch(connName, client);
    if (token !== undefined) moduleTokens.set(connName, token);
    if (project) {
      const forThisProject = projectConnections.get(project.id) ?? new Set<string>();
      forThisProject.add(connName);
      projectConnections.set(project.id, forThisProject);
    }
    const took = timing
      ? `（${Math.round(performance.now() - timing.started)}ms：${[...timing.phases, `申告と可視性の確認 ${Math.round(performance.now() - checking)}ms`].join("・")}）`
      : "";
    console.log(
      `[host] ${declaration.name} connected${project ? ` for project ${project.id} (root ${project.root})` : ""}${took}`,
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
  async function releaseProjectModules(projectId: string, opts: { stopContainer?: boolean } = {}): Promise<string[]> {
    // 起動の途中のものに「畳まれた」と分かるようにする（上の `projectReleases`、終わった側が自分で片づける）
    projectReleases.set(projectId, (projectReleases.get(projectId) ?? 0) + 1);
    const names = [...(projectConnections.get(projectId) ?? [])];
    projectConnections.delete(projectId);
    // 止まって起こし直しを待っているものも、もう起こさない
    for (const [connName, pending] of [...pendingRestarts]) {
      if (pending.origin.projectId === projectId) cancelRestart(connName);
    }
    for (const connName of names) {
      const client = connectedModules.get(connName);
      connectedModules.delete(connName);
      connectionOrigins.delete(connName);
      liveness.unwatch(connName);
      connectBackoff.clear(connName);
      retriedAfterSelfReport.delete(connName);
      registry.unregisterModule(connName); // 合言葉もここで失効する
      moduleTokens.delete(connName);
      shellHomes.delete(connName);
      await agentRelayEndpoint.unregisterModule(connName);
      // **プロセスを落とすのは最後**（先に台帳から外しておけば、落とす途中に
      // 来た要求が死にかけの接続を掴まない）
      await client?.close().catch((err: unknown) => {
        console.warn(`[host] ${connName} を畳むときに例外:`, err);
      });
    }
    if (names.length > 0) console.log(`[host] project ${projectId} を畳んだ: ${names.join(", ")}`);
    // **Project を畳んだらコンテナも止める**（決定・2026-09-25）。止めるのは待ちすぎない（上限→強制停止）。
    // 止められなくても畳むこと自体は済んでいるので、畳む操作は失敗させない——ただし**黙らない**：
    // 動いたまま残ったことを受信箱で言う（規則2）
    const ready = readyContainers.get(projectId);
    readyContainers.delete(projectId);
    if (opts.stopContainer && ready) {
      await containers.stop(ready.name).catch(async (err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(`[host] project ${projectId} のコンテナ ${ready.name} を止められませんでした: ${reason}`);
        await inbox.raiseNotice({
          projectId,
          dedupeKey: `container-stop:${projectId}`,
          title: "Project のコンテナを止められませんでした",
          detail: `${ready.name} が動いたまま残っています：${reason}`,
        });
      });
    }
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
  /** banto 全体の Module が立っているか（追加・2026-09-15、instance 層の画面用）。 */
  function instanceModuleStatus(): Array<{ name: string; connected: boolean; error?: string }> {
    return listInstanceModules(runtimeConfig).map((m) => {
      const failure = connectBackoff.failure(m.name);
      return {
        name: m.name,
        // Project ごとに立つものは、この名前では繋がらない——どこかの Project で
        // 立っていれば「立っている」と言う（画面は内訳を別に出す）
        connected:
          m.scope === "instance"
            ? connectedModules.has(m.name)
            : [...connectedModules.keys()].some((c) => c.startsWith(`${m.name}-`)),
        ...(failure ? { error: failure.reason } : {}),
      };
    });
  }

  /** その Module のプロセスを落とす（止めた・消したとき）。名前で始まる接続を全部。 */
  async function releaseModule(name: string): Promise<void> {
    const targets = [...connectedModules.keys()].filter((c) => c === name || c.startsWith(`${name}-`));
    for (const connName of [...pendingRestarts.keys()]) {
      if (connName === name || connName.startsWith(`${name}-`)) cancelRestart(connName);
    }
    for (const connName of targets) {
      const client = connectedModules.get(connName);
      connectedModules.delete(connName);
      connectionOrigins.delete(connName);
      liveness.unwatch(connName);
      connectBackoff.clear(connName);
      retriedAfterSelfReport.delete(connName);
      registry.unregisterModule(connName);
      moduleTokens.delete(connName);
      shellHomes.delete(connName);
      await agentRelayEndpoint.unregisterModule(connName);
      await client?.close().catch((err: unknown) => {
        console.warn(`[host] ${connName} を畳むときに例外:`, err);
      });
    }
    for (const set of projectConnections.values()) for (const t of targets) set.delete(t);
    if (targets.length > 0) console.log(`[host] ${name} を畳んだ: ${targets.join(", ")}`);
  }

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
      const failure = connectBackoff.failure(connName);
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
        // ——落ちた事実は connectBackoff と受信箱のお知らせに残っている
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

  /**
   * **新しいセッションで効かせる Skill の集合**（決定・2026-09-23、§5.7）。
   * その会話に繋ぐ Module が配っている Skill を集め、設定（Project 上書き → 全体の既定）
   * で絞る。刻むのは `turn-runner.ts`。
   */
  async function resolveSessionSkills(threadId: string): Promise<SessionSkillSet> {
    const thread = projectThread.getThread(threadId);
    if (!thread) throw new Error(`thread ${threadId} not found`);
    const discovery = await discoverSkills(await resolveModuleClientsForThread(threadId));
    return selectSessionSkills(discovery, (ref) => isSkillEnabled(runtimeConfig, ref, thread.projectId));
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
    // **札で、呼び出し元の Thread に届ける**（決定・2026-09-25、アーキ仕様 §4.2）
    deliverToThread: async (caller, input) => {
      const h = replyHandles.use(input.replyTo, { moduleName: caller.moduleName, ...(caller.connName ? { connName: caller.connName } : {}) });
      if ("error" in h) return { ok: false, error: h.error };
      const r = await deliveries.deliver({
        threadId: h.threadId,
        from: caller.moduleName,
        title: input.title,
        text: input.text,
        hop: h.hop + 1,
      });
      if (input.final) {
        replyHandles.settle(input.replyTo);
        await projectThread.settleReply(h.threadId, input.replyTo);
        publishBackground(h.threadId);
      }
      return { ok: true, deliveryId: r.deliveryId, wake: r.wake };
    },
    // 出所（人の画面か、AI のターンか）を引くための台帳。承認の要否がここで分かれる
    moduleCalls,
    // **公開の実装が、Project のコンテナに届くアドレスを引く**（§4.3 Publish）。この banto が作ったものだけ。
    // 確かに届かない（止まっている・無い・他人のもの）は値で返し、分からない（Incus が答えない）は投げる
    projectAddress: (projectId) =>
      containers.containerAddress(containerNameFor(projectId), bootstrap.dataDir).then(
        (address) => ({ address }),
        (err: unknown) => {
          if (err instanceof ContainerAddressUnavailable) return { unavailable: err.message };
          throw err;
        },
      ),
    // **Project の一覧**（§2.4 Repositories——どの Project がそのフォルダを根にしているか）。引ける相手と場面は
    // 中継が絞る（`mayListProjects`）。根は store が正規化したもの（realpath）
    listProjects: () =>
      projectThread.listProjects().map((p) => ({ id: p.id, name: p.name, root: p.root, status: p.status })),
    // **受信箱に知らせる**（§2.4 Repositories——ログインの更新に失敗したとき）。出せる相手は中継が絞る
    // （`mayRaiseNotice`）。鍵は Module ごとに分ける——別の Module の知らせを潰さない
    raiseNotice: async (caller, input) => {
      await inbox.raiseNotice({ dedupeKey: `module:${caller.moduleName}:${input.key}`, title: input.title, detail: input.detail });
    },
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
      onJudgmentSettled: (threadId, settled) => {
        turnEvents.publish(threadId, { type: "answered", judgmentId: settled.id, answer: settled.answer });
      },
    }),
    onAudit: async ({ allowed, reason, ok, ts, ...call }) => {
      // **記録は Event Store が本体**（アーキ仕様 §2.5）。console はおまけ。
      // 時刻はイベント自身が持つので payload には入れない（規則3）
      console.log("[relay-audit]", JSON.stringify({ ...call, allowed, reason, ok, ts }));
      await relayGrants.recordCall(call, { allowed, reason, ok });
    },
  });

  /**
   * **Runner の差し替え（試験のときだけ）**（追加・2026-09-20、ユーザー決定）。
   *
   * E2E が見たいのは banto 自身の振る舞い（画面・Vault・Module・中継）であって、
   * **モデルがどの tool を選ぶかではない**。実 LLM を引き金にすると、
   * 「AI がその 180 秒のうちに呼ばなかった」だけで落ちる——実際 2026-09-20 に
   * フル E2E 5回中2回がこれで落ちた（`vault-request-inline`）。
   *
   * `AppDeps.runTurn` は元から在る（単体試験が使っている）。本番の経路が
   * 渡していないだけなので、**env で指し示されたときだけ**そこへ流し込む。
   *
   * **本番では効かない**ようにしている——env が無ければ何も起きず、
   * 既定の実物が走る。**黙って偽物に落ちることは無い**（規則2）：
   * 指していて読めなければ、理由を言って**立ち上がりを止める**。
   */
  if (bootstrap.testOnlySelfUpdate) {
    console.warn(
      `[host] **画面からの更新を差し替えています**（試験用、config.json の testOnlySelfUpdate）: systemctl=${bootstrap.testOnlySelfUpdate.systemctl}・` +
        `動いているコード=${bootstrap.testOnlySelfUpdate.codeDir}`,
    );
  }
  const fakeRunnerPath = process.env.BANTO_FAKE_RUNNER;
  let runTurnOverride: Parameters<typeof createApp>[0]["runTurn"] | undefined;
  let listModelsOverride: Parameters<typeof createApp>[0]["listModels"] | undefined;
  if (fakeRunnerPath) {
    const loaded = (await import(fakeRunnerPath)) as { runTurn?: unknown; listModels?: unknown };
    if (typeof loaded.runTurn !== "function") {
      throw new Error(
        `BANTO_FAKE_RUNNER が指す ${fakeRunnerPath} に runTurn がありません（試験用の差し替えが効きません）`,
      );
    }
    console.warn(`[host] **Runner を差し替えています**（試験用）: ${fakeRunnerPath}`);
    runTurnOverride = loaded.runTurn as Parameters<typeof createApp>[0]["runTurn"];
    // 選べるモデルも偽物に聞く（あれば）——試験で本物の CLI を起こさない
    if (typeof loaded.listModels === "function") {
      listModelsOverride = loaded.listModels as Parameters<typeof createApp>[0]["listModels"];
    }
  }

  const app = createApp({
    warmModelCatalog: true,
    ...(runTurnOverride ? { runTurn: runTurnOverride } : {}),
    ...(listModelsOverride ? { listModels: listModelsOverride } : {}),
    projectThread,
    globalMemory,
    inbox,
    pendingApprovals,
    runtimeConfig,
    turnEvents,
    threadTurns,
    deliveries,
    appEvents,
    moduleCalls,
    relayEndpoint,
    agentRelayEndpoint,
    authToken: bootstrap.authToken,
    auth: new AuthService({
      store: authStore,
      dataDir: bootstrap.dataDir,
      authToken: bootstrap.authToken,
      ...loginOrigins(bootstrap),
      sandboxOrigin: bootstrap.sandboxPublicUrl,
      events: appEvents,
    }),
    // **画面から banto を更新する**（決定・2026-10-04、アーキ仕様 §2.5）。動いているコードの本当のパスで、
    // 版ごとのフォルダから動いているかを見る。
    // E2E だけが差し替える（本物の systemd は使えない）：偽の systemctl と、試験の置き場の `current/banto`。
    // **環境変数では受けない**——config.json の明示の項目 `testOnlySelfUpdate` だけ（理由は bootstrap.ts）
    selfUpdate: new SelfUpdate({
      releaseDir: bootstrap.releaseDir,
      dataDir: bootstrap.dataDir,
      codeDir: bootstrap.testOnlySelfUpdate?.codeDir ?? monorepoRoot,
      ...(bootstrap.testOnlySelfUpdate ? { systemctl: bootstrap.testOnlySelfUpdate.systemctl } : {}),
    }),
    releaseProjectModules,
    projectContainerStatus: async (projectId: string) => {
      const name = containerNameFor(projectId);
      const st = await containers.state(name);
      return st ? { name, status: st.status } : undefined;
    },
    // **資源の上限**（決定・2026-10-02）。設定を変えたら、動いているコンテナにも起こし直さずに効かせる
    containerLimits: {
      describe: (projectId?: string) => describeLimits(runtimeConfig, hostResources(), projectId),
      async apply(projectId?: string) {
        const ids = projectId !== undefined
          ? [projectId]
          : [...projectThread.listProjects().map((p) => p.id), instanceContainerId(bootstrap.dataDir)];
        for (const id of ids) {
          await containers.applyLimits(containerNameFor(id), toContainerLimits(limitNumbersFor(runtimeConfig, hostResources(), id)));
        }
      },
    },
    resolveModulesForThread,
    resolveSessionSkills,
    // **Shell 専用のホームに写すもの**（決定・2026-09-23）。変えたら、立っている Shell にも写し直す
    shellHome: {
      files: () => shellHomeFiles(runtimeConfig),
      lastSync: () => lastShellHomeSync,
      async setFiles(files: string[]) {
        await runtimeConfig.setInstanceDefault(
          SHELL_HOME_FILES_KEY,
          files as unknown as Parameters<RuntimeConfigStore["setInstanceDefault"]>[1],
        );
        return resyncShellHomes();
      },
    },
    moduleStatusForProject,
    instanceModuleStatus,
    releaseModule,
    startOAuth,
    finishOAuth,
    dataDir: bootstrap.dataDir,
    configDir: dirname(resolveBootstrapConfigPath()),
    releaseDir: bootstrap.releaseDir,
    resolveModuleClientsForThread,
    resolveModuleClientsForProject,
    resolveInstanceModuleClients,
    sandboxPublicUrl: bootstrap.sandboxPublicUrl,
    // **引く registry を差し替えられるようにしておく**（追加・2026-09-21）。
    // 既定は公式。自前の registry を立てている人と、**本物を叩かない E2E**
    // の両方がここを使う（規則6——外の都合で落ちる試験にしない）
    registryBaseUrl: process.env.BANTO_MCP_REGISTRY_URL,
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
      authStore.save(),
    ]);
  };
  const snapshotTimer = setInterval(() => {
    void saveSnapshots().catch((err) => console.error("[host] スナップショット保存に失敗:", err));
  }, 60_000);
  snapshotTimer.unref();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      // 止める途中で Module が切れても、起こし直さない
      stopping = true;
      liveness.stop();
      for (const connName of [...pendingRestarts.keys()]) cancelRestart(connName);
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
    // 起動する前に届いていて、起こす前だったもの（と、上で「途中で終わりました」を届けたもの）を起こす
    // ——**待ち受けてから**（Runner は中継の口に繋ぐので、先に起こすと繋がらない）
    deliveries.resumeAll();
    // **合言葉はログに出さない**（改訂・2026-10-03、Fable のレビュー——journald に写しが残っていた）
    console.log(`[host] listening on http://0.0.0.0:${bootstrap.port}/（画面：${loginOrigins(bootstrap).uiOrigin}）`);
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

/**
 * レビュー待ちに出す1行——**そのターンの最後の返事の頭**。返事が記録されていなければ（途中で終わった）そう書く
 */
function turnEndSummary(thread: { messages: Array<{ role: string; text: string }> } | undefined): string {
  const last = thread?.messages.at(-1);
  if (!last || last.role !== "assistant" || last.text.trim() === "") {
    return "ターンが終わりました（返事は記録されていません——途中で止まった可能性があります）";
  }
  const flat = last.text.trim().replace(/\s+/g, " ");
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}
