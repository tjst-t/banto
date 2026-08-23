/**
 * フォークからのフォークは作れない（決定31）。
 *
 * 実際に本番で、幹の解決が1階層しか遡らず、フォークのフォークを開くと
 * 幹側のパネルまでフォーク扱いに見える壊れ方が起きた（PO報告）。
 * フロント（ボタンを出さない）だけでなく、ここでも断る——直接APIを叩けば
 * フロントの制約は素通りする（規則1）。
 */

import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventLog } from '@banto/core';

import { startServer } from './server.js';

let dataDir: string;
let log: EventLog;
let server: ReturnType<typeof startServer>;
let origin: string;

const post = async (p: string, body: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(origin + p, { method: 'POST', body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'banto-thread-fork-'));
  log = new EventLog(dataDir);
  await log.append({ type: 'channel.created', channelId: 'c1', channelName: 'banto' });
  await log.append({ type: 'thread.created', threadId: 't1', channelId: 'c1', title: '幹' });

  server = startServer({
    dataDir,
    port: 0,
    modules: [],
    toolsByModule: new Map(),
    model: 'claude-haiku-4-5',
  });
  await new Promise((r) => server.once('listening', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  server.close();
});

describe('POST /api/threads/fork', () => {
  it('幹からはフォークできる', async () => {
    const res = await post('/api/threads/fork', { fromThreadId: 't1' });
    expect(res.status).toBe(200);
  });

  it('フォークからのフォークは 400 で断る', async () => {
    const first = await post('/api/threads/fork', { fromThreadId: 't1' });
    expect(first.status).toBe(200);

    const second = await post('/api/threads/fork', { fromThreadId: first.body.threadId });
    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/フォークからのフォーク/);
  });
});
