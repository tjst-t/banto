// onElicitation を渡さない場合、仕様書コメントどおり自動 decline されるか。
import { query } from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.join(here, 'module.mjs');
writeFileSync(path.join(here, 'module.observed.log'), '');

for await (const m of query({
  prompt: 'poc-elicit-module の ask_name tool を1回呼んで、結果をそのまま報告して。',
  options: {
    maxTurns: 3,
    settingSources: [],
    allowedTools: ['mcp__poc__ask_name'],
    mcpServers: { poc: { type: 'stdio', command: 'node', args: [modulePath] } },
    // onElicitation を渡さない
  },
})) {
  if (m.type === 'result') {
    console.log('[sdk] result subtype=' + m.subtype + ' is_error=' + m.is_error);
    if (m.subtype === 'success') console.log('[sdk] result text:', m.result);
  }
}

console.log('--- module.observed.log ---');
const { readFileSync } = await import('node:fs');
console.log(readFileSync(path.join(here, 'module.observed.log'), 'utf8'));
