import { query } from './node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
const t0 = Date.now();
let firstEvent = null, sessionId = null, result = null;
for await (const m of query({
  prompt: 'ok とだけ答えて',
  options: { model: 'claude-sonnet-5', maxTurns: 1, settingSources: [], allowedTools: [] },
})) {
  if (firstEvent === null) firstEvent = Date.now() - t0;
  if (m.type === 'system' && m.session_id) sessionId = m.session_id;
  if (m.type === 'result') result = m;
}
console.log(JSON.stringify({
  first_event_ms: firstEvent,
  total_ms: Date.now() - t0,
  session_id: sessionId,
  usage: result?.usage,
  cost_usd: result?.total_cost_usd,
}, null, 2));
