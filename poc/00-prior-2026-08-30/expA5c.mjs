import { query } from './node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
const CWD='/tmp/banto-a5';
let close; const held=new Promise(r=>{close=r;});
async function* gen(){ yield {type:'user',message:{role:'user',content:'note.txt を作って中身を「A」だけにして。'},parent_tool_use_id:null,session_id:''}; await held; }
const q=query({ prompt:gen(), options:{ model:'claude-sonnet-5',maxTurns:6,settingSources:[],cwd:CWD,
  enableFileCheckpointing:true, allowedTools:['Write'], permissionMode:'bypassPermissions' }});
const seen=[];
for await (const m of q){
  seen.push({ type:m.type, subtype:m.subtype, uuid:m.uuid?.slice(0,8),
    role:m.message?.role, content_kind: Array.isArray(m.message?.content)? m.message.content.map(c=>c.type).join(',') : typeof m.message?.content });
  if (m.type==='result'){
    // 全部の uuid を順に試す
    for (const s of seen.filter(x=>x.uuid)) {
      try { const r = await q.rewindFiles(seen.find(y=>y.uuid===s.uuid) && (await (async()=>s.fullUuid ?? null)()) || '', {dryRun:true}); } catch(e){}
    }
    close();
  }
}
console.log(JSON.stringify(seen,null,1));
process.exit(0);
