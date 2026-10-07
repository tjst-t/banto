#!/usr/bin/env node
// **Infisical を使う Vault**（role `vault` の2本目、2026-09-12）。
//
// A/B/C の配線と alias 管理は `@banto/vault-kit` が持つ。この Module が書くのは
// 「秘密をどこに置くか」と「メタデータをどこに置くか」だけ。
//
// **メタデータは Infisical の中**（`InfisicalAliasStore`）。組み込み Vault は
// ローカルのファイルで足りるが、Infisical は「複数台のホストで同じ backend を
// 共有する」ことが眼目なので、**メタデータもそこに無いと共有が成立しない**。
//
// **繋ぎ方は人が画面から入れる**（改訂・2026-09-13、ユーザー要望）。以前は
// 環境変数だけで、**設定していないと Module が立たなかった**——立たないので
// 設定画面にも辿り着けず、host は毎回「繋げませんでした」を受信箱に出していた。
// いまは**未設定でも立つ**：設定画面を出し、値を触る口は理由つきで断る。
//
// **資格情報は Infisical には入れられない**（金庫を開ける鍵は金庫に入らない）
// ——この Module のデータ置き場に 0600 で置く（`settings-store.ts`）。
// **banto の宣言には書かない**——宣言は Event Store に残るため。

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createVaultModuleServer } from "@banto/vault-kit";
import { VISIBILITY_META_KEY, VALUE_FREE_META_KEY } from "@banto/module-contract";
import { InfisicalConnection, readConfigFromEnv, type InfisicalConfig } from "./client.js";
import { InfisicalTokenCache } from "./token-cache.js";
import { InfisicalBackend } from "./infisical-backend.js";
import { InfisicalAliasStore } from "./infisical-alias-store.js";
import { CONFIG_APP_HTML, CONFIG_APP_URI } from "./config-app.js";
import {
  InfisicalSettingsStore,
  toConfig,
  viewOf,
  type InfisicalSettingsInput,
} from "./settings-store.js";

/**
 * 設定が入るまで繋がない。**入ったら繋ぎ直す**——人が画面で直した直後から
 * 使えないと、「保存したのに動かない」になる。
 */
class LazyConnection {
  private conn?: InfisicalConnection;
  private config?: InfisicalConfig;
  private source: "saved" | "env" | "none" = "none";
  private lastError?: string;

  constructor(
    private readonly settings: InfisicalSettingsStore,
    /** 環境変数からの既定を使ってよいか（正規の1本だけ）。 */
    private readonly mayUseEnv: boolean,
    /** 前回のログインの結果。**起動のたびのログインを避けるため**（2026-09-20）。 */
    private readonly tokens: InfisicalTokenCache,
  ) {}

