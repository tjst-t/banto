// docs/specs/v4-architecture.md §2.5「Module 側がこの中継 tool にどう到達するか」
// のModule側実装。BANTO_HOST_MCP_URL・BANTO_HOST_MCP_TOKENはhostが起動時に
// envで渡す（決定・2026-09-03）。

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface HostRelayClientOptions {
  url: string;
  token: string;
}

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

  async resolveAlias(targetModule: string, name: string): Promise<string> {
    const client = await this.ensureConnected();
    const result = await client.callTool({
      name: "relayCallTool",
      arguments: { targetModule, name: "resolveAlias", arguments: { name } },
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text;
    if (typeof text !== "string") throw new Error(`alias "${name}" の解決に失敗しました`);
    return text;
  }

  async startSshAgent(targetModule: string, identity: string): Promise<{ socketPath: string }> {
    const client = await this.ensureConnected();
    const result = await client.callTool({
      name: "relayCallTool",
      arguments: { targetModule, name: "startSshAgent", arguments: { identity } },
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text;
    return JSON.parse(text ?? "{}") as { socketPath: string };
  }

  async close(): Promise<void> {
    await this.client?.close();
  }
}
