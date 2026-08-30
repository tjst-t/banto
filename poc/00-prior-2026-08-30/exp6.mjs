import { query } from './node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
let closeInput; const held = new Promise(r => { closeInput = r; });
async function* openTurn(t){ yield { type:'user', message:{role:'user',content:t}, parent_tool_use_id:null, session_id:'' }; await held; }

// (1) usage API を正常なターンで叩く
const q1 = query({ prompt: openTurn('ok'), options:{ model:'claude-sonnet-5', maxTurns:2, settingSources:[], allowedTools:[] }});
let usage=null, ctx=null;
for await (const m of q1) {
  if (m.type==='result') {
    try { usage = await q1.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(); } catch(e){ usage={error:e.message}; }
    try { ctx = await q1.getContextUsage(); } catch(e){ ctx={error:e.message}; }
    closeInput();
  }
}
console.log('=== usage API ===');
console.log(JSON.stringify(usage?.error ? usage : {
  subscription_type: usage?.subscription_type, rate_limits_available: usage?.rate_limits_available,
  five_hour: usage?.rate_limits?.five_hour, seven_day: usage?.rate_limits?.seven_day,
  session_cost: usage?.session?.total_cost_usd }, null, 2));
console.log('=== getContextUsage（カテゴリ） ===');
console.log(JSON.stringify(ctx?.error ? ctx : (ctx?.categories ?? ctx)?.slice?.(0,12) ?? Object.keys(ctx ?? {}), null, 2));

// (2) close() を走行中に呼ぶ
let closeInput2; const held2 = new Promise(r => { closeInput2 = r; });
async function* openTurn2(t){ yield { type:'user', message:{role:'user',content:t}, parent_tool_use_id:null, session_id:'' }; await held2; }
const t0=Date.now();
const q2 = query({ prompt: openTurn2('1から2000まで1行ずつ全部数えて'), options:{ model:'claude-sonnet-5', maxTurns:5, settingSources:[], allowedTools:[] }});
let closeRes=null, n2=0, res2=null;
setTimeout(async()=>{ try{ await q2.close(); closeRes='ok'; }catch(e){ closeRes='ERR: '+e.message; } }, 6000);
try { for await (const m of q2) { n2++; if(m.type==='result') res2=m; } } catch(e){ console.log('LOOP2 ERR:', e.message); }
closeInput2();
console.log('=== close() ===');
console.log(JSON.stringify({ close_call: closeRes, elapsed_ms: Date.now()-t0, messages: n2, subtype: res2?.subtype }, null, 2));
process.exit(0);
