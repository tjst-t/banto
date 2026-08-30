import { query } from './node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
async function run(label, opts) {
  let res=null,ctx=null,close; const held=new Promise(r=>{close=r;});
  async function* g(){ yield {type:'user',message:{role:'user',content:'ok'},parent_tool_use_id:null,session_id:''}; await held; }
  const q=query({ prompt:g(), options:{model:'claude-sonnet-5',maxTurns:1,allowedTools:[],...opts} });
  for await (const m of q){ if(m.type==='result'){ res=m; try{ ctx=await q.getContextUsage(); }catch(e){ ctx={error:e.message}; } close(); } }
  const u=res?.usage??{};
  const sk=(ctx?.categories??[]).find(c=>/^Skills/i.test(c.name));
  const raw=ctx?.skills; const det=Array.isArray(raw)?raw.map(s=>`${s.name}:${s.tokens}`):(raw&&typeof raw==="object"?Object.keys(raw):[]);
  console.log(JSON.stringify({ label, skills_row: sk?`${sk.tokens}`:'(なし)', skill_count: det.length,
    detail: det.slice(0,6), cache_read:u.cache_read_input_tokens, cache_create:u.cache_creation_input_tokens }));
}
await run('a: settingSources なし（既定）', {});
await run('b: settingSources []（分離）', { settingSources: [] });
await run('c: settingSources [user] + skills 未指定', { settingSources: ['user'] });
await run('d: settingSources [user] + skills: []', { settingSources: ['user'], skills: [] });
await run('e: settingSources [user] + skills: all', { settingSources: ['user'], skills: 'all' });
