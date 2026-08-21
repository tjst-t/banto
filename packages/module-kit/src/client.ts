/**
 * モジュールを**呼ぶ**側（要件 C10・C13）。
 *
 * 決定5 は「モジュールは他のモジュールのツールインターフェースを**クライアントとして
 * 直接呼ぶ**。Banto は経路に入らない」と定めている。要件 C13 でその相手に
 * 中核同梱のものも入ったので、**呼び方は1つだけあればよい。**
 *
 * ここが無いと、呼ぶ側がそれぞれ MCP クライアントの組み立てを持つことになる
 * ——同じことが何箇所にも散る。
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** ツールを1つ呼ぶ。**返るのはテキスト**——MCP の契約がそうなっている。 */
export interface ToolCaller {
  call(tool: string, args: Record<string, unknown>): Promise<string>;
  /**
   * 実在するツール名（要件 C11）。
   *
   * **繋いだ口から聞く。** 台帳の突き合わせに使うので、ここを手で書いた一覧に
   * すると「自己申告を自己申告で確かめる」ことになって何も証明しない（規則1）。
   */
  listTools(): Promise<string[]>;
  close(): Promise<void>;
}

/**
 * 返事からテキストを取り出す。
 *
 * **`isError` を握りつぶさない**（規則2）。モジュールが「断った」と言っているのに
 * 普通の返事として通すと、断りが黙って無視される。
 */
function textOf(result: unknown, tool: string): string {
  const r = result as {
    isError?: boolean;
    content?: { type: string; text?: string }[];
  };
  const text = (r.content ?? [])
    .flatMap((c) => (c.type === 'text' && typeof c.text === 'string' ? [c.text] : []))
    .join('\n');
  if (r.isError === true) throw new Error(`${tool} が断った: ${text}`);
  return text;
}

function callerOf(client: Client): ToolCaller {
  return {
    call: async (tool, args) =>
      textOf(await client.callTool({ name: tool, arguments: args }), tool),
    listTools: async () => (await client.listTools()).tools.map((t) => t.name),
    close: async () => {
      await client.close().catch(() => undefined);
    },
  };
}

/** in-process のモジュールに繋ぐ。**IPC は無い**が、契約は MCP のまま（要件 C8b）。 */
export async function connectInProcess(server: McpServer): Promise<ToolCaller> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'banto', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return callerOf(client);
}

/** subprocess のモジュールに繋ぐ。 */
export async function connectSubprocess(
  command: string,
  args: readonly string[] = [],
): Promise<ToolCaller> {
  const client = new Client({ name: 'banto', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command, args: [...args] }));
  return callerOf(client);
}
