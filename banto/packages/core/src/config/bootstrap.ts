// docs/specs/v4-architecture.md §2.6「層1：bootstrap config」の実装。
// Event Storeを開くより前に要るもの——だからEvent Storeには置けない。
// XDG Base Directory・素のJSON・BANTO_CONFIG_PATHでの上書き（決定・2026-08-30）。

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface BootstrapConfig {
  dataDir: string;
  port: number;
  /** 待受の合言葉。実装時にランダム生成して保存する。 */
  authToken: string;
  /** Module の Canvas を隔離するサンドボックスの配信口（決定・2026-09-06）。
   *  **画面とは別オリジンでなければならない**（MCP Apps の仕様、§6.2）。 */
  sandboxPort: number;
  /** サンドボックスを埋め込んでよい相手（`frame-ancestors`）。
   *  Caddy 経由・LAN 直・E2E で変わるので設定に置く。 */
  allowedEmbedderOrigins: string[];
  /** 画面から見たサンドボックスの住所。**画面に推測させない**（規則3）
   *  ——Caddy 経由なら別サブドメイン、開発なら別ポートで、値が違う。 */
  sandboxPublicUrl: string;
}

export class ConfigOverlapError extends Error {}

/** サンドボックスを埋め込んでよい相手の既定。**開発と E2E で使う口だけ**——
 *  外から見える住所（Caddy のサブドメイン等）は、その環境の config に足す。 */
const DEFAULT_EMBEDDER_ORIGINS = ["http://127.0.0.1:4175", "http://localhost:4175"];

function xdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

function xdgDataHome(): string {
  return process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
}

export function resolveBootstrapConfigPath(): string {
  if (process.env.BANTO_CONFIG_PATH) return resolve(process.env.BANTO_CONFIG_PATH);
  return join(xdgConfigHome(), "banto", "config.json");
}

function defaultDataDir(): string {
  return join(xdgDataHome(), "banto");
}

function isAncestorOrEqual(candidate: string, of: string): boolean {
  const c = resolve(candidate);
  const o = resolve(of);
  return o === c || o.startsWith(c.endsWith("/") ? c : c + "/");
}

/**
 * dataDir が config.json 自身を含むディレクトリと重なっていないか検査する。
 * 重なっていたら起動を拒否する（アーキ仕様§2.6の決定、規則2）。
 */
export function assertNoOverlap(configPath: string, dataDir: string): void {
  const configDir = resolve(dirname(configPath));
  const resolvedDataDir = resolve(dataDir);
  if (isAncestorOrEqual(resolvedDataDir, configDir) || isAncestorOrEqual(configDir, resolvedDataDir)) {
    throw new ConfigOverlapError(
      `dataDir (${resolvedDataDir}) と config.json の置き場 (${configDir}) が重なっています。` +
        `§9の事故（作業範囲を見失った）を防ぐため、起動を拒否します。`,
    );
  }
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

/** 無ければ既定値で新規作成し、あれば読む。 */
export function loadOrCreateBootstrapConfig(configPath = resolveBootstrapConfigPath()): BootstrapConfig {
  if (existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Partial<BootstrapConfig>;
    const config: BootstrapConfig = {
      dataDir: raw.dataDir ?? defaultDataDir(),
      port: raw.port ?? 4737,
      authToken: raw.authToken ?? randomToken(),
      sandboxPort: raw.sandboxPort ?? 4176,
      allowedEmbedderOrigins: raw.allowedEmbedderOrigins ?? DEFAULT_EMBEDDER_ORIGINS,
      sandboxPublicUrl: raw.sandboxPublicUrl ?? `http://127.0.0.1:${raw.sandboxPort ?? 4176}`,
    };
    assertNoOverlap(configPath, config.dataDir);
    return config;
  }

  const config: BootstrapConfig = {
    dataDir: defaultDataDir(),
    port: 4737,
    authToken: randomToken(),
    sandboxPort: 4176,
    allowedEmbedderOrigins: DEFAULT_EMBEDDER_ORIGINS,
    sandboxPublicUrl: "http://127.0.0.1:4176",
  };
  assertNoOverlap(configPath, config.dataDir);
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  return config;
}
