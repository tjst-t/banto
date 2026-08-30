import { Server } from './node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js';
import { StdioServerTransport } from './node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from './node_modules/@modelcontextprotocol/sdk/dist/esm/types.js';
const name = process.argv[2] ?? 'sub';
const s = new Server({ name, version:'1.0.0' }, { capabilities:{ tools:{} } });
s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name:`ping_${name}`, description:`${name} 疎通`, inputSchema:{ type:'object', properties:{ x:{type:'string'} } } },
]}));
s.setRequestHandler(CallToolRequestSchema, async () => ({ content:[{type:'text',text:'pong'}] }));
await s.connect(new StdioServerTransport());
