/**
 * repo モジュールの配線を確かめる試験。
 *
 * push は vault（Phase 3）に依存する（要件 C11・ADR-0001 決定5）。
 * vault が使えない台帳では、push だけが理由付きで断ることを、
 * 実際に MCP サーバへ繋いで（in-memory transport で）確認する——
 * 「そのはず」で終わらせない（規則1：自己申告を信頼しない）。
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describeDependency, type Availability } from '@banto/module-kit';
import { beforeAll, describe, expect, it } from 'vitest';

import { repoModule } from './index.js';

/**
 * **根は使い捨てのディレクトリに向ける。**
 *
 * これを怠ると、`createCore` が banto 自身のリポジトリを掴む。実際に事故が起きた
 * ——試験を走らせただけで本物のリモートへ `git push` が飛んだ（2026-08-20）。
 * いまは `requiredRoot` が既定値を持たないので、設定を忘れれば起動時に落ちる。
 */
beforeAll(async () => {
  process.env['BANTO_REPO_ROOT'] = await mkdtemp(path.join(tmpdir(), 'banto-repo-wiring-'));
});

const vaultUnavailable: Availability = {
  has: () => false,
  reasonFor: (dep) => `${describeDependency(dep)} は Phase 1 の台帳に無い`,
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
