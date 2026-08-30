import { query } from './node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';

// 1メッセージ出したあと、ストリームを「開いたまま」保つ
let closeInput;
const held = new Promise(r => { closeInput = r; });
async function* openTurn(text) {
  yield { type:'user', message:{ role:'user', content:text }, parent_tool_use_id:null, session_id:'' };
  await held;                      // ← ここで開きっぱなしにする
}

const t0 = Date.now();
const q = query({ prompt: openTurn('1 から 2000 まで、1行に1つずつ数えて出力して。絶対に省略しないで全部書いて。'),
  options: { model:'claude-sonnet-5', maxTurns:5, settingSources: [], allowedTools: [] } });

let interruptResult=null, res=null, n=0;
const timer = setTimeout(async () => {
  try { await q.interrupt(); interruptResult='ok'; } catch(e) { interruptResult='ERR: '+e.message; }
}, 6000);

try {
  for await (const m of q) { n++; if (m.type==='result') { res = m; closeInput(); } }
} catch(e) { console.log('LOOP ERR:', e.message); }
clearTimeout(timer); closeInput();

console.log(JSON.stringify({ interrupt_call: interruptResult, elapsed_ms: Date.now()-t0,
  messages: n, result_subtype: res?.subtype, is_error: res?.is_error,
  output_tokens: res?.usage?.output_tokens }, null, 2));
process.exit(0);
