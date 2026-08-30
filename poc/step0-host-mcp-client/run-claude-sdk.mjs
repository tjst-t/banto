// F1 の前半：Claude Code CLI（Claude Agent SDK 経由）が Module に対して
// initialize でどんな capabilities を advertise するか（tasks / elicitation を含むか）。
// module.mjs 側の stderr に記録される。
import { query } from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.join(here, 'module.mjs');

for await (const m of query({
  prompt: 'poc-module の ping tool を1回呼んで、結果をそのまま報告して。',
  options: {
    maxTurns: 3,
    settingSources: [],
    allowedTools: ['mcp__poc__ping'],
    mcpServers: {
      poc: { type: 'stdio', command: 'node', args: [modulePath] },
    },
  },
})) {
  if (m.type === 'system' && m.subtype === 'init') {
    console.log('[sdk] init mcp_servers=' + JSON.stringify(m.mcp_servers));
  }
  if (m.type === 'result') {
    console.log('[sdk] result subtype=' + m.subtype + ' is_error=' + m.is_error);
  }
}
