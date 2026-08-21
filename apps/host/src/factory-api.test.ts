/**
 * Factory の口（要件 B1・B2・E1）。**本物の HTTP で叩く。**
 *
 * 実装者だけ決まった動きのものに差し替える——Claude の枠を使わずに、
 * 「依頼を投げる → 進める → 状態が見える」という**経路そのもの**を確かめたい。
 * 経路が繋がっていないことは、口を眺めても分からない。
 */

import { execFile } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventLog } from '@banto/core';
import { Factory } from '@banto/factory';
import { RepoCore } from '@banto/module-repo';
import { ProcessEnvironmentCore } from '@banto/module-env-process';

import { startServer } from './server.js';

const exec = promisify(execFile);

let root: string;
let dataDir: string;
let server: ReturnType<typeof startServer>;
let origin: string;

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'banto-api-repo-'));
  const git = (...args: string[]) => exec('git', args, { cwd: dir });
  await git('init', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'test');
  await writeFile(path.join(dir, 'README.md'), '# test\n', 'utf8');
  await git('add', '-A');
  await git('commit', '-m', 'first');
  return dir;
}

const post = async (p: string, body: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(origin + p, { method: 'POST', body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const get = async (p: string): Promise<any> => (await fetch(origin + p)).json();

beforeEach(async () => {
  root = await makeRepo();
  const repo = new RepoCore(root);
  const env = new ProcessEnvironmentCore(root);
  dataDir = await mkdtemp(path.join(tmpdir(), 'banto-api-log-'));
  const log = new EventLog(dataDir);

  const factory = new Factory({
    log,
    repo,
    environment: {
      create: (w) => env.create(w),
      status: (h) => env.status(h),
      exec: (h, c, a) => env.exec(h, c, a),
      destroy: (h) => env.destroy(h),
    },
    implementer: {
      implement: async (plan) => {
        const cwd = path.join(root, plan.workdir);
        await writeFile(path.join(cwd, 'work.txt'), plan.request, 'utf8');
        await exec('git', ['add', '-A'], { cwd });
        await exec('git', ['commit', '-m', plan.request], { cwd });
      },
    },
    test: { command: 'sh', args: ['-c', 'test -f work.txt'] },
  });

  server = startServer({
    // **ホストと Factory は同じログを見る。** 別々にすると、口が返す状態と
    // 実際に進んでいるものが食い違う（規則3）。
    dataDir,
    port: 0,
    modules: [],
    toolsByModule: new Map(),
    model: 'claude-sonnet-5',
    factory,
  });
  await new Promise((r) => server.once('listening', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  server.close();
});

describe('Factory の口', () => {
  it('依頼を投げて、進めて、main に入る', async () => {
    const requested = await post('/api/runs', { request: 'ファイルを1つ足す' });
    expect(requested.status).toBe(200);
    expect(requested.body.branch).toMatch(/^factory\//);

    // **投げただけでは進まない**（要件 B4：投げる側を待たせない）。
    const before = await get('/api/state');
    expect(before.runs).toHaveLength(1);

    await post('/api/runs/advance', {});

    const merged = await exec('git', ['cat-file', '-e', 'main:work.txt'], { cwd: root }).then(
      () => true,
      () => false,
    );
    expect(merged).toBe(true);
  }, 60_000);

  it('依頼は base に入り、会話が1本できる（仕様 §5.1）', async () => {
    await post('/api/runs', { request: '依頼の文' });

    const state = await get('/api/state');
    expect(state.threads).toHaveLength(1);
    // base に入っているので、ゲートの残量が減っている（要件 R8）。
    expect(state.threads[0].baseCharacters).toBe('依頼の文'.length);
    expect(state.threads[0].baseVersion).toBe(1);
  });

  it('Run の一覧は畳んで作る。テスト結果が sha つきで見える', async () => {
    await post('/api/runs', { request: 'ファイルを1つ足す' });
    await post('/api/runs/advance', {});

    const state = await get('/api/state');
    expect(state.runs[0].failed).toBe(false);
    expect(state.runs[0].testedCommits[0].passed).toBe(true);
    expect(state.runs[0].testedCommits[0].commit).toMatch(/^[0-9a-f]{40}$/);
  }, 60_000);

  it('request が空なら断る', async () => {
    expect((await post('/api/runs', { request: '  ' })).status).toBe(400);
  });
});

describe('Factory が紐づいていないとき', () => {
  it('黙って何もしない口を作らない（規則2）', async () => {
    const bare = startServer({
      dataDir: await mkdtemp(path.join(tmpdir(), 'banto-api-bare-')),
      port: 0,
      modules: [],
      toolsByModule: new Map(),
      model: 'claude-sonnet-5',
    });
    await new Promise((r) => bare.once('listening', r));
    const at = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`;
    const res = await fetch(`${at}/api/runs`, { method: 'POST', body: '{"request":"x"}' });
    expect(res.status).toBe(501);
    bare.close();
  });
});
