#!/usr/bin/env node
/**
 * Worker Pool を独立プロセスとして立てる入口（ADR-0010 決定27b・ADR-0013 決定61 の同型）。
 *
 *   node --import tsx packages/banto-worker-pool/src/bin.ts serve --port 4300
 *
 * **なぜ独立させるか。** Worker Pool は番頭ホストに同居していたため、**Kobo が職人を
 * 起こすのに番頭の稼働を必要としていた**——決定27b が「Banto が単一障害点になり、依存の
 * 向きが逆転する」として避けた形そのもの。Environment Pool を独立させたのと同じ理由で、
 * ここも単体で立てられるようにする。
 *
 * 環境変数:
 *   BANTO_WORKER_POOL_PORT   待ち受けポート（既定 4300）
 *   BANTO_WORKER_POOL_BIND   待ち受けアドレス（既定 127.0.0.1。決定40）
 *   BANTO_WORKER_POOL_DATA   台帳・セッション・イベントログの置き場
 *                            （既定 <BANTO_DATA_DIR>/worker-pool）
 *   BANTO_DATA_DIR           上の既定を組み立てる元（既定 ./.banto）。**番頭ホストと
 *                            同じ値にすること**——tier→モデルの台帳（llm-registry.json）を
 *                            共有しないと、画面で選んだモデルが職人に効かない（D3）
 *   BANTO_WORKER_PROVIDER    職人の既定 provider（省略時は pi の既定解決）
 *   BANTO_WORKER_MODEL       職人の既定モデル
 *   BANTO_CLAUDE_MODEL       Claude Code の職人の既定モデル（既定 sonnet。番頭は
 *                            `worker.delegate` の `model` で仕事ごとに指名できる）
 *   BANTO_WORKER_IDLE_MS     安全弁（何もしていない職人を畳むまで。既定15分。0 で切る）
 *
 * **既定では 127.0.0.1 しか待ち受けない。** この面は**任意のディレクトリで任意のコマンドを
 * 実行できる職人**を起こせるので、認証の無いまま外へ出すと最も危ない口になる（決定40）。
 *
 * D5: ここに判断は無い。組み立てて起こすだけ。
 * D6: node 標準のみ。
 * I2: 壊れた台帳で黙って動き出さない（生きている職人を見失って二重に起こす）。
 */

import * as path from "node:path";
import { PiRpcDriver } from "./pi-rpc-driver.js";
import { ClaudeAgentDriver, CLAUDE_AGENT_DRIVER_ID } from "./claude-agent-driver.js";
import { CLAUDE_KNOWN_MODELS, CLAUDE_TIER_MODELS } from "./claude-agent/naming.js";
import { claudeAgentAvailability } from "./claude-agent/availability.js";
import { WorkerPool, DEFAULT_IDLE_TIMEOUT_MS } from "./pool.js";
import { createWorkerModuleTools, createWorkerReportTools, createWorkerTools } from "./worker-tools.js";
import { WorkerPoolService, WORKER_POOL_DEFAULT_PORT } from "./service.js";
import { createWorkerPoolSettings } from "./settings.js";
import { WORKER_POOL_BASE_URL } from "./module.js";
import {
  LlmCatalog,
  ModelLedger,
  createFileModelResolver,
  createFileSettingsSection,
  createSettingsTools,
  piAgentDir,
} from "@banto/core";
import { resumeWorkers } from "./resume.js";

/** 既定の待ち受けアドレス（決定40：広げるのは明示のときだけ）。 */
export const WORKER_POOL_DEFAULT_BIND = "127.0.0.1";

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`--${name} には値が要ります。`);
  }
  return value;
}

