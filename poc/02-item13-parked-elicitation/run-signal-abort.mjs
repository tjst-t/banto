// (5) 2026-08-31 追加：onElicitation の第2引数 options.signal は、Module 側が
// タイムアウトしたときに abort されるか。本編（run-timeout.mjs）は options を
// 受け取っていなかったため未検証だった点を埋める。
// 合否はここでも Module 側のログで見る（module.observed.log）——signal が
// 発火したタイミングを、会話のターン終了（query() の result イベント）と
// 比較することが目的。
import { query } from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.join(here, 'module.mjs');
writeFileSync(path.join(here, 'module.observed.log'), '');

const t0 = Date.now();
let sawAbort = false;
let abortAt = null;
let resultAt = null;

for await (const m of query({
  prompt: 'poc-elicit-module の ask_name tool を1回呼んで、結果をそのまま報告して。',
  options: {
    maxTurns: 3,
    settingSources: [],
    allowedTools: ['mcp__poc__ask_name'],
    mcpServers: { poc: { type: 'stdio', command: 'node', args: [modulePath, '5000'] } }, // Module側5秒タイムアウト
    onElicitation: async (request, options) => {
      console.log('[sdk] onElicitation 受信 at ' + (Date.now() - t0) + 'ms. signal.aborted=' + options.signal.aborted);
      options.signal.addEventListener('abort', () => {
        sawAbort = true;
        abortAt = Date.now() - t0;
        console.log('[sdk] signal aborted at ' + abortAt + 'ms. reason=' + JSON.stringify(options.signal.reason));
      });
      return new Promise(() => {}); // 人が答えない、を模す。abortを見るためresolveしない
    },
  },
})) {
  if (m.type === 'result') {
    resultAt = Date.now() - t0;
    console.log('[sdk] result subtype=' + m.subtype + ' elapsed=' + resultAt + 'ms sawAbort=' + sawAbort);
  }
}

console.log('FINAL sawAbort=' + sawAbort + ' resultAt=' + resultAt + 'ms abortAt=' + (abortAt ?? 'null') + 'ms');
if (sawAbort && abortAt !== null && resultAt !== null) {
  console.log(
    abortAt > resultAt
      ? '=> signal の到着は会話のターン終了より遅い（tool結果の到着をトリガーにすべき、という結論の根拠）'
      : '=> signal の到着は会話のターン終了より早い（今回はこちらが優勢だった——安定した傾向かはn数を増やして要再確認）',
  );
}
