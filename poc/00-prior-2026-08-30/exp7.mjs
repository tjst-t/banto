import { query } from './node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import { writeFileSync } from 'node:fs';
let ci; const held=new Promise(r=>{ci=r;});
async function* t(x){ yield {type:'user',message:{role:'user',content:x},parent_tool_use_id:null,session_id:''}; await held; }
const q = query({ prompt:t('ok'), options:{model:'claude-sonnet-5',maxTurns:2,settingSources:[],allowedTools:[]}});
let u=null;
for await (const m of q) if (m.type==='result') {
  try{ u = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(); }catch(e){ u={error:e.message}; }
  ci();
}
writeFileSync('/tmp/banto-exp/usage.json', JSON.stringify(u,null,2));
console.log(JSON.stringify({ subscription_type:u?.subscription_type, rate_limits_available:u?.rate_limits_available,
  rate_limit_keys: u?.rate_limits ? Object.keys(u.rate_limits) : null,
  five_hour:u?.rate_limits?.five_hour, seven_day:u?.rate_limits?.seven_day,
  session_cost:u?.session?.total_cost_usd, error:u?.error }, null, 2));
process.exit(0);
