// (6) 2026-08-31 追加：「生きている」状態の核心を実測する。
// 受信箱から答えるとき、まだ Module 側のタイムアウトを迎えていなければ、
// banto は手元に残る onElicitation の Promise をそのまま resolve すればよく、
// 「次のターンへの新規入力」に頼らず元の tool 呼び出しを直接解決できる
// ——という v4-architecture.md §2.4.1（2026-08-31訂正）の主張を確認する。
// Module 側のタイムアウトを8秒に設定し、2秒後（タイムアウト前）に
// onElicitation の Promise を resolve する——「受信箱からまだ間に合ううちに
// 答えた」を模す。
import { query } from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, appendFileSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.join(here, 'module.mjs');
const logPath = path.join(here, 'module.observed.log');
writeFileSync(logPath, '');

const t0 = Date.now();
let finalResultText = null;

for await (const m of query({
  prompt: 'poc-elicit-module の ask_name tool を1回呼んで、結果をそのまま報告して。',
  options: {
    maxTurns: 3,
    settingSources: [],
    allowedTools: ['mcp__poc__ask_name'],
    mcpServers: { poc: { type: 'stdio', command: 'node', args: [modulePath, '8000'] } }, // Module側8秒タイムアウト
    onElicitation: async (request) => {
      console.log('[sdk] onElicitation 受信 at ' + (Date.now() - t0) + 'ms. 2秒後に answer する（タイムアウト=8秒より前）');
      // 「受信箱からまだ間に合ううちに答えた」を模す——2秒の遅延を挟んでから resolve
      await new Promise((r) => setTimeout(r, 2000));
      console.log('[sdk] answer を返す at ' + (Date.now() - t0) + 'ms');
      return { action: 'accept', content: { name: 'poc太郎（受信箱からの遅延回答）' } };
    },
  },
})) {
  if (m.type === 'result') {
    console.log('[sdk] result subtype=' + m.subtype + ' elapsed=' + (Date.now() - t0) + 'ms');
    if (m.subtype === 'success') finalResultText = m.result;
  }
}

console.log('FINAL result text:', finalResultText);
appendFileSync(
  logPath,
  JSON.stringify({ t: Date.now(), event: 'poc:final', finalResultText }) + '\n',
);

const ok = typeof finalResultText === 'string' && finalResultText.includes('poc太郎');
console.log(
  ok
    ? '=> 合格：2秒遅延させた回答でも、タイムアウト前なら tool 呼び出しがそのまま正常に解決した'
    : '=> 不合格：期待した回答が tool 結果に反映されていない',
);
