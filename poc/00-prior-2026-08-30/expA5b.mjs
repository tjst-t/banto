import { query } from './node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import { readFileSync, existsSync } from 'node:fs';
const CWD='/tmp/banto-a5';
const base = { model:'claude-sonnet-5', maxTurns:6, settingSources:[], cwd:CWD,
  enableFileCheckpointing:true, allowedTools:['Write','Edit','Read'], permissionMode:'bypassPermissions' };
const read=()=>existsSync(CWD+'/note.txt')?readFileSync(CWD+'/note.txt','utf8').trim():'(なし)';

function open(text){ let close; const held=new Promise(r=>{close=r;});
  const gen=(async function*(){ yield {type:'user',message:{role:'user',content:text},parent_tool_use_id:null,session_id:''}; await held; })();
  return { gen, close }; }

// ターン1
const a=open('note.txt を作って、中身を「A」だけにして。');
const q1=query({ prompt:a.gen, options:base });
let sid=null, uuids=[], r1=null;
for await (const m of q1){ if(m.type==='system'&&m.session_id)sid=m.session_id;
  if(m.type==='user'&&m.uuid)uuids.push(m.uuid);
  if(m.type==='result'){ try{ r1=await q1.rewindFiles(uuids[0],{dryRun:true}); }catch(e){ r1={error:e.message}; } a.close(); } }
console.log(JSON.stringify({step:'1 同一セッション内 dryRun', session:sid?.slice(0,8), uuids:uuids.length, file:read(), rewind:r1},null,2));

// ターン2：resume した別の query() から、ターン1の uuid へ
const b=open('note.txt の中身を「B」に書き換えて。');
const q2=query({ prompt:b.gen, options:{...base, resume:sid} });
let r2=null;
for await (const m of q2){ if(m.type==='result'){ try{ r2=await q2.rewindFiles(uuids[0],{dryRun:true}); }catch(e){ r2={error:e.message}; } b.close(); } }
console.log(JSON.stringify({step:'2 resume 後に、ターン1の uuid へ dryRun', file:read(), rewind_across_resume:r2},null,2));

// ターン3：本当に巻き戻せるか（dryRun なし）
const c=open('何もしないで ok とだけ答えて。');
const q3=query({ prompt:c.gen, options:{...base, resume:sid} });
let r3=null;
for await (const m of q3){ if(m.type==='result'){ try{ r3=await q3.rewindFiles(uuids[0],{}); }catch(e){ r3={error:e.message}; } c.close(); } }
console.log(JSON.stringify({step:'3 実際に巻き戻す', rewind:r3, file_after:read()},null,2));
process.exit(0);
