/**
 * `FactoryCore`（決定33）。**本物の Factory は要らない**——ここで確かめたいのは
 * 「core がどう束ねるか」であって、Factory 自身の中身は `packages/factory` の
 * 試験が本物で確かめている（`apps/host/src/factory-pool.test.ts` と同じ考え）。
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { EventLog, fold } from '@banto/core';
import type { Factory, FactoryPool, Observation } from '@banto/factory';

import { FactoryCore } from './core.js';

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
let requested: unknown[];
let advancedIds: string[];
let builtRepos: string[];

/**
 * **`run.requested` を実際にログへ積む**——本物の `Factory.request` がそうする
 * ので、偽物もそこだけは揃えないと `foldRuns`（core が使う）に何も映らない。
 * それ以外（実装・テスト・取り込み）は Factory 自身の試験が本物で確かめている。
 */
function fakeFactory(): Factory {
  return {
    request: async (input: {
      runId: string;
      channelId: string;
      threadId: string;
      branch: string;
      request: string;
    }) => {
      requested.push(input);
      await log.append({ type: 'run.requested', ...input });
    },
    advanceAll: async () => {
      advancedIds.push('advanced');
    },
    observe: async () => FRESH_OBSERVATION,
  } as unknown as Factory;
}

function fakePool(rejectRepos: readonly string[] = []): FactoryPool {
  const built = new Map<string, Factory>();
  return {
    factoryFor: async (repo: string) => {
      builtRepos.push(repo);
      if (rejectRepos.includes(repo)) throw new Error(`許された範囲の外: ${repo}`);
      let f = built.get(repo);
      if (f === undefined) {
        f = fakeFactory();
        built.set(repo, f);
      }
      return f;
    },
    allBuilt: async () => [...built.values()],
  };
}

beforeEach(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'banto-module-factory-'));
  log = new EventLog(dataDir);
  requested = [];
  advancedIds = [];
  builtRepos = [];
});

describe('FactoryCore.requestRun', () => {
  it('チャンネルを名前で1つに保ち、Factory へ依頼を渡す', async () => {
    const core = new FactoryCore(log, fakePool());
    const res = await core.requestRun({ request: 'テストを直す' });

    expect(res.branch).toMatch(/^factory\//);
    expect(res.uri).toBe(`banto://factory/run/${res.runId}`);
    expect(requested).toHaveLength(1);
    expect((requested[0] as { request: string }).request).toBe('テストを直す');

    // 既定のチャンネル名は 'banto-v3'。2回目も同じチャンネルに束ねる（二重に作らない）。
    await core.requestRun({ request: '2件目' });
    const state = fold(await log.read());
    expect([...state.channels.values()].filter((c) => c.name === 'banto-v3')).toHaveLength(1);
  });

  it('repo・branch・channelNameを渡すとそのまま使う', async () => {
    const core = new FactoryCore(log, fakePool());
    const res = await core.requestRun({
      request: 'X',
      repo: 'sub-repo',
      branch: 'my-branch',
      channelName: 'other-channel',
    });

    expect(res.branch).toBe('my-branch');
    expect(builtRepos).toContain('sub-repo');
    const state = fold(await log.read());
    expect([...state.channels.values()].some((c) => c.name === 'other-channel')).toBe(true);
  });
});

describe('FactoryCore.advanceRuns', () => {
  it('組み立て済みの Factory を全部進める', async () => {
    const pool = fakePool();
    const core = new FactoryCore(log, pool);
    await core.requestRun({ request: 'A' });
    await core.requestRun({ request: 'B', repo: 'other' });

    await core.advanceRuns();

    expect(advancedIds).toHaveLength(2);
  });
});

describe('FactoryCore.listRuns / describeRun', () => {
  it('Run が無ければ空配列', async () => {
    const core = new FactoryCore(log, fakePool());
    expect(await core.listRuns()).toEqual([]);
  });

  it('段を観測して返す（新規Runはworktree段）', async () => {
    const core = new FactoryCore(log, fakePool());
    const { runId } = await core.requestRun({ request: '依頼の文' });

    const runs = await core.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ runId, request: '依頼の文', failed: false, stage: 'worktree' });

    const one = await core.describeRun(runId);
    expect(one).toMatchObject({ runId, stage: 'worktree' });
  });

  it('知らない runId には null を返す', async () => {
    const core = new FactoryCore(log, fakePool());
    expect(await core.describeRun('no-such-run')).toBeNull();
  });

  it('デフォルトrepoのFactoryが組み立てられなければ、観測できない理由を返す', async () => {
    const core = new FactoryCore(log, fakePool(['.']));
    const { runId } = await core.requestRun({ request: 'X', repo: 'sub' });

    const runs = await core.listRuns();
    expect(runs[0]?.stage).toContain('観測できない');
    const one = await core.describeRun(runId);
    expect(one?.stage).toContain('観測できない');
  });
});
