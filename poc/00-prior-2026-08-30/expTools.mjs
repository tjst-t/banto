import { query, createSdkMcpServer, tool } from './node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import { z } from './node_modules/zod/index.js';
const mk=(srv,n)=>createSdkMcpServer({name:srv,version:'1.0.0',tools:Array.from({length:n},(_,i)=>
  tool(`op_${srv}_${i}`,`${srv} の操作 ${i}。引数を受け取って結果を返す。`,{a:z.string().describe('入力'),b:z.number().optional()},async()=>({content:[{type:'text',text:'ok'}]})))});
const set=(servers,per)=>Object.fromEntries(Array.from({length:servers},(_,i)=>[`m${i}`,mk(`m${i}`,per)]));

async function run(label, mcpServers, resume) {
  let sid=null,res=null,ctx=null,close;
  const held=new Promise(r=>{close=r;});
  async function* g(){ yield {type:'user',message:{role:'user',content:'ok'},parent_tool_use_id:null,session_id:''}; await held; }
  const q=query({ prompt:g(), options:{model:'claude-sonnet-5',maxTurns:1,settingSources:[],allowedTools:[],mcpServers,...(resume?{resume}:{})} });
  for await (const m of q){ if(m.type==='system') sid ??= m.session_id;
    if(m.type==='result'){ res=m; try{ ctx=await q.getContextUsage(); }catch(e){ ctx={error:e.message}; } close(); } }
  const u=res?.usage??{};
  const cats = (ctx?.categories??[]).filter(c=>/MCP/i.test(c.name));
  console.log(JSON.stringify({ label, cache_read:u.cache_read_input_tokens, cache_create:u.cache_creation_input_tokens,
    cost:res?.total_cost_usd, mcp_rows: cats.map(c=>`${c.name}=${c.tokens}${c.isDeferred?'(窓外)':''}`).join(' / ') }));
  return sid;
}
await run('tool 0個', undefined);
await run('tool 8個（1サーバ×8）', set(1,8));
await run('tool 40個（5サーバ×8）', set(5,8));
await run('tool 120個（15サーバ×8）', set(15,8));
