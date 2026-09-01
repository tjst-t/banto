// 最小の MCP Module。1つの無害な tool を持つだけ——canUseTool が
// nested session のバイパスを受けない経路（builtin ではなく MCP tool）で
// ちゃんと呼ばれるかを確かめるため。
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const s = new Server({ name: 'poc-hold-module', version: '1.0.0' }, { capabilities: { tools: {} } });

s.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo_test',
      description: '文字列をそのまま返す（破壊的操作のふり）',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      annotations: { destructiveHint: true },
    },
  ],
}));

s.setRequestHandler(CallToolRequestSchema, async (req) => {
  const text = req.params.arguments?.text ?? '';
  return { content: [{ type: 'text', text: `echoed: ${text}` }] };
});

await s.connect(new StdioServerTransport());
