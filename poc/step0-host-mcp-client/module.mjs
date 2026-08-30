// 実 stdio Module（実験用）。banto から見た「第三者 Module」の代わり。
// - initialize で受け取った clientCapabilities / clientVersion を stderr へ記録する
//   （Claude Code CLI が何を advertise するかを見るため）
// - tools/list と resources/list の両方に _meta を付けて返す
//   （host 自前クライアントに _meta が届くかを見るため）
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const META_PREFIX = 'jp.banto.poc/';
const LOG = path.join(path.dirname(fileURLToPath(import.meta.url)), 'module.observed.log');
const log = (line) => appendFileSync(LOG, line + '\n');

const s = new Server(
  { name: 'poc-module', version: '1.0.0' },
  { capabilities: { tools: {}, resources: {} } },
);

s.oninitialized = () => {
  const caps = s.getClientCapabilities();
  const ver = s.getClientVersion();
  log(
    '[module pid=' + process.pid + '] initialized. clientCapabilities=' + JSON.stringify(caps) +
    ' clientVersion=' + JSON.stringify(ver),
  );
};

s.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'ping',
      description: 'poc 疎通確認',
      inputSchema: { type: 'object', properties: {} },
      _meta: { [META_PREFIX + 'kind']: 'diagnostic' },
    },
  ],
}));

s.setRequestHandler(CallToolRequestSchema, async (req) => {
  log('[module] tools/call ' + JSON.stringify(req.params));
  return { content: [{ type: 'text', text: 'pong' }] };
});

s.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: 'banto-poc://hello',
      name: 'hello',
      title: 'PoC 資源',
      mimeType: 'text/plain',
      _meta: { [META_PREFIX + 'launcher']: true, [META_PREFIX + 'kind']: 'skill' },
    },
  ],
}));

s.setRequestHandler(ReadResourceRequestSchema, async () => ({
  contents: [{ uri: 'banto-poc://hello', mimeType: 'text/plain', text: 'hello from module' }],
}));

await s.connect(new StdioServerTransport());
