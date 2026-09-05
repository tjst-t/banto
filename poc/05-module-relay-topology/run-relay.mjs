// 本実験：host が実 Module への接続を1本だけ持ち、Runner には
// createSdkMcpServer（in-process）で作った「代理サーバ」を見せる、という形が
// 技術的に成立するかの実測。
//
// 確かめること：
//  (a) 代理サーバ経由で本物 Module まで実際に転送されて動くか
//  (b) 本物 Module のプロセスが 1つだけ（stdio 2重起動が起きない）か
//  (c) 代理サーバに登録しなかった module/admin 可視性の tool が
//      Runner に見えないか
import { query, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';

const VIS = 'dev.banto/visibility';
const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.join(here, 'module.mjs');
const logPath = path.join(here, 'module.observed.log');
writeFileSync(logPath, '');

// --- 1. host が実 Module へ「1本だけ」接続する ---------------------------
const client = new Client({ name: 'banto-host-poc', version: '0.0.0' });
await client.connect(new StdioClientTransport({ command: 'node', args: [modulePath] }));
const listed = await client.listTools();
console.log(
  '[host] 実 Module の tools/list =',
  listed.tools.map((t) => `${t.name}(${t._meta?.[VIS]})`).join(', '),
);

// --- 2. host が可視性で選別し、agent のものだけ代理サーバに登録する -------
// JSON Schema → zod の最小変換（PoC 用。文字列プロパティの平たいオブジェクトだけ）。
// ここが汎用中継の実装上の摩擦点になる（README「つまずいた点」参照）。
function toZodShape(jsonSchema) {
  const shape = {};
  const props = jsonSchema?.properties ?? {};
  const required = new Set(jsonSchema?.required ?? []);
  for (const [k, v] of Object.entries(props)) {
    let f = z.string();
    if (v.description) f = f.describe(v.description);
    shape[k] = required.has(k) ? f : f.optional();
  }
  return shape;
}

const relayCalls = [];
const agentTools = listed.tools.filter((t) => t._meta?.[VIS] === 'agent');
console.log('[host] 代理サーバに載せる tool =', agentTools.map((t) => t.name).join(', '));

const proxy = createSdkMcpServer({
  name: 'vault',
  version: '0.0.0',
  tools: agentTools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: toZodShape(t.inputSchema),
    // 呼ばれたら host が持つ「1本の実接続」へそのまま転送する
    handler: async (args) => {
      relayCalls.push({ name: t.name, args });
      console.log(`[host/relay] 転送: ${t.name} ${JSON.stringify(args)}`);
      const res = await client.callTool({ name: t.name, arguments: args });
      console.log(`[host/relay] 実 Module の応答: ${JSON.stringify(res.content)}`);
      return res;
    },
  })),
});

// --- 3. Runner（Agent SDK）には代理サーバだけを渡す ----------------------
let sdkToolList = null;
let finalText = null;
for await (const m of query({
  prompt:
    'vault の requestAlias tool を name="github-token", hint="poc" で1回だけ呼んで、返ってきた文字列をそのまま報告して。',
  options: {
    maxTurns: 4,
    settingSources: [],
    mcpServers: { vault: proxy },
    canUseTool: async (toolName, input) => {
      console.log(`[runner] canUseTool ${toolName}`);
      return { behavior: 'allow', updatedInput: input };
    },
  },
})) {
  if (m.type === 'system' && m.subtype === 'init') {
    sdkToolList = m.tools;
    console.log('[runner] init が申告した tools =', JSON.stringify(m.tools));
    console.log('[runner] init mcp_servers =', JSON.stringify(m.mcp_servers));
  }
  if (m.type === 'result') {
    console.log(`[runner] result subtype=${m.subtype} is_error=${m.is_error}`);
    if (m.subtype === 'success') finalText = m.result;
  }
}

// --- 4. host 自身が module 可視性の tool を呼ぶ（Module 間中継の側） -----
const resolved = await client.callTool({ name: 'resolveAlias', arguments: { name: 'github-token' } });
console.log('[host] module 可視性 resolveAlias を host 経由で呼んだ:', JSON.stringify(resolved.content));

await client.close();

// --- 5. 判定 ------------------------------------------------------------
const observed = readFileSync(logPath, 'utf8');
console.log('--- module.observed.log ---\n' + observed);
const pids = [...new Set([...observed.matchAll(/pid=(\d+)/g)].map((m) => m[1]))];

const vaultTools = (sdkToolList ?? []).filter((t) => t.includes('vault'));
const checks = {
  '代理経由で本物まで転送された': relayCalls.some((c) => c.name === 'requestAlias'),
  '結果が会話に返った': typeof finalText === 'string' && finalText.includes('poc-ticket-4711'),
  '実 Module のプロセスは1つだけ': pids.length === 1,
  'agent 可視性の tool は Runner に見えた': vaultTools.includes('mcp__vault__requestAlias'),
  'module 可視性の tool は Runner に見えない': !sdkToolList.some((t) => t.includes('resolveAlias')),
  'admin 可視性の tool は Runner に見えない': !sdkToolList.some((t) => t.includes('createAlias')),
  'host 側からは module 可視性を呼べる': JSON.stringify(resolved.content).includes('SECRET-VALUE-OF'),
};
console.log('--- 判定 ---');
console.log('観測した pid:', pids.join(', '), `(${pids.length} 個)`);
console.log('Runner に見えた vault の tool:', JSON.stringify(vaultTools));
console.log('finalText:', finalText);
for (const [k, v] of Object.entries(checks)) console.log(`${v ? 'OK  ' : 'NG  '} ${k}`);
console.log(Object.values(checks).every(Boolean) ? '=> 合格' : '=> 不合格');