  /** 立ち上がり。**繋がらなくても投げない**（投げると Module ごと落ちる）。 */
  async start(): Promise<void> {
    const saved = await this.settings.load();
    if (saved) {
      // **繋がらなくても立つ**（訂正・2026-09-20、ユーザー報告）。ここだけ例外を
      // 捕まえておらず、**保存済みの資格情報が拒否されると Module ごと落ちていた**
      // ——落ちると設定画面も消えるので、**入れ直す手段が無くなる**。
      // 2026-09-13 に「設定していないと立たない→設定画面に辿り着けない」を潰した
      // はずが、「設定はあるが通らない」で同じ行き止まりに戻っていた。
      // 資格情報は期限切れ・使用回数切れ・取り消しで**普通に通らなくなる**ので、
      // これは例外的な状態ではない
      try {
        await this.use(saved, "saved");
      } catch (err) {
        this.config = saved;
        this.source = "saved";
        this.lastError = err instanceof Error ? err.message : String(err);
      }
      return;
    }
    // 環境変数は開発・E2E の経路。**無ければ未設定のまま立つ**
    if (!this.mayUseEnv) {
      this.lastError = "接続先と資格情報が設定されていません（設定画面から入れてください）";
      return;
    }
    try {
      await this.use(readConfigFromEnv(), "env");
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * その設定で実際に繋いでみる。**繋がって初めて「使える」**（規則1）。
   *
   * @param forceLogin **資格情報そのものを試す**（覚えているトークンで通さない）。
   * 人が設定画面で入れ直したときはこちら——さもないと、**間違った Client Secret を
   * 貼っても「繋がった」ことになって保存される**。
   */
  async use(config: InfisicalConfig, source: "saved" | "env", forceLogin = false): Promise<void> {
    const conn = new InfisicalConnection(config, this.tokens);
    await conn.connect({ forceLogin });
    this.conn = conn;
    this.config = config;
    this.source = source;
    this.lastError = undefined;
  }

  /** 使える状態か。**理由を持って返す**——画面と受信箱がそのまま出せる形。 */
  readiness(): { ready: boolean; reason?: string } {
    if (this.conn) return { ready: true };
    return { ready: false, reason: this.lastError ?? "接続先と資格情報が設定されていません" };
  }

  view() {
    const base = viewOf(this.config, this.config ? this.source : "none");
    // **繋がっていないのに「繋がっています」と出さない**（訂正・2026-09-20）。
    // 設定が入っていることと、その設定で繋がることは別。**欄は埋めたまま**
    // （入れ直す手間を増やさない）で、**状態だけは正直に出す**（規則2・規則13）
    return { ...base, configured: !!this.conn, lastError: this.lastError };
  }

  /** backend / alias 置き場が使う。**未設定なら理由つきで断る**（黙って空を返さない）。 */
  active(): InfisicalConnection {
    if (!this.conn) throw new Error(this.readiness().reason ?? "未設定です");
    return this.conn;
  }
}

/**
 * **この実装の正規の名前**。同じ実装を2本以上立てられる（自前ホストと
 * Infisical Cloud を並べるなど）ので、**「自分がどの1本か」で振る舞いが変わる**
 * ところが2つある——画面に出す名前と、環境変数からの既定（下記）。
 */
const CANONICAL_NAME = "vault-infisical";

export function createInfisicalVaultServer(dataDir: string, moduleName = CANONICAL_NAME) {
  const settings = new InfisicalSettingsStore(dataDir);
  // **環境変数の既定は、正規の1本にだけ効かせる**（決定・2026-09-15）。
  // `BANTO_INFISICAL_*` は**1つの接続先**を指す値なので、写しにも効かせると
  // **2本目が黙って1本目と同じサーバに繋がる**——同じ秘密が2つの名前で
  // 一覧に並び、人には理由が分からない（規則2——黙って別の経路へ行かない）
  const lazy = new LazyConnection(settings, moduleName === CANONICAL_NAME, new InfisicalTokenCache(dataDir));
  // backend と台帳には「いま繋がっている接続」を毎回引かせる——繋ぎ直しても
  // 古い接続を掴まない（規則3——写しを持たない）
  const proxy = new Proxy({} as InfisicalConnection, {
    get: (_t, prop) => Reflect.get(lazy.active() as object, prop, lazy.active()),
  });
  const backend = new InfisicalBackend(proxy);

  return createVaultModuleServer({
    moduleName,
    backend,
    aliasStore: new InfisicalAliasStore(proxy),
    dataDir,
    configApp: {
      uri: CONFIG_APP_URI,
      html: CONFIG_APP_HTML,
      // **2本以上立てたら、どれか分かる名前にする**（追加・2026-09-15）。
      // 設定画面の見出しはこの名前なので、固定にすると同じ見出しが並ぶ
      name: moduleName === CANONICAL_NAME ? "Vault（Infisical）" : `Vault（Infisical：${moduleName}）`,
    },
    // グループ＝フォルダ（管理画面の「＋ 新しいグループを作る…」に添える、2026-10-07）
    groupCreateNote: "Infisical ではフォルダができます",
    // **未設定でも立つ**。繋がらない理由は readiness で返す
    init: () => lazy.start(),
    readiness: async () => lazy.readiness(),
    extraTools: [
      {
        definition: {
          name: "getConnectionSettings",
          description:
            "Infisical への繋ぎ方（接続先・Client ID・Project）を読む。**Client Secret は返さない**——入っているかどうかだけ",
          inputSchema: { type: "object", properties: {} },
          _meta: { [VISIBILITY_META_KEY]: "admin", [VALUE_FREE_META_KEY]: true },
        },
        handle: async () => ({ content: [{ type: "text" as const, text: JSON.stringify(lazy.view()) }] }),
      },
      {
        definition: {
          name: "setConnectionSettings",
          description:
            "Infisical への繋ぎ方を保存する。**実際に繋いでみて、繋がったときだけ保存する**。" +
            "clientSecret を省くと、いま保存されているものを使う",
          inputSchema: {
            type: "object",
            properties: {
              target: { type: "string", enum: ["us", "eu", "self"], description: "Cloud US / Cloud EU / 自前ホスト" },
              siteUrl: { type: "string", description: "自前ホストのときの URL" },
              clientId: { type: "string" },
              clientSecret: { type: "string" },
              projectId: { type: "string" },
              environment: { type: "string", description: "dev / staging / prod など（既定 dev）" },
            },
            // **Client Secret は、既に保存されているなら省ける**（改訂・2026-09-15）
            required: ["target", "clientId", "projectId"],
          },
          _meta: { [VISIBILITY_META_KEY]: "admin" },
        },
        handle: async (args) => {
          // 空で来たら、いま保存されているものを使う（接続先や環境だけ直す場合）
          const saved = await settings.load();
          const config = toConfig(args as unknown as InfisicalSettingsInput, saved?.clientSecret);
          // **繋がってから保存する**（規則1——自己申告を信頼しない）。
          // 保存してから繋ぐと、間違った設定が残って毎回失敗する
          // **ここは本物のログインで試す**——覚えているトークンで通すと、
          // 間違った Client Secret を貼っても「繋がった」ことになる（規則1）
          await lazy.use(config, "saved", true);
          await settings.save(config);
          return { content: [{ type: "text" as const, text: JSON.stringify(lazy.view()) }] };
        },
      },
    ],
  });
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const dataDir =
    process.env.BANTO_VAULT_INFISICAL_DATA_DIR ?? `${process.env.HOME}/.local/share/banto/vault-infisical`;
  const server = createInfisicalVaultServer(dataDir, process.env.BANTO_MODULE_NAME ?? CANONICAL_NAME);
  await server.connect(new StdioServerTransport());
}
