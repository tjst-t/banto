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
}

export class ConfigOverlapError extends Error {}

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
    };
    assertNoOverlap(configPath, config.dataDir);
    return config;
  }

  const config: BootstrapConfig = {
    dataDir: defaultDataDir(),
    port: 4737,
    authToken: randomToken(),
  };
  assertNoOverlap(configPath, config.dataDir);
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  return config;
}
