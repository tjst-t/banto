// docs/specs/v4-architecture.md §2.5「Module 側がこの中継 tool にどう到達するか」
// のModule側実装。BANTO_HOST_MCP_URL・BANTO_HOST_MCP_TOKENはhostが起動時に
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

export class HostRelayClient {
  private client?: Client;

  constructor(private readonly opts: HostRelayClientOptions) {}

  private async ensureConnected(): Promise<Client> {
    if (this.client) return this.client;
    const transport = new StreamableHTTPClientTransport(new URL(this.opts.url), {
      requestInit: { headers: { authorization: `Bearer ${this.opts.token}` } },
    });
    const client = new Client({ name: "banto-module-shell", version: "0.1.0" });
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
    return (result.content as { type: string; text: string }[])[0]?.text;
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
  ): Promise<{ implementation: string }> {
    const text = await this.callRelay(
      { targetModule: directoryModule, name: "lookupAlias", arguments: { name } },
      onProgress,
    );
    const found = JSON.parse(text ?? "{}") as { implementation?: string };
    // 在りかが分からないまま既定の Vault へ落とすと、**別の金庫の同名を
    // 開けてしまう**。黙って別の経路へ行かない（規則2）
    if (!found.implementation) throw new Error(`alias "${name}" の在りかが分かりません`);
    return { implementation: found.implementation };
  }

  async resolveAlias(
    targetModule: string,
    name: string,
    onProgress?: RelayProgressListener,
  ): Promise<string> {
    const text = await this.callRelay(
      { targetModule, name: "resolveAlias", arguments: { name } },
      onProgress,
    );
    if (typeof text !== "string") throw new Error(`alias "${name}" の解決に失敗しました`);
    return text;
  }

  async startSshAgent(
    targetModule: string,
    identity: string,
    onProgress?: RelayProgressListener,
  ): Promise<{ socketPath: string }> {
    const text = await this.callRelay(
      { targetModule, name: "startSshAgent", arguments: { identity } },
      onProgress,
    );
    return JSON.parse(text ?? "{}") as { socketPath: string };
  }

  async close(): Promise<void> {
    await this.client?.close();
  }
}
