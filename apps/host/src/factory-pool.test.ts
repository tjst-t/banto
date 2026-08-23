/**
 * `/api/runs` の `repo` 選択（決定29）。**本物の Factory は要らない**——
 * ここで確かめたいのは「host がどの repo に対して factoryFor を呼ぶか」であって、
 * Factory 自身の中身は `factory-api.test.ts` が本物で確かめている。
 */

import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Factory } from '@banto/factory';

import { startServer, type FactoryPool } from './server.js';

let dataDir: string;
let server: ReturnType<typeof startServer>;
let origin: string;
let requestedRepos: string[];
let advanced: string[];

const post = async (p: string, body: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(origin + p, { method: 'POST', body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

function fakeFactory(id: string): Factory {
  return {
    request: async () => undefined,
    advanceAll: async () => {
      advanced.push(id);
    },
  } as unknown as Factory;
}

function fakePool(): FactoryPool {
  const built = new Map<string, Factory>();
  return {
    factoryFor: async (repo: string) => {
      requestedRepos.push(repo);
      if (repo === 'outside') throw new Error('許された範囲の外: outside');
      let f = built.get(repo);
      if (!f) {
        f = fakeFactory(repo);
        built.set(repo, f);
      }
      return f;
    },
    allBuilt: async () => [...built.values()],
  };
}

beforeEach(async () => {
  requestedRepos = [];
  advanced = [];
  dataDir = await mkdtemp(path.join(tmpdir(), 'banto-pool-'));
  server = startServer({
    dataDir,
    port: 0,
    modules: [],
    toolsByModule: new Map(),
    model: 'claude-sonnet-5',
    factory: fakePool(),
  });
  await new Promise((r) => server.once('listening', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  server.close();
});

describe('複数リポジトリの Factory 選択', () => {
  it('repo を省くと "." を要求する（単一リポジトリ運用と同じ動き）', async () => {
    const res = await post('/api/runs', { request: 'x' });
    expect(res.status).toBe(200);
    expect(requestedRepos).toEqual(['.']);
  });

  it('repo を指定すると、そのリポジトリを要求する', async () => {
    await post('/api/runs', { request: 'x', repo: 'repo-a' });
    expect(requestedRepos).toEqual(['repo-a']);
  });

  it('別々の repo は別々に要求される。advance は要求された分だけ進める', async () => {
    await post('/api/runs', { request: 'x', repo: 'repo-a' });
    await post('/api/runs', { request: 'y', repo: 'repo-b' });
    await post('/api/runs/advance', {});
    expect(advanced.sort()).toEqual(['repo-a', 'repo-b']);
  });

  it('root の外を指すと 400 で断る（factoryFor が投げた理由をそのまま返す）', async () => {
    const res = await post('/api/runs', { request: 'x', repo: 'outside' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/許された範囲の外/);
  });
});
