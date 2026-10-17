#!/usr/bin/env node
// banto本体の起動プロセス（host）。ここまで作った全パッケージを実際に配線する。
// これがPhase 0/1の完了条件を実測する対象そのもの。

import { mkdirSync } from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { BantoOAuthProvider, oauthAliasFor } from "./oauth/provider.js";
import { hostResources, toContainerLimits } from "@banto/container";
import { loadOrCreateBootstrapConfig, loginOrigins, resolveBootstrapConfigPath } from "./config/bootstrap.js";
import { AuthStore } from "./auth/store.js";
import { AuthService } from "./auth/service.js";
import { EventLog } from "./event-store/log.js";
import { ProjectThreadStore, currentSkillSet, isRemoteProject } from "./project-thread/store.js";
import {
  discoverSkills,
  isSkillEnabled,
  renderSkillInstructions,
  selectSessionSkills,
  type SessionSkillSet,
} from "./skills/index.js";
import { RuntimeConfigStore } from "./config/runtime.js";
import { AutomationStore } from "./automation/store.js";
import { AutomationRunner } from "./automation/runner.js";
import { AutomationClock } from "./automation/clock.js";
import { AutomationWebhooks } from "./automation/webhook.js";
import { GlobalMemoryStore } from "./global-memory/store.js";
import { InboxStore } from "./inbox/store.js";
import { judgmentAnswerText } from "./inbox/answer-text.js";
import { PendingApprovalRegistry } from "./inbox/pending-approvals.js";
import { RelayRegistry, HostRelayEndpoint, RELAY_BODY_MAX_BYTES } from "./relay/host-relay-endpoint.js";
import { AgentRelayEndpoint } from "./relay/agent-relay-endpoint.js";
import { RelayGrantStore } from "./relay/grants.js";
import { ModuleCallTracker, STOP_DRAIN_LIMIT_MS } from "./relay/module-calls.js";
import { ElicitationRouter } from "./relay/elicitation-router.js";
import { createRelayApprovalGate } from "./relay/approval-gate.js";
import { isAutoApproveAll } from "./inbox/auto-approve.js";
import { TurnEventBus } from "./http/turn-events.js";
import { createApp, CONTAINER_NESTING_KEY, claudeLoginEnabled, readJsonBody, type ToolsInstallView } from "./http/app.js";
import { ClaudeLoginRelay, hostClaudeCredentialsPath } from "./claude-login/relay.js";
import { installedAgentSdkVersion, relayRefreshDecision } from "./claude-login/refresh.js";
import { describeLimits, limitNumbersFor } from "./container-limits.js";
import { ContainerPressureWatch } from "./container-pressure.js";
import { HostContainerRuntime } from "./runtime/host-container.js";
import { RemoteRuntimeStore } from "./runtime/remote-store.js";
import { RemoteRuntimes, isRemoteUnreachable, remoteNameOf, runtimeIdOf } from "./runtime/remote-runtimes.js";
import { RemoteSshRuntime } from "./runtime/remote-ssh.js";
import { RuntimeRouter } from "./runtime/router.js";
import { ProjectMover, type RunningItem } from "./runtime/project-move.js";
import { ProjectSleep } from "./runtime/project-sleep.js";
import { collectActivity } from "./http/activity.js";
import { createRelayListener } from "./relay/relay-listener.js";
import { RuntimeStopError, type PreparedPlace, type Runtime, type RuntimePlace, type ToolsInstallStatus } from "./runtime/runtime.js";
import { createSandboxServer } from "./http/sandbox-server.js";
import { StreamRelay, streamUrlOf } from "./http/streams.js";
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
import { RemoteOutageWatch } from "./modules/remote-outage.js";
import { LIVENESS, LivenessMonitor } from "./modules/liveness.js";
import { HostStallMeter } from "./host-stall.js";
import { StallProfiler } from "./stall-profiler.js";
import { collectHostHealth, timestampConsole } from "./host-health.js";
import { ResourceWatch } from "./resources.js";
import { ThreadTurns } from "./delivery/thread-turns.js";
import { ReplyHandles } from "./delivery/reply-handles.js";
import { ModuleReplies } from "./delivery/module-replies.js";
import { receivesReplies, TOOLS_PREPARING_MARKER, type ModuleReplyArguments } from "@banto/module-contract";
import type { CallerIdentity } from "./relay/host-relay-endpoint.js";
import { ThreadDeliveries } from "./delivery/thread-deliveries.js";
import { continueStoppedTurn, resumeHoldReason, sdkSessionReader } from "./delivery/turn-continuation.js";
import { ReviewToolCounter, reviewDueAfterTurn } from "./inbox/review-turn.js";
import { acknowledgesReviewsOnStart, planAutomationReview } from "./inbox/automation-review.js";
import { NON_WORK_TOOLS } from "./http/turn-summary.js";
import { ModuleNotUpYetError, RESUME_ASK_TIMEOUT_MS, RestartRecovery } from "./delivery/restart-recovery.js";
import { AppEventBus, announceProjectsChanged, backgroundItemsOf } from "./http/app-events.js";
import { SelfUpdate } from "./self-update/self-update.js";
import {
  assertAllVisibilityExplicit,
  assertVisibilityValues,
  classifyMetaDifference,
  CALLER_META_KEY,
  RESUME_AFTER_RESTART_TOOL,
  SOCKET_DIR_META_KEY,
  STREAM_SOCKET_RELATIVE_PATH,
} from "@banto/module-contract";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** 道具用のコンテナの Module を使うときに起こすとき、呼び元を待たせる上限（入れ始めたらすぐ返す）。起き終わっていれば待たずに通る */
const ON_DEMAND_START_WAIT_MS = 20_000;
const ON_DEMAND_POLL_MS = 250;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
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
  /** 実行場所が自分の口を渡したとき（別のサーバ：env を最初の1行で渡す）はそれを使う */
  makeTransport?: () => Transport,
): Promise<Client> {
  const transport = makeTransport ? makeTransport() : new StdioClientTransport({ command, args, cwd, env: env as Record<string, string> });
  // elicitation を宣言しないと、Module側の server.elicitInput() が
  // 「Client does not support form elicitation」で即エラーになる
  // （agent-proxy.ts のelicitation転送の前提）。
  const client = new Client({ name: "banto-host", version: "0.1.0" }, { capabilities: { elicitation: {} } });
  try {
    await client.connect(transport);
  } catch (err) {
    // 起こせなかった理由（向こうの起動役・ssh の言葉）が標準エラーにあれば添える——「Connection closed」だけにしない
    const tail = (transport as { lastStderr?: () => string }).lastStderr?.();
    if (tail) throw new Error(`${err instanceof Error ? err.message : String(err)}：${tail.split("\n").slice(-3).join(" ")}`);
    throw err;
  }
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
  // `~/banto-host.log` の行に時刻を付ける（決定・2026-10-09、v4-architecture.md §5.4-0）
  timestampConsole();
  // **診断の報告で接続の名前を逆引きしない**（2026-10-10）——SDK などが `process.report.getReport()` を呼ぶと、開いている接続
  // ごとに名前の逆引きをして本体が数秒止まっていた（host の CPU の記録）。banto はネットワークの欄を使わない
  if (process.report) (process.report as { excludeNetwork?: boolean }).excludeNetwork = true;
  const bootstrap = loadOrCreateBootstrapConfig();
  console.log(`[host] dataDir=${bootstrap.dataDir} port=${bootstrap.port}`);

  /**
   * **中に渡してよい host の環境変数**（名前をカンマで並べる）。コンテナには host の環境を渡さない——
   * 試験の差し替え（偽のエージェントなど）を中の Module に届ける口。人の banto では使わない
   */
  const containerEnvPassthrough = (process.env.BANTO_CONTAINER_ENV_PASSTHROUGH ?? "").split(",").map((x) => x.trim()).filter(Boolean);

  const eventLog = new EventLog(bootstrap.dataDir);
  await eventLog.init();

  const projectThread = new ProjectThreadStore(bootstrap.dataDir, eventLog);
  await projectThread.load();
  const runtimeConfig = new RuntimeConfigStore(bootstrap.dataDir, eventLog);
  await runtimeConfig.load();
  // **自動化の台帳**（決定・2026-10-15、アーキ仕様 §4.3）。project-thread とは別の fold と snapshot
  const automations = new AutomationStore(bootstrap.dataDir, eventLog);
  await automations.load();
  // **登録した別のサーバ**（決定・2026-10-08、`docs/specs/v4-security.md` §1「登録と選び方」）
  const remoteRuntimeStore = new RemoteRuntimeStore(bootstrap.dataDir, eventLog);
  await remoteRuntimeStore.load();
  // **Project の実行場所**（決定・2026-10-08、`docs/specs/v4-security.md` §1「実行場所は core の中の差し替え口」）。
  // 今は この host のコンテナだけ。**閉じ込めはコンテナ**（決定・2026-09-25）——前提が欠けていれば、
  // コンテナで起こす Module（Project の Module・外から足した banto 全体の Module）は起こさず、受信箱で言う
  // （黙って閉じ込め無しで起こさない、規則2）。banto 本体で動く同梱の Module はそのまま立つ
  const hostRuntime = await HostContainerRuntime.create({
    dataDir: bootstrap.dataDir,
    port: bootstrap.port,
    bantoDir: monorepoRoot,
    // この host の資源と、banto 全体・Project ごとの設定から計算する（決定・2026-10-02）
    limitsFor: (placeId) => toContainerLimits(limitNumbersFor(runtimeConfig, hostResources(), placeId)),
    // **どこから写すか**は既定で人のホーム。E2E だけが差し替える（本物のホームを試験に使わない）
    ...(process.env.BANTO_SHELL_HOME_SOURCE ? { shellHomeSource: process.env.BANTO_SHELL_HOME_SOURCE } : {}),
  });
  console.log(`[host] ${hostRuntime.describePrerequisites()}`);
  const globalMemory = new GlobalMemoryStore(bootstrap.dataDir, eventLog);
  await globalMemory.load();
  const inbox = new InboxStore(bootstrap.dataDir, eventLog);
  await inbox.load();
  // 前のプロセスが抱えていた判断待ちは、もう誰も待っていない（決定・2026-09-06）
  const orphaned = await inbox.expireOrphanedJudgments();
  if (orphaned > 0) console.log(`[host] 前回の走行が抱えていた判断待ち ${orphaned} 件を期限切れにした`);
  await stopSleepingContainers();
  /**
   * **banto を起こし直しても眠ったまま**（決定・2026-10-16、アーキ仕様 §2.2「スリープ」）。眠っている Project のコンテナが
   * 動いていれば止める（Incus の自動起動や人が起こしたもの）。待ち受ける前に——起きた直後の `modules/prepare` で起こしたものを
   * 後から止めない。順序は (1) 待たれている Module の集合を決める (2) ここ (3) §4.3 の「起こしておく」。出来事を待たれる
   * Module はまだ無い（Backlog `project-sleep-awaited-modules`）ので (1)(3) は空。別のサーバは眠らせるときに Service の
   * 自動起動を切ってあるので、改めて確かめない
   */
  async function stopSleepingContainers(): Promise<void> {
    const sleeping = projectThread.listProjects().filter((p) => p.status !== "closed" && p.sleep && !isRemoteProject(p));
    await Promise.all(
      sleeping.map(async (p) => {
        try {
          if ((await hostRuntime.status(p.id))?.status !== "Running") return;
          await hostRuntime.stopProjectContainer(p.id);
          console.log(`[host] 眠っている project ${p.id} のコンテナが動いていたので止めました`);
        } catch (err) {
          const reason = err instanceof RuntimeStopError ? err.reason : err instanceof Error ? err.message : String(err);
          console.warn(`[host] 眠っている project ${p.id} のコンテナを止められませんでした: ${reason}`);
          await inbox.raiseNotice({
            projectId: p.id,
            dedupeKey: `container-stop:${p.id}`,
            title: "眠っている Project のコンテナを止められませんでした",
            detail: reason,
          });
        }
      }),
    );
  }
  const pendingApprovals = new PendingApprovalRegistry();
  /**
   * **Claude のログインの中継**（core に常設、決定・2026-09-27、`docs/specs/v4-security.md` §2）。Project のコンテナの
   * 環境に住所とその Project の合言葉を入れ、コンテナの中の `claude -p`・Agent SDK・サブエージェント・Service が
   * 本体のログインで推論を呼べる。本物のトークンは中に入れない
   */
  // 中継が本体のログインを取り直すか（§2「中継も、切れかけたら取り直す」）
  const relayRefresh = relayRefreshDecision(process.env, installedAgentSdkVersion());
  if (!relayRefresh.enabled) console.warn(`[host] Claude ログインの中継は取り直しません（${relayRefresh.why}）`);
  const claudeLogin: ClaudeLoginRelay = new ClaudeLoginRelay({
    refreshEnabled: relayRefresh.enabled,
    // 試験は本物のログインを読まない（E2E が置いた偽物を指す）。ふだんは本体（Runner）と同じ置き場
    credentialsPath: process.env.BANTO_CLAUDE_RELAY_CREDENTIALS ?? hostClaudeCredentialsPath(),
    ...(process.env.BANTO_CLAUDE_RELAY_UPSTREAM ? { upstream: process.env.BANTO_CLAUDE_RELAY_UPSTREAM } : {}),
    // 取り直しの口（E2E が偽物を指す。§2「中継も、切れかけたら取り直す」）
    ...(process.env.BANTO_CLAUDE_RELAY_TOKEN_URL ? { tokenUrl: process.env.BANTO_CLAUDE_RELAY_TOKEN_URL } : {}),
    secretsPath: join(bootstrap.dataDir, "claude-login-secrets.json"),
    enabled: (projectId) => claudeLoginEnabled(runtimeConfig, projectId),
    // **送り元はその Project のコンテナ**（測った・2026-10-08：同じブリッジの別のコンテナからも core の口に届く。
    // 起こし直しでもアドレスは変わらない（MAC が固定・DHCP の貸し出しは1時間）が、中の root はアドレスを足せる）。
    // 覚えずに毎回、実行場所に聞く——止まっている・無いコンテナは「違う」
    sourceMatches: (projectId, remote) => runtime.sourceMatches(projectId, remote),
    // **中継が取り直しても直せなかったときだけ、受信箱に1件**（同じものが開いている間は増やさない。改訂・2026-10-16、
    // v4-security.md §2「中継も、切れかけたら取り直す」）。以前は 401 が1回来たら出し、本体の会話が次に動いて自然に
    // 直っても閉じなかった
    onUpstreamUnauthorized: (_projectId, reason) => {
      console.warn(`[host] Claude ログインの中継で直せませんでした: ${reason}`);
      void inbox
        .raiseNotice({
          dedupeKey: "claude-login-upstream-unauthorized",
          title: "banto 本体の Claude ログインを取り直せませんでした",
          detail:
            `Project のコンテナからの Claude の呼び出しが通りません（${reason}）。` +
            "banto は自分でトークンを取り直そうとしましたが、うまくいきませんでした。" +
            "banto を動かしているユーザーで `claude auth login` でログインし直してください。通るようになれば、このカードは自動で閉じます",
        })
        .catch((err: unknown) => console.warn("[host] お知らせを出せませんでした:", err));
    },
    // 通ったら、出していたカードを閉じる
    onUpstreamAuthorized: () => {
      void inbox
        .acknowledgeNoticesByKey("claude-login-upstream-unauthorized")
        .catch((err: unknown) => console.warn("[host] お知らせを閉じられませんでした:", err));
    },
  });
  /**
   * **登録した別のサーバ**（決定・2026-10-08、`docs/specs/v4-security.md` §1「登録と選び方」）。鍵は Vault から使わせてもらう
   * （下の `sshIdentityThroughVault`——関数なので、呼ばれるのは Vault が繋がってから）
   */
  const remoteRuntimes = new RemoteRuntimes({
    dataDir: bootstrap.dataDir,
    store: remoteRuntimeStore,
    startSshAgent: (identity, socketDir) => sshIdentityThroughVault(identity, "startSshAgent", socketDir),
    publicKeyOf: (identity) => sshIdentityThroughVault(identity, "getPublicKey"),
    // 閉じた Project は数えない（閉じたら空く——v4-security.md §1「閉じた Project は数えない」。外すときだけ数える）。
    // 移している途中の Project は、閉じていても移す先として数える（その間に別の Project を作らせない——§1「Project を別の実行場所へ移す」）
    projectsUsing: (rt, opts) =>
      projectThread
        .listProjects()
        .filter((p) => (p.runtime === rt && (p.status !== "closed" || opts?.includeClosed)) || p.move?.to.runtime === rt)
        .map((p) => ({ id: p.id, name: p.name })),
  });
  /**
   * **別のサーバに繋がらないお知らせは、実行場所ごとに1枚**（決定・2026-10-16、v4-architecture.md §2.4 の 3.、
   * `modules/remote-outage.ts`）。3 分続いたら出し、繋がったら閉じる
   */
  const remoteOutageKey = (runtimeName: string) => `remote-unreachable:${runtimeName}`;
  const remoteOutage = new RemoteOutageWatch({
    raise: (n) => {
      const names = n.projectIds.map((id) => `「${projectThread.getProject(id)?.name ?? id}」`).join("");
      console.warn(`[host] 別のサーバ「${n.runtimeName}」に 3 分を超えて繋がりません（Module ${n.modules} 個）: ${n.reason}`);
      void inbox
        .raiseNotice({
          dedupeKey: remoteOutageKey(n.runtimeName),
          title: `${n.runtimeName} に繋げません`,
          detail: `${n.reason}（影響している Project：${names || "なし"}・動けない Module ${n.modules} 個。繋がったら、このお知らせは閉じます）`,
        })
        .catch((err: unknown) => console.warn("[host] お知らせを出せませんでした:", err));
    },
    close: (runtimeName) =>
      void inbox
        .acknowledgeNoticesByKey(remoteOutageKey(runtimeName))
        .catch((err: unknown) => console.warn("[host] お知らせを閉じられませんでした:", err)),
  });
  /**
   * **実行場所の2つ目——別のサーバ**（決定・2026-10-08、Backlog `remote-runtime-ssh`）。Project の記録の `runtime` が
   * `remote:<名前>` の Project は、SSH の接続1本の上で Module を起こす。中から banto へは逆向きのトンネルで、host の
   * 127.0.0.1 の**中継だけを受ける専用の待ち受け**（実行場所ごとに1つ。その実行場所の Project の合言葉だけを受ける）に届く
   */
  const remoteSsh: RemoteSshRuntime = new RemoteSshRuntime({
    dataDir: bootstrap.dataDir,
    monorepoRoot,
    runtimes: remoteRuntimes,
    remoteNameOf: (projectId) => remoteNameOf(projectThread.getProject(projectId)?.runtime),
    createRelayListener: (runtimeName) =>
      createRelayListener({
        relayEndpoint: { handleRequest: (req, res, body, accepts) => relayEndpoint.handleRequest(req, res, body, accepts) },
        claudeLogin,
        acceptsProject: (projectId) => projectThread.getProject(projectId)?.runtime === runtimeIdOf(runtimeName),
        // 本文の上限は core の口と同じ（`RELAY_BODY_MAX_BYTES`）
        readJsonBody: (req) => readJsonBody(req, RELAY_BODY_MAX_BYTES),
      }),
    ...(process.env.BANTO_SHELL_HOME_SOURCE ? { shellHomeSource: process.env.BANTO_SHELL_HOME_SOURCE } : {}),
    notify: async (n) => {
      await inbox.raiseNotice(n);
    },
    onConnected: (runtimeName) => {
      const outMs = remoteOutage.recordConnected(runtimeName);
      if (outMs !== undefined) console.log(`[host] 別のサーバ「${runtimeName}」に繋がりました（${Math.round(outMs / 1000)} 秒 繋がりませんでした）`);
    },
    // 送っている間を画面に出す（Backlog #269）——サイドバーとその Project の会話
    onCodeTransfer: (runtimeName, transfer) =>
      appEvents.publish({ type: "code.transfer", runtime: runtimeName, projectIds: projectsOnRuntime(runtimeName), ...(transfer ? { transfer } : {}) }),
  });
  /** その実行場所で動く Project（記録の `runtime` がそこのもの） */
  const projectsOnRuntime = (runtimeName: string): string[] =>
    projectThread
      .listProjects()
      .filter((p) => p.runtime === runtimeIdOf(runtimeName))
      .map((p) => p.id);
  // 止まるとき、張っている SSH の接続を残さない（親が居なくなっても ssh は自分では終わらない）
  process.on("exit", () => remoteSsh.killAll());
  const runtime: Runtime = new RuntimeRouter(hostRuntime, remoteSsh);
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
  /** 起き直したときの札の判定と切れたターン（下で作る。判定の終わっていない Thread は留める） */
  let recovery: RestartRecovery | undefined;
  /** 別の実行場所へ移す（下で作る。移している途中の Project の Module は、Service を止めておく間だけ起こす） */
  let projectMover: ProjectMover | undefined;
  const deliveries = new ThreadDeliveries({
    projectThread,
    turns: threadTurns,
    notify: async (n) => {
      await inbox.raiseNotice(n);
    },
    // 起こし直しのたびに切れるので自動で続けるのをやめた Thread は、お知らせが開いている間は起こさない（§2.5「上限」）
    // 起こし直したあと、続けられると名乗った Module に続けるかを聞いている間も起こさない（§2.5「2.」）
    hold: (threadId) => recovery?.holdReason(threadId) ?? resumeHoldReason({ projectThread, inbox }, threadId),
    // E2E だけが縮める（眠っている Project に留めた届けものでは起きない、を見る——アーキ仕様 §2.2「起こす」）
    ...(Number(process.env.BANTO_TEST_DELIVERY_WAKES_PER_HOUR) > 0 ? { wakesPerHour: Number(process.env.BANTO_TEST_DELIVERY_WAKES_PER_HOUR) } : {}),
  });
  // **自動化を届ける層**（アーキ仕様 §4.3「判断は届ける口の手前に置く」）。`deliver` の手前で飛ばす・Clear してから届ける
  const automationRunner = new AutomationRunner({
    projectThread,
    automations,
    turns: threadTurns,
    deliveries,
    listJudgmentsForThread: (threadId) => inbox.listJudgmentsForThread(threadId),
    notify: async (n) => {
      await inbox.raiseNotice(n);
    },
    // 乗り換えで閉じた古い Fork を、開いている画面のサイドバーから外す（Backlog #318）
    announceClosed: ({ threadId, projectId, reason }) =>
      appEvents.publish({ type: "thread.closed", threadId, projectId, by: "automation", reason }),
  });
  // **自動化の画面**（v4-frontend.md §6.42）は台帳が変わったら取り直す——どの Project のものかだけ流す
  automations.onChange(({ projectId }) => appEvents.publish({ type: "automations.changed", projectId }));
  // **サイドバーの Project の一覧**（アーキ仕様 §2.2）は一覧が変わったら取り直す——携帯とパソコンでそろえる
  announceProjectsChanged(projectThread, appEvents);
  // **時刻のきっかけ**（アーキ仕様 §4.3「時計」）。1分ごとの刻み1本。刻み始めるのは待ち受けて `resumeAll` したあと
  const automationClock = new AutomationClock({
    automations,
    projectThread,
    runner: automationRunner,
    // 間隔は E2E だけ縮める（BANTO_AUTOMATION_CLOCK_INTERVAL_MS）
    ...(Number(process.env.BANTO_AUTOMATION_CLOCK_INTERVAL_MS) > 0 ? { intervalMs: Number(process.env.BANTO_AUTOMATION_CLOCK_INTERVAL_MS) } : {}),
  });
  // **Webhook のきっかけ**（アーキ仕様 §4.3「Webhook」）。受け口は `/hooks/<印>`。溜まったものを届け始めるのは時計と同じく
  // 待ち受けて `resumeAll` したあと（起き直したら残っている受けたものからまとめ直す）
  const automationWebhooks = new AutomationWebhooks({
    dataDir: bootstrap.dataDir,
    automations,
    runner: automationRunner,
    onTurnEnded: (listener) =>
      threadTurns.onChange((change) => {
        if (change.type === "ended") listener(change.threadId);
      }),
    // **送り元がどの Project のコンテナか**——覚えずに毎回、実行場所に聞く（Claude のログインの中継と同じ）。この機械の
    // 中からの要求（127.0.0.1）はコンテナではない。別のサーバの Project のコンテナは core の口には来ない（専用の待ち受け）
    containerProjectOf: async (remote) => {
      if (remote === "127.0.0.1" || remote === "::1") return undefined;
      const projects = projectThread.listProjects();
      const matches = await Promise.all(projects.map((p) => runtime.sourceMatches(p.id, remote)));
      return projects.find((_, i) => matches[i])?.id;
    },
    // その Project のための呼び出しとして引く——Project のグループと共通の既定にある alias が使える
    resolveSecret: (alias, projectId) => resolveSecretThroughVault(alias, { project: projectId }),
    projectClosed: (projectId) => projectThread.getProject(projectId)?.status === "closed",
  });
  // 受信箱のレビュー待ちに添える tool の数（CLI の会話の記録から数える。追加・2026-10-15、`inbox/review-turn.ts`）
  const reviewToolCounter = new ReviewToolCounter((sessionId, dir) => sdkSessionReader.messages(sessionId, dir), NON_WORK_TOOLS);
  // ターンの始まりに本体が止まったら、何をしていたかを残す（`stall-profiler.ts`、下で用意する）
  let stallProfiler: StallProfiler | undefined;
  threadTurns.onChange((change) => {
    const projectId = projectThread.getThread(change.threadId)?.projectId;
    // 届いたもので起こしたターンはホップ 1 以上、人が送ったターンは 0
    if (change.type === "started") {
      void stallProfiler?.capture(`turn-${change.threadId.slice(0, 8)}`);
      appEvents.publish({ type: "turn.started", threadId: change.threadId, ...(projectId ? { projectId } : {}), cause: change.hop > 0 ? "delivery" : "human" });
    } else {
      appEvents.publish({ type: "turn.ended", threadId: change.threadId, ...(projectId ? { projectId } : {}) });
    }
    // **ターンが終わったら受信箱にレビュー待ち**（決定・2026-09-27、ユーザー。アーキ仕様 §2.4「レビュー待ち」）
    // ——並行で走らせた Thread（AI が立てた Fork など）が終わったことに、見に行かなくても気づけるように。
    // 人がその Thread で送ったら、その Thread のものは「見た」にする（人がそこにいる）。
    // 開いて見ている画面は、自分で「見た」にする（real-inbox.ts）
    // 自動化の届けもので起きたターンもホップ 0 だが、人はそこにいない——前の回のカードを消さない（アーキ仕様 §4.3「受信箱」）
    if (change.type === "started" && acknowledgesReviewsOnStart(projectThread.getThread(change.threadId), change.hop)) {
      void inbox
        .acknowledgeReviewsFor(change.threadId)
        .catch((err: unknown) => console.warn("[host] レビュー待ちを「見た」にできませんでした:", err));
    } else if (change.type === "ended") {
      // **その Thread に裏の仕事も、まだ渡していない届いたものも残っていなければ出す**（改訂・2026-10-15、アーキ仕様 §2.4
      // 「受信箱は『あなたの番になったもの』だけ」）。残っていれば、結果が届いて AI がまとめ終えた最後のターンで出る。
      // 途中で切れた・失敗したターンは残りがあっても出す（`reviewDueAfterTurn`）
      const thread = projectThread.getThread(change.threadId);
      if (!reviewDueAfterTurn(thread)) return;
      // **自動化の回**（アーキ仕様 §4.3「受信箱」）：「出さない」を選んだ自動化の何も無く完了した回は出さない。決めること・
      // 判断待ち・失敗の回は、後の何も無い回で置き換えない
      const plan = thread
        ? planAutomationReview(thread, {
            automation: (id) => automations.get(id),
            hasLiveJudgment: inbox.listJudgmentsForThread(change.threadId).some((j) => j.liveness === "live"),
          })
        : ({ kind: "plain" } as const);
      if (plan.kind === "skip") return;
      const summary = turnEndSummary(thread);
      void (plan.kind === "automation"
        ? inbox.raiseAutomationReview({ threadId: change.threadId, summary, automation: plan.automation })
        : inbox.raiseReview({ threadId: change.threadId, summary })
      ).catch((err: unknown) => console.warn("[host] ターンの終わりを受信箱に出せませんでした:", err));
    }
  });
  inbox.onChange(() => appEvents.publish({ type: "inbox.changed" }));
  inbox.onJudgmentAnswered((item, answer) =>
    appEvents.publish({ type: "judgment.answered", threadId: item.threadId, judgmentId: item.id, answer: judgmentAnswerText(answer, item.choices) }),
  );
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
    opts: { note?: string } = {},
  ): Promise<void> {
    try {
      await deliveries.deliver({
        threadId: reply.threadId,
        from: reply.moduleName,
        title: `${reply.moduleName} の仕事は途中で終わりました`,
        // 別のサーバの Module に繋がらないまま打ち切ったもの（Backlog #324）は、結果の場所と、繋がったら届け直すことを添える
        text: opts.note
          ? `${reply.moduleName} に頼んだ「終わったら届ける」仕事の返事は、いまは届きません——${why}。${opts.note}。`
          : `${reply.moduleName} に頼んだ「終わったら届ける」仕事の返事は、もう届きません——${why}。結果が要るなら、頼み直してください。`,
        hop: reply.hop,
        kind: "banto",
      });
    } catch (err) {
      console.warn(`[host] ${reply.threadId} に「途中で終わりました」を届けられませんでした:`, err);
    } finally {
      replyHandles.settle(reply.replyTo);
      recovery?.noteSettled(reply.replyTo, "lost");
      await projectThread.settleReply(reply.threadId, reply.replyTo).catch(() => {});
      publishBackground(reply.threadId);
    }
  }
  // **起き直したときの片づけ**（アーキ仕様 §2.5「起こし直しをまたいで続ける」、`delivery/restart-recovery.ts`）。
  // 順番：判断待ちの期限切れ（上）→ 返事待ちの札の判定 → 切れたターン → 待ち受け → `resumeAll`。札を渡した Module が
  // 「起こし直しても続けられる」と名乗っていなければ、ここで「途中で終わりました」（Module ごと止まっている）。名乗って
  // いれば札を覚え直し、**待ち受けを始めてから**その Module を起こして続けるかを聞き、その Thread の切れたターンは
  // 答えのあとに片づける（それまでその Thread は留める）。名乗った Module の札を持たない Thread の切れたターンは
  // ここで片づける。続きは届いたものとして積むだけ——起こすのは待ち受けを始めてからの `resumeAll`
  const logTurns = (results: Awaited<ReturnType<RestartRecovery["beforeListen"]>>) => {
    for (const r of results) {
      const t = r.turn;
      console.log(
        `[host] 前の走行で途中で切れたターン: Thread ${t.threadId} ターン ${t.turnId}（${t.startedAt} に始めた・` +
          `${t.cause === "human" ? "人の発言" : "届いたもの"}・続き ${t.attempt} 回目・会話 ${t.sessionId ?? "不明"}` +
          `${t.rewindTo ? `・巻き戻し ${t.rewindTo}` : ""}）→ ` +
          (r.action === "continued"
            ? "続きを届けた"
            : r.action === "closed"
              ? `続けずに閉じた（${r.reason}）`
              : r.action === "stopped-retrying"
                ? "続けて切れたので自動では続けない（続きは積んで留めた・受信箱に出した）"
                : `片づけられなかった（${r.error}）`),
      );
    }
  };
  /** 起動済みの Module。instance のものは key が名前、Project のものは `<名前>-<projectId>`。 */
  const connectedModules = new Map<string, Client>();
  /**
   * **Module 宛ての返事**（追加・2026-10-05、アーキ仕様 §4.2「Module 宛ての返事」）。Module が中継で「終わったら届ける」
   * tool を呼んだときの返事は、呼んだ Module の受け口（`dev.banto/receivesReplies`）に渡す。残してから渡すので、
   * 呼んだ Module が止まっていても次に繋がったときに渡る。**起き直したときの札の判定より前に開く**——前の走行の返事待ちも
   * 判定に乗せる（続けられると名乗った Module に頼んだものは続けるかを問い、ほかは「途中で終わりました」を残す。
   * `delivery/restart-recovery.ts`、2026-10-05）
   */
  const moduleReplies = await ModuleReplies.open({
    file: join(bootstrap.dataDir, "delivery", "module-replies.json"),
    hand: async (toConn: string, args: ModuleReplyArguments) => {
      const client = connectedModules.get(toConn);
      if (!client) throw new Error(`${toConn} は繋がっていません`);
      const { tools } = await client.listTools();
      const receiver = tools.find((t) => receivesReplies(t as { _meta?: Record<string, unknown> }));
      if (!receiver) throw new Error(`${toConn} は返事の受け口（dev.banto/receivesReplies）を名乗っていません`);
      const r = await client.callTool({ name: receiver.name, arguments: { ...args } });
      return r.isError ? "refused" : "handed";
    },
  });
  /** その Module が「起こし直しても続けられる」と名乗っているか（宣言で見る——起こさずに分かる）。札の判定と activity が使う */
  const resumesAfterRestart = ({ moduleName, projectId }: { moduleName: string; projectId?: string }): boolean =>
    loadModuleDeclarations(runtimeConfig, projectId ?? "").find((d) => d.name === moduleName)?.meta.resumesAfterRestart === true;
  recovery = new RestartRecovery({
    projectThread,
    inbox,
    deliveries,
    replyHandles,
    moduleReplies,
    resumable: resumesAfterRestart,
    // 起こして繋ぐ。期限（`signal`）が過ぎたら、繋がっても問いは送らない（`RestartRecovery` が見る）
    connect: async ({ moduleName, connName, projectId }, signal) => {
      const declaration = loadModuleDeclarations(runtimeConfig, projectId ?? "").find((d) => d.name === moduleName);
      if (!declaration) throw new Error(`${moduleName} の宣言が見つかりません`);
      const project = projectId !== undefined ? projectThread.getProject(projectId) : undefined;
      if (declaration.meta.scope === "project" && !project) throw new Error(`${moduleName} を起こす Project が分かりません`);
      const got = await connectDeclaredModule(declaration, declaration.meta.scope === "project" ? project : undefined);
      if (signal.aborted) throw signal.reason;
      // 起きなかった——別のサーバの Module なら、繋がるのを待つ上限まで試し直す（`RestartRecovery`、Backlog #324）
      if (!got) throw new ModuleNotUpYetError(`${moduleName} を起こせませんでした${connectBackoff.failure(connName) ? `（${connectBackoff.failure(connName)!.reason}）` : ""}`);
      if (got !== connName) throw new Error(`${moduleName} の接続（${got}）が札を渡した接続（${connName}）と違います`);
      const client = connectedModules.get(got);
      if (!client) throw new Error(`${moduleName} に繋がっていません`);
      return {
        ask: async (question, askSignal) => {
          // 期限が来たら問いを取り消す（MCP の取り消しが Module に届く）
          const result = (await client.callTool({ name: RESUME_AFTER_RESTART_TOOL, arguments: { ...question } }, undefined, {
            timeout: RESUME_ASK_TIMEOUT_MS,
            signal: askSignal,
          })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
          const text = result.content?.find((c) => c.type === "text")?.text ?? "";
          if (result.isError) throw new Error(`${moduleName} が問いを断りました：${text.slice(0, 300)}`);
          return JSON.parse(text) as unknown;
        },
      };
    },
    deliverLost: deliverLostReply,
    publishBackground,
    // **別のサーバの Module は繋がってから期限を数える**（Backlog #324）
    remoteOf: ({ projectId }) => (projectId !== undefined ? remoteNameOf(projectThread.getProject(projectId)?.runtime) : undefined),
    unreachableReason: (runtimeName) => remoteOutage.unreachableReason(runtimeName),
    isConnected: (connName) => connectedModules.has(connName),
    // E2E だけが縮める（繋がらないまま上限を越えたときを見る）
    ...(Number(process.env.BANTO_RESUME_CONNECT_LIMIT_MS) > 0 ? { connectLimitMs: Number(process.env.BANTO_RESUME_CONNECT_LIMIT_MS) } : {}),
  });
  logTurns(await recovery.beforeListen());

  const registry = new RelayRegistry();
  const relayUrl = `http://127.0.0.1:${bootstrap.port}/relay`;
  // Module からの問い（Elicitation）を、正しいターンへ届けるための宛先表
  // ——1本の接続にハンドラを付け替えると、並行ターンで別の会話に出る（決定・2026-09-10）
  const elicitations = new ElicitationRouter(moduleCalls);
  /**
   * **承認をすべて自動で許可する**（決定・2026-10-05、ユーザー。v4-frontend.md §6.4）。聞くたび・刻むたびに設定を引く
   * ——保存した時点で、走っているターンにも次の承認から効く
   */
  const autoApproveAll = (projectId: string) => isAutoApproveAll(runtimeConfig, projectId);
  const agentRelayEndpoint = new AgentRelayEndpoint(bootstrap.authToken, {
    onRelay: (r) => console.log("[agent-relay]", JSON.stringify(r)),
    // Module は設定を知らない——人を待つもの（Publish）のために、呼び出しに刻む
    autoApproveFor: autoApproveAll,
    moduleCalls,
    elicitations,
    // **返信用の札**（決定・2026-09-25）。ホップ数は、札を出したターンのもの（人が送ったターン＝0）
    replies: {
      issue: (input) => replyHandles.issue({ ...input, hop: threadTurns.hopOf(input.threadId) ?? 0 }),
      markAwaiting: async (replyTo, waitingOn, resultLocation) => {
        const h = replyHandles.markAwaiting(replyTo, waitingOn, resultLocation);
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

  /**
   * **Shell 専用のホーム**（接続名 → 写し直す口）。写すものの一覧を人が変えたら、立っている
   * Shell のホームにも写し直す——コマンドは毎回新しく起こすので、再起動は要らない。
   * 写すのは実行場所（`PreparedPlace.prepareShellHome`）——host は Module の置き場に直接書かない
   */
  const shellHomes = new Map<string, (files: readonly string[]) => Promise<ShellHomeSync>>();
  let lastShellHomeSync: ShellHomeSync | undefined;
  /** banto 本体で起こす Module の Shell のホーム（host の置き場にそのまま写す） */
  async function hostShellHome(moduleDataDir: string, files: readonly string[]) {
    const home = join(moduleDataDir, "home");
    const sourceHome = process.env.BANTO_SHELL_HOME_SOURCE || undefined;
    const resync = (f: readonly string[]) => syncShellHome(home, f, { sourceHome });
    return { home, sync: await resync(files), resync };
  }
  async function resyncShellHomes(): Promise<ShellHomeSync | undefined> {
    for (const resync of shellHomes.values()) {
      lastShellHomeSync = await resync(shellHomeFiles(runtimeConfig));
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

  /** 中で Docker を使うか（Project ごとの設定）。入れ子を許したコンテナだけ `/proc`・`/sys` の保護が外れる */
  const projectNesting = (projectId: string) => runtimeConfig.resolve(CONTAINER_NESTING_KEY, projectId) === true;

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
   * **名指しで畳んだ回数**（接続ごと、追加・2026-10-16、アーキ仕様 §2.2「Module を名指しで外せる形に分ける」）。名指しで
   * 外すときは Project の数（上）を増やさない——残す Module の起動を「畳まれた」と巻き込まない
   */
  const connectionReleases = new Map<string, number>();

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
  // **banto 本体の止まり具合を測る**（決定・2026-10-09、v4-architecture.md §5.4-0）——本体が止まっていた間の
  // ping の時間切れを Module のせいにしない。1 秒以上止まったらログに残す
  const hostStall = new HostStallMeter(undefined, (s) =>
    console.warn(`[host] 本体が ${(s.ms / 1000).toFixed(1)} 秒止まっていました`),
  );
  hostStall.start();
  stallProfiler = new StallProfiler({
    dir: join(bootstrap.dataDir, "profiles"),
    stalledBetween: (from, to) => hostStall.stalledBetween(from, to),
  });
  // **資源の逼迫を見せる**（決定・2026-10-09、v4-security.md §1、`resources.ts`）。host がコンテナの cgroup のファイルを
  // 直接読む（incus exec を通さない）。10 秒ごと。混んでいる Project が変わったら画面に知らせる
  const resourceWatch = new ResourceWatch({
    incusProject: () => runtime.resourceScope(),
    // 別のサーバ（2026-10-14）。繋いでいる実行場所だけ読み、その実行場所で動く閉じていない Project を添える
    remotes: async () => {
      const probes = await remoteSsh.readResources();
      // 眠っている Project は向こうでも測らない（`sleeping` に出る）
      const open = projectThread.listProjects().filter((p) => p.status !== "closed" && !p.sleep);
      return probes.map((probe) => ({
        ...probe,
        projects: open.filter((p) => remoteNameOf(p.runtime) === probe.runtime).map((p) => ({ projectId: p.id, name: p.name })),
      }));
    },
    cores: availableParallelism(),
    sleeping: () =>
      projectThread
        .listProjects()
        .filter((p) => p.status !== "closed" && p.sleep)
        .map((p) => ({ projectId: p.id, name: p.name })),
    selfBytes: () => process.memoryUsage().rss,
    stalls: () => hostStall.recent(100),
  });
  const liveness = new LivenessMonitor(
    LIVENESS,
    (connName, client, reason) => {
      const origin = connectionOrigins.get(connName);
      if (origin) void moduleLost(connName, client as Client, origin, reason);
    },
    hostStall,
    (connName, stalledMs, elapsedMs) =>
      console.warn(
        `[host] ${connName} の ping が時間切れでしたが、その間 本体が ${(stalledMs / 1000).toFixed(1)} 秒止まっていたので数えません（待った ${(elapsedMs / 1000).toFixed(1)} 秒）。もう一度確かめます`,
      ),
  );

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
    if (origin.containerId) runtime.forget(origin.containerId);
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
    // **別の実行場所へ移している間は起こさない**（写している元の置き場に書かせない）。Service を止めておく間だけは起こす
    if (declaration.meta.scope === "project" && forProject && projectThread.getProject(forProject.id)?.move) {
      if (!projectMover?.allowsModuleStart(forProject.id)) {
        console.log(`[host] ${connName} は起こしません（Project を別の実行場所へ移しています）`);
        return undefined;
      }
    }
    // **眠っている Project の Module は起こさない**（決定・2026-10-16、アーキ仕様 §2.2「それ以外の道では起こさない」）
    // ——設定の画面・Skills の一覧・入口の一覧を開いただけでコンテナが起きる、を作らない。起こすのは `projectSleep.wake`
    // （`modules/prepare` と `openTurn`）だけで、起きれば `sleep` が外れてここを通る
    if (declaration.meta.scope === "project" && forProject && projectThread.getProject(forProject.id)?.sleep) {
      console.log(`[host] ${connName} は起こしません（Project が眠っています）`);
      return undefined;
    }
    const fingerprint = declarationFingerprint(declaration);
    if (connectBackoff.blocked(connName, fingerprint) !== undefined) return undefined;

    const releaseProjectId = declaration.meta.scope === "project" ? forProject?.id : undefined;
    const releasesAtStart = releaseProjectId ? (projectReleases.get(releaseProjectId) ?? 0) : 0;
    const connReleasesAtStart = connectionReleases.get(connName) ?? 0;
    const releasedMeanwhile = () =>
      releaseProjectId !== undefined &&
      ((projectReleases.get(releaseProjectId) ?? 0) !== releasesAtStart || (connectionReleases.get(connName) ?? 0) !== connReleasesAtStart);
    // この試みを始めた時刻——同じ失敗を待っていた数だけ数えないため（ConnectBackoff.recordFailure、Backlog #370）
    const attemptStartedAt = Date.now();
    try {
      const connected = await spawnDeclaredModule(declaration, forProject);
      if (releasedMeanwhile()) {
        // 起動している間に Project が畳まれた——いま繋がったものも畳む（閉じた・眠ったままならコンテナも止める）
        console.log(`[host] ${connName} は起動中に Project が畳まれたので、繋がったものを畳みます`);
        const now = projectThread.getProject(releaseProjectId!);
        const stillDown = now?.status === "closed" || now?.sleep !== undefined;
        await releaseProjectModules(releaseProjectId!, { stopContainer: stillDown });
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
      // **別のサーバに SSH で繋がらないなら、Module ごとには知らせない**（決定・2026-10-16、§2.4 の 3.）——実行場所ごとの
      // 見張りに渡し、3 分続いたらそちらが1枚出す。繋がっていて Module だけ起きないとき・この機械のコンテナは今どおり
      const unreachableRuntime =
        declaration.meta.scope === "project" && forProject && isRemoteUnreachable(err)
          ? remoteNameOf(projectThread.getProject(forProject.id)?.runtime)
          : undefined;
      const notify = connectBackoff.recordFailure(connName, fingerprint, reason, {
        quiet: unreachableRuntime !== undefined,
        attemptStartedAt,
      });
      if (unreachableRuntime) remoteOutage.recordUnreachable(unreachableRuntime, connName, forProject?.id, reason);
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

  /**
   * **別のサーバに繋ぐ鍵を、Vault から使わせてもらう**（決定・2026-10-08、v4-security.md §1「向こうとの道」）。
   * core が自分のために頼む（`resolveSecretPlaceholders` と同じく承認を聞かない——人が実行場所に登録した鍵だけ）。
   * 刻印は banto 全体（共通の秘密だけ）。値（秘密鍵）は返らない：公開鍵と、鍵を持った ssh-agent の窓口だけ
   */
  async function sshIdentityThroughVault(
    alias: string,
    tool: "getPublicKey" | "startSshAgent",
    socketDir?: string,
  ): Promise<string> {
    // **窓口は繋がっている Vault だけを探す**——起き直したばかりで Vault がまだ繋がっていないと、在る鍵が「どの Vault にも
    // ありません」に化ける（移している途中で落ちた Project の片づけが、起き直した 12ms 後に踏んだ。E2E runtime-move、2026-10-11）
    await Promise.all(
      loadModuleDeclarations(runtimeConfig, "")
        .filter((d) => d.meta.scope === "instance" && d.meta.satisfies.includes("vault"))
        .map((d) => connectDeclaredModule(d)),
    );
    const directory = await ensureVaultDirectory();
    if (!directory) throw new Error("Vault の窓口が繋がっていません");
    const caller = { instance: true as const };
    const endDirectoryCall = moduleCalls.begin("vault-directory", undefined, "host", undefined, true);
    let found: { implementation?: string; name?: string; group?: string; kind?: string };
    try {
      found = JSON.parse(
        ((
          await directory.callTool({ name: "lookupAlias", arguments: { name: alias }, _meta: { [CALLER_META_KEY]: caller } })
        ).content as { text: string }[])[0]!.text,
      ) as typeof found;
    } finally {
      endDirectoryCall();
    }
    if (!found.implementation || !found.name) throw new Error(`"${alias}" の在りかが分かりません`);
    const backend = connectedModules.get(found.implementation);
    if (!backend) throw new Error(`${found.implementation} が繋がっていません`);
    const result = await backend.callTool({
      name: tool,
      arguments:
        tool === "getPublicKey"
          ? { name: found.name, ...(found.group ? { group: found.group } : {}) }
          : { identity: found.name, ...(found.group ? { group: found.group } : {}) },
      _meta: { [CALLER_META_KEY]: caller, ...(socketDir ? { [SOCKET_DIR_META_KEY]: socketDir } : {}) },
    });
    const text = (result.content as { text?: string }[])[0]?.text ?? "";
    if (result.isError) throw new Error(text || `${found.implementation} の ${tool} が失敗しました`);
    await relayGrants.recordCall(
      {
        projectId: undefined,
        callerModule: "banto",
        targetModule: found.implementation,
        kind: "tool",
        name: tool,
        identifiers: { name: alias },
      },
      { allowed: true, reason: "別のサーバに繋ぐ鍵（実行場所）" },
    );
    if (tool === "getPublicKey") return text;
    const socketPath = (JSON.parse(text) as { socketPath?: unknown }).socketPath;
    if (typeof socketPath !== "string" || socketPath === "") throw new Error(`SSH 鍵 ${alias} の ssh-agent の窓口が返ってきませんでした`);
    return socketPath;
  }

  /** 実行場所の登録の画面で選べる SSH 鍵（banto 全体から使える ssh-identity の alias の名前） */
  async function sshIdentitiesThroughVault(): Promise<string[]> {
    const directory = await ensureVaultDirectory();
    if (!directory) throw new Error("Vault の窓口が繋がっていません");
    const endDirectoryCall = moduleCalls.begin("vault-directory", undefined, "host", undefined, true);
    try {
      const body = JSON.parse(
        ((
          await directory.callTool({ name: "listAliases", arguments: {}, _meta: { [CALLER_META_KEY]: { instance: true } } })
        ).content as { text: string }[])[0]!.text,
      ) as { aliases?: Array<{ name?: unknown; kind?: unknown; scope?: unknown }> };
      const names = (body.aliases ?? [])
        .filter((a) => a.kind === "ssh-identity" && a.scope === "shared" && typeof a.name === "string")
        .map((a) => a.name as string);
      return [...new Set(names)].sort();
    } finally {
      endDirectoryCall();
    }
  }

  /**
   * **その Project から使える秘密の alias の名前**（自動化の Webhook の署名の鍵の選び先、v4-frontend.md §6.42）。共通の
   * グループのものと、その Project に紐付いたもの。値は通らない
   */
  async function secretAliasesFor(projectId: string): Promise<string[]> {
    const directory = await ensureVaultDirectory();
    if (!directory) throw new Error("Vault の窓口が繋がっていません");
    const endDirectoryCall = moduleCalls.begin("vault-directory", undefined, "host", undefined, true);
    try {
      const listed = await directory.callTool({ name: "listAliases", arguments: {}, _meta: { [CALLER_META_KEY]: { instance: true } } });
      const text = (listed.content as { text: string }[])[0]?.text ?? "";
      if (listed.isError) throw new Error(text || "Vault の alias の一覧を読めませんでした");
      const body = JSON.parse(text) as { aliases?: Array<{ name?: unknown; kind?: unknown; scope?: unknown; projects?: unknown }> };
      const names = (body.aliases ?? [])
        .filter(
          (a) =>
            a.kind === "secret" &&
            typeof a.name === "string" &&
            (a.scope === "shared" || (a.scope === "project" && Array.isArray(a.projects) && a.projects.includes(projectId))),
        )
        .map((a) => a.name as string);
      return [...new Set(names)].sort();
    } finally {
      endDirectoryCall();
    }
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
      const looked = await directory.callTool({ name: "lookupAlias", arguments: { name: alias }, _meta: meta });
      const lookedText = (looked.content as { text: string }[])[0]?.text ?? "";
      // 窓口が断った理由（「どの Vault にもありません」等）をそのまま返す——JSON として読むと理由が構文の誤りに化ける
      // （追加・2026-10-15、自動化の Webhook の署名の鍵で人の画面に出るようになった）
      if (looked.isError) throw new Error(lookedText || `"${alias}" の在りかを引けませんでした`);
      found = JSON.parse(lookedText) as { implementation?: string; name?: string; group?: string };
    } finally {
      endDirectoryCall();
    }
    if (!found.implementation || !found.name) throw new Error(`"${alias}" の在りかが分かりません`);
    const backend = connectedModules.get(found.implementation);
    if (!backend) throw new Error(`${found.implementation} が繋がっていません`);
    const resolved = await backend.callTool({
      name: "resolveAlias",
      arguments: { name: found.name, group: found.group },
      _meta: meta,
    });
    const text = (resolved.content as { text: string }[])[0]?.text;
    if (resolved.isError) throw new Error(text || `"${alias}" の値を受け取れませんでした`);
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
    //   同梱の banto 全体の Module のうち道具用のコンテナを名乗るもの → 同梱の道具用のコンテナ（追加・2026-10-15。中で sudo
    //     できず、名乗った apt のパッケージを入れてから起こす）
    //   同梱の banto 全体の Module → banto 本体
    // 中からは host の 127.0.0.1 に届かないので、中継の住所はブリッジの host 側にする（host は 0.0.0.0 で待ち受けている）
    const where = modulePlacement(declaration.meta, declaration.launch);
    const place: RuntimePlace | undefined =
      where === "project-container" && project
        ? { id: project.id, root: project.root, nesting: projectNesting(project.id) }
        : where === "instance-container"
          ? { id: runtime.instancePlaceId, nesting: false }
          : where === "tools-container"
            ? { id: runtime.toolsPlaceId, nesting: false, tools: { aptPackages: declaration.meta.toolsContainer?.aptPackages ?? [] } }
            : undefined;
    // **繋がるまでにどこで時間を使ったかを、繋がった行に添える**（追加・2026-09-26）——新しい Project を
    // 開くのが遅いとき、手元でプローブを書かずに `~/banto-host.log` で内訳が分かるように（規則4）
    const started = performance.now();
    const phases: string[] = [];
    const mark = (what: string, since: number) => phases.push(`${what} ${Math.round(performance.now() - since)}ms`);
    const prepared: PreparedPlace | undefined = place ? await runtime.prepare(place) : undefined;
    if (prepared) mark("コンテナ", started);
    // Module の置き場（host の側のパス）。Module ごとに1つ。**その Module の分だけ**書けるようにする（決定・2026-09-07）
    const moduleDataDir = join(bootstrap.dataDir, "modules", connName);
    // **プログラムの置き場は、状態の置き場と分ける**（追加・2026-09-21）。
    // registry から取ってきたものがここに入り、起動時は**読み取り専用**で渡す
    // **宣言の名前で引く**（プロセス名 `<名前>-<projectId>` ではない）
    // ——入れるときも同じ名前で置いている（`install/paths.ts`、規則3）
    const modulePackageDir = modulePackageDirOf(bootstrap.dataDir, declaration.name);
    const token = registry.issueToken({
      moduleName: declaration.name,
      connName,
      projectId: project?.id,
      meta: declaration.meta,
      // 中では AI がこの合言葉も読める——値を返す口への承認を、何を指していたかごとに分ける
      ...(prepared ? { inContainer: true } : {}),
      // **身元は「道具用のコンテナ」と刻む**（追加・2026-10-15）。コンテナの中なので「banto 本体で動く」線（`mayRaiseNotice` 等）
      // には入らない
      ...(where === "tools-container" ? { toolsContainer: true } : {}),
      // **鍵の窓口を立てる場所**（追加・2026-09-27）。host の Vault がここに立てた ssh-agent に、中の Module が届く
      ...(prepared ? { socketDir: prepared.socketDirFor(moduleDataDir) } : {}),
      // 別のサーバでは、Vault が立てた窓口を向こうへ転送してから返す
      ...(prepared?.socketPathInside ? { socketPathInside: prepared.socketPathInside.bind(prepared) } : {}),
    });
    // **差し込み語は実行場所の側のパスで組み立てる**（`docs/specs/v4-security.md` §1「実行場所は core の中の差し替え口」）
    // ——Module の宣言・Module のコードは実行場所を知らない
    const inside = (hostPath: string) => (prepared ? prepared.pathInside(hostPath) : hostPath);
    const context: LaunchContext = {
      ...launchContextBase,
      ...(prepared
        ? {
            nodeExec: prepared.nodePath,
            monorepoRoot: inside(monorepoRoot),
            dataDir: inside(bootstrap.dataDir),
            hostRelayUrl: `${prepared.bantoOrigin}/relay`,
          }
        : {}),
      hostRelayToken: token,
      projectRoot: project ? inside(project.root) : undefined,
      moduleDataDir: inside(moduleDataDir),
      modulePackageDir: inside(modulePackageDir),
    };
    // **中に見せる置き場は、先に頼んでおく**（改訂・2026-09-26、実測）——下の Shell のホームの用意や
    // 金庫の語の解決を待ってから頼むと、並んで起きる他の Module のマウントの束に乗り遅れ、
    // 自分の分だけもう1回待つことになっていた。起こす直前に揃っていればよい
    const mounting = performance.now();
    const mounted = prepared?.prepareModuleDirs({ dataDir: moduleDataDir, packageDir: modulePackageDir });
    if (!prepared) mkdirSync(moduleDataDir, { recursive: true, mode: 0o700 });
    // 待たずに進むあいだに失敗しても、下で待つまで「誰も読まない拒否」にしない
    mounted?.catch(() => undefined);
    // **Shell 専用のホーム**（決定・2026-09-23、ユーザー）。人のホームは閉じ込めで
    // 読めないので、Project ごとに書けるホームを用意し、人が選んだ設定だけを写す。
    // `shell` は同梱だけが名乗れる役割（RESERVED_ROLES）——**第三者の Module に
    // 人の git の設定を渡さない**。写すのは実行場所（banto 本体で起こすなら host の置き場にそのまま）。
    // 人が打つ Terminal（v4-modules.md §4.6）も同じ形のホームを持つが、`terminal` は予約していないので、
    // 同梱のコードであること（origin）で見る
    let shellHome: string | undefined;
    const satisfies = declaration.meta.satisfies as string[];
    const wantsShellHome =
      satisfies.includes("shell") || (satisfies.includes("terminal") && declaration.meta.origin === "bundled");
    if (wantsShellHome && declaration.meta.confinement) {
      const prep = prepared
        ? await prepared.prepareShellHome(moduleDataDir, shellHomeFiles(runtimeConfig))
        : await hostShellHome(moduleDataDir, shellHomeFiles(runtimeConfig));
      shellHome = prep.home;
      shellHomes.set(connName, prep.resync);
      lastShellHomeSync = prep.sync;
      if (prep.sync.removedGitKeys.length > 0 || prep.sync.rewrittenGitKeys.length > 0) {
        console.log(
          `[host] ${connName}: Shell のホームへ写した git の設定から外したもの ${JSON.stringify(prep.sync.removedGitKeys)}` +
            `・向け直したもの ${JSON.stringify(prep.sync.rewrittenGitKeys)}`,
        );
      }
    }
    // **金庫の語を先に解く**（追加・2026-09-16）。値はここで初めて現れ、
    // env として子プロセスへ渡るだけ——**記録に残るのは名前だけ**
    const withSecrets = await resolveSecretPlaceholders(declaration, project?.id);
    // ここへ来るのは起動する形だけ（URL に繋ぐ形は上で分かれている）
    const launch = expandLaunch(withSecrets, context) as StdioLaunch;

    // **実行場所の中で起こす**。閉じ込めはその箱そのもの。中に見せるのは Project の根（作るときに）・
    // banto のコード（読み取り専用、作るときに）・この Module の置き場・取ってきた配布物（読み取り専用）だけ。
    // **host の環境は渡さない**（渡すのは下の一覧だけ）
    if (prepared) {
      await mounted;
      mark("マウント", mounting);
      const passthrough = Object.fromEntries(
        containerEnvPassthrough.flatMap((name) => (process.env[name] !== undefined ? [[name, process.env[name]!]] : [])),
      );
      const spawned = prepared.processCommand({
        name: connName,
        command: launch.command,
        args: launch.args,
        cwd: context.projectRoot ?? context.moduleDataDir,
        // 変換役は中の root で囲いを起こす（`meta.toolsContainer.runAsRoot`、道具用の箱だけが受ける）
        ...(where === "tools-container" && declaration.meta.toolsContainer?.runAsRoot ? { asRoot: true as const } : {}),
        env: {
          ...passthrough,
          HOME: context.moduleDataDir,
          // 箱の中で動いていることを Module に知らせる（Shell の説明の言い方が変わる）
          BANTO_IN_CONTAINER: "1",
          // 箱ごとに足すもの（別のサーバ：sudo しない印）
          ...prepared.moduleEnv,
          // **Claude のログイン**（決定・2026-09-27）：中継の住所とその Project の合言葉・契約の種類。Shell の子・
          // サブエージェント・Service はこれをそのまま使う。Project 設定で切られていれば入れない
          ...(where === "project-container" && project ? await claudeLogin.envFor(project.id, prepared.bantoOrigin) : undefined),
          BANTO_MODULE_DATA_DIR: context.moduleDataDir,
          // **自分の宣言上の名前**（追加・2026-09-15）。同じ実装を2本以上立てることがある——Module 自身が
          // 「自分はどの1本か」を知らないと、画面に同じ名前が並ぶ。host が必ず渡す
          BANTO_MODULE_NAME: declaration.name,
          ...(shellHome ? { BANTO_SHELL_HOME: shellHome } : {}),
          ...launch.env,
        },
      });
      // 起こす役（`incus` など）自身は host で動く——host の環境（Incus の設定の置き場など）はこちらに渡す
      const connecting = performance.now();
      const client = await connectStdioModule(spawned.command, spawned.args, undefined, process.env, spawned.transport);
      mark("起動と接続", connecting);
      return finishModuleConnection(declaration, connName, project, client, token, forProject, { started, phases }, place?.id);
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
      // 宛先が同梱の道具用のコンテナで動くか（中継の承認の線、`statelessTransform`）。置き場は host が導いたもの
      ...(modulePlacement(declaration.meta, declaration.launch) === "tools-container" ? { toolsContainer: true as const } : {}),
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
        // Module 宛ての札は下の `loseFrom` が呼んだ Module に知らせる
        if (h.toModule) {
          replyHandles.settle(replyTo);
          recovery?.noteSettled(replyTo, "lost");
          continue;
        }
        void deliverLostReply({ threadId: h.threadId, replyTo, moduleName: h.moduleName, hop: h.hop + 1 }, "Module が止まったため");
      }
      void moduleReplies
        .loseFrom(connName, "頼んだ先の Module が止まったため")
        .catch((err: unknown) => console.warn(`[host] ${connName} からの返事待ちを片づけられませんでした:`, err));
      void moduleLost(connName, client, origin, "接続が閉じました");
    };
    // **閉じずに黙ることもある**——定期的に確かめる（`liveness.ts`）
    liveness.watch(connName, client);
    if (token !== undefined) moduleTokens.set(connName, token);
    // **この Module 宛ての返事が残っていれば渡す**（追加・2026-10-05）——止まっている間に届いたもの・前の走行の「途中で終わりました」
    void moduleReplies.handPending(connName).catch(() => undefined);
    // **起こし直しで打ち切った札があれば、届け直させる**（追加・2026-10-16、Backlog #324）
    recovery?.moduleConnected(connName);
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
  async function releaseProjectModules(
    projectId: string,
    opts: {
      stopContainer?: boolean;
      /**
       * **外す Module を名指しする**（宣言の名前、追加・2026-10-16、アーキ仕様 §2.2「Module を名指しで外せる形に分ける」）。
       * 無ければ全部。名指ししたときは、ほかの Module・その起こし直しの待ち・起動の途中のものを巻き込まない
       */
      only?: readonly string[];
    } = {},
  ): Promise<string[]> {
    const picked = opts.only ? new Set(opts.only.map((name) => `${name}-${projectId}`)) : undefined;
    // 起動の途中のものに「畳まれた」と分かるようにする（上の `projectReleases`・`connectionReleases`、終わった側が自分で片づける）
    if (picked) for (const connName of picked) connectionReleases.set(connName, (connectionReleases.get(connName) ?? 0) + 1);
    else projectReleases.set(projectId, (projectReleases.get(projectId) ?? 0) + 1);
    const all = projectConnections.get(projectId) ?? new Set<string>();
    const names = [...all].filter((c) => !picked || picked.has(c));
    if (picked) for (const c of names) all.delete(c);
    else projectConnections.delete(projectId);
    // 止まって起こし直しを待っているものも、もう起こさない
    for (const [connName, pending] of [...pendingRestarts]) {
      if (pending.origin.projectId === projectId && (!picked || picked.has(connName))) cancelRestart(connName);
    }
    // **先に全部を台帳から外し、それから落とす**（改訂・2026-10-09）。以前は1つずつ「外す→落とす」だったので、頼んだ先
    // （subagent 等）を落とした瞬間の「途中で終わりました」が、**まだ台帳に残っている同じ Project の呼んだ Module**（この
    // あと落とすもの）に渡り、そのプロセスごと消えていた——畳む順番しだいで、次に立ったプロセスに届かない（E2E
    // subagent-from-module:153 がたまに落ちていた）。全部を先に外せば、渡せずに残り（`module-replies.ts` の「残してから渡す」）、
    // 次に繋がったときに渡る
    const clients: Array<[string, Client | undefined]> = [];
    for (const connName of names) {
      clients.push([connName, connectedModules.get(connName)]);
      connectedModules.delete(connName);
      connectionOrigins.delete(connName);
      liveness.unwatch(connName);
      connectBackoff.clear(connName);
      retriedAfterSelfReport.delete(connName);
      registry.unregisterModule(connName); // 合言葉もここで失効する
      moduleTokens.delete(connName);
      shellHomes.delete(connName);
      await agentRelayEndpoint.unregisterModule(connName);
    }
    // **プロセスを落とすのは最後**（先に台帳から外しておけば、落とす途中に
    // 来た要求が死にかけの接続を掴まない）
    for (const [connName, client] of clients) {
      await client?.close().catch((err: unknown) => {
        console.warn(`[host] ${connName} を畳むときに例外:`, err);
      });
    }
    if (names.length > 0) console.log(`[host] project ${projectId} を畳んだ: ${names.join(", ")}`);
    // 名指しで外して、コンテナは止めない——残した Module はそのコンテナで動き続ける（用意したことを忘れない）
    if (picked && opts.stopContainer !== true) return names;
    // **Project を畳んだらコンテナも止める**（決定・2026-09-25）。止めるのは待ちすぎない（上限→強制停止）。
    // 止められなくても畳むこと自体は済んでいるので、畳む操作は失敗させない——ただし**黙らない**：
    // 動いたまま残ったことを受信箱で言う（規則2）
    await runtime.release(projectId, { stop: opts.stopContainer === true }).catch(async (err: unknown) => {
      if (!(err instanceof RuntimeStopError)) throw err;
      console.warn(`[host] project ${projectId} のコンテナ ${err.placeName} を止められませんでした: ${err.reason}`);
      await inbox.raiseNotice({
        projectId,
        dedupeKey: `container-stop:${projectId}`,
        title: "Project のコンテナを止められませんでした",
        detail: `${err.placeName} が動いたまま残っています：${err.reason}`,
      });
    });
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
  function instanceModuleStatus(): Array<{ name: string; connected: boolean; error?: string; toolsInstall?: ToolsInstallView }> {
    const tools = runtime.toolsInstallStatus();
    const declarations = loadModuleDeclarations(runtimeConfig, "");
    return listInstanceModules(runtimeConfig).map((m) => {
      const failure = connectBackoff.failure(m.name);
      const toolsInstall = m.placement === "tools-container" ? toolsInstallOf(declarations.find((d) => d.name === m.name), tools) : undefined;
      return {
        ...(toolsInstall ? { toolsInstall } : {}),
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

  /** 道具用のコンテナで動く Module の、名乗ったパッケージを入れているか・入れられなかったか */
  function toolsInstallOf(declaration: ParsedModuleDeclaration | undefined, tools: ToolsInstallStatus): ToolsInstallView | undefined {
    if (!declaration) return undefined;
    // 「入れ直す」を押してから起き終わるまで（コンテナの用意を含む）は「入れています」
    if (toolsRetrying.has(declaration.name)) return { state: "installing" };
    const want = new Set(declaration.meta.toolsContainer?.aptPackages ?? []);
    if (want.size === 0) return undefined;
    const failed = tools.failures.find((f) => f.packages.some((p) => want.has(p)));
    if (failed) return { state: "failed", reason: failed.reason };
    if (tools.installing?.some((p) => want.has(p))) return { state: "installing" };
    return undefined;
  }
  /** 「入れ直す」を押されて、起こし直している Module */
  const toolsRetrying = new Set<string>();

  /** 使うときに起こしている途中の、道具用のコンテナの Module（名前 → 起こしている約束） */
  const onDemandStarts = new Map<string, Promise<string | undefined>>();
  /**
   * **道具用のコンテナの Module を、中継で初めて呼ばれたときに起こす**（追加・2026-10-15、`v4-modules.md` §2.2「変換役」）。
   * 初回はコンテナを作って LibreOffice 等を入れる（数分）ので、呼び元を待たせ続けない——少し待って繋がらなければ
   * 「入れています／起こしています」（`TOOLS_PREPARING_MARKER`）で断り、起こすのは続ける。呼び元はあとで呼び直す。
   * 呼び元の依存に無い宛先・道具用のコンテナの Module でない宛先は起こさない（中継の確かめがいつもどおり断る）
   */
  function onDemandDeclarations(caller: CallerIdentity): ParsedModuleDeclaration[] {
    return loadModuleDeclarations(runtimeConfig, "").filter(
      (d) =>
        d.meta.scope === "instance" &&
        modulePlacement(d.meta, d.launch) === "tools-container" &&
        caller.meta.dependsOn.some((dep) => d.meta.satisfies.includes(dep.role)),
    );
  }
  function onDemandTargets(caller: CallerIdentity): Array<{ name: string; roles: string[] }> {
    const roles = new Set(caller.meta.dependsOn.map((d) => d.role));
    return onDemandDeclarations(caller).map((d) => ({ name: d.name, roles: d.meta.satisfies.filter((r) => roles.has(r)) }));
  }
  async function connectToolsModuleOnDemand(caller: CallerIdentity, targetModule: string): Promise<void> {
    const declaration = onDemandDeclarations(caller).find((d) => d.name === targetModule);
    if (!declaration) return;
    let starting = onDemandStarts.get(targetModule);
    if (!starting) {
      starting = connectDeclaredModule(declaration).finally(() => onDemandStarts.delete(targetModule));
      onDemandStarts.set(targetModule, starting);
    }
    let settled: { connName: string | undefined; error?: string } | undefined;
    void starting.then(
      (connName) => (settled = { connName }),
      (err: unknown) => (settled = { connName: undefined, error: err instanceof Error ? err.message : String(err) }),
    );
    const deadline = Date.now() + ON_DEMAND_START_WAIT_MS;
    while (!settled && Date.now() < deadline) {
      // 入れ始めたら待たない（数分かかる）
      if (toolsInstallOf(declaration, runtime.toolsInstallStatus())?.state === "installing") break;
      await sleep(ON_DEMAND_POLL_MS);
    }
    if (settled?.connName) return;
    if (settled) {
      const reason = settled.error ?? connectBackoff.failure(targetModule)?.reason ?? "理由は host のログにあります";
      throw new Error(`${targetModule} を起こせませんでした：${reason}`);
    }
    const installing = toolsInstallOf(declaration, runtime.toolsInstallStatus())?.state === "installing";
    throw new Error(
      `${TOOLS_PREPARING_MARKER} ${installing ? `${targetModule} に要る道具を入れています（初回だけ、数分）` : `${targetModule} を起こしています`}。` +
        "あとでもう一度呼んでください",
    );
  }

  /**
   * **道具を入れ直す**（追加・2026-10-15）。入れられなかったことを忘れ、繋ぎ直しの待ちも消して、その Module を起こし直す
   * （入れ終わるのは待たない——数分かかる。画面は「入れています」を出す）
   */
  async function retryToolsInstall(name: string): Promise<void> {
    const declaration = loadModuleDeclarations(runtimeConfig, "").find((d) => d.name === name);
    if (!declaration) throw new Error(`知らない Module です（有効になっていません）: ${name}`);
    if (modulePlacement(declaration.meta, declaration.launch) !== "tools-container") {
      throw new Error(`${name} は道具用のコンテナで動く Module ではありません`);
    }
    runtime.retryToolsInstall();
    connectBackoff.clear(name);
    toolsRetrying.add(name);
    void connectDeclaredModule(declaration)
      .catch((err: unknown) => {
        console.warn(`[host] ${name} を起こし直せませんでした:`, err);
      })
      .finally(() => toolsRetrying.delete(name));
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

  /** 道具用のコンテナで動く banto 全体の Module（使うとき——中継で呼ばれたとき・名指されたとき——だけ起こす） */
  function startsOnDemand(declaration: ParsedModuleDeclaration): boolean {
    return declaration.meta.scope === "instance" && modulePlacement(declaration.meta, declaration.launch) === "tools-container";
  }
  /** 起こさずに、いま繋がっていればその名前（banto 全体の Module はプロセスの名前＝宣言の名前） */
  function connectedNameIfAny(declaration: ParsedModuleDeclaration): string | undefined {
    return connectedModules.has(declaration.name) ? declaration.name : undefined;
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
        // **道具用のコンテナの Module は、使うとき（中継で呼ばれたとき）に起こす**——会話を始めるたびに起こすと、初めての
        // banto で LibreOffice 等を入れる数分のあいだ会話が始まらない（2026-10-15、E2E で発覚）。繋がっていれば使う
        const connName = startsOnDemand(declaration) ? connectedNameIfAny(declaration) : await connectDeclaredModule(declaration, project);
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
        // 道具用のコンテナの Module は使うときに起こす（上の resolveModulesForThread と同じ。入口の一覧が数分出なかった）
        const connName = startsOnDemand(declaration) ? connectedNameIfAny(declaration) : await connectDeclaredModule(declaration, project);
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
  async function resolveInstanceModuleClients(opts: { start?: string } = {}) {
    // instance 既定の宣言を読む（Project 上書きは Project 側の話）
    const spawned = await Promise.all(
      loadModuleDeclarations(runtimeConfig, "")
        .filter((declaration) => declaration.meta.scope === "instance")
        .map(async (declaration) => {
          // **道具用のコンテナの Module は、使うときに起こす**（追加・2026-10-15、`v4-modules.md` §2.2「変換役」）。起動のとき・
          // 画面の一覧を出すたびに起こすと、初めての banto で数分の apt が走る。名指されたとき（`start`）・中継で呼ばれたとき
          // （`connectOnDemand`）だけ起こし、それまでは繋がっていれば返す
          const onDemand = modulePlacement(declaration.meta, declaration.launch) === "tools-container" && opts.start !== declaration.name;
          const connName = onDemand
            ? connectedModules.has(declaration.name)
              ? declaration.name
              : undefined
            : await connectDeclaredModule(declaration);
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
    autoApproveFor: autoApproveAll,
    connectOnDemand: connectToolsModuleOnDemand,
    onDemandTargets,
    // **札で、呼び出し元の Thread に届ける**（決定・2026-09-25、アーキ仕様 §4.2）
    deliverToThread: async (caller, input) => {
      // 起こし直しのあと覚え直した札は、最後の届けにしか使えない（`final` を渡して確かめる）
      const h = replyHandles.use(
        input.replyTo,
        { moduleName: caller.moduleName, ...(caller.connName ? { connName: caller.connName } : {}) },
        { final: input.final },
      );
      if ("error" in h) return { ok: false, error: h.error };
      if (input.final) recovery?.noteSettled(input.replyTo, "delivered");
      // **宛先が Module の札**（追加・2026-10-05）——呼んだ Module の受け口に渡す（残してから渡す）
      if (h.toModule) {
        const r = await moduleReplies.deliver({
          toConn: h.toModule.connName,
          replyTo: input.replyTo,
          args: {
            replyId: h.toModule.replyId,
            from: caller.moduleName,
            title: input.title,
            text: input.text,
            final: input.final,
            lost: false,
          },
        });
        if (input.final) replyHandles.settle(input.replyTo);
        return { ok: true, deliveryId: r.deliveryId };
      }
      const r = await deliveries.deliver({
        threadId: h.threadId,
        from: caller.moduleName,
        // 打ち切った札を繋がったあと覚え直したもの（Backlog #324）——頼んだ Thread にはもう「途中で終わりました」が届いている
        title: h.afterLost ? `起こし直しで途切れたあとに終わっていました：${input.title}` : input.title,
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
    // **Module 宛ての札**（追加・2026-10-05、アーキ仕様 §4.2）
    replies: {
      issueToModule: (input) => replyHandles.issueToModule(input),
      markAwaiting: async (replyTo, waitingOn) => {
        const h = replyHandles.markAwaiting(replyTo, waitingOn);
        if (!h?.toModule) return;
        await moduleReplies.recordAwaiting({
          replyTo,
          replyId: h.toModule.replyId,
          toConn: h.toModule.connName,
          toModule: h.toModule.moduleName,
          fromConn: h.connName,
          fromModule: h.moduleName,
          // 起こし直したとき、頼んだ先が続けられると名乗っているかを宣言で見るのに使う（2026-10-05）
          ...(h.projectId ? { projectId: h.projectId } : {}),
        });
      },
    },
    // 出所（人の画面か、AI のターンか）を引くための台帳。承認の要否がここで分かれる
    moduleCalls,
    // **公開の実装が、Project のコンテナに届くアドレスを引く**（§4.3 Publish）。この banto が作ったものだけ。
    // 確かに届かない（止まっている・無い・他人のもの）は値で返し、分からない（実行場所が答えない）は投げる
    projectAddress: (projectId) => runtime.address(projectId),
    // **Project の一覧**（§2.4 Repositories——どの Project がそのフォルダを根にしているか）。引ける相手と場面は
    // 中継が絞る（`mayListProjects`）。根は store が正規化したもの（realpath）
    listProjects: () =>
      projectThread
        .listProjects()
        .map((p) => ({ id: p.id, name: p.name, root: p.root, status: p.status, runtime: p.runtime ?? "host-container" })),
    // **受信箱に知らせる**（§2.4 Repositories——ログインの更新に失敗したとき）。出せる相手は中継が絞る
    // （`mayRaiseNotice`）。鍵は Module ごとに分ける——別の Module の知らせを潰さない
    raiseNotice: async (caller, input) => {
      await inbox.raiseNotice({
        dedupeKey: `module:${caller.moduleName}:${input.key}`,
        title: input.title,
        detail: input.detail,
        ...(input.threadId ? { threadId: input.threadId } : {}),
      });
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
      autoApproveAll,
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

  // **画面と Module の間の流れ**（決定・2026-10-08、アーキ仕様 §5.8）。住所は画面から見た API の基点の `/api/streams`
  // （本番は画面と同じオリジン）。繋いでよいのはサンドボックスのオリジンからだけ
  const streamRelay = new StreamRelay({
    url: streamUrlOf(loginOrigins(bootstrap).apiBaseUrl),
    allowedOrigin: bootstrap.sandboxPublicUrl,
  });
  /**
   * **その Project の Service の Module（`satisfies: service`）に人の管理操作を頼む**——移す前に止めておく（`disableAllServices`）・
   * 閉じるときに止めて自動起動から外す（`suspendAllServices`）。繋げない・断られたら投げる（止めたことにしない）。
   * 返り値の `field` に入った名前を集めて返す
   */
  async function callServiceAdminTool(projectId: string, tool: string, field: string, what: string): Promise<string[]> {
    const project = projectThread.getProject(projectId);
    if (!project) return [];
    const names: string[] = [];
    const services = loadModuleDeclarations(runtimeConfig, projectId).filter(
      (d) => d.meta.scope === "project" && (d.meta.satisfies as string[]).includes("service"),
    );
    for (const declaration of services) {
      const connName = await connectDeclaredModule(declaration, project);
      const client = connName ? connectedModules.get(connName) : undefined;
      if (!client) throw new Error(`${declaration.name} に繋げないので、${what}ません`);
      const r = await client.callTool({
        name: tool,
        arguments: {},
        _meta: { [CALLER_META_KEY]: { admin: true, forProject: projectId } },
      });
      const text = (r.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "";
      if (r.isError) throw new Error(`${declaration.name} が${what}ませんでした：${text}`);
      names.push(...(((JSON.parse(text) as Record<string, unknown>)[field] as string[] | undefined) ?? []));
    }
    return names;
  }
  /**
   * **host が知っている、その Project で動いているもの**（ターン・返事待ちの札・Module 宛ての返事待ち・走っている Module の
   * 呼び出し）。別の実行場所へ移すときと眠らせるときは、これが空でなければ断る（同じ一覧——独自の列挙を作らない、規則3）
   */
  function hostActivity(projectId: string): RunningItem[] {
    const a = collectActivity({ projectThread, inbox, threadTurns, moduleCalls, moduleReplies, resumesAfterRestart });
    const mine = <T extends { projectId?: string }>(items: T[]) => items.filter((i) => i.projectId === projectId);
    const where = (t: { threadTitle?: string }) => t.threadTitle ?? "会話";
    return [
      ...mine(a.turns).map((t): RunningItem => ({ kind: "turn", label: `ターンが走っています（${where(t)}）` })),
      ...mine(a.awaitingReplies).map((r): RunningItem => ({ kind: "reply", label: `裏の仕事の返事を待っています（${r.module}・${where(r)}）` })),
      ...mine(a.moduleReplies).map((r): RunningItem => ({ kind: "moduleReply", label: `${r.caller} が ${r.module} の返事を待っています` })),
      ...mine(a.moduleCalls).map((c): RunningItem => ({ kind: "call", label: `Module の呼び出しが走っています（${c.connName}）` })),
    ];
  }
  /** 別のサーバの Project を閉じる・眠らせる前に（v4-security.md §1「閉じた Project は数えない」） */
  const suspendProjectServices = (projectId: string) =>
    callServiceAdminTool(projectId, "suspendAllServices", "suspended", "閉じる前に別のサーバの Service を止めて自動起動から外せ");
  /**
   * **Project を別の実行場所へ移す**（決定・2026-10-11、`docs/specs/v4-security.md` §1「Project を別の実行場所へ移す」）
   */
  projectMover = new ProjectMover({
    dataDir: bootstrap.dataDir,
    monorepoRoot,
    // Runner（Claude の CLI）と同じ置き場
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
    projectThread,
    remoteRuntimes,
    hostContainers: hostRuntime,
    hostActivity,
    disableServices: (projectId) => callServiceAdminTool(projectId, "disableAllServices", "disabled", "元の場所の Service を止めておけ"),
    releaseModules: async (projectId) => {
      await releaseProjectModules(projectId, { stopContainer: true });
    },
    revokeClaudeLogin: (projectId) => claudeLogin.revoke(projectId),
    deliver: async (threadId, title, text) => {
      await deliveries.deliver({ threadId, from: "banto", title, text, hop: 1, kind: "banto" }, { wake: false });
    },
    kick: (threadId) => deliveries.kick(threadId),
    notify: async (n) => {
      await inbox.raiseNotice(n);
    },
    onChange: (change) => appEvents.publish({ type: "runtime_move.changed", ...change }),
    // E2E だけ：写す途中で banto を落とすために、写す速さを抑える
    ...(process.env.BANTO_TEST_RUNTIME_MOVE_BYTES_PER_SEC
      ? { throttleBytesPerSec: Number(process.env.BANTO_TEST_RUNTIME_MOVE_BYTES_PER_SEC) }
      : {}),
  });
  /** **Project のスリープ**（決定・2026-10-16、アーキ仕様 §2.2「スリープ」）。眠らせる・起こす口・止まるもの */
  const projectSleep = new ProjectSleep({
    projectThread,
    hostActivity,
    suspendServices: suspendProjectServices,
    releaseModules: (projectId) => releaseProjectModules(projectId, { stopContainer: true }),
    runningInPlace: (projectId) => projectMover!.runningInPlace(projectId),
  });
  const app = createApp({
    warmModelCatalog: true,
    ...(runTurnOverride ? { runTurn: runTurnOverride } : {}),
    ...(listModelsOverride ? { listModels: listModelsOverride } : {}),
    projectThread,
    globalMemory,
    inbox,
    pendingApprovals,
    runtimeConfig,
    automations,
    automationRunner,
    automationWebhooks,
    listSecretAliases: (projectId) => secretAliasesFor(projectId),
    ...(bootstrap.publicUrl ? { webhookBaseUrl: bootstrap.publicUrl } : {}),
    turnEvents,
    threadTurns,
    deliveries,
    appEvents,
    moduleCalls,
    // 起こし直しで待つものと待たないもの（GET /api/admin/activity）
    restartActivity: { moduleReplies, resumesAfterRestart },
    // 本体の止まり具合と host の詰まり具合（GET /api/admin/host-health）
    hostHealth: () => collectHostHealth(hostStall),
    // 資源（GET /api/admin/resources・hello の混んでいる印）
    resources: { snapshot: () => resourceWatch.snapshot(), busy: () => resourceWatch.busySummary() },
    // 別のサーバへコードを送っている途中のもの（hello）と、登録したあと先に送っておく口（Backlog #269）
    codeTransfers: () => remoteSsh.codeTransfers().map((t) => ({ ...t, projectIds: projectsOnRuntime(t.runtime) })),
    // 起きたときの先送り（Backlog #278）と同じ順番に並べる——一度に1台ずつ
    warmUpRemoteRuntime: (name) => void remoteSsh.queueWarmUp(name),
    closeRemoteRuntime: (name) => {
      remoteOutage.forget(name);
      return remoteSsh.closeRuntime(name);
    },
    relayEndpoint,
    claudeLogin,
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
      ...(bootstrap.testOnlySelfUpdate?.prebuiltBase && bootstrap.testOnlySelfUpdate.githubApi
        ? { prebuilt: { base: bootstrap.testOnlySelfUpdate.prebuiltBase, api: bootstrap.testOnlySelfUpdate.githubApi } }
        : {}),
    }),
    releaseProjectModules,
    // 別のサーバの Project を閉じる前に（v4-security.md §1「閉じた Project は数えない」）
    suspendProjectServices,
    projectSleep,
    continueStoppedTurn: (noticeId) => continueStoppedTurn({ projectThread, inbox, deliveries }, noticeId),
    reviewToolCalls: (thread) => {
      const project = projectThread.getProject(thread.projectId);
      let dir: string | undefined;
      try {
        dir = project ? projectThread.runnerCwd(project) : undefined;
      } catch {
        dir = undefined; // 置き場を全部から探す（`sdkSessionReader`）
      }
      return reviewToolCounter.count(thread, dir);
    },
    // 起こし直したあと Module に続けるかを聞いている Thread は、人が送ったターンも答えを待ってから始める（§2.5「2.」）
    awaitRestartRecovery: (threadId) => recovery!.waitFor(threadId),
    remoteRuntimes,
    runtimeMove: projectMover,
    listSshIdentities: sshIdentitiesThroughVault,
    // 別のサーバの Project にはこの機械のコンテナは無い（あれば前の名残——聞かない）
    projectContainerStatus: async (projectId: string) => {
      const project = projectThread.getProject(projectId);
      return project && isRemoteProject(project) ? undefined : runtime.status(projectId);
    },
    // **資源の上限**（決定・2026-10-02）。設定を変えたら、動いているコンテナにも起こし直さずに効かせる
    containerLimits: {
      describe: (projectId?: string) => describeLimits(runtimeConfig, hostResources(), projectId),
      async apply(projectId?: string) {
        // **上限はこの機械のコンテナだけ**（別のサーバの資源は向こうの持ち主の責任——v4-security.md §1）
        const ids = (projectId !== undefined
          ? [projectId]
          : [...projectThread.listProjects().map((p) => p.id), runtime.instancePlaceId, runtime.toolsPlaceId]
        ).filter((id) => {
          const project = projectThread.getProject(id);
          return !project || !isRemoteProject(project);
        });
        for (const id of ids) await runtime.applyLimits(id);
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
    retryToolsInstall,
    startOAuth,
    finishOAuth,
    dataDir: bootstrap.dataDir,
    configDir: dirname(resolveBootstrapConfigPath()),
    releaseDir: bootstrap.releaseDir,
    resolveModuleClientsForThread,
    resolveModuleClientsForProject,
    resolveInstanceModuleClients,
    sandboxPublicUrl: bootstrap.sandboxPublicUrl,
    // 待ち受けは Module の置き場（host とコンテナで同じパス）の中——host は host の側のパスへ直接繋ぐ。
    // 別のサーバの Module には、多重化した接続にソケットの転送を張り、その host の側の窓口へ繋ぐ
    streams: {
      relay: streamRelay,
      socketPathOf: async (connName) => {
        const projectId = registry.getModule(connName)?.projectId;
        if (projectId && remoteSsh.handles(projectId)) return remoteSsh.streamSocketPath(projectId, connName, STREAM_SOCKET_RELATIVE_PATH);
        return join(bootstrap.dataDir, "modules", connName, STREAM_SOCKET_RELATIVE_PATH);
      },
    },
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
      automations.save(),
      remoteRuntimeStore.save(),
      relayGrants.save(),
      authStore.save(),
    ]);
  };
  // **コンテナが資源の上限に当たったらログに残す**（決定・2026-10-05、`container-pressure.ts`。受信箱には出さない——改訂・
  // 2026-10-15）。1分ごとに、用意できているコンテナの数え（memory.events の oom_kill・pids.events の max）を見る
  const pressureWatch = new ContainerPressureWatch({
    // 数えは host から cgroup のファイルを直接読む（2026-10-09、incus exec を通さない）
    read: (name) => resourceWatch.readEvents(name),
    report: async (n) => console.warn(`[host] ${n.title}：${n.detail}`),
    describeLimits: (projectId) => {
      const n = limitNumbersFor(runtimeConfig, hostResources(), projectId);
      return `メモリ ${Math.round((n.memoryMiB / 1024) * 10) / 10} GiB・CPU ${n.cpus} コア分・プロセス ${n.processes}`;
    },
  });
  const pressureTimer = setInterval(() => {
    const targets = runtime.resourceTargets();
    void pressureWatch.tick(targets).catch((err: unknown) => console.warn("[host] コンテナの上限の見張りで例外:", err));
    // 間隔は E2E だけ縮める（BANTO_CONTAINER_PRESSURE_INTERVAL_MS）
  }, Number(process.env.BANTO_CONTAINER_PRESSURE_INTERVAL_MS) || 60_000);
  pressureTimer.unref();
  let lastBusy = "";
  const resourceTimer = setInterval(() => {
    // 用意できているかに依らず、banto が知っている Project のコンテナを全部見る（2026-10-09）——起こし直した直後は Module を
    // 使うまで「用意できた」にならず、動いているのに名前の無いコンテナとして出ていた。動いていなければ読めずに飛ばす
    const targets = [
      ...projectThread.listProjects().map((p) => ({ containerName: runtime.placeName(p.id), projectId: p.id, name: p.name })),
      { containerName: runtime.placeName(runtime.instancePlaceId), name: "banto 全体用のコンテナ" },
      { containerName: runtime.placeName(runtime.toolsPlaceId), name: "同梱の道具用のコンテナ" },
    ];
    void resourceWatch
      .tick(targets)
      .then(() => {
        const busy = resourceWatch.busySummary();
        const key = JSON.stringify(busy);
        if (key !== lastBusy) {
          lastBusy = key;
          appEvents.publish({ type: "resources.busy", busy });
        }
      })
      .catch((err: unknown) => console.warn("[host] 資源の見張りで例外:", err));
    // 間隔は E2E だけ縮める（BANTO_RESOURCES_INTERVAL_MS）
  }, Number(process.env.BANTO_RESOURCES_INTERVAL_MS) || 10_000);
  resourceTimer.unref();
  const snapshotTimer = setInterval(() => {
    void saveSnapshots().catch((err) => console.error("[host] スナップショット保存に失敗:", err));
  }, 60_000);
  snapshotTimer.unref();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      // 2回目の信号（人が Ctrl-C を重ねた等）は待たずに止まる
      if (stopping) {
        console.log(`[host] ${signal} をもう一度受けたので、実行中の呼び出しを待たずに止まります`);
        void saveSnapshots()
          .catch((err) => console.error("[host] 終了時のスナップショット保存に失敗:", err))
          .finally(() => process.exit(0));
        return;
      }
      // 止める途中で Module が切れても、起こし直さない
      stopping = true;
      // 開いている流れは 1012（起こし直し中）で閉じる——画面は札を取り直して繋ぎ直す（§5.8）
      streamRelay.closeAll();
      liveness.stop();
      automationClock.stop();
      automationWebhooks.stop();
      hostStall.stop();
      stallProfiler?.stop();
      for (const connName of [...pendingRestarts.keys()]) cancelRestart(connName);
      // **新しい Module の呼び出しを断り、実行中の呼び出しが終わるのを上限つきで待ってから止まる**（追加・2026-10-05、
      // アーキ仕様 §2.5「いま動いているもの」）。ターン・続けられる仕事は待たずに起こし直すので、「待つものが無い」と見て
      // から止まるまでに走っているターンが次の tool を呼ぶ——それを断り（AI には「起き直したあとにもう一度」と返る）、
      // 呼んでいた途中のものは結果を返し終えるまで待つ。上限（`STOP_DRAIN_LIMIT_MS`）は systemd の止める上限より短い
      moduleCalls.stopAccepting();
      void moduleCalls
        .drain(STOP_DRAIN_LIMIT_MS)
        .then(({ left, waitedMs }) => {
          if (left > 0) {
            console.warn(`[host] 実行中の呼び出しが ${Math.round(waitedMs / 1000)} 秒で終わらないので、${left} 件を切って止まります`);
          } else if (waitedMs > 0) {
            console.log(`[host] 実行中の呼び出しが終わるのを ${Math.round(waitedMs / 1000)} 秒待ちました`);
          }
        })
        .then(() => saveSnapshots())
        .catch((err) => console.error("[host] 終了時のスナップショット保存に失敗:", err))
        .finally(() => process.exit(0));
    });
  }

  // Module の Canvas を隔離するサンドボックス（決定・2026-09-06、§6.2）。
  // **画面とは別オリジンでなければならない**ので、別の口で配る。
  const sandbox = createSandboxServer({ allowedEmbedderOrigins: bootstrap.allowedEmbedderOrigins, streamUrl: streamRelay.url });
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
    // **時刻の自動化を刻み始める**（§4.3「時計」）。最初の刻みで止まっていた間の時刻を取り戻す——待ち受けて、届いたものを
    // 再開したあと（届けたもので起こすターンも Runner が中継の口に繋ぐ）
    automationClock.start();
    // 受けて、まだ届けていない Webhook をまとめ直す（§4.3「まとめる」）
    automationWebhooks.start();
    // **別の実行場所へ移している途中で落ちていたら**、移す先の作ったものを片づけて failed を積む（待ち受けてから——
    // 別のサーバへは Vault の鍵で繋ぐ）
    void projectMover!.recoverInterrupted().catch((err: unknown) => console.warn("[host] 途中で止まった移し替えを片づけられませんでした:", err));
    // **使っている Project がある別のサーバへ、いまの版のコードを裏で先に送っておく**（追加・2026-10-12、Backlog #278）
    // ——banto を更新して起こし直すと版が変わり、次に Project を開いたとき送り終わるまで Module が起きない。一度に1台ずつ、
    // 失敗しても次へ（`queueWarmUp`）。待ち受けてから——鍵は Vault から借りる
    for (const r of remoteRuntimes.list()) {
      if (projectsOnRuntime(r.name).length > 0) void remoteSsh.queueWarmUp(r.name);
    }
    // **続けられると名乗った Module に、続けるかを聞く**（§2.5「2.」）。待ち受けてから——Module は中継で資格情報を
    // 受け取り、札で届ける。答えが出た Thread から切れたターンを片づけ、留めを解く
    void recovery!.afterListen().then(({ answers, turns }) => {
      for (const a of answers) {
        const to = "threadId" in a.to ? `Thread ${a.to.threadId}` : `呼び元 ${a.to.module}`;
        console.log(
          `[host] 前の走行の返事待ち（${a.target.moduleName}・${to}）→ ` +
            (a.outcome === "kept"
              ? "続けると答えた（札を覚え直した。最後の届け1回だけ）"
              : a.outcome === "settled"
                ? `問いの答えより前に済んだ（${a.why}）`
                : `途中で終わりました（${a.why}）`),
        );
      }
      logTurns(turns);
    });
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
