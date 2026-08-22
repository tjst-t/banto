/**
 * **同じ `McpServer` インスタンスは、2回 `connect` できない**（実測 2026-08-22）。
 *
 * `apps/host/src/server.ts` が、起動時に1回だけ作った `fs` の `McpServer` を
 * `resourceCallers`（`/api/resource` 用）と、会話ごとの Agent SDK 問い合わせの
 * 両方で使い回していた。2つ目の接続は静かに断られ、AI から `fs` の道具が
 * 見えなくなっていた——会話には何のエラーも出ず、AI が「道具が無い」と
 * 正直に言うだけだったので、原因が分からなかった。
 *
 * ここで固定するのは「使い回すと壊れる」ことと、
 * 「`createServer()` を毎回呼べば壊れない」こと。
 */

import { describe, expect, it } from 'vitest';

import { connectInProcess } from './client.js';
import { ok, defineModule } from './define.js';
import type { BantoModule } from './manifest.js';

const manifest: BantoModule = {
  id: 'probe',
  description: '試験用',
  isolation: 'in-process',
  mcp: { kind: 'in-process' },
};

const probe = defineModule({
  manifest,
  createCore: () => ({}),
  tools: (tool) => [
    tool({ name: 'ping', description: '試験用', input: {}, run: async () => ok('pong') }),
  ],
});

describe('in-process の McpServer は使い回せない（実測 2026-08-22）', () => {
  it('同じインスタンスへ2回目の接続は断られる', async () => {
    const server = probe.createServer();
    await connectInProcess(server);
    await expect(connectInProcess(server)).rejects.toThrow(/[Aa]lready connected/);
  });

  it('createServer() を呼び直せば、どちらも独立して繋がる', async () => {
    const first = await connectInProcess(probe.createServer());
    const second = await connectInProcess(probe.createServer());
    await expect(first.listTools()).resolves.toEqual(['ping']);
    await expect(second.listTools()).resolves.toEqual(['ping']);
  });
});
