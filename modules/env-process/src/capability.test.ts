/**
 * 役割の契約が、**本物の MCP サーバに対して**成り立っているかを確かめる（決定16）。
 *
 * ここが決定16 の眼目：Factory は `{ capability: 'environment' }` としか書いておらず、
 * **実装の名前をどこにも持たない。** それでも起動時に、実装が本当にその口を
 * 満たしているかが `tools/list` で実測される（要件 C11）。
 *
 * `inProcessSource` にツール名を手渡す形では**自己申告を自己申告で確かめる**ことに
 * なるので、実際にサーバへ繋いで聞く（規則1・教訓1）。
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, describe, expect, it } from 'vitest';

import { resolve, type BantoModule, type ModuleSource } from '@banto/module-kit';
import { publishNoneModule } from '@banto/module-publish-none';

import { envProcessModule, manifest as envProcessManifest } from './index.js';

/** 本物のサーバに繋いで `tools/list` を聞く。ここを偽ると、試験が何も証明しない。 */
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

/** Factory の代わり。**実装の名前を1つも持たない**ことがこの試験の要。 */
const factory: ModuleSource = {
  manifest: {
    id: 'factory',
    description: '試験用。役割だけで依存する',
    isolation: 'in-process',
    mcp: { kind: 'in-process' },
    requires: [
      { capability: 'environment', tools: ['create', 'status', 'exec', 'address', 'destroy'] },
      { capability: 'publish', tools: ['publish', 'unpublish'] },
    ],
  },
  listTools: async () => ['request'],
};

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'banto-env-cap-'));
});

describe('env-process と publish-none が役割を満たす（決定16）', () => {
  const sources = () => [liveSource(envProcessModule(root)), liveSource(publishNoneModule), factory];
  const bound = new Map([
    ['environment', 'env-process'],
    ['publish', 'publish-none'],
  ]);

  it('割り当てれば、Factory は実装を知らないまま解ける', async () => {
    const resolution = await resolve(sources(), bound);
    expect(resolution.problems).toEqual([]);
    expect(resolution.ready).toEqual(expect.arrayContaining(['factory', 'env-process', 'publish-none']));
  });

  // 名乗るだけでは足りない。口の名前を1つ変えれば、起動時に落ちなければならない。
  it('実装がツール名を変えたら、使う瞬間ではなく起動時に落ちる', async () => {
    const renamed: ModuleSource = {
      manifest: { ...envProcessManifest, id: 'env-process' },
      listTools: async () => ['create', 'status', 'run', 'address', 'destroy'], // exec → run
    };
    const resolution = await resolve([renamed, liveSource(publishNoneModule), factory], bound);
    expect(resolution.problems).toContainEqual(
      expect.objectContaining({ kind: 'required-tool-missing', tool: 'exec', missing: 'env-process' }),
    );
  });

  // 黙って選ばれた既定は忘れられる（要件 C8c と同じ理由）。
  it('割り当てが無ければ、候補が在っても起動しない', async () => {
    const resolution = await resolve(sources());
    expect(resolution.problems.map((p) => p.kind)).toEqual([
      'capability-unbound',
      'capability-unbound',
    ]);
  });
});
