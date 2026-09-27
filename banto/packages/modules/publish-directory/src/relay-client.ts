// host の中継（docs/specs/v4-architecture.md §2.5）のうち、窓口が使う口。
// vault-directory の `relay-client.ts` と同じ形——**共有にはまだしない**（`module-kit-extract`、docs/tasks.json）。
// 違いは **isError を捨てない**こと：公開の実装の断り（「もう公開しています」等）を、解釈できる形で受け取る。

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface RelayTarget {
  name: string;
  roles: string[];
}

export interface RelayResult {
  text: string;
  isError: boolean;
}

/** 窓口が中継に求めるのはこれだけ（試験では偽の Service と本物の実装に直接繋ぐ）。 */
export interface RelayLike {
  /** 自分が呼んでよい相手（role つき）。**Project の Module は、その Project のための呼び出しの中でだけ出る** */
  listTargets(): Promise<RelayTarget[]>;
  callTool(targetModule: string, name: string, args: Record<string, unknown>): Promise<RelayResult>;
  /** 返信用の札で、呼び出し元の Thread に届ける（届いたらその Thread の AI が起きる） */
  deliver(input: { replyTo: string; title: string; text: string; final: boolean }): Promise<void>;
}

export class HostRelayClient implements RelayLike {
  private client?: Promise<Client>;

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private connect(): Promise<Client> {
    if (!this.client) {
      const c = new Client({ name: "banto-module-publish-directory", version: "0.1.0" });
      this.client = c
        .connect(new StreamableHTTPClientTransport(new URL(this.url), { requestInit: { headers: { authorization: `Bearer ${this.token}` } } }))
        .then(() => c);
      this.client.catch(() => {
        this.client = undefined;
      });
    }
    return this.client;
  }

  private async call(name: string, args: Record<string, unknown>): Promise<RelayResult> {
    const client = await this.connect();
    // 中継の初回は host が人に承認を聞く——待っている間、既定の60秒で切れないよう進捗で上限を延ばす
    const result = await client.callTool({ name, arguments: args }, undefined, {
      resetTimeoutOnProgress: true,
      onprogress: () => undefined,
    });
    return { text: (result.content as { type: string; text: string }[])[0]?.text ?? "", isError: result.isError === true };
  }

  async listTargets(): Promise<RelayTarget[]> {
    const r = await this.call("relayListTargets", {});
    if (r.isError) throw new Error(r.text || "中継が相手の一覧を返しませんでした");
    return JSON.parse(r.text) as RelayTarget[];
  }

  callTool(targetModule: string, name: string, args: Record<string, unknown>): Promise<RelayResult> {
    return this.call("relayCallTool", { targetModule, name, arguments: args });
  }

  async deliver(input: { replyTo: string; title: string; text: string; final: boolean }): Promise<void> {
    const r = await this.call("relayDeliverToThread", input);
    if (r.isError) throw new Error(r.text || "Thread に届けられませんでした");
  }
}
