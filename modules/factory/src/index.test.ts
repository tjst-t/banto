/**
 * Factory モジュールの配線を確かめる試験。**本物の MCP** で接続し、
 * ツール呼び出しとリソース読みの両方が実際に通ることを確認する
 * ——core 単体の試験（`core.test.ts`）は経路そのものを見ていない。
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';

import { EventLog } from '@banto/core';
import type { Factory, FactoryPool, Observation } from '@banto/factory';

import { factoryModule } from './index.js';

const FRESH_OBSERVATION: Observation = {
  failed: false,
  hasWorktree: false,
  environment: 'gone',
  hasCommits: false,
  head: null,
  testedHead: null,
  review: 'not-required',
  merged: false,
};

let log: EventLog;

function fakePool(): FactoryPool {
  const factory: Factory = {
    request: async (input: { runId: string; channelId: string; threadId: string; branch: string; request: string }) =>
      log.append({ type: 'run.requested', ...input }).then(() => undefined),
    advanceAll: async () => undefined,
    observe: async () => FRESH_OBSERVATION,
  } as unknown as Factory;
  return { factoryFor: async () => factory, allBuilt: async () => [factory] };
}

async function connect(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = factoryModule(log, fakePool()).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, close: () => client.close() };
}

beforeEach(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'banto-module-factory-wiring-'));
  log = new EventLog(dataDir);
});

describe('Factory モジュールの配線', () => {
  it('request_run で投げ、list_runs / banto://factory/runs の両方に出る', async () => {
    const { client, close } = await connect();
    try {
      const requested = await client.callTool({
        name: 'request_run',
        arguments: { request: 'テストを直す' },
      });
      expect(requested.isError).toBeFalsy();
      const runId = (requested.structuredContent as { runId: string }).runId;
      expect(runId).toBeTruthy();

      const listed = await client.callTool({ name: 'list_runs', arguments: {} });
      const runs = (listed.structuredContent as { runs: { runId: string; stage: string }[] }).runs;
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ runId, stage: 'worktree' });

      const resource = await client.readResource({ uri: 'banto://factory/runs' });
      const text = (resource.contents[0] as { text: string }).text;
      expect(JSON.parse(text)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('banto://factory/run/{runId} で個別に読める。無ければ断る', async () => {
    const { client, close } = await connect();
    try {
      const requested = await client.callTool({
        name: 'request_run',
        arguments: { request: 'X' },
      });
      const runId = (requested.structuredContent as { runId: string }).runId;

      const resource = await client.readResource({ uri: `banto://factory/run/${runId}` });
      const text = (resource.contents[0] as { text: string }).text;
      expect(JSON.parse(text)).toMatchObject({ runId, stage: 'worktree' });

      await expect(client.readResource({ uri: 'banto://factory/run/no-such-run' })).rejects.toThrow();
    } finally {
      await close();
    }
  });

  it('advance_runs は断らずに済む', async () => {
    const { client, close } = await connect();
    try {
      const res = await client.callTool({ name: 'advance_runs', arguments: {} });
      expect(res.isError).toBeFalsy();
    } finally {
      await close();
    }
  });
});
