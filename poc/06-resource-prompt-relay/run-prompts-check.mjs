// 問い3：prompts/list・prompts/get は Runner に届くか。
// run-lowlevel-relay.mjs では prompts/list が一度も来なかったので、
// 「Claude Code は MCP prompt をスラッシュコマンド（/mcp__<server>__<prompt>）として扱う」
// という仮説を、prompt 文字列をスラッシュコマンドにして測る。
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const client = new Client({ name: 'banto-host-poc', version: '0.0.0' });
await client.connect(
  new StdioClientTransport({ command: 'node', args: [path.join(here, 'module.mjs')] }),
);

const seen = [];
const proxy = new Server(
  { name: 'vault', version: '0.0.0' },
  { capabilities: { tools: {}, prompts: {} } },
);
proxy.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
proxy.setRequestHandler(ListPromptsRequestSchema, async () => {
  seen.push('prompts/list');
  return await client.listPrompts();
});
proxy.setRequestHandler(GetPromptRequestSchema, async (req) => {
  seen.push(`prompts/get ${req.params.name}`);
  return await client.getPrompt({ name: req.params.name, arguments: req.params.arguments ?? {} });
});

const which = process.argv[2] ?? 'slash';
const prompt =
  which === 'slash'
    ? '/mcp__vault__vault-onboarding github-token'
    : 'vault が提供している MCP prompt を使って、alias=github-token の onboarding 文面を出して。';

let finalText = null;
let slashCommands = null;
for await (const m of query({
  prompt,
  options: {
    maxTurns: 4,
    settingSources: [],
    mcpServers: { vault: { type: 'sdk', name: 'vault', instance: proxy } },
    canUseTool: async (n, i) => ({ behavior: 'allow', updatedInput: i }),
  },
})) {
  if (m.type === 'system' && m.subtype === 'init') {
    slashCommands = m.slash_commands;
    console.log(
      '[runner] init slash_commands（vault を含むものだけ）=',
      JSON.stringify((m.slash_commands ?? []).filter((c) => c.includes('vault'))),
    );
  }
  if (m.type === 'result') {
    console.log(`[runner] result subtype=${m.subtype} is_error=${m.is_error}`);
    finalText = m.result ?? null;
  }
}
await client.close();

console.log('--- 代理サーバが受けた prompt 系メソッド ---', JSON.stringify(seen));
console.log('finalText:', String(finalText).slice(0, 800));
console.log(
  'prompt の中身（POC-PROMPT-MARKER-7714）が会話に届いた:',
  typeof finalText === 'string' && finalText.includes('POC-PROMPT-MARKER-7714'),
);
console.log(
  'slash_commands に vault の prompt が載った:',
  (slashCommands ?? []).some((c) => c.includes('vault')),
);
