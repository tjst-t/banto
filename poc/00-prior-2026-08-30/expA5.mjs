import { query } from './node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import { readFileSync, existsSync } from 'node:fs';
const CWD='/tmp/banto-a5';
const opts = { model:'claude-sonnet-5', maxTurns:6, settingSources:[], cwd:CWD,
  enableFileCheckpointing:true, allowedTools:['Write','Edit','Read'], permissionMode:'bypassPermissions' };

// --- ターン1：ファイルを作らせる。user message の uuid を拾う
let sid=null, uuids=[];
const q1 = query({ prompt:'note.txt というファイルを作って、中身を「A」だけにして。', options:opts });
for await (const m of q1) {
  if (m.type==='system' && m.session_id) sid=m.session_id;
  if (m.type==='user' && m.uuid) uuids.push(m.uuid);
  if (m.type==='result') {
    try { var same = await q1.rewindFiles(uuids[0], {dryRun:true}); } catch(e){ var same={error:e.message}; }
  }
}
console.log(JSON.stringify({ step:'1 同一セッション内で dryRun', session:sid?.slice(0,8), uuid0:uuids[0]?.slice(0,8),
  uuid_count:uuids.length, file:existsSync(CWD+'/note.txt')?readFileSync(CWD+'/note.txt','utf8').trim():'(なし)',
  rewind:same }, null, 2));

// --- ターン2：resume した別の query() で、同じ uuid に巻き戻せるか
const q2 = query({ prompt:'note.txt の中身を「B」に書き換えて。', options:{...opts, resume:sid} });
let uuids2=[], r2=null;
for await (const m of q2) {
  if (m.type==='user' && m.uuid) uuids2.push(m.uuid);
  if (m.type==='result') {
    try { r2 = await q2.rewindFiles(uuids[0], {dryRun:true}); } catch(e){ r2={error:e.message}; }
  }
}
console.log(JSON.stringify({ step:'2 resume 後に、ターン1の uuid へ dryRun',
  file:existsSync(CWD+'/note.txt')?readFileSync(CWD+'/note.txt','utf8').trim():'(なし)',
  rewind_across_resume:r2 }, null, 2));
process.exit(0);
