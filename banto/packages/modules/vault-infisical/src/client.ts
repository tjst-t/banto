// Infisical への接続（`@infisical/sdk`）。
//
// **行き先は Infisical Cloud**（確認・2026-09-12、ユーザー）。開発と試験では
// docker で立てた自前ホストを相手にするが、**違いは `siteUrl` と資格情報だけ**
// ——このファイルに自前ホスト固有の前提を書かない（Cloud だけの機能・有料段に
// しか無い機能にも依存しない）。
//
// **資格情報は Infisical には入れられない**（金庫を開ける鍵は金庫に入らない）。
// 組み込み Vault の `identity.txt`（age の秘密鍵）とまったく同じ category
// ——仕様が「alias 解決の対象ではない、唯一、本当に特別な1点」と呼んでいるもの。
// ここでは Module 起動時の環境変数として受け取る（宣言 → host が渡す）。

import { InfisicalSDK } from "@infisical/sdk";

export interface InfisicalConfig {
  /** `https://app.infisical.com`（Cloud）か、自前ホストの住所。 */
  siteUrl: string;
  /** Machine Identity（Universal Auth）。 */
  clientId: string;
  clientSecret: string;
  /** 秘密を置く Project。 */
  projectId: string;
  /** Infisical の環境（`dev` / `staging` / `prod`）。 */
  environment: string;
}

/** 足りない設定を**黙って既定に倒さない**（規則2）——立たないなら理由を言って立たない。 */
export function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): InfisicalConfig {
  const required = {
    siteUrl: env.BANTO_INFISICAL_SITE_URL,
    clientId: env.BANTO_INFISICAL_CLIENT_ID,
    clientSecret: env.BANTO_INFISICAL_CLIENT_SECRET,
    projectId: env.BANTO_INFISICAL_PROJECT_ID,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => `BANTO_INFISICAL_${k.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`);
  if (missing.length > 0) {
    throw new Error(`Infisical の設定が足りません：${missing.join(", ")}`);
  }
  return {
    siteUrl: required.siteUrl!,
    clientId: required.clientId!,
    clientSecret: required.clientSecret!,
    projectId: required.projectId!,
    environment: env.BANTO_INFISICAL_ENVIRONMENT ?? "dev",
  };
}

/**
 * ログイン済みの SDK を1つだけ持つ。
 *
 * **繋がらないことを繋がったように見せない**（規則2）——`login()` が失敗したら
 * そのまま投げる。host は「繋げませんでした」を理由つきで受信箱に出す。
 */
export class InfisicalConnection {
  private sdk?: InfisicalSDK;

  constructor(readonly config: InfisicalConfig) {}

  async connect(): Promise<void> {
    const sdk = new InfisicalSDK({ siteUrl: this.config.siteUrl });
    await sdk.auth().universalAuth.login({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
    });
    this.sdk = sdk;
  }

  private ready(): InfisicalSDK {
    if (!this.sdk) throw new Error("Infisical にまだログインしていません");
    return this.sdk;
  }

  // **戻り値の型を明示する**——SDK の返す無名クラスは private を持つので、
  // 推論に任せると「export できない型」になる
  secrets(): ReturnType<InfisicalSDK["secrets"]> {
    return this.ready().secrets();
  }

  folders(): ReturnType<InfisicalSDK["folders"]> {
    return this.ready().folders();
  }

  /** どの Project・どの環境か。呼び出しのたびに要る共通の引数。 */
  get scope(): { projectId: string; environment: string } {
    return { projectId: this.config.projectId, environment: this.config.environment };
  }
}
