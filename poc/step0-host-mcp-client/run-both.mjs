// F2 の帰結確認：同じ Module に対して SDK 側接続と host 自前接続を「同時に」張ると
// 実際に2プロセス起動になるか（pid をログに残させて確認する）。
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.join(here, 'module.mjs');
writeFileSync(path.join(here, 'module.observed.log'), '');

const client = new Client({ name: 'banto-host-poc', version: '0.0.0' });
const transport = new StdioClientTransport({ command: 'node', args: [modulePath] });
await client.connect(transport);
await client.listTools();

for await (const m of query({
  prompt: 'poc-module の ping tool を1回呼んで、結果をそのまま報告して。',
  options: {
    maxTurns: 3, settingSources: [], allowedTools: ['mcp__poc__ping'],
    mcpServers: { poc: { type: 'stdio', command: 'node', args: [modulePath] } },
  },
})) {
  if (m.type === 'result') console.log('[sdk] result subtype=' + m.subtype);
}

await client.close();
console.log('--- module.observed.log (pid 行を見る) ---');
console.log(readFileSync(path.join(here, 'module.observed.log'), 'utf8'));
