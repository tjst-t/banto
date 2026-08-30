import { query } from './node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
async function* oneTurn(text) { yield { type:'user', message:{ role:'user', content:text }, parent_tool_use_id:null, session_id:'' }; }

const t0 = Date.now();
const q = query({ prompt: oneTurn('1 から 2000 まで、1行に1つずつ数えて出力して。絶対に省略しないで全部書いて。'),
  options: { model:'claude-sonnet-5', maxTurns:5, settingSources: [], allowedTools: [] } });

let interruptResult=null, res=null, usageProbe=null, n=0, firstAssistantAt=null;
const timer = setTimeout(async () => {
  try { await q.interrupt(); interruptResult='ok'; } catch(e) { interruptResult='ERR: '+e.message; }
}, 6000);

try {
  for await (const m of q) {
    n++;
    if (m.type==='assistant' && firstAssistantAt===null) firstAssistantAt = Date.now()-t0;
    if (m.type==='result') res = m;
  }
} catch(e) { console.log('LOOP ERR:', e.message); }
clearTimeout(timer);

console.log(JSON.stringify({
  interrupt_call: interruptResult, elapsed_ms: Date.now()-t0,
  first_assistant_ms: firstAssistantAt, messages: n,
  result_subtype: res?.subtype, is_error: res?.is_error,
  output_tokens: res?.usage?.output_tokens,
}, null, 2));
