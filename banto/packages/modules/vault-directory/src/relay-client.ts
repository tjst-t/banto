// host 中継の Module 側（docs/specs/v4-architecture.md §2.5）。
// Shell の `host-relay-client.ts` と同じ形——**共有ライブラリにはまだしない**。
// 2本目が出てきたところなので、3本目で実際の差分を見てから切り出す
// （`module-kit-extract`、docs/tasks.json）。ここでその判断を先取りしない。

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface RelayTarget {
  name: string;
  roles: string[];
}

/**
 * vault-directory が中継に求めるのはこれだけ。**実装ではなくこの形に依存する**
 * ——試験では実 Vault へ直接繋いだ差し替えを入れて、vault-directory の横断の組み立てを
 * 本物の相手で確かめる（中継の HTTP まで持ち込まずに、嘘にもしない）。
 */
export interface RelayLike {
  listTargets(): Promise<RelayTarget[]>;
  callTool(targetModule: string, name: string, args: Record<string, unknown>): Promise<string>;
}

export class HostRelayClient implements RelayLike {
  private client?: Client;

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private async ensureConnected(): Promise<Client> {
    if (this.client) return this.client;
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: { headers: { authorization: `Bearer ${this.token}` } },
    });
    const client = new Client({ name: "banto-module-vault-directory", version: "0.1.0" });
    await client.connect(transport);
    this.client = client;
    return client;
  }

  private async call(name: string, args: Record<string, unknown>): Promise<string | undefined> {
    const client = await this.ensureConnected();
    // 中継の初回は host が人に承認を聞く——待っている間、既定の60秒で切れないよう
    // 進捗で上限を延ばす（Shell と同じ手当て）
    const result = await client.callTool({ name, arguments: args }, undefined, {
      resetTimeoutOnProgress: true,
      onprogress: () => undefined,
    });
    return (result.content as { type: string; text: string }[])[0]?.text;
  }

  /**
   * **自分が呼んでよい Module の一覧**（role つき）。
   * 宛先の名前を決め打ちしない——同じ role を複数の実装が名乗れる（§2.5）。
   */
  async listTargets(): Promise<RelayTarget[]> {
    const text = await this.call("relayListTargets", {});
    if (typeof text !== "string") throw new Error("中継が相手の一覧を返しませんでした");
    return JSON.parse(text) as RelayTarget[];
  }

  /** 相手の tool を1つ呼ぶ。**返ってきた本文をそのまま返す**（解釈は呼び出し側）。 */
  async callTool(targetModule: string, name: string, args: Record<string, unknown>): Promise<string> {
    const text = await this.call("relayCallTool", { targetModule, name, arguments: args });
    if (typeof text !== "string") {
      throw new Error(`${targetModule} の ${name} が本文を返しませんでした`);
    }
    return text;
  }

  async close(): Promise<void> {
    await this.client?.close();
  }
}
