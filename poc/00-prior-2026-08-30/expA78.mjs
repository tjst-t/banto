import { query } from './node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import { existsSync, readFileSync } from 'node:fs';

// 資格情報B の指定は /tmp/banto-exp/cred2.json から読む（中身は表示しない）
// 形式1: {"ANTHROPIC_API_KEY": "sk-..."}      ← APIキーの場合
// 形式2: {"CLAUDE_CONFIG_DIR": "/path/to/dir"} ← 別サブスクでログイン済みの設定ディレクトリ
const P='/tmp/banto-exp/cred2.json';
if (!existsSync(P)) { console.log('cred2.json が無い'); process.exit(1); }
const credB = JSON.parse(readFileSync(P,'utf8'));
console.log('資格情報B の指定キー:', Object.keys(credB).join(','));

const base = { model:'claude-sonnet-5', maxTurns:1, settingSources:[], allowedTools:[] };
async function run(label, extraEnv, resume) {
  const t0=Date.now(); let sid=null,res=null,src=null,init=null;
  for await (const m of query({ prompt:'ok', options:{ ...base,
      ...(extraEnv?{env:{...process.env, ...extraEnv}}:{}), ...(resume?{resume}:{}) } })) {
    if (m.type==='system') { sid ??= m.session_id; src ??= m.apiKeySource; init ??= m.uuid; }
    if (m.type==='result') res=m;
  }
  const u=res?.usage??{};
  console.log(JSON.stringify({ label, session:sid?.slice(0,8), apiKeySource:src,
    cache_read:u.cache_read_input_tokens, cache_create:u.cache_creation_input_tokens,
    cost:res?.total_cost_usd, is_error:res?.is_error, subtype:res?.subtype, ms:Date.now()-t0 }));
  return { sid, res };
}
const a1 = await run('1: 資格情報A で新規', null, null);
await run('2: A で resume（温まり基準）', null, a1.sid);
await run('3: ★ B で同じセッションを resume', credB, a1.sid);
await run('4: A に戻して resume', null, a1.sid);
