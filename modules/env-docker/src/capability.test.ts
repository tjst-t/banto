/**
 * **3つ目の実装でも、口は1文字も変わらない**（決定16 の実装順）。
 *
 * `env-process`（ホストで直接走らせる）・`env-script`（リポジトリのスクリプトへ委譲）
 * に続く3つ目が docker である。**中身は3つとも似ていない**——プロセス、
 * 他人の書いたシェル、コンテナ。それでも同じ5本で満たせて、Factory は無変更で載る。
 *
 * **ここは docker を要らない。** 確かめるのは `tools/list` と役割の解決で、
 * コンテナを起こす必要は無い（起こすのは `core.test.ts`）。
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, describe, expect, it } from 'vitest';

import { resolve, type BantoModule, type ModuleSource } from '@banto/module-kit';
import { envProcessModule } from '@banto/module-env-process';

import { envDockerModule } from './index.js';

function liveSource(module: { manifest: BantoModule; createServer: () => unknown }): ModuleSource {
  return {
    manifest: module.manifest,
    listTools: async () => {
      const server = module.createServer() as { connect(t: unknown): Promise<void> };
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'capability-test', version: '0.0.0' });
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      try {
        return (await client.listTools()).tools.map((t) => t.name);
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  };
}

/** **実装の名前を1つも持たない。** これがこの試験の要。 */
const factory: ModuleSource = {
  manifest: {
    id: 'factory',
    description: '試験用。役割だけで依存する',
    isolation: 'in-process',
    mcp: { kind: 'in-process' },
    requires: [
      { capability: 'environment', tools: ['create', 'status', 'exec', 'address', 'destroy'] },
    ],
  },
  listTools: async () => ['request'],
};

beforeAll(async () => {
  process.env['BANTO_ENV_ROOT'] = await mkdtemp(path.join(tmpdir(), 'banto-env-sub-'));
  // core は image を要る（既定を持たない）。**役割の解決には走らせる必要が無い。**
  process.env['BANTO_DOCKER_IMAGE'] ??= 'node:22-slim';
});

describe('環境の実装は差し替えられる（決定16）', () => {
  const sources = () => [
    liveSource(envProcessModule),
    liveSource(envDockerModule),
    factory,
  ];

  // 中身が似ていない2つの実装に、同じ Factory がそのまま載る。
  it.each(['env-process', 'env-docker'])('%s に差し替えても、Factory は無変更で解ける', async (chosen) => {
    const resolution = await resolve(sources(), new Map([['environment', chosen]]));
    expect(resolution.problems).toEqual([]);
    expect(resolution.ready).toContain('factory');
  });

  it('どちらも同じ5つの動詞を、本物の tools/list で出す', async () => {
    for (const module of [envProcessModule, envDockerModule]) {
      const tools = await liveSource(module).listTools();
      expect([...tools].sort()).toEqual(['address', 'create', 'destroy', 'exec', 'status']);
    }
  });

});
