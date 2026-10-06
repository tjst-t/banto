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
import { InfisicalTokenCache, tokenKeyOf } from "./token-cache.js";

/**
 * **そのトークンで、この Project を実際に読めるか。**
 *
 * ログインの代わりの確かめ——**1往復かかるが、ログイン回数は消費しない**。
 * 落ちた理由（期限切れ／取り消し／到達できない）は区別しない：どれであっても
 * 「このトークンでは進めない」で、次の手（ログイン）は同じ。ログインも駄目なら
 * そのときの例外がそのまま上がる（規則2——ここで握りつぶすのは**判定**であって、
 * 失敗ではない）。
 */
async function stillUsable(sdk: InfisicalSDK, config: InfisicalConfig): Promise<boolean> {
  try {
    await sdk.folders().listFolders({
      projectId: config.projectId,
      environment: config.environment,
      path: "/",
    });
    return true;
  } catch {
    return false;
  }
}

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

  constructor(
    readonly config: InfisicalConfig,
    /**
     * **前回のログインの結果**（追加・2026-09-20、ユーザー指示）。
     * 渡さないとき（試験など）は、毎回ログインする今までの挙動。
     */
    private readonly tokens?: InfisicalTokenCache,
  ) {}

  /**
   * **覚えているトークンがあれば、ログインしない**（決定・2026-09-20、ユーザー指示）。
   *
   * Client Secret には使用回数の上限を付けられるので、**起動のたびに1回ログイン
   * すると、再起動のたびに残数が減る**——実際に切れた（2026-09-20）。
   *
   * 期限は持たない。**使ってみて駄目なら、そのときログインし直す**
   * （規則3——推測した期限を保存しない）。
   *
   * @param opts.forceLogin **資格情報そのものを試したいとき**に立てる。
   * 設定画面の「繋いで保存する」がこれ——覚えているトークンで通してしまうと、
   * **間違った Client Secret を貼っても「繋がった」ことになる**（規則1）。
   */
  async connect(opts: { forceLogin?: boolean } = {}): Promise<void> {
    if (!opts.forceLogin && this.tokens) {
      const cached = await this.tokens.load(tokenKeyOf(this.config));
      if (cached) {
        const sdk = new InfisicalSDK({ siteUrl: this.config.siteUrl });
        sdk.auth().accessToken(cached);
        if (await stillUsable(sdk, this.config)) {
          this.sdk = sdk;
          return;
        }
        // 期限切れか、取り消されたか。**残しておくと毎回ここで1往復無駄になる**
        await this.tokens.forget();
      }
    }
    const sdk = new InfisicalSDK({ siteUrl: this.config.siteUrl });
    await sdk.auth().universalAuth.login({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
    });
    const token = sdk.auth().getAccessToken();
    if (token && this.tokens) await this.tokens.save(tokenKeyOf(this.config), token);
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

  /** どの Project・どの環境か。呼び出しのたびに要る共通の引数（接続設定の環境＝既定の版）。 */
  get scope(): { projectId: string; environment: string } {
    return { projectId: this.config.projectId, environment: this.config.environment };
  }

  /** 版（環境）を指定した共通の引数。無ければ接続設定の環境（2026-10-06）。 */
  scopeFor(env: string | undefined): { projectId: string; environment: string } {
    return { projectId: this.config.projectId, environment: env ?? this.config.environment };
  }

  /**
   * **その Project の環境の一覧**（slug、2026-10-06）。SDK に口が無いので Infisical の API を直接呼ぶ
   * ——`GET /api/v1/projects/{id}`（新しい形）、無ければ `GET /api/v1/workspace/{id}`（古い自前ホスト）。
   * 応答の `project`／`workspace` の `environments[].slug` を返す。読めなければ理由を言って止まる（規則2）
   */
  async listEnvironments(): Promise<string[]> {
    const token = this.ready().auth().getAccessToken();
    if (!token) throw new Error("Infisical のアクセストークンがありません（ログインし直してください）");
    const base = this.config.siteUrl.replace(/\/+$/, "");
    const id = encodeURIComponent(this.config.projectId);
    const failures: string[] = [];
    for (const [path, field] of [
      [`/api/v1/projects/${id}`, "project"],
      [`/api/v1/workspace/${id}`, "workspace"],
    ] as const) {
      const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        failures.push(`${path} → ${res.status}`);
        continue;
      }
      const body = (await res.json()) as Record<string, { environments?: Array<{ slug?: unknown }> } | undefined>;
      const envs = body[field]?.environments;
      if (!Array.isArray(envs)) {
        failures.push(`${path} の応答に ${field}.environments がありません`);
        continue;
      }
      return envs.map((e) => e.slug).filter((slug): slug is string => typeof slug === "string");
    }
    throw new Error(`Infisical の環境の一覧を読めませんでした（${failures.join("、")}）`);
  }
}
