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
  /**
   * **外から見た banto の住所**（追加・2026-09-18、OAuth の戻り先）。
   *
   * OAuth 2.1 は戻り先が https であることを要求する。その値は**相手のサーバに
   * 登録される**ので、banto が推測してはいけない——設定に置く（規則3）。
   * 省略時は loopback（OAuth は使えないが、他は動く）。
   */
  publicUrl?: string;
  /**
   * **画面のオリジン**（追加・2026-10-03、人のログイン）。Cookie で来た要求の Origin の検め・パスキーの origin・
   * CORS・ログインのリンクに使う。**省略時は `publicUrl` のオリジン**（本番は画面と API が同じオリジン）。
   * 開発・E2E は画面と host のポートが違うので書く。どちらも無ければ `http://localhost:4175`
   */
  uiOrigin?: string;
  /**
   * **稼働中の banto の置き場**（追加・2026-10-04、画面からの更新）。`repo.git`・`versions/<commit>`・`current`・
   * `previous` を持つ（アーキ仕様 §2.5「画面から banto を更新する」）。既定は `~/.local/share/banto-release`
   */
  releaseDir: string;
  /**
   * **試験だけの差し替え：画面からの更新**（追加・2026-10-04、E2E の `self-update.spec.ts`）。本物の systemd を
   * 使えない試験が、偽の systemctl と「動いているコードの場所」を指す。**本番の config には書かない**
   * （install・setup-update.sh は書かない）。
   *
   * 環境変数にしない理由：host の環境は人の Shell・unit の `Environment=` から引き継がれ、しかも `update.mjs` は
   * 同じ名前（`BANTO_UPDATE_SYSTEMCTL`）を自分の試験の差し替えに読む——そこに置いた値が、気づかないうちに本番の
   * host の「準備が済んでいるか・今の版」の判断まで変えてしまう。設定ファイルの明示の項目なら、置いたのが誰か・
   * どこかがはっきりし、起動時に警告も出る
   */
  testOnlySelfUpdate?: { systemctl: string; codeDir: string };
}

/** 画面のオリジンと、画面から見た API の基点（`docs/specs/v4-security.md`「人のログイン」） */
export function loginOrigins(config: Pick<BootstrapConfig, "publicUrl" | "uiOrigin" | "port">): {
  uiOrigin: string;
  apiBaseUrl: string;
} {
  const apiBaseUrl = config.publicUrl ?? `http://localhost:${config.port}`;
  const uiOrigin = new URL(config.uiOrigin ?? (config.publicUrl ? new URL(config.publicUrl).origin : "http://localhost:4175")).origin;
  return { uiOrigin, apiBaseUrl };
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

function defaultReleaseDir(): string {
  return join(xdgDataHome(), "banto-release");
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

/** 形が違えば止まる（黙って本物の systemctl・動いているコードへ落ちない、規則2） */
function parseTestOnlySelfUpdate(value: unknown): { systemctl: string; codeDir: string } {
  const v = value as { systemctl?: unknown; codeDir?: unknown } | null;
  if (typeof v?.systemctl !== "string" || !v.systemctl || typeof v.codeDir !== "string" || !v.codeDir) {
    throw new Error("config.json の testOnlySelfUpdate は { systemctl: string, codeDir: string } です（試験だけの項目）");
  }
  return { systemctl: v.systemctl, codeDir: v.codeDir };
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
      ...(raw.publicUrl ? { publicUrl: raw.publicUrl } : {}),
      ...(raw.uiOrigin ? { uiOrigin: raw.uiOrigin } : {}),
      releaseDir: raw.releaseDir ?? defaultReleaseDir(),
      ...(raw.testOnlySelfUpdate !== undefined ? { testOnlySelfUpdate: parseTestOnlySelfUpdate(raw.testOnlySelfUpdate) } : {}),
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
    releaseDir: defaultReleaseDir(),
  };
  assertNoOverlap(configPath, config.dataDir);
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  return config;
}
