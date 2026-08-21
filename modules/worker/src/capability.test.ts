/**
 * **中核同梱のものも、口は他のモジュールと同じ**（要件 C13・決定17）。
 *
 * ここで確かめるのは、`worker` / `ledger` が**他のモジュールと同じやり方で**
 * 台帳に載り、役割を名乗り、その役割を本物の `tools/list` で満たすこと。
 * 満たしていないなら、C13 は言葉だけになる。
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { EventLog } from '@banto/core';
import { resolve, type BantoModule, type ModuleSource } from '@banto/module-kit';
import { ledgerModule } from '@banto/module-ledger';

import { WorkerCore, workerModule } from './index.js';

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

async function freshLog(): Promise<EventLog> {
  return new EventLog(await mkdtemp(path.join(tmpdir(), 'banto-core-mod-')));
}

const worker = async () =>
  workerModule({
    log: await freshLog(),
    model: 'claude-haiku-4-5',
    mcpServers: [],
    toolsByModule: new Map(),
  });

describe('中核同梱のモジュールも、役割を名乗って満たす（要件 C13）', () => {
  it('worker と ledger が、本物の tools/list で役割を満たす', async () => {
    const consumer: ModuleSource = {
      manifest: {
        id: 'consumer',
        description: '試験用。役割だけで依存する',
        isolation: 'in-process',
        mcp: { kind: 'in-process' },
        requires: [
          { capability: 'worker', tools: ['work'] },
          { capability: 'ledger', tools: ['request_decision', 'resolve_decision', 'read_events'] },
        ],
      },
      listTools: async () => ['noop'],
    };

    const resolution = await resolve(
      [liveSource(await worker()), liveSource(ledgerModule(await freshLog())), consumer],
      new Map([
        ['worker', 'worker'],
        ['ledger', 'ledger'],
      ]),
    );
    expect(resolution.problems).toEqual([]);
    expect(resolution.ready).toEqual(expect.arrayContaining(['worker', 'ledger', 'consumer']));
  });

  // 中核の資源を握っていても、外から見える形は普通のモジュールと変わらない。
  it('worker の口に、ランタイムの語彙が漏れていない（決定6）', async () => {
    const server = (await worker()).createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'leak-test', version: '0.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const { tools } = await client.listTools();
      const surface = JSON.stringify(tools);
      for (const vendorWord of ['SDKMessage', 'QueryInput', 'anthropic', 'claude-']) {
        expect(surface).not.toContain(vendorWord);
      }
    } finally {
      await client.close();
    }
  });

  // ランタイムを呼ぶ前に落ちる。Claude の枠を使わずに確かめられる。
  it('知らないスレッドの仕事は、走らせる前に断る（規則2）', async () => {
    const w = new WorkerCore({
      log: await freshLog(),
      model: 'claude-haiku-4-5',
      mcpServers: [],
      toolsByModule: new Map(),
    });
    await expect(
      w.work({ threadId: 'nope', queryId: 'q1', request: 'x', cwd: '/tmp' }),
    ).rejects.toThrow(/知らないスレッド/);
  });
});
