// 対照実験（＝「ガードを外したら通ってしまう」ことの確認）。
// 代理サーバを挟まず、host の自前接続と Runner の接続を同じ stdio Module に
// 直接張ったらどうなるか。step0 の結果（別プロセスになる）を、可視性つきの
// Module で再現し、module/admin 可視性の tool がそのまま Runner に晒される
// ことを合わせて示す。
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.join(here, 'module.mjs');
const logPath = path.join(here, 'module.observed.log');
writeFileSync(logPath, '');

const client = new Client({ name: 'banto-host-poc', version: '0.0.0' });
await client.connect(new StdioClientTransport({ command: 'node', args: [modulePath] }));
await client.listTools();

let sdkToolList = null;
for await (const m of query({
  prompt: 'vault の requestAlias tool を name="github-token" で1回呼んで、結果をそのまま報告して。',
  options: {
    maxTurns: 4,
    settingSources: [],
    mcpServers: { vault: { type: 'stdio', command: 'node', args: [modulePath] } },
    canUseTool: async (toolName, input) => ({ behavior: 'allow', updatedInput: input }),
  },
})) {
  if (m.type === 'system' && m.subtype === 'init') sdkToolList = m.tools;
  if (m.type === 'result') console.log(`[runner] result subtype=${m.subtype}`);
}
await client.close();

const observed = readFileSync(logPath, 'utf8');
console.log('--- module.observed.log ---\n' + observed);
const pids = [...new Set([...observed.matchAll(/pid=(\d+)/g)].map((m) => m[1]))];
console.log('観測した pid:', pids.join(', '), `(${pids.length} 個)`);
console.log('Runner に見えた vault の tool:', JSON.stringify(sdkToolList.filter((t) => t.includes('vault'))));
