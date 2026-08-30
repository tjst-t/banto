import { query } from './node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
const base={ model:'claude-sonnet-5', maxTurns:1, settingSources:[], allowedTools:[], skills:[] };
async function run(label, opts){
  let sid=null,res=null;
  for await (const m of query({ prompt:'ok', options:{...base,...opts} })){
    if(m.type==='system') sid ??= m.session_id;
    if(m.type==='result') res=m; }
  const u=res?.usage??{};
  console.log(JSON.stringify({ label, session:sid?.slice(0,8),
    cache_read:u.cache_read_input_tokens, cache_create:u.cache_creation_input_tokens, cost:res?.total_cost_usd }));
  return sid;
}
const s1 = await run('1: 新規', {});
await run('2: resume（同じ枝）', { resume:s1 });
const f = await run('3: forkSession で枝分かれ', { resume:s1, forkSession:true });
await run('4: 枝の続き（fork 先を resume）', { resume:f });
await run('5: 元の枝の続き', { resume:s1 });
