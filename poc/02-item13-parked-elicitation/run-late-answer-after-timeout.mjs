// (7) 2026-08-31 追加：「タイムアウト済み」状態で、遅れて resolve しても意味が
// 無いことを確認する——「受信箱からの回答は、元の Elicitation の応答としてでは
// なく、次のターンへの新しい入力として渡す」（item13の決定）が、単なる設計判断
// ではなく必要な帰結であることの裏付け。
// Module 側のタイムアウトを3秒に設定し、6秒後（タイムアウト後）に
// onElicitation の Promise を resolve してみる——Module は既に諦めているはずなので、
// この resolve が tool 呼び出しの結果に反映されないことを期待する。
import { query } from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.join(here, 'module.mjs');
writeFileSync(path.join(here, 'module.observed.log'), '');

const t0 = Date.now();
let finalResultText = null;
let resolveThrew = null;

for await (const m of query({
  prompt: 'poc-elicit-module の ask_name tool を1回呼んで、結果をそのまま報告して。',
  options: {
    maxTurns: 3,
    settingSources: [],
    allowedTools: ['mcp__poc__ask_name'],
    mcpServers: { poc: { type: 'stdio', command: 'node', args: [modulePath, '3000'] } }, // Module側3秒タイムアウト
    onElicitation: async (request) => {
      console.log('[sdk] onElicitation 受信 at ' + (Date.now() - t0) + 'ms. 6秒後に answer する（タイムアウト=3秒より後）');
      await new Promise((r) => setTimeout(r, 6000));
      console.log('[sdk] （タイムアウト後の）answer を返そうとする at ' + (Date.now() - t0) + 'ms');
      try {
        return { action: 'accept', content: { name: 'poc太郎（タイムアウト後の回答、届かないはず）' } };
      } catch (err) {
        resolveThrew = String(err);
        throw err;
      }
    },
  },
})) {
  if (m.type === 'result') {
    console.log('[sdk] result subtype=' + m.subtype + ' elapsed=' + (Date.now() - t0) + 'ms');
    if (m.subtype === 'success') finalResultText = m.result;
  }
}

console.log('FINAL result text:', finalResultText, 'resolveThrew:', resolveThrew);
const answerLeaked = typeof finalResultText === 'string' && finalResultText.includes('poc太郎');
console.log(
  answerLeaked
    ? '=> 意外：タイムアウト後の resolve が tool 結果に反映された（想定外、再検証が要る）'
    : '=> 想定通り：タイムアウト後に resolve しても tool 呼び出しの結果には反映されない。'
      + '受信箱からの回答が「次のターン」に頼らざるを得ない理由の裏付け',
);
