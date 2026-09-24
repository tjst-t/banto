// docs/specs/v4-architecture.md §2.5「Module 側がこの中継 tool にどう到達するか」
// のModule側実装。Shell の同名のファイルから、要る分（在りかを引く・値を受け取る）だけを写した
// ——Module は互いの内部を import しない。BANTO_HOST_MCP_URL・BANTO_HOST_MCP_TOKENはhostが起動時に
// envで渡す（決定・2026-09-03）。
//
// **待つ側の上限を、進捗で更新し続ける**（追加・2026-09-10）。中継の初回は
// host が人に承認を聞くので、返事が来るまでこの呼び出しは待つ——既定の60秒で
// 切れると「人が答えたのに、その回のコマンドは失敗している」になる。
// host からの `notifications/progress` を受けたらタイムアウトを引き延ばし、
// **さらに自分の呼び出し元（＝AI のターン）へも中継する**——さもないと、
// この呼び出しが生きていても外側の tool 呼び出しが先に切れる。

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface HostRelayClientOptions {
  url: string;
  token: string;
}

/** 待っている間の合図（host から届いた進捗を、そのまま上へ流すため）。 */
export type RelayProgressListener = (note: string) => void;

/**
 * **秘密の在りか**。alias の同一性は (Vault, グループ, 名前) の三つ組
 * （`v4-modules.md` §2.1）なので、**運ぶときも三つ組のまま運ぶ**。
 *
 * 平たくして名前だけにすると、受け取った側が自分の既定解決で復元することになり、
 * **別の秘密を開ける／見つからない**が起きる（実際に起きていた・2026-09-15）。
 */
export interface AliasPlace {
  implementation: string;
  /** backend での本当の名前（修飾名ではない） */
  name: string;
  /** 置き場。省くと backend の既定解決に落ちるので、**引けたなら必ず入れる** */
  group?: string;
}

export class HostRelayClient {
  private client?: Client;

  constructor(private readonly opts: HostRelayClientOptions) {}

  private async ensureConnected(): Promise<Client> {
    if (this.client) return this.client;
    const transport = new StreamableHTTPClientTransport(new URL(this.opts.url), {
      requestInit: { headers: { authorization: `Bearer ${this.opts.token}` } },
    });
    const client = new Client({ name: "banto-module-subagent", version: "0.1.0" });
    await client.connect(transport);
    this.client = client;
    return client;
  }

  /** 中継を1本呼ぶ。**進捗を受け取れる形**で呼ぶのはここ1箇所（規則3）。 */
  private async callRelay(
    args: Record<string, unknown>,
    onProgress?: RelayProgressListener,
  ): Promise<string | undefined> {
    const client = await this.ensureConnected();
    // `onprogress` を渡すと、SDK が progressToken を付けてくれる（host は
    // それを見て進捗を送れる）。**渡さないと host は送りようがない**
    const result = await client.callTool({ name: "relayCallTool", arguments: args }, undefined, {
      resetTimeoutOnProgress: true,
      onprogress: (progress) => {
        onProgress?.(progress.message ?? "host の返事を待っています");
      },
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text;
    // **相手が断ったら、断ったと言う**（規則2）——エラーの文言を値として持ち帰らない
    if (result.isError) throw new Error(text ?? `${String(args.targetModule)} の ${String(args.name)} が失敗しました`);
    return text;
  }

  /**
   * 名前から**在りか**を引く（`vault-directory` の窓口）。**値は通らない**
   * ——返るのは「どの Vault にあるか」だけで、値は引いたあと backend を
   * 直接呼んで受け取る（アーキ仕様 §2.5、DNS と同じ形）。
   */
  async lookupAlias(
    directoryModule: string,
    name: string,
    onProgress?: RelayProgressListener,
  ): Promise<AliasPlace> {
    const text = await this.callRelay(
      { targetModule: directoryModule, name: "lookupAlias", arguments: { name } },
      onProgress,
    );
    const found = JSON.parse(text ?? "{}") as { implementation?: string; name?: string; group?: string };
    // 在りかが分からないまま既定の Vault へ落とすと、**別の金庫の同名を
    // 開けてしまう**。黙って別の経路へ行かない（規則2）
    if (!found.implementation) throw new Error(`alias "${name}" の在りかが分かりません`);
    // **窓口が返した名前と置き場をそのまま運ぶ**（訂正・2026-09-15）。
    // 以前は implementation だけを読み、`resolveAlias` には AI が書いた文字列を
    // そのまま渡していた——**修飾名（`vault-infisical:npm-token`）だと backend に
    // その名前は無く、一覧に出た名前が使えない**という形で壊れていた。
    // 窓口自身が「name は backend での本当の名前」と言っているのに、捨てていた。
    if (!found.name) throw new Error(`alias "${name}" の本当の名前が分かりません`);
    return { implementation: found.implementation, name: found.name, group: found.group };
  }

  async resolveAlias(place: AliasPlace, onProgress?: RelayProgressListener): Promise<string> {
    const text = await this.callRelay(
      {
        targetModule: place.implementation,
        name: "resolveAlias",
        arguments: { name: place.name, group: place.group },
      },
      onProgress,
    );
    if (typeof text !== "string") throw new Error(`alias "${place.name}" の解決に失敗しました`);
    return text;
  }

  /** Vault の目録（名前と置き場だけ——値は通らない） */
  async listAliases(directoryModule: string): Promise<{ name: string; implementation: string; group?: string }[]> {
    const text = await this.callRelay({ targetModule: directoryModule, name: "listAliases", arguments: {} });
    const body = JSON.parse(text ?? "{}") as { aliases?: { name: string; implementation: string; group?: string }[] };
    return body.aliases ?? [];
  }

  /** 人が設定画面で入れた鍵を、窓口経由で Vault にしまう（値は窓口を通って金庫へ——§2.1） */
  async createAlias(directoryModule: string, alias: { name: string; value: string; note: string }): Promise<void> {
    await this.callRelay({
      targetModule: directoryModule,
      name: "createAlias",
      arguments: { name: alias.name, kind: "secret", value: alias.value, note: alias.note },
    });
  }

  async close(): Promise<void> {
    await this.client?.close();
  }
}
