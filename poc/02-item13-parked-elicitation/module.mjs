// 実 stdio Module。tool 呼び出しの中で elicitInput() を呼ぶ（Elicitation の
// 本来の使い方）。既定の RequestOptions で呼ぶ（教訓1——in-process だと
// 参照渡しになり JSON-RPC の枠も 60秒の要求側タイムアウトも無いので、
// 簡単に「寝かせられた」ことになってしまう。第三者 Module は既定値で呼ぶ）。
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOG = path.join(path.dirname(fileURLToPath(import.meta.url)), 'module.observed.log');
const log = (obj) => appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...obj }) + '\n');

const timeoutMsArg = process.argv[2] ? Number(process.argv[2]) : undefined; // 未指定なら既定(60000ms)

const s = new Server({ name: 'poc-elicit-module', version: '1.0.0' }, { capabilities: { tools: {} } });

s.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'ask_name', description: '名前を尋ねる（elicitation を使う）', inputSchema: { type: 'object', properties: {} } }],
}));

s.setRequestHandler(CallToolRequestSchema, async () => {
  log({ event: 'elicitInput:start', timeoutMsArg });
  try {
    const result = await s.elicitInput(
      { message: '名前を教えてください', requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
      timeoutMsArg ? { timeout: timeoutMsArg } : undefined,
    );
    log({ event: 'elicitInput:resolved', result });
    return { content: [{ type: 'text', text: `結果: ${JSON.stringify(result)}` }] };
  } catch (err) {
    log({ event: 'elicitInput:rejected', message: err?.message, code: err?.code });
    return { content: [{ type: 'text', text: `エラー: ${err?.message}` }], isError: true };
  }
});

await s.connect(new StdioServerTransport());
