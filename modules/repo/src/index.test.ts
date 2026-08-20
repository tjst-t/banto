/**
 * repo モジュールの配線を確かめる試験。
 *
 * push は vault（Phase 3）に依存する（要件 C11・ADR-0001 決定5）。
 * vault が使えない台帳では、push だけが理由付きで断ることを、
 * 実際に MCP サーバへ繋いで（in-memory transport で）確認する——
 * 「そのはず」で終わらせない（規則1：自己申告を信頼しない）。
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Availability } from '@banto/module-kit';
import { describe, expect, it } from 'vitest';

import { repoModule } from './index.js';

const vaultUnavailable: Availability = {
  has: () => false,
  reasonFor: (moduleId) => `${moduleId} は Phase 1 の台帳に無い`,
};

describe('repo モジュールの配線', () => {
  it('vault が使えないとき、push は理由付きで断る', async () => {
    const server = repoModule.createServer(vaultUnavailable);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const result = await client.callTool({
        name: 'push',
        arguments: { remote: 'origin', branch: 'main' },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as { type: string; text: string }[]).map((c) => c.text).join('\n');
      expect(text).toContain('vault');
    } finally {
      await client.close();
    }
  });

  it('vault が使えないときも、push 以外のツールは一覧に残る（要件 C12：消さない）', async () => {
    const server = repoModule.createServer(vaultUnavailable);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toEqual(['log', 'status', 'diff', 'branches', 'commit', 'push']);
    } finally {
      await client.close();
    }
  });
});
