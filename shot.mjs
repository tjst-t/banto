import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventLog } from '@banto/core';
import { startServer } from '@banto/host/dist/server.js';
import { chromium } from 'playwright';
const dataDir = await mkdtemp(path.join(tmpdir(), 'shot-sb-'));
const log = new EventLog(dataDir);
await log.append({ type: 'channel.created', channelId: 'c1', channelName: 'banto-v3' });
await log.append({ type: 'thread.created', threadId: 't1', channelId: 'c1', title: 'Python の面' });
await log.append({ type: 'message.recorded', threadId: 't1', queryId: 'q1', role: 'user', text: 'banto に挨拶して' });
await log.append({ type: 'message.recorded', threadId: 't1', queryId: 'q1', role: 'assistant', text: '挨拶を用意しました。' });
await log.append({ type: 'reference.recorded', threadId: 't1', uri: 'banto://hello-py/greeting/banto', name: 'banto への挨拶', mimeType: 'text/plain', note: 'Python から返しています' });
const fsRoot = await mkdtemp(path.join(tmpdir(), 'shot-fs-'));
process.env.BANTO_FS_ROOT = fsRoot;
const { fsModule } = await import('@banto/module-fs');
const helloPy = JSON.parse(await readFile('modules/hello-py/manifest.json', 'utf8'));
const server = startServer({ dataDir, port: 0,
  modules: [
    { name: 'fs', kind: 'in-process', server: fsModule.createServer() },
    { name: 'hello-py', kind: 'subprocess', command: 'python3', args: ['modules/hello-py/server.py'] },
  ],
  toolsByModule: new Map(), manifests: [fsModule.manifest, helloPy],
  model: 'claude-haiku-4-5', webRoot: path.resolve('apps/web/dist') });
await new Promise((r) => server.once('listening', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1200, height: 760 } });
await p.goto(origin, { waitUntil: 'networkidle' });
await p.waitForSelector('[data-reference]');
await p.locator('[data-reference]').click();
await p.waitForSelector('[data-sandboxed-view]');
await p.waitForTimeout(900);
await p.screenshot({ path: '/tmp/sandboxed.png' });
await b.close(); server.close();
console.log('ok');
