// 実 stdio Module（実験用）。05 の module.mjs に resource と prompt を足したもの。
// Vault を模す：
//   tools     … requestAlias(agent) / resolveAlias(module) / createAlias(admin)
//   resources … vault://aliases, vault://aliases/{name}
//   prompts   … vault-onboarding
// 観測は機構の外側（ファイル）へ。Agent SDK は MCP subprocess の stderr を出さない。
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VIS = 'dev.banto/visibility';
const LOG = path.join(path.dirname(fileURLToPath(import.meta.url)), 'module.observed.log');
const log = (line) => appendFileSync(LOG, line + '\n');

const s = new Server(
  { name: 'poc-vault', version: '1.0.0' },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

const TOOLS = [
  {
    name: 'requestAlias',
    description: 'この alias が必要だが Vault に無い、という判断待ちを起こす。値は返さない。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'alias 名' },
        hint: { type: 'string', description: '人へのヒント' },
      },
      required: ['name'],
    },
    _meta: { [VIS]: 'agent' },
  },
  {
    name: 'resolveAlias',
    description: 'alias を実際の秘密の値に解決して返す。',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    _meta: { [VIS]: 'module' },
  },
];

const RESOURCES = [
  {
    uri: 'vault://aliases',
    name: 'vault aliases',
    description: 'この Project で使える alias の一覧（値は含まない）',
    mimeType: 'application/json',
    _meta: { [VIS]: 'agent' },
  },
  {
    uri: 'vault://internal/audit',
    name: 'vault audit log',
    description: '監査ログ（人専用）',
    mimeType: 'application/json',
    _meta: { [VIS]: 'admin' },
  },
];

const CONTENTS = {
  'vault://aliases': JSON.stringify({
    aliases: [
      { name: 'github-token', scope: 'project', marker: 'POC-RESOURCE-MARKER-8823' },
      { name: 'openai-key', scope: 'project' },
    ],
  }),
  'vault://internal/audit': JSON.stringify({ entries: ['SECRET-AUDIT-ENTRY'] }),
};

s.setRequestHandler(ListToolsRequestSchema, async () => {
  log(`[module pid=${process.pid}] tools/list`);
  return { tools: TOOLS };
});
s.setRequestHandler(CallToolRequestSchema, async (req) => {
  log(`[module pid=${process.pid}] tools/call ${JSON.stringify(req.params)}`);
  const { name, arguments: args } = req.params;
  if (name === 'requestAlias')
    return {
      content: [
        { type: 'text', text: `REQUEST-ACCEPTED alias=${args?.name} ticket=poc-ticket-4711` },
      ],
    };
  if (name === 'resolveAlias')
    return { content: [{ type: 'text', text: `SECRET-VALUE-OF-${args?.name}` }] };
  return { content: [{ type: 'text', text: 'unknown tool' }], isError: true };
});

s.setRequestHandler(ListResourcesRequestSchema, async () => {
  log(`[module pid=${process.pid}] resources/list`);
  return { resources: RESOURCES };
});
s.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
  log(`[module pid=${process.pid}] resources/templates/list`);
  return {
    resourceTemplates: [
      {
        uriTemplate: 'vault://aliases/{name}',
        name: 'vault alias detail',
        mimeType: 'application/json',
      },
    ],
  };
});
s.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  log(`[module pid=${process.pid}] resources/read ${req.params.uri}`);
  const uri = req.params.uri;
  const text = CONTENTS[uri] ?? JSON.stringify({ uri, note: 'template hit' });
  return { contents: [{ uri, mimeType: 'application/json', text }] };
});

s.setRequestHandler(ListPromptsRequestSchema, async () => {
  log(`[module pid=${process.pid}] prompts/list`);
  return {
    prompts: [
      {
        name: 'vault-onboarding',
        description: 'alias の使い方を説明する定型プロンプト',
        arguments: [{ name: 'alias', description: 'alias 名', required: true }],
      },
    ],
  };
});
s.setRequestHandler(GetPromptRequestSchema, async (req) => {
  log(`[module pid=${process.pid}] prompts/get ${JSON.stringify(req.params)}`);
  return {
    description: 'vault onboarding',
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `POC-PROMPT-MARKER-7714 alias=${req.params.arguments?.alias}`,
        },
      },
    ],
  };
});

log(`[module pid=${process.pid}] process start`);
await s.connect(new StdioServerTransport());
