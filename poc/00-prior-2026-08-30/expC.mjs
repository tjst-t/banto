import { query } from './node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
const SID='a9ad1f76-7fcd-4ba4-8839-f1ed28bffe4b';
const base={ model:'claude-sonnet-5', maxTurns:1, settingSources:[], allowedTools:[] };
async function run(label, dir){
  let sid=null,res=null,err=null;
  try{ for await (const m of query({ prompt:'ok', options:{...base, resume:SID,
        ...(dir?{env:{...process.env, CLAUDE_CONFIG_DIR:dir}}:{}) } })){
    if(m.type==='system') sid ??= m.session_id;
    if(m.type==='result') res=m; } }
  catch(e){ err=e.message.slice(0,80); }
  const u=res?.usage??{};
  console.log(JSON.stringify({ label, session:sid?.slice(0,8),
    cache_read:u.cache_read_input_tokens, cache_create:u.cache_creation_input_tokens,
    cost:res?.total_cost_usd, error:err }));
}
await run('C: B の設定 + A の資格情報', '/home/ubuntu/.claude-c');
await run('A: 素の A（対照）', null);
