// **OAuth を要る相手に繋ぐ**（決定・2026-09-18、ユーザー指示）。
//
// **プロトコルは SDK が全部持っている**（`@modelcontextprotocol/sdk/client/auth.js`
// が OAuth 2.1 + PKCE・RFC 9728 のリソース探索・RFC 8414 のサーバ探索・
// RFC 7591 の動的クライアント登録を実装済み）。**banto が書くのは2つだけ**
// ——**どこに預けるか**と、**人にどう見せるか**（規則12）。
//
// ## どこに預けるか
//
// **Vault。** refresh token は長命の秘密なので、金庫の仕事そのもの。
// `${secret:…}` と同じ刻印・同じ絞り込み・同じ監査に乗る（秘密の第二の
// 置き場を作らない）。**1つの Module につき1つの alias**（`oauth-<名前>`、
// 種別 `oauth-token`）に JSON でまとめて置く——人は一覧で「何にログイン
// しているか」が見え、**消せばログアウト**になる（規則13）。
//
// ## 人にどう見せるか
//
// **banto はサーバで、人は別の端末のブラウザにいる。** Claude Code のように
// 自分でブラウザを開くことはできない。`redirectToAuthorization` は URL を
// **覚えるだけ**で、画面が「ログインする」ボタンとして出す。
//
// ## 一時の値はメモリに置く
//
// PKCE の `code_verifier` は**数分の寿命**。金庫に書くと、回るたびに共有の
// 置き場へ書き込みが増える（`markUsed` で踏んだのと同じ形）。ここはプロセス
// メモリでよい——**跨ぐ必要があるのは「開始」と「戻り」の間だけ**で、その間に
// host が落ちたらもう一度押せばよい。

import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

/** 金庫へ読み書きする口（host が配線する——ここは金庫の形を知らない）。 */
export interface OAuthVaultStore {
  /** 無ければ `undefined`。 */
  read(alias: string): Promise<string | undefined>;
  /** 作るか置き換える。 */
  write(alias: string, value: string): Promise<void>;
}

/** 金庫に置く中身。**1つの alias にまとめる**（人の一覧を散らかさない）。 */
interface StoredOAuth {
  tokens?: OAuthTokens;
  client?: OAuthClientInformationFull;
}

export interface BantoOAuthProviderOptions {
  /** その Module の宣言上の名前（alias の名前になる）。 */
  moduleName: string;
  /** 戻り先。**https でなければ相手が拒む**（OAuth 2.1）。 */
  redirectUrl: string;
  /** 金庫の口。 */
  vault: OAuthVaultStore;
  /** 人に押してもらう URL が決まったときに呼ばれる。 */
  onAuthorizationUrl(url: URL): void;
  /** 動的クライアント登録に使う申告（名前と戻り先だけ）。 */
  clientName?: string;
  /**
   * **戻ってきたときに、どのログインか分かるための印**（CSRF 対策も兼ねる）。
   * host が作って覚え、`/api/oauth/callback` で引き当てる。
   */
  state?: string;
}

/** その Module の alias 名。**名前から導く**（写しを持たない・規則3）。 */
export function oauthAliasFor(moduleName: string): string {
  return `oauth-${moduleName}`;
}

/**
 * SDK の `OAuthClientProvider`。**保管とボタンだけ**を受け持つ。
 *
 * 型は構造で合わせる（SDK の型を `implements` すると、SDK の版が上がるたびに
 * ここが壊れる。必要な形は下の各メソッドがそのまま示している）。
 */
export class BantoOAuthProvider {
  private verifier: string | undefined;
  private cached: StoredOAuth | undefined;

  /**
   * **追っているログインのときだけ生やす**（SDK 側では省略可）。
   *
   * 背景の接続でも SDK は認可の手順を始めてしまうが、そちらは**印を持たない**
   * ——追っていない流れが印を持つと、人が押した本物の流れと見分けが付かなくなる。
   */
  state?: () => string;

  constructor(private readonly opts: BantoOAuthProviderOptions) {
    if (opts.state) this.state = () => opts.state!;
  }

  get redirectUrl(): string {
    return this.opts.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.opts.clientName ?? `banto (${this.opts.moduleName})`,
      redirect_uris: [this.opts.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  /** 金庫から1回だけ読んで覚える（同じ接続の中で何度も引かない）。 */
  private async load(): Promise<StoredOAuth> {
    if (this.cached) return this.cached;
    const raw = await this.opts.vault.read(oauthAliasFor(this.opts.moduleName));
    if (!raw) {
      this.cached = {};
      return this.cached;
    }
    try {
      this.cached = JSON.parse(raw) as StoredOAuth;
    } catch {
      // **読めないものを「無い」にしない**（規則2）——直す手がかりが消える
      throw new Error(
        `${this.opts.moduleName} のログイン情報が読めません（金庫の "${oauthAliasFor(this.opts.moduleName)}" が壊れています）。消してログインし直してください`,
      );
    }
    return this.cached;
  }

  private async save(patch: StoredOAuth): Promise<void> {
    const next = { ...(await this.load()), ...patch };
    this.cached = next;
    await this.opts.vault.write(oauthAliasFor(this.opts.moduleName), JSON.stringify(next));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.load()).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.save({ tokens });
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    return (await this.load()).client;
  }

  async saveClientInformation(client: OAuthClientInformationFull): Promise<void> {
    await this.save({ client });
  }

  /** **banto はブラウザを開けない**——押してもらう URL を覚えるだけ。 */
  redirectToAuthorization(authorizationUrl: URL): void {
    this.opts.onAuthorizationUrl(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) {
      // **推測で埋めない**（規則2）。押し直してもらうほうが正しい
      throw new Error("ログインの途中の値が残っていません。もう一度「ログインする」を押してください");
    }
    return this.verifier;
  }

  /** ログアウト・やり直しのとき。**金庫の中身は消さない**（消すのは人の操作）。 */
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "verifier" || scope === "all") this.verifier = undefined;
    if (scope === "tokens" || scope === "all" || scope === "client") this.cached = undefined;
  }
}
