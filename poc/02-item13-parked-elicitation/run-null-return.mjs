// (2) onElicitation が null を返したとき何が起きるか。
// 型定義の但し書き：「null を返してよいのは、帯域外で control_response を
// 既に送った後だけ。うっかり null を返すと、何も送られず elicitation は
// サーバがタイムアウトするまで pending のまま（fail-closed）」。
// ここでは「帯域外の応答を送らずに、うっかり null を返す」を試す。
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
    mcpServers: { poc: { type: 'stdio', command: 'node', args: [modulePath, '5000'] } }, // 5秒で切って確認する
    onElicitation: async () => {
      console.log('[sdk] onElicitation 受信。null を返す（帯域外応答は送らない）');
      return null;
    },
  },
})) {
  if (m.type === 'result') {
    console.log('[sdk] result subtype=' + m.subtype + ' is_error=' + m.is_error + ' elapsed=' + (Date.now() - t0) + 'ms');
  }
}

console.log('--- module.observed.log ---');
const { readFileSync } = await import('node:fs');
console.log(readFileSync(path.join(here, 'module.observed.log'), 'utf8'));
