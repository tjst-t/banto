/**
 * Factory モジュールが `startServer` に配線されたときの経路（決定33）。
 * **本物の Factory・本物の HTTP。** `factory-api.test.ts` が `/api/runs` の
 * 経路を確かめているのと同じ理由——モジュールとして配線した口が実際に
 * 繋がっているかは、コードを眺めても分からない。
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
import { factoryModule, manifest as factoryManifest } from '@banto/module-factory';
import { RepoCore } from '@banto/module-repo';
import { ProcessEnvironmentCore } from '@banto/module-env-process';

import { startServer } from './server.js';

const exec = promisify(execFile);

let root: string;
let dataDir: string;
let server: ReturnType<typeof startServer>;
let origin: string;

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'banto-factory-module-repo-'));
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
  dataDir = await mkdtemp(path.join(tmpdir(), 'banto-factory-module-log-'));
  const log = new EventLog(dataDir);

  const factory = new Factory({
    log,
    repo: Object.assign(repo, { readFileAt: (ref: string, p: string) => repo.showFile(ref, p) }),
    environment: {
      create: (w) => env.create(w),
      status: (h) => env.status(h),
      exec: (h, c, a) => env.exec(h, c, a),
      address: async (h, port) => env.address(h, port),
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
  const pool = { factoryFor: async () => factory, allBuilt: async () => [factory] };

  server = startServer({
    dataDir,
    port: 0,
    // `apps/host/src/index.ts` の serve コマンドと同じ配線
    // ——AI 向けの道具（modules）と台帳（manifests）の両方に載せる。
    modules: [{ name: factoryManifest.id, kind: 'in-process', createServer: () => factoryModule(log, pool).createServer() }],
    manifests: [factoryManifest],
    toolsByModule: new Map([['factory', ['request_run', 'advance_runs', 'list_runs']]]),
    model: 'claude-sonnet-5',
    factory: pool,
  });
  await new Promise((r) => server.once('listening', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  server.close();
});

describe('Factory モジュールの配線（host）', () => {
  it('台帳に launcherUri が出る（人がAIのshowを待たずに開ける入口。要件C3）', async () => {
    const modules = await get('/api/modules');
    const factoryEntry = modules.modules.find((m: { id: string }) => m.id === 'factory');
    expect(factoryEntry.launcherUri).toBe('banto://factory/runs');
  });

  it('/api/resource で一覧・個別のRunが読める。中身は/api/runsと食い違わない', async () => {
    const requested = await post('/api/runs', { request: 'ファイルを1つ足す' });
    expect(requested.status).toBe(200);

    const runsResource = await get(`/api/resource?uri=${encodeURIComponent('banto://factory/runs')}`);
    const runs = JSON.parse(runsResource.text);
    expect(runs).toHaveLength(1);
    expect(runs[0].stage).toBe('worktree');

    const runId = runs[0].runId;
    const runResource = await get(
      `/api/resource?uri=${encodeURIComponent(`banto://factory/run/${runId}`)}`,
    );
    expect(JSON.parse(runResource.text)).toMatchObject({ runId, stage: 'worktree' });
  });

  it('/api/runs/advance で進めた結果が、モジュールのリソース読みにもそのまま反映される（真実は一箇所）', async () => {
    await post('/api/runs', { request: 'ファイルを1つ足す' });
    await post('/api/runs/advance', {});

    const merged = await exec('git', ['cat-file', '-e', 'main:work.txt'], { cwd: root }).then(
      () => true,
      () => false,
    );
    expect(merged).toBe(true);

    const runsResource = await get(`/api/resource?uri=${encodeURIComponent('banto://factory/runs')}`);
    const runs = JSON.parse(runsResource.text);
    expect(runs[0].stage).toBe('done');
  }, 60_000);
});
