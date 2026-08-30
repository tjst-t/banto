import { query, createSdkMcpServer, tool } from './node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import { z } from './node_modules/zod/index.js';
const inproc = (n)=>createSdkMcpServer({name:n,version:'1.0.0',tools:[tool(`ping_${n}`,'x',{x:z.string()},async()=>({content:[{type:'text',text:'p'}]}))]});
const sub = (n)=>({ type:'stdio', command:'node', args:['/tmp/banto-exp/stdio-mcp.mjs', n] });

async function run(label, mcpServers) {
  const t0=Date.now(); let initAt=null, firstAssist=null, res=null;
  for await (const m of query({ prompt:'ok', options:{model:'claude-sonnet-5',maxTurns:1,settingSources:[],allowedTools:[],mcpServers} })) {
    if (m.type==='system' && initAt===null) initAt = Date.now()-t0;
    if (m.type==='assistant' && firstAssist===null) firstAssist = Date.now()-t0;
    if (m.type==='result') res=m;
  }
  return { label, init_ms:initAt, first_assistant_ms:firstAssist, total_ms:Date.now()-t0, cost:res?.total_cost_usd };
}
const conds = [
  ['0: MCP なし', undefined],
  ['1: in-process ×3', {a:inproc('a'),b:inproc('b'),c:inproc('c')}],
  ['2: subprocess ×3', {sa:sub('sa'),sb:sub('sb'),sc:sub('sc')}],
  ['3: subprocess ×8', Object.fromEntries(['s1','s2','s3','s4','s5','s6','s7','s8'].map(n=>[n,sub(n)]))],
];
for (const [l,s] of conds) { for (let i=0;i<2;i++) console.log(JSON.stringify(await run(`${l} (${i+1})`, s))); }
