// F2: host が自分の MCP クライアントを持てば、_meta が届くか。
// Agent SDK の Query には callTool/listResources が無い（sdk.d.ts で確認済み）ので、
// host は自前で @modelcontextprotocol/sdk の Client を持つしかない、という仮説の検証。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.join(here, 'module.mjs');

const client = new Client({ name: 'banto-host-poc', version: '0.0.0' });
const transport = new StdioClientTransport({ command: 'node', args: [modulePath] });
await client.connect(transport);

const tools = await client.listTools();
console.log('[own-client] tools/list =', JSON.stringify(tools, null, 2));

const resources = await client.listResources();
console.log('[own-client] resources/list =', JSON.stringify(resources, null, 2));

await client.close();
