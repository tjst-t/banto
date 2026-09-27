// host の中継（docs/specs/v4-architecture.md §2.5）のうち、この実装が使う口だけ。
// Shell・vault-directory・subagent もそれぞれ小さな写しを持っている——共有にするかは `module-kit-extract`
// （docs/tasks.json）で差分を見て決める。ここでその判断を先取りしない。

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export class HostRelay {
  private client?: Promise<Client>;

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private connect(): Promise<Client> {
    if (!this.client) {
      const c = new Client({ name: "banto-module-publish-caddy", version: "0.1.0" });
      this.client = c
        .connect(new StreamableHTTPClientTransport(new URL(this.url), { requestInit: { headers: { authorization: `Bearer ${this.token}` } } }))
        .then(() => c);
      // 繋げなかったら次にやり直す（一度の失敗を覚え続けない）
      this.client.catch(() => {
        this.client = undefined;
      });
    }
    return this.client;
  }

  /** host からその Project のコンテナに届くアドレス。**覚えない**——変わりうる（DHCP） */
  async projectAddress(projectId: string): Promise<string> {
    const client = await this.connect();
    const result = await client.callTool({ name: "relayProjectAddress", arguments: { projectId } });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    if (result.isError) throw new Error(text || "アドレスを引けませんでした");
    const { address } = JSON.parse(text) as { address?: unknown };
    if (typeof address !== "string" || address === "") throw new Error("host がアドレスを返しませんでした");
    return address;
  }
}
