import { query } from './node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';

// 1ターンぶんだけの streaming input（会話をつなぎっぱなしにしない）
async function* oneTurn(text) { yield { type:'user', message:{ role:'user', content:text }, parent_tool_use_id:null, session_id:'' }; }

const t0 = Date.now();
const q = query({ prompt: oneTurn('1 から 300 まで、1行に1つずつ数えて出力して。省略しないで。'),
  options: { model:'claude-sonnet-5', maxTurns:1, settingSources: [], allowedTools: [] } });

let interrupted=false, res=null, usageProbe=null, n=0;
setTimeout(async () => {
  try { await q.interrupt(); interrupted='ok'; } catch(e) { interrupted='ERR: '+e.message; }
}, 3500);

try {
  for await (const m of q) {
    n++;
    if (m.type==='system' && usageProbe===null) {
      try { usageProbe = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(); }
      catch(e) { usageProbe = { error: e.message }; }
    }
    if (m.type==='result') res = m;
  }
} catch(e) { console.log('LOOP ERR:', e.message); }

console.log(JSON.stringify({
  interrupt_call: interrupted, elapsed_ms: Date.now()-t0, messages: n,
  result_subtype: res?.subtype, is_error: res?.is_error,
  usage_api: usageProbe?.error ? {error:usageProbe.error} : {
    subscription_type: usageProbe?.subscription_type,
    rate_limits_available: usageProbe?.rate_limits_available,
    five_hour: usageProbe?.rate_limits?.five_hour,
    seven_day: usageProbe?.rate_limits?.seven_day,
  },
}, null, 2));
