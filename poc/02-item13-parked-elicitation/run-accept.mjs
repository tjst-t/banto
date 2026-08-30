// 基本ケース：onElicitation が accept を返したら、正常に往復するか。
import { query } from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.join(here, 'module.mjs');
writeFileSync(path.join(here, 'module.observed.log'), '');

let elicitationSeen = null;

for await (const m of query({
  prompt: 'poc-elicit-module の ask_name tool を1回呼んで、結果をそのまま報告して。',
  options: {
    maxTurns: 3,
    settingSources: [],
    allowedTools: ['mcp__poc__ask_name'],
    mcpServers: { poc: { type: 'stdio', command: 'node', args: [modulePath] } },
    onElicitation: async (request) => {
      elicitationSeen = request;
      console.log('[sdk] onElicitation 受信:', JSON.stringify(request));
      return { action: 'accept', content: { name: 'banto-poc' } };
    },
  },
})) {
  if (m.type === 'result') {
    console.log('[sdk] result subtype=' + m.subtype + ' is_error=' + m.is_error);
    if (m.subtype === 'success') console.log('[sdk] result text:', m.result);
  }
}

console.log('elicitation request の形:', JSON.stringify(elicitationSeen, null, 2));
