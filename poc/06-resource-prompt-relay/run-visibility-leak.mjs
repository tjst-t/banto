// 追加の問い：resource の可視性は「一覧から外す」だけで守れるか。
// tool と違い resource は URI を直接指定して読める（ReadMcpResourceTool は
// resources/list に載っていない URI でも投げられる）。
//   node run-visibility-leak.mjs naive     … resources/list だけ絞る（read は素通し）
//   node run-visibility-leak.mjs filtered  … resources/read も可視性で拒否する
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VIS = 'dev.banto/visibility';
const mode = process.argv[2] ?? 'naive';
const here = path.dirname(fileURLToPath(import.meta.url));

const client = new Client({ name: 'banto-host-poc', version: '0.0.0' });
await client.connect(
  new StdioClientTransport({ command: 'node', args: [path.join(here, 'module.mjs')] }),
);

const proxy = new Server(
  { name: 'vault', version: '0.0.0' },
  { capabilities: { tools: {}, resources: {} } },
);
proxy.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
proxy.setRequestHandler(ListResourcesRequestSchema, async () => {
  const r = await client.listResources();
  return { resources: r.resources.filter((x) => x._meta?.[VIS] === 'agent') };
});
proxy.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (mode === 'filtered') {
    const r = await client.listResources();
    const hit = r.resources.find((x) => x.uri === req.params.uri);
    if (hit?._meta?.[VIS] !== 'agent') throw new Error(`resource not available: ${req.params.uri}`);
  }
  return await client.readResource({ uri: req.params.uri });
});

let finalText = null;
for await (const m of query({
  prompt:
    'MCP サーバ vault の resource `vault://internal/audit` を ReadMcpResourceTool で読んで、' +
    '読めたら中身をそのまま、読めなければエラー文をそのまま報告して。一覧に無くても一度は試して。',
  options: {
    maxTurns: 8,
    settingSources: [],
    mcpServers: { vault: { type: 'sdk', name: 'vault', instance: proxy } },
    canUseTool: async (n, i) => {
      console.log(`[runner] canUseTool ${n} ${JSON.stringify(i)}`);
      return { behavior: 'allow', updatedInput: i };
    },
  },
})) {
  if (m.type === 'user')
    for (const b of m.message.content ?? [])
      if (b.type === 'tool_result')
        console.log(`[runner] tool_result ${JSON.stringify(b.content).slice(0, 300)}`);
  if (m.type === 'result') finalText = m.result ?? null;
}
await client.close();
console.log(`mode=${mode}`);
console.log('finalText:', String(finalText).slice(0, 600));
console.log(
  'SECRET-AUDIT-ENTRY が Runner に届いた:',
  typeof finalText === 'string' && finalText.includes('SECRET-AUDIT-ENTRY'),
);
