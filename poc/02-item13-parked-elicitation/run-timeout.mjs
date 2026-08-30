// (1) タイムアウトで本当に切れるか。Module 側に短いタイムアウト（5秒）を渡し、
// SDK 側の onElicitation は永久に解決しない Promise を返す（人が答えない、を模す）。
import { query } from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.join(here, 'module.mjs');
writeFileSync(path.join(here, 'module.observed.log'), '');

const t0 = Date.now();

for await (const m of query({
  prompt: 'poc-elicit-module の ask_name tool を1回呼んで、結果をそのまま報告して。',
  options: {
    maxTurns: 3,
    settingSources: [],
    allowedTools: ['mcp__poc__ask_name'],
    mcpServers: { poc: { type: 'stdio', command: 'node', args: [modulePath, '5000'] } }, // Module 側 5秒タイムアウト
    onElicitation: async () => {
      console.log('[sdk] onElicitation 受信。永久に応答しない（人が答えない、を模す）');
      return new Promise(() => {}); // 永久に pending
    },
  },
})) {
  if (m.type === 'result') {
    console.log('[sdk] result subtype=' + m.subtype + ' is_error=' + m.is_error + ' elapsed=' + (Date.now() - t0) + 'ms');
    if (m.subtype === 'success') console.log('[sdk] result text:', m.result);
  }
}
