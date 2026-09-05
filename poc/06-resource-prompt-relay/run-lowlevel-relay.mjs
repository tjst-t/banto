// 問い1：createSdkMcpServer を使わず、@modelcontextprotocol/sdk の低レベル Server を
// 自分で組み立てて {type:'sdk', name, instance} の形に手で整形して mcpServers に渡したら、
// Agent SDK はそれを受け入れ、resource / prompt も扱えるか。
//
// 配線は 05 と同じ「host が実 Module への接続を1本だけ持ち、Runner には in-process の
// 代理サーバを見せる」。違いは代理サーバが createSdkMcpServer 製ではなく低レベル Server 製で、
// tools だけでなく resources/list・resources/read・prompts/list・prompts/get も中継すること。
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';

const VIS = 'dev.banto/visibility';
const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.join(here, 'module.mjs');
const logPath = path.join(here, 'module.observed.log');
writeFileSync(logPath, '');

// --- 1. host が実 Module へ1本だけ接続する -------------------------------
const client = new Client({ name: 'banto-host-poc', version: '0.0.0' });
await client.connect(new StdioClientTransport({ command: 'node', args: [modulePath] }));
const listedTools = await client.listTools();
const listedResources = await client.listResources();
console.log(
  '[host] 実 Module tools =',
  listedTools.tools.map((t) => `${t.name}(${t._meta?.[VIS]})`).join(', '),
);
console.log(
  '[host] 実 Module resources =',
  listedResources.resources.map((r) => `${r.uri}(${r._meta?.[VIS]})`).join(', '),
);

// --- 2. 低レベル Server で代理サーバを組む（可視性 agent だけ通す） ------
const relayed = [];
const proxy = new Server(
  { name: 'vault', version: '0.0.0' },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

proxy.setRequestHandler(ListToolsRequestSchema, async () => {
  relayed.push('tools/list');
  return { tools: listedTools.tools.filter((t) => t._meta?.[VIS] === 'agent') };
});
proxy.setRequestHandler(CallToolRequestSchema, async (req) => {
  relayed.push(`tools/call ${req.params.name}`);
  return await client.callTool({ name: req.params.name, arguments: req.params.arguments ?? {} });
});
proxy.setRequestHandler(ListResourcesRequestSchema, async () => {
  relayed.push('resources/list');
  const r = await client.listResources();
  return { resources: r.resources.filter((x) => x._meta?.[VIS] === 'agent') };
});
proxy.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
  relayed.push('resources/templates/list');
  return await client.listResourceTemplates();
});
proxy.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  relayed.push(`resources/read ${req.params.uri}`);
  return await client.readResource({ uri: req.params.uri });
});
proxy.setRequestHandler(ListPromptsRequestSchema, async () => {
  relayed.push('prompts/list');
  return await client.listPrompts();
});
proxy.setRequestHandler(GetPromptRequestSchema, async (req) => {
  relayed.push(`prompts/get ${req.params.name}`);
  return await client.getPrompt({ name: req.params.name, arguments: req.params.arguments ?? {} });
});

// Agent SDK が代理サーバへ流し込む JSON-RPC を、そのまま観測する
// （connectSdkMcpServer は instance.connect(transport) しか呼ばない、が前提。ここで検証する）
const seenFromCli = [];
const origConnect = proxy.connect.bind(proxy);
let connectCalled = false;
proxy.connect = async (transport) => {
  connectCalled = true;
  const ret = await origConnect(transport);
  const inner = transport.onmessage;
  transport.onmessage = (msg, extra) => {
    if (msg && msg.method) seenFromCli.push(msg.method);
    return inner?.(msg, extra);
  };
  return ret;
};

// --- 3. createSdkMcpServer が返すのと同じ形に手で整形して渡す ------------
const handmadeConfig = { type: 'sdk', name: 'vault', instance: proxy };

let sdkToolList = null;
let mcpServers = null;
let finalText = null;
const toolUses = [];
for await (const m of query({
  prompt:
    'MCP サーバ vault が公開している resource の一覧を取り、vault://aliases を読んで、' +
    '中身に出てくる marker の文字列をそのまま報告して。',
  options: {
    maxTurns: 8,
    settingSources: [],
    mcpServers: { vault: handmadeConfig },
    canUseTool: async (toolName, input) => {
      console.log(`[runner] canUseTool ${toolName} ${JSON.stringify(input)}`);
      return { behavior: 'allow', updatedInput: input };
    },
  },
})) {
  if (m.type === 'system' && m.subtype === 'init') {
    sdkToolList = m.tools;
    mcpServers = m.mcp_servers;
    console.log('[runner] init mcp_servers =', JSON.stringify(m.mcp_servers));
    console.log(
      '[runner] init tools（resource 関係と vault 関係だけ）=',
      JSON.stringify(m.tools.filter((t) => /vault|[Rr]esource/.test(t))),
    );
  }
  if (m.type === 'assistant') {
    for (const b of m.message.content ?? [])
      if (b.type === 'tool_use') {
        toolUses.push({ name: b.name, input: b.input });
        console.log(`[runner] tool_use ${b.name} ${JSON.stringify(b.input)}`);
      }
  }
  if (m.type === 'user') {
    for (const b of m.message.content ?? [])
      if (b.type === 'tool_result')
        console.log(`[runner] tool_result ${JSON.stringify(b.content).slice(0, 400)}`);
  }
  if (m.type === 'result') {
    console.log(`[runner] result subtype=${m.subtype} is_error=${m.is_error}`);
    if (m.subtype === 'success') finalText = m.result;
  }
}

await client.close();

// --- 4. 判定 ------------------------------------------------------------
console.log('--- 代理サーバが CLI から受けたメソッド ---');
console.log(JSON.stringify([...new Set(seenFromCli)]));
console.log('--- 代理サーバが実 Module へ中継した内容 ---');
console.log(JSON.stringify(relayed));
console.log('--- module.observed.log ---\n' + readFileSync(logPath, 'utf8'));

const checks = {
  '低レベル Server が connect された（instance.connect しか呼ばれない）': connectCalled,
  'MCP サーバとして connected 扱いになった': (mcpServers ?? []).some(
    (s) => s.name === 'vault' && s.status === 'connected',
  ),
  'tools/list が来た': seenFromCli.includes('tools/list'),
  'resources/list が来た': seenFromCli.includes('resources/list'),
  'resources/read が来た': seenFromCli.includes('resources/read'),
  'prompts/list が来た': seenFromCli.includes('prompts/list'),
  'resource の中身が会話に届いた': typeof finalText === 'string' &&
    finalText.includes('POC-RESOURCE-MARKER-8823'),
  'admin 可視性の resource は一覧に出さなかった': !relayed.some((r) =>
    r.includes('vault://internal/audit'),
  ),
};
console.log('--- 判定 ---');
console.log('finalText:', finalText);
for (const [k, v] of Object.entries(checks)) console.log(`${v ? 'OK  ' : 'NG  '} ${k}`);
console.log(Object.values(checks).every(Boolean) ? '=> 合格' : '=> 不合格');
