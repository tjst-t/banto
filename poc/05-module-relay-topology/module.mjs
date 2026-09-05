// 実 stdio Module（実験用）。banto から見た「第三者 Module」の代わり。Vault を模す。
// - tool を3つ、_meta の visibility で agent / module / admin と印を付けて出す
// - initialize と tools/call を、自分の pid つきでファイルに記録する
//   （Agent SDK は MCP subprocess の stderr を表に出さないので、
//    観測は機構の外側＝ファイルに置く。step0 と同じ理由）
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VIS = 'dev.banto/visibility';
const LOG = path.join(path.dirname(fileURLToPath(import.meta.url)), 'module.observed.log');
const log = (line) => appendFileSync(LOG, line + '\n');

const s = new Server({ name: 'poc-vault', version: '1.0.0' }, { capabilities: { tools: {} } });

const TOOLS = [
  {
    name: 'requestAlias',
    description:
      'この alias が必要だが Vault に無い、という判断待ちを起こす。値は一切返さない。',
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
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    _meta: { [VIS]: 'module' },
  },
  {
    name: 'createAlias',
    description: 'alias を新規登録する（人専用の管理操作）。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, value: { type: 'string' } },
      required: ['name', 'value'],
    },
    _meta: { [VIS]: 'admin' },
  },
];

s.setRequestHandler(ListToolsRequestSchema, async () => {
  log(`[module pid=${process.pid}] tools/list`);
  return { tools: TOOLS };
});

s.setRequestHandler(CallToolRequestSchema, async (req) => {
  log(`[module pid=${process.pid}] tools/call ${JSON.stringify(req.params)}`);
  const { name, arguments: args } = req.params;
  if (name === 'requestAlias') {
    return {
      content: [
        {
          type: 'text',
          text: `REQUEST-ACCEPTED alias=${args?.name} ticket=poc-ticket-4711 (人の判断待ちに積んだ)`,
        },
      ],
    };
  }
  if (name === 'resolveAlias') {
    return { content: [{ type: 'text', text: `SECRET-VALUE-OF-${args?.name}` }] };
  }
  if (name === 'createAlias') {
    return { content: [{ type: 'text', text: `CREATED ${args?.name}` }] };
  }
  return { content: [{ type: 'text', text: 'unknown tool' }], isError: true };
});

log(`[module pid=${process.pid}] process start`);
await s.connect(new StdioServerTransport());
