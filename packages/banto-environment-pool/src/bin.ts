#!/usr/bin/env node
/**
 * Environment Pool を独立プロセスとして立てる入口（ADR-0013 決定61）。
 *
 *   node --import tsx packages/banto-environment-pool/src/bin.ts serve --port 4400
 *
 * 環境変数:
 *   BANTO_ENV_POOL_PORT   待ち受けポート（既定 4400）
 *   BANTO_ENV_POOL_BIND   待ち受けアドレス（既定 127.0.0.1。決定40a）
 *   BANTO_ENV_POOL_DATA   台帳と回収物の置き場（既定 <BANTO_DATA_DIR>/environment-pool）
 *   BANTO_DATA_DIR        上の既定を組み立てる元（既定 ./.banto）
 *   BANTO_PUBLIC_URL      外から見えるときの banto 自身の URL（中継 URL の組み立てに使う）
 *   BANTO_CADDY_ADMIN     Caddy admin API（BANTO_ENV_DOMAIN と対で指定。決定39c）
 *   BANTO_ENV_DOMAIN      Caddy でサブドメイン公開するときの基底ドメイン
 *   SOPS_AGE_KEY_FILE     credentials の復号鍵（決定32d：鍵を持つのはここだけ）
 *
 * **既定では 127.0.0.1 しか待ち受けない。** Environment Pool は sops の復号鍵を持つため、
 * 無認証の面を外に出すと credentials 経路が露出する（決定40）。広げるときは明示する。
 *
 * D5: ここに判断は無い。組み立てて起こすだけ。
 * D6: node 標準のみ。
 * I2: 半端な設定（Caddy の片側だけ）は黙って既定へ落とさず止める。
 */

import * as path from "node:path";
import { EnvironmentPool } from "./pool.js";
import { createEnvTools } from "./tools.js";
import { createEnvProxyExposer } from "./proxy-exposer.js";
import { createCaddyExposer } from "./caddy-exposer.js";
import {
  EnvironmentPoolService,
  ENVIRONMENT_POOL_DEFAULT_BIND,
  ENVIRONMENT_POOL_DEFAULT_PORT,
} from "./service.js";
import { ENVIRONMENT_POOL_BASE_URL } from "./module.js";
import { createEnvironmentSettings } from "./settings.js";
import { createFileSettingsSection, createSettingsTools } from "@banto/core";

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
    "使い方: banto-environment-pool serve [--port <n>] [--host <addr>]\n" +
      "  --host は待ち受けるアドレス（既定 127.0.0.1）。Environment Pool は認証を持たず\n" +
      "  sops の復号鍵を持つので、広げるときは前段（Caddy 等）で守ること。\n"
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const subcommand = args[0] ?? "serve";
  if (subcommand !== "serve") usage();

  const dataDir =
    process.env["BANTO_ENV_POOL_DATA"] ??
    path.join(process.env["BANTO_DATA_DIR"] ?? "./.banto", "environment-pool");

  const port = Number.parseInt(
    flag("port") ?? process.env["BANTO_ENV_POOL_PORT"] ?? String(ENVIRONMENT_POOL_DEFAULT_PORT),
    10
  );
  if (!Number.isFinite(port)) throw new Error("--port は数値で指定してください。");

  const host = flag("host") ?? process.env["BANTO_ENV_POOL_BIND"] ?? ENVIRONMENT_POOL_DEFAULT_BIND;
  if (host !== "127.0.0.1" && host !== "localhost") {
    // 決定40a と同じ形：広げたことが起動ログに残る
    console.warn(
      `[environment-pool] 警告: ${host} で待ち受けます。認証は持っていません。` +
        `sops の復号鍵を持つ面なので、前段（Caddy 等）で守ってください。`
    );
  }

  // 決定39: 検証環境を外から見えるようにする口。既定は自分で中継する
  const proxy = createEnvProxyExposer({
    baseUrl: ENVIRONMENT_POOL_BASE_URL,
    ...(process.env["BANTO_PUBLIC_URL"] ? { publicBaseUrl: process.env["BANTO_PUBLIC_URL"] } : {}),
  });
  const caddyAdmin = process.env["BANTO_CADDY_ADMIN"];
  const envDomain = process.env["BANTO_ENV_DOMAIN"];
  if (caddyAdmin && !envDomain) {
    // I2: 半端な設定を黙って既定へ落とさない（Caddy のつもりで中継されると気づけない）
    throw new Error("BANTO_CADDY_ADMIN を設定するなら BANTO_ENV_DOMAIN も要ります。");
  }
  const caddy =
    caddyAdmin && envDomain
      ? createCaddyExposer({ adminUrl: caddyAdmin, baseDomain: envDomain })
      : undefined;

  const pool = new EnvironmentPool({
    dataDir,
    exposers: { proxy, ...(caddy ? { caddy } : {}) },
    ...(process.env["SOPS_AGE_KEY_FILE"]
      ? { sopsAgeKeyFile: process.env["SOPS_AGE_KEY_FILE"] }
      : {}),
    // サービスのログにも出す。**会話への経路はこれではない**（task-0067）——番頭は
    // `env.events` を引きに来る。ここは実機のログだけを見ている人のために残す
    onAttention: (message) => {
      console.warn(`[environment-pool] ${message}`);
    },
  });

  // 決定41: PO が画面で決めた上限は**次の起動でも効く**必要がある。同居していたときは
  // 番頭ホストの設定ファイルの一区画を借りていたので、独立して立てるなら自分で持つ
  const settings = createFileSettingsSection(path.join(dataDir, "settings.json"));
  pool.applyLimits(settings.read() as Partial<ReturnType<typeof pool.currentLimits>>);

  if (pool.ledgerCorruption) {
    // I2: 壊れた台帳で黙って動き出さない
    console.error(`[environment-pool] 台帳を読めませんでした: ${pool.ledgerCorruption}`);
  }
  if (pool.eventLogCorruption) {
    // I2: 読めなかった行があることを黙らせない。番頭が引く知らせに抜けが出る
    console.error(`[environment-pool] 出来事のログを読めませんでした: ${pool.eventLogCorruption}`);
  }

  // spec-environment §5: **ここで回さないと期限が効かない**。外に残った環境は費用（I3）
  pool.startMaintenance();

  const service = await EnvironmentPoolService.start({
    // 設定画面（決定41）は番頭ホスト側に出る。別プロセスなので読み書きを口で受ける
    tools: [
      ...createEnvTools(pool),
      ...createSettingsTools("env", createEnvironmentSettings(pool, settings)),
    ],
    port,
    host,
    proxy,
  });

  console.log(
    `[environment-pool] ${service.baseUrl} で待ち受けています（台帳: ${dataDir}）\n` +
      `[environment-pool] レジストリにはこの URL を登録してください（meta/modules.json の environment-pool）`
  );

  const shutdown = async (): Promise<void> => {
    console.log("[environment-pool] 終了します...");
    pool.stopMaintenance();
    await service.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((err: unknown) => {
  process.stderr.write(`[environment-pool] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
