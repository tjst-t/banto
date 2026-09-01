// canUseTool の Promise を長時間（90秒、Elicitation の60秒タイムアウトより長く）
// 解決しないまま放置して、SDK が独自にタイムアウトして自動拒否しないかを確かめる。
// 「(A) 電話を切らずに待つ」モデルが、tool 承認ゲートでも成立するかの実測。
//
// 実測で判明した注意点：
// - builtin tool（Bash 等）は、この実行環境が Claude Code の子セッション
//   （CLAUDE_CODE_CHILD_SESSION=1）であるため、canUseTool を経由せず自動承認
//   されてしまう（親セッションの信任を継承するとみられる）。これは環境固有の
//   バイパスであって、banto の本実装（子セッションではない）には無関係のはず。
// - 代わりに MCP tool（module.mjs、破壊的操作のふりをする echo_test）を使うと、
//   このバイパスを受けず canUseTool が正しく呼ばれることを確認した。
import { query } from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.join(here, 'module.mjs');

const t0 = Date.now();
const HOLD_MS = 90_000; // Elicitation の既定60秒より長く設定
let canUseToolCalledAt = null;
let canUseToolResolvedAt = null;
let finalResultText = null;

console.log(`[poc] 開始。canUseTool を ${HOLD_MS}ms 待たせてから allow する`);

for await (const m of query({
  prompt: 'poc の echo_test tool を、text="hold-the-line-ok" で1回呼んで、結果をそのまま報告して。',
  options: {
    maxTurns: 3,
    settingSources: [],
    permissionMode: 'default',
    mcpServers: { poc: { type: 'stdio', command: 'node', args: [modulePath] } },
    canUseTool: async (toolName, input) => {
      canUseToolCalledAt = Date.now() - t0;
      console.log(`[poc] canUseTool 呼ばれた at ${canUseToolCalledAt}ms. tool=${toolName} input=${JSON.stringify(input)}`);
      await new Promise((r) => setTimeout(r, HOLD_MS));
      canUseToolResolvedAt = Date.now() - t0;
      console.log(`[poc] canUseTool を allow で解決 at ${canUseToolResolvedAt}ms`);
      return { behavior: 'allow', updatedInput: input };
    },
  },
})) {
  if (m.type === 'result') {
    console.log(`[poc] result subtype=${m.subtype} is_error=${m.is_error} elapsed=${Date.now() - t0}ms`);
    if (m.subtype === 'success') finalResultText = m.result;
  }
}

console.log('--- 集計 ---');
console.log('canUseToolCalledAt:', canUseToolCalledAt, 'ms');
console.log('canUseToolResolvedAt:', canUseToolResolvedAt, 'ms');
console.log('finalResultText:', finalResultText);
const heldLongEnough =
  canUseToolCalledAt !== null && canUseToolResolvedAt !== null && canUseToolResolvedAt - canUseToolCalledAt >= HOLD_MS - 200;
const gotResult = typeof finalResultText === 'string' && finalResultText.includes('hold-the-line-ok');
console.log(
  heldLongEnough && gotResult
    ? '=> 合格：90秒待たせても SDK 側の自動タイムアウトは発生せず、allow が正しく反映されて tool が実行された'
    : '=> 不合格 or 要確認：' + JSON.stringify({ heldLongEnough, gotResult }),
);
