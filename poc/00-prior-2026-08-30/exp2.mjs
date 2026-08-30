import { query, createSdkMcpServer, tool } from './node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import { z } from './node_modules/zod/index.js';

const mk = (name) => createSdkMcpServer({ name, version: '1.0.0', tools: [
  tool(`ping_${name}`, `${name} の疎通確認`, { x: z.string() }, async () => ({ content: [{ type:'text', text:'pong' }] })),
]});

async function run(label, opts) {
  const t0 = Date.now(); let first=null, sid=null, res=null;
  for await (const m of query({ prompt: opts.prompt, options: { model:'claude-sonnet-5', maxTurns:1,
      settingSources: [], allowedTools: [], mcpServers: opts.mcpServers, ...(opts.resume?{resume:opts.resume}:{}) } })) {
    if (first===null) first = Date.now()-t0;
    if (m.type==='system' && m.session_id) sid = m.session_id;
    if (m.type==='result') res = m;
  }
  const u = res?.usage ?? {};
  console.log(JSON.stringify({ label, first_ms:first, total_ms:Date.now()-t0, session:sid?.slice(0,8),
    cache_read:u.cache_read_input_tokens, cache_create:u.cache_creation_input_tokens,
    input:u.input_tokens, cost:res?.total_cost_usd, is_error:res?.is_error, subtype:res?.subtype }));
  return sid;
}

const A = { alpha: mk('alpha') };
const AB = { alpha: mk('alpha'), beta: mk('beta') };

const s1 = await run('1: 新規（alpha のみ）', { prompt:'ok とだけ答えて', mcpServers:A });
const s2 = await run('2: resume（同じ alpha）', { prompt:'ok', mcpServers:A, resume:s1 });
const s3 = await run('3: resume（alpha+beta に変更）', { prompt:'ok', mcpServers:AB, resume:s2 ?? s1 });
const s4 = await run('4: resume（beta を外して alpha のみ）', { prompt:'ok', mcpServers:A, resume:s3 ?? s1 });
