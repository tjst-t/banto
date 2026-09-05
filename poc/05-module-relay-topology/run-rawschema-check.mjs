// 付随の確認：代理サーバの inputSchema に、本物 Module から受け取った
// JSON Schema をそのまま渡せるか（渡せるなら、汎用中継に JSON Schema→zod の
// 変換器が要らなくなる）。SDK の型は zod の raw shape を要求しているが、
// 実行時に何が起きるかは型から分からないので測る。
import { query, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';

const rawJsonSchema = {
  type: 'object',
  properties: { name: { type: 'string', description: 'alias 名' } },
  required: ['name'],
};

let called = null;
let sdkToolList = null;
let err = null;
try {
  const proxy = createSdkMcpServer({
    name: 'vault',
    version: '0.0.0',
    tools: [
      {
        name: 'requestAlias',
        description: 'alias を人に頼む',
        inputSchema: rawJsonSchema, // わざと zod ではなく生の JSON Schema
        handler: async (args) => {
          called = args;
          return { content: [{ type: 'text', text: `RAWSCHEMA-OK ${JSON.stringify(args)}` }] };
        },
      },
    ],
  });

  for await (const m of query({
    prompt: 'vault の requestAlias tool を name="github-token" で1回呼んで、結果をそのまま報告して。',
    options: {
      maxTurns: 4,
      settingSources: [],
      mcpServers: { vault: proxy },
      canUseTool: async (t, i) => ({ behavior: 'allow', updatedInput: i }),
    },
  })) {
    if (m.type === 'system' && m.subtype === 'init') sdkToolList = m.tools;
    if (m.type === 'result') console.log('[runner] result subtype=' + m.subtype, m.subtype === 'success' ? m.result : '');
  }
} catch (e) {
  err = e;
  console.log('[poc] 例外:', e?.message);
}
console.log('Runner に見えた vault の tool:', JSON.stringify((sdkToolList ?? []).filter((t) => t.includes('vault'))));
console.log('handler が受け取った引数:', JSON.stringify(called));
console.log(
  called && !err
    ? '=> 生の JSON Schema をそのまま渡しても動いた（変換器は不要）'
    : '=> 生の JSON Schema では動かない（JSON Schema→zod の変換が要る）',
);
