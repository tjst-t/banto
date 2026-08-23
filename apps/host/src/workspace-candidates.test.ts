/**
 * スレッド作成の場所の候補（決定32）。**役割 `workspace-suggestions` を持つ
 * モジュールに聞いて集める**——ここでは本物の `repo` モジュールを1つ繋いで、
 * 集約と `inUse` の付け方だけを測る（`list_candidates` 自体のふるまいは
 * `modules/repo/src/core.test.ts` が持っている）。
 */

import { execFile } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventLog } from '@banto/core';
import { repoModule } from '@banto/module-repo';

import { startServer } from './server.js';

const execFileAsync = promisify(execFile);

let dataDir: string;
let fsRoot: string;
let log: EventLog;
let server: ReturnType<typeof startServer>;
let origin: string;

const get = async (p: string): Promise<any> => (await fetch(origin + p)).json();

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'banto-wscand-log-'));
  fsRoot = await mkdtemp(path.join(tmpdir(), 'banto-wscand-fs-'));
  log = new EventLog(dataDir);
  await log.append({ type: 'channel.created', channelId: 'c1', channelName: 'banto' });

  await mkdir(path.join(fsRoot, 'repo-a'), { recursive: true });
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: path.join(fsRoot, 'repo-a') });

  server = startServer({
    dataDir,
    port: 0,
    modules: [],
    toolsByModule: new Map(),
    model: 'claude-haiku-4-5',
    workspaceSuggestionModules: [
      { name: 'repo', kind: 'in-process', createServer: () => repoModule(fsRoot).createServer() },
    ],
  });
  await new Promise((r) => server.once('listening', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  server.close();
});

describe('GET /api/workspace-candidates', () => {
  it('繋いだモジュールの候補を集めて返す', async () => {
    const body = await get('/api/workspace-candidates');
    expect(body.candidates).toEqual([
      expect.objectContaining({ path: 'repo-a', label: 'repo-a', inUse: false }),
    ]);
  });

  it('既にスレッドが使っている場所は inUse: true になる', async () => {
    await log.append({
      type: 'thread.created',
      threadId: 't1',
      channelId: 'c1',
      title: '一本目',
      workspaceRoot: 'repo-a',
    });
    const body = await get('/api/workspace-candidates');
    expect(body.candidates).toEqual([
      expect.objectContaining({ path: 'repo-a', inUse: true }),
    ]);
  });

  it('モジュールを何も繋いでいなければ空で返る', async () => {
    const bareDir = await mkdtemp(path.join(tmpdir(), 'banto-wscand-bare-'));
    const bare = startServer({
      dataDir: bareDir,
      port: 0,
      modules: [],
      toolsByModule: new Map(),
      model: 'claude-haiku-4-5',
    });
    await new Promise((r) => bare.once('listening', r));
    const bareOrigin = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`;
    const res = await fetch(`${bareOrigin}/api/workspace-candidates`);
    expect(res.status).toBe(200);
    expect((await res.json()).candidates).toEqual([]);
    bare.close();
  });
});
