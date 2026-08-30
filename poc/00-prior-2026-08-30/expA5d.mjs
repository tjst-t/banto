import { query } from './node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
const CWD='/tmp/banto-a5', PROJ='/home/ubuntu/.claude/projects/-tmp-banto-a5';
const read=()=>existsSync(CWD+'/note.txt')?readFileSync(CWD+'/note.txt','utf8').trim():'(なし)';
const newest=()=>readdirSync(PROJ).filter(f=>f.endsWith('.jsonl')).map(f=>({f,t:statSync(PROJ+'/'+f).mtimeMs})).sort((a,b)=>b.t-a.t)[0].f;
function firstUserUuid(file){ for(const l of readFileSync(PROJ+'/'+file,'utf8').split('\n')){ if(!l.trim())continue;
  const d=JSON.parse(l); if(d.type==='user' && typeof d.message?.content==='string') return d.uuid; } }

const sess = newest().replace('.jsonl','');
const uuid = firstUserUuid(newest());
console.log(JSON.stringify({ session:sess.slice(0,8), first_user_uuid:uuid?.slice(0,8), file_now:read() }));

const base={ model:'claude-sonnet-5',maxTurns:6,settingSources:[],cwd:CWD,
  enableFileCheckpointing:true, allowedTools:['Write','Edit'], permissionMode:'bypassPermissions' };
function open(t){ let c; const h=new Promise(r=>{c=r;});
  return { gen:(async function*(){ yield {type:'user',message:{role:'user',content:t},parent_tool_use_id:null,session_id:''}; await h; })(), close:()=>c() }; }

// resume した別 query() から、ターン1 の user uuid へ巻き戻す
const a=open('note.txt の中身を「Z」に書き換えて。');
const q=query({ prompt:a.gen, options:{...base, resume:sess} });
let dry=null, real=null;
for await (const m of q){ if(m.type==='result'){
  try{ dry = await q.rewindFiles(uuid,{dryRun:true}); }catch(e){ dry={error:e.message}; }
  try{ real = await q.rewindFiles(uuid,{}); }catch(e){ real={error:e.message}; }
  a.close(); } }
console.log(JSON.stringify({ after_write:'(Z のはず)', dryRun:dry, real:real, file_after_rewind:read() },null,2));
process.exit(0);
