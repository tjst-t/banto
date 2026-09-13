// Infisical への繋ぎ方を、**この Module 自身が持つ**（決定・2026-09-13、
// ユーザー要望「接続先と API Token を Global の Module 設定で入れたい」）。
//
// **なぜ banto の設定（宣言）に置かないか**：宣言は Event Store に残る。
// 書くと**秘密が記録に残る**——`docs/notes/2026-09-12-second-vault-backend.md`
// で「資格情報は宣言に書かない」と決めた理由がそのまま効く。
//
// **金庫を開ける鍵は金庫に入らない**（仕様 §2.1）。組み込み Vault の
// `identity.txt`（age の秘密鍵）とまったく同じ扱いで、この Module の
// データ置き場に 0600 で置く。
//
// 環境変数も引き続き読む（開発・E2E はそちら）。**保存した設定が勝つ**
// ——人が画面で入れたものを、環境変数が黙って上書きしない。

import { readFile, writeFile, mkdir, rename, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { InfisicalConfig } from "./client.js";

/**
 * Infisical Cloud の住所（実在を確認済み・2026-09-13）。
 * **自前ホストのときは URL をそのまま受け取る**ので、ここには入れない。
 */
export const CLOUD_SITES = {
  us: "https://app.infisical.com",
  eu: "https://eu.infisical.com",
} as const;

export type CloudRegion = keyof typeof CLOUD_SITES;

/** 画面が送ってくる形。`siteUrl` は「自前」のときだけ意味がある。 */
export interface InfisicalSettingsInput {
  /** `us` / `eu` / `self`（自前ホスト）。 */
  target: CloudRegion | "self";
  siteUrl?: string;
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment?: string;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} が要ります`);
  return value.trim();
}

/** 入力を接続設定に直す。**足りないものを既定で埋めない**（規則2）。 */
export function toConfig(input: InfisicalSettingsInput): InfisicalConfig {
  const siteUrl =
    input.target === "self"
      ? requiredText(input.siteUrl, "接続先の URL")
      : CLOUD_SITES[input.target as CloudRegion];
  if (!siteUrl) throw new Error(`接続先が分かりません（${String(input.target)}）`);
  if (input.target === "self" && !/^https?:\/\//.test(siteUrl)) {
    throw new Error("接続先の URL は http:// か https:// で始めてください");
  }
  return {
    siteUrl,
    clientId: requiredText(input.clientId, "Client ID"),
    clientSecret: requiredText(input.clientSecret, "Client Secret"),
    projectId: requiredText(input.projectId, "Project ID"),
    environment: (input.environment ?? "dev").trim() || "dev",
  };
}

/** 画面に返す形。**Client Secret は返さない**——入っているかどうかだけ。 */
export interface InfisicalSettingsView {
  configured: boolean;
  target: CloudRegion | "self";
  siteUrl: string;
  clientId: string;
  projectId: string;
  environment: string;
  /** 画面に出すための印。値そのものは決して返さない。 */
  hasClientSecret: boolean;
  /** 設定がどこから来たか——`saved`（画面で入れた）／`env`（環境変数）／`none`。 */
  source: "saved" | "env" | "none";
}

export function viewOf(config: InfisicalConfig | undefined, source: "saved" | "env" | "none"): InfisicalSettingsView {
  if (!config) {
    return {
      configured: false,
      target: "us",
      siteUrl: "",
      clientId: "",
      projectId: "",
      environment: "dev",
      hasClientSecret: false,
      source: "none",
    };
  }
  const target =
    (Object.keys(CLOUD_SITES) as CloudRegion[]).find((r) => CLOUD_SITES[r] === config.siteUrl) ?? "self";
  return {
    configured: true,
    target,
    siteUrl: config.siteUrl,
    clientId: config.clientId,
    projectId: config.projectId,
    environment: config.environment,
    hasClientSecret: Boolean(config.clientSecret),
    source,
  };
}

/**
 * 保存した設定。**この Module のデータ置き場に 0600 で置く。**
 *
 * `aliases.json` と同じ書き方（tmp → rename）——書いている途中の中身を
 * 誰かが読むことがない。
 */
export class InfisicalSettingsStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "connection.json");
  }

  async load(): Promise<InfisicalConfig | undefined> {
    if (!existsSync(this.filePath)) return undefined;
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<InfisicalConfig>;
      if (!raw.siteUrl || !raw.clientId || !raw.clientSecret || !raw.projectId) return undefined;
      return {
        siteUrl: raw.siteUrl,
        clientId: raw.clientId,
        clientSecret: raw.clientSecret,
        projectId: raw.projectId,
        environment: raw.environment ?? "dev",
      };
    } catch {
      // **壊れた設定を「たぶんこう」で読まない**（規則2）——未設定として扱い、
      // 人が画面から入れ直せる状態にする
      return undefined;
    }
  }

  async save(config: InfisicalConfig): Promise<void> {
    await mkdir(join(this.filePath, ".."), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(config), { mode: 0o600 });
    await rename(tmp, this.filePath);
    await chmod(this.filePath, 0o600);
  }
}