function usage(): never {
  process.stderr.write(
    "使い方: banto-worker-pool serve [--port <n>] [--host <addr>]\n" +
      "  --host は待ち受けるアドレス（既定 127.0.0.1）。この面は任意のコマンドを実行できる\n" +
      "  職人を起こせるので、広げるときは前段（Caddy 等）で守ること。\n"
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const subcommand = args[0] ?? "serve";
  if (subcommand !== "serve") usage();

  const dataDir =
    process.env["BANTO_WORKER_POOL_DATA"] ??
    path.join(process.env["BANTO_DATA_DIR"] ?? "./.banto", "worker-pool");

  const port = Number.parseInt(
    flag("port") ?? process.env["BANTO_WORKER_POOL_PORT"] ?? String(WORKER_POOL_DEFAULT_PORT),
    10
  );
  if (!Number.isFinite(port)) throw new Error("--port は数値で指定してください。");

  const host = flag("host") ?? process.env["BANTO_WORKER_POOL_BIND"] ?? WORKER_POOL_DEFAULT_BIND;
  if (host !== "127.0.0.1" && host !== "localhost") {
    // 決定40 と同じ形：広げたことが起動ログに残る
    console.warn(
      `[worker-pool] 警告: ${host} で待ち受けます。認証は持っていません。` +
        "この口は**任意のディレクトリで任意のコマンドを実行できる職人**を起こせます——" +
        "前段（Caddy 等）で守ってください。"
    );
  }

  // 職人が報告・質問を返す先（決定29e）。子プロセスから叩くので絶対URL
  const reportUrl = `http://127.0.0.1:${port}${WORKER_POOL_BASE_URL}`;

  // ADR-0004: 職人のモデルは tier で頼まれる（決定60a：Kobo は tier までしか渡さない）。
  // **台帳が無いと tier が効かず、全部 pi の既定モデルに落ちる**——番頭ホストに同居して
  // いたときはホストの台帳が解決していたので、独立して立てるならここで持つ（task-0066）
  // **pi は import しない**（決定3：モジュールはハーネスに依存しない）。models.json だけを
  // 見る解決器で足りる——結果のうち実際に使われるのは provider と id で、最後の解決は
  // 職人を起こす pi の CLI が行う
  const agentDir = piAgentDir();
  const bantoDataDir =
    process.env["BANTO_DATA_DIR"] ?? path.join(process.cwd(), ".banto");
  /**
   * **役の台帳**（ADR-0021 決定101）。番頭ホストが書き、工房は**読むだけ**（決定101d）。
   *
   * **書き先を移したら、読み手も一緒に移す。** ここを繋がないと、役の割り当てが
   * 引けなくなって候補の先頭が黙って選ばれる（`resolveForWorker` の `preferred` が外れる）。
   */
  const ledger = new ModelLedger({
    path: path.join(bantoDataDir, "model-roles.json"),
    readOnly: true,
  });
  const catalog = new LlmCatalog({
    ledger,
    authJsonPath: path.join(agentDir, "auth.json"),
    modelsJsonPath: path.join(agentDir, "models.json"),
    // **番頭ホストと同じオーバーレイ**（画面で選んだ tier・採用したモデルがそのまま効く）
    overlayPath: path.join(bantoDataDir, "llm-registry.json"),
    resolver: createFileModelResolver(path.join(agentDir, "models.json")),
  });
  const fallback = catalog.resolveForWorker();

  const driver = new PiRpcDriver({
    sessionBaseDir: path.join(dataDir, "sessions"),
    catalog,
    // 環境変数の指定が最優先。次に台帳の既定 tier の解決結果（catalog が解決できない
    // ときの最後の受け皿）
    ...(process.env["BANTO_WORKER_PROVIDER"]
      ? { defaultProvider: process.env["BANTO_WORKER_PROVIDER"] }
      : fallback
        ? { defaultProvider: fallback.model.provider }
        : {}),
    ...(process.env["BANTO_WORKER_MODEL"]
      ? { defaultModel: process.env["BANTO_WORKER_MODEL"] }
      : fallback
        ? { defaultModel: fallback.model.id }
        : {}),
  });

  // 設定画面で決めた値 > 環境変数 > 既定。保存先は自分のデータ置き場（task-0066）
  const settings = createFileSettingsSection(path.join(dataDir, "settings.json"));
  const saved = settings.read();
  const savedIdleMs = saved["idleTimeoutMs"];

  // 決定11: ランタイムは差し替えられる。番頭は `worker.delegate` の `runtime` で選ぶ
  // （既定は pi のまま——Claude Code は認証とコストの前提が違うので、黙って既定にしない）
  const claudeDriver = new ClaudeAgentDriver({
    sessionBaseDir: path.join(dataDir, "sessions"),
    // 等級ごとの割り当ては工房が持つ（設定画面「職人」）。ここは名指しも割り当ても
    // 無いときの受け皿だけ
    ...(process.env["BANTO_CLAUDE_MODEL"] ? { defaultModel: process.env["BANTO_CLAUDE_MODEL"] } : {}),
  });
  const idleTimeoutMs =
    typeof savedIdleMs === "number"
      ? savedIdleMs
      : Number.parseInt(process.env["BANTO_WORKER_IDLE_MS"] ?? String(DEFAULT_IDLE_TIMEOUT_MS), 10);

  const pool = new WorkerPool({
    // 決定101: 等級 → モデルの割り当ては核の台帳が持つ（工房は読むだけ）
    modelLedger: ledger,
    driver,
    // pi は登録（LLM Registry）で解く。第一候補が無ければ同じ等級の採用済みから
    driverRegistration: {
      title: "pi",
      description: "pi coding agent。モデルは「LLM・モデル」の登録から解決する。",
      resolveTier: (tier) => {
        const resolved = catalog.resolveForWorker(tier);
        return resolved ? `${resolved.model.provider}/${resolved.model.id}` : undefined;
      },
    },
    runtimes: {
      [CLAUDE_AGENT_DRIVER_ID]: {
        driver: claudeDriver,
        title: "Claude Code",
        description:
          "Claude Code（Agent SDK）。認証は Claude Code のもの（~/.claude）を使う——" +
          "モデルは別名で指定し、世代は Claude 側が解決する。",
        probe: () => claudeAgentAvailability(),
        models: () => CLAUDE_KNOWN_MODELS.map((m) => ({ name: m.value, label: m.label })),
        // 割り当てが無い等級は、Claude Code 側の別名で解ける
        resolveTier: (tier) => CLAUDE_TIER_MODELS[tier],
      },
    },
    // 名指しできるモデルを数え上げるため（`worker.models`）。tier→モデルの解決は
    // 設定画面で決めた割り当て（`settingsSection`）が持つ
    catalog,
    settingsSection: settings,
    dataDir,
    // 単体で立てるときの既定の名乗り。起動元は呼び出しごとに `origin` を渡す（決定29）
    defaultProjectTag: "default",
    defaultOrigin: "unknown",
    reportUrl,
    ...(Number.isFinite(idleTimeoutMs) ? { idleTimeoutMs } : {}),
  });

  // 決定44: 落ちる前に生きていた職人を起こし直す。**同居していたときは番頭ホストが
  // やっていた**ので、独立して立てるならここで回す（誰もやらないと復帰が消える）
  const resumed = await resumeWorkers({
    pool,
    stateDir: dataDir,
    log: (message) => console.log(`[worker-pool] ${message}`),
  });
  console.log(
    `[worker-pool] 職人の復帰: ${resumed.filter((r) => r.detail === "復帰").length} 件（対象 ${resumed.length} 件）`
  );

  const service = await WorkerPoolService.start({
    // 職人自身が叩く口（`worker.report` / `worker.ask`）と、起動元が道具立てを載せる口
    // （`worker.delegate_toolkit`）も出す。**番頭には渡らない**が、公開の口では一続き（決定29e）
    tools: [
      ...createWorkerTools(pool),
      ...createWorkerReportTools(pool),
      ...createWorkerModuleTools(pool),
      // 設定画面（決定41）は番頭ホスト側に出る。別プロセスなので読み書きを口で受ける
      ...createSettingsTools("worker", createWorkerPoolSettings(pool, { section: settings })),
    ],
    port,
    host,
  });

  /**
   * **実際に走るものを言う**（ADR-0021 症状2）。
   *
   * ここは LLM 登録の解決（`resolveForWorker`）を出していたが、実機では**工房の割り当てが
   * 勝っていた**ので、`職人の既定モデル: opencode-go/deepseek-v4-flash（standard）` と
   * 出しながら実際は `opus` で走っていた——**1行に2つの嘘**。台帳を引いて言い直す。
   */
  const startupTier = pool.resolvedDefaultTier();
  const startupModel = pool.resolvedDefaultModel();
  console.log(
    `[worker-pool] 職人の既定: ${startupTier ?? "(指定なし)"} → ` +
      `${startupModel ?? "(ランタイムの既定解決)"}`
  );
  // I2: 古い割り当てが残っていたら黙って無視しない（どこを直せばよいか分からなくなる）
  const stale = pool.staleTierAssignments();
  if (stale.length > 0) {
    console.warn(
      `[worker-pool] 工房に残っている等級の割り当て ${stale.length} 件は**もう読まれません**` +
        `（${stale.join(" / ")}）。割り当ては「役」の設定画面（核の台帳）で決めます（ADR-0021）`
    );
  }
  console.log(
    `[worker-pool] 使えるランタイム: ${pool.availableRuntimes().join(", ")}` +
      `（既定 ${pool.defaultRuntime}／Claude Code の既定モデル ${claudeDriver.currentDefaults().model}）`
  );
  console.log(
    `[worker-pool] ${service.baseUrl} で待ち受けています（台帳: ${dataDir}）\n` +
      "[worker-pool] Kobo には BANTO_WORKER_POOL_URL、番頭には同じ URL を登録してください"
  );

  const shutdown = async (): Promise<void> => {
    console.log("[worker-pool] 終了します...");
    // **職人は畳まない**（決定44）。次の起動で起こし直せるようにしておく——
    // ここで畳むと、番頭ホストの再起動のたびに実作業が消える
    pool.dispose();
    await service.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((err: unknown) => {
  process.stderr.write(`[worker-pool] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
