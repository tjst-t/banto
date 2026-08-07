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
 *   BANTO_DATA_DIR           上の既定を組み立てる元（既定 ./.banto）
 *   BANTO_WORKER_PROVIDER    職人の既定 provider（省略時は pi の既定解決）
 *   BANTO_WORKER_MODEL       職人の既定モデル
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
import { WorkerPool, DEFAULT_IDLE_TIMEOUT_MS } from "./pool.js";
import { createWorkerModuleTools, createWorkerReportTools, createWorkerTools } from "./worker-tools.js";
import { WorkerPoolService, WORKER_POOL_DEFAULT_PORT } from "./service.js";
import { WORKER_POOL_BASE_URL } from "./module.js";
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

  const driver = new PiRpcDriver({
    sessionBaseDir: path.join(dataDir, "sessions"),
    ...(process.env["BANTO_WORKER_PROVIDER"]
      ? { defaultProvider: process.env["BANTO_WORKER_PROVIDER"] }
      : {}),
    ...(process.env["BANTO_WORKER_MODEL"] ? { defaultModel: process.env["BANTO_WORKER_MODEL"] } : {}),
  });

  const idleTimeoutMs = Number.parseInt(
    process.env["BANTO_WORKER_IDLE_MS"] ?? String(DEFAULT_IDLE_TIMEOUT_MS),
    10
  );

  const pool = new WorkerPool({
    driver,
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
    ],
    port,
    host,
  });

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
