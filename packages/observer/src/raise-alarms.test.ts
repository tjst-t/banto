import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { EventLog, fold, pendingQueue } from '@banto/core';
import { describe, expect, it } from 'vitest';

import { observe, type ObserveOptions, type Turn } from './observe.js';
import { raiseAlarms } from './raise-alarms.js';

const options: ObserveOptions = { contextLimit: 1_000, absenceTurns: 5, compactionDropRatio: 0.2 };
const quiet: ObserveOptions = { contextLimit: 10_000_000, absenceTurns: 10_000, compactionDropRatio: 0.2 };

function rising(seriesId: string, count: number): Turn[] {
  return Array.from({ length: count }, (_, index) => ({
    seriesId,
    index,
    usage: {
      inputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 100 * (index + 1),
      outputTokens: 1,
    },
  }));
}

async function queueOf(dataDir: string): Promise<ReturnType<typeof pendingQueue>> {
  return pendingQueue(fold(await new EventLog(dataDir).read()));
}

describe('raiseAlarms', () => {
  it('警報を判断待ちの列に入れる（要件 F1 → A6）', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'banto-alarm-'));
    const result = await raiseAlarms(dataDir, observe(rising('t1', 20), options));

    expect(result.raised).toHaveLength(2); // 量 と 不在
    const queue = await queueOf(dataDir);
    // 出所は observer。会話・Factory と同じ1本の列に入る。
    expect(queue.every((d) => d.source === 'observer')).toBe(true);
    expect(queue.map((d) => d.decisionId).sort()).toEqual([
      'alarm:absence:t1',
      'alarm:quantity:t1',
    ]);
  });

  // 2回目で `since` を上書きすると、滞留の時計が毎回巻き戻り、
  // 要件 A7 の「滞留したら端末へ push」が永久に発火しなくなる。
  it('繰り返し走らせても増えず、待ち始めた時刻を巻き戻さない', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'banto-alarm-'));
    const observation = observe(rising('t1', 20), options);

    await raiseAlarms(dataDir, observation);
    const first = await queueOf(dataDir);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await raiseAlarms(dataDir, observation);

    expect(second.raised).toHaveLength(0);
    expect(second.alreadyPending).toHaveLength(2);

    const after = await queueOf(dataDir);
    expect(after).toHaveLength(2);
    expect(after.map((d) => d.since)).toEqual(first.map((d) => d.since));
  });

  it('条件が消えたら列から畳む（列が嘘をつかない）', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'banto-alarm-'));
    await raiseAlarms(dataDir, observe(rising('t1', 20), options));
    expect(await queueOf(dataDir)).toHaveLength(2);

    const result = await raiseAlarms(dataDir, observe(rising('t1', 20), quiet));
    expect(result.resolved).toHaveLength(2);
    expect(await queueOf(dataDir)).toHaveLength(0);
  });

  it('人が立てた判断待ちには触らない', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'banto-alarm-'));
    const log = new EventLog(dataDir);
    await log.append({
      type: 'decision.requested',
      decisionId: 'human-1',
      source: 'thread',
      threadId: null,
      question: 'この方針でよいか',
    });

    // 警報ゼロの観測を渡しても、警報由来でないものは畳まれない。
    const result = await raiseAlarms(dataDir, observe(rising('t1', 20), quiet));
    expect(result.resolved).toHaveLength(0);
    expect((await queueOf(dataDir)).map((d) => d.decisionId)).toEqual(['human-1']);
  });
});
