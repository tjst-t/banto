/**
 * **2つ目の実装ができたので、口が本当に差し替え可能かを確かめる**（決定16 の実装順）。
 *
 * 1つ目の実装では口の正しさは分からない——1つしか無ければ、口はその実装の形を
 * しているだけかもしれない。`env-process`（ホストで直接走らせる）と
 * `env-script`（リポジトリのスクリプトへ委譲する）は**中身が似ていない**ので、
 * 同じ Factory が両方に載るなら、口は実装から独立している。
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, describe, expect, it } from 'vitest';

import { resolve, type BantoModule, type ModuleSource } from '@banto/module-kit';
import { envProcessModule } from '@banto/module-env-process';

import { envScriptModule } from './index.js';

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
});

describe('環境の実装は差し替えられる（決定16）', () => {
  const sources = () => [
    liveSource(envProcessModule),
    liveSource(envScriptModule({ allowedRepos: [] })),
    factory,
  ];

  // 中身が似ていない2つの実装に、同じ Factory がそのまま載る。
  it.each(['env-process', 'env-script'])('%s に差し替えても、Factory は無変更で解ける', async (chosen) => {
    const resolution = await resolve(sources(), new Map([['environment', chosen]]));
    expect(resolution.problems).toEqual([]);
    expect(resolution.ready).toContain('factory');
  });

  it('どちらも同じ4つの動詞を、本物の tools/list で出す', async () => {
    for (const module of [envProcessModule, envScriptModule({ allowedRepos: [] })]) {
      const tools = await liveSource(module).listTools();
      expect([...tools].sort()).toEqual(['address', 'create', 'destroy', 'exec', 'status']);
    }
  });

  // 許可が空でも tools/list は答える——**起動できることと、使えることは別**。
  // ここを混ぜると、許可の判断が「モジュールが載っているか」にすり替わる。
  it('許可が空でも役割は満たす。断るのは呼ばれたとき', async () => {
    const resolution = await resolve(
      [liveSource(envScriptModule({ allowedRepos: [] })), factory],
      new Map([['environment', 'env-script']]),
    );
    expect(resolution.problems).toEqual([]);
  });
});
