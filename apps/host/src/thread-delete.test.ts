/**
 * スレッド削除（決定30）。**トゥームストーン**で、ログからは何も消えない。
 * 未マージのフォークは先に自動でマージし、選んだ行は共有baseへ持ち出してから削除する。
 */

import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventLog, fold, SHARED_BASE_THREAD_ID } from '@banto/core';

import { startServer } from './server.js';

let dataDir: string;
let log: EventLog;
let server: ReturnType<typeof startServer>;
let origin: string;

const post = async (p: string, body: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(origin + p, { method: 'POST', body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const get = async (p: string): Promise<any> => (await fetch(origin + p)).json();

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'banto-thread-delete-'));
  log = new EventLog(dataDir);
  await log.append({ type: 'channel.created', channelId: 'c1', channelName: 'banto' });

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

describe('POST /api/threads/delete', () => {
  it('未マージのフォークが無いスレッドは、そのまま削除される', async () => {
    await log.append({ type: 'thread.created', threadId: 't1', channelId: 'c1', title: '一本目' });

    const res = await post('/api/threads/delete', { threadId: 't1' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ threadId: 't1', mergedForks: 0, shared: 0 });

    const state = fold(await log.read());
    expect(state.threads.get('t1')?.deleted).toBe(true);
  });

  it('削除したスレッドは /api/state のどの一覧にも出ない', async () => {
    await log.append({ type: 'thread.created', threadId: 't1', channelId: 'c1', title: '一本目' });
    await post('/api/threads/delete', { threadId: 't1' });

    const state = await get('/api/state');
    expect(state.threads.find((t: any) => t.id === 't1')).toBeUndefined();
  });

  it('存在しないスレッドは 404', async () => {
    const res = await post('/api/threads/delete', { threadId: 'nope' });
    expect(res.status).toBe(404);
  });

  it('すでに削除済みなら 400', async () => {
    await log.append({ type: 'thread.created', threadId: 't1', channelId: 'c1', title: '一本目' });
    await post('/api/threads/delete', { threadId: 't1' });
    const res = await post('/api/threads/delete', { threadId: 't1' });
    expect(res.status).toBe(400);
  });

  it('共有baseスレッドは削除できない', async () => {
    const res = await post('/api/threads/delete', { threadId: SHARED_BASE_THREAD_ID });
    expect(res.status).toBe(400);
  });

  it('未マージのフォークを自動でマージしてから削除する', async () => {
    await log.append({ type: 'thread.created', threadId: 't1', channelId: 'c1', title: '親' });
    await log.append({
      type: 'thread.forked',
      threadId: 't2',
      channelId: 'c1',
      title: '枝',
      from: { threadId: 't1', baseVersion: 0 },
      mode: 'base',
    });
    await log.append({ type: 'base.appended', threadId: 't2', baseVersion: 1, text: '枝の決定' });

    const res = await post('/api/threads/delete', { threadId: 't1' });
    expect(res.status).toBe(200);
    expect(res.body.mergedForks).toBe(1);

    const state = fold(await log.read());
    expect(state.threads.get('t2')?.mergedInto).toBe('t1');
    // マージされた行は親（t1）に流れ込んでいる。t1自体は削除済みだが、記録は残る。
    expect(state.threads.get('t1')?.ownBase.map((e) => e.text)).toContain('枝の決定');
    expect(state.threads.get('t1')?.deleted).toBe(true);
  });

  it('選んだ行を、削除の前に共有baseへ持ち出す', async () => {
    await log.append({ type: 'thread.created', threadId: 't1', channelId: 'c1', title: '一本目' });
    await log.append({ type: 'base.appended', threadId: 't1', baseVersion: 1, text: 'このプロジェクト固有の決定' });
    await log.append({ type: 'base.appended', threadId: 't1', baseVersion: 2, text: '一般的な事実' });

    const res = await post('/api/threads/delete', { threadId: 't1', shareToSharedBase: [2] });
    expect(res.status).toBe(200);
    expect(res.body.shared).toBe(1);

    const state = fold(await log.read());
    const shared = state.threads.get(SHARED_BASE_THREAD_ID)?.ownBase.map((e) => e.text);
    expect(shared).toContain('一般的な事実');
    expect(shared).not.toContain('このプロジェクト固有の決定');
  });
});
