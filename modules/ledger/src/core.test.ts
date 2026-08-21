import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { EventLog, fold } from '@banto/core';

import { LedgerCore } from './core.js';

async function fresh(): Promise<{ log: EventLog; core: LedgerCore }> {
  const log = new EventLog(await mkdtemp(path.join(tmpdir(), 'banto-ledger-')));
  return { log, core: new LedgerCore(log) };
}

const decision = { decisionId: 'd1', source: 'thread' as const, threadId: null, question: 'よいか' };

describe('ledger（イベントログの面・決定17）', () => {
  it('判断を立てると、1本のキューに載る（要件 A6）', async () => {
    const { log, core } = await fresh();
    await core.requestDecision(decision);
    expect(fold(await log.read()).pendingDecisions.has('d1')).toBe(true);
  });

  it('同じ id では二重に立てない', async () => {
    const { log, core } = await fresh();
    for (let i = 0; i < 3; i += 1) await core.requestDecision(decision);
    expect((await log.read()).filter((e) => e.type === 'decision.requested')).toHaveLength(1);
  });

  it('答えが出たものを、もう一度立て直さない', async () => {
    const { log, core } = await fresh();
    await core.requestDecision(decision);
    await core.resolveDecision('d1', 'よい');
    await core.requestDecision(decision);
    expect((await log.read()).filter((e) => e.type === 'decision.requested')).toHaveLength(1);
  });

  // 握りつぶすと「答えたつもり」が残る（規則2）。
  it('立っていない判断には答えさせない', async () => {
    const { core } = await fresh();
    await expect(core.resolveDecision('nope', 'x')).rejects.toThrow(/立っていない判断/);
  });

  describe('選択肢', () => {
    const withOptions = {
      ...decision,
      threadId: 't1',
      options: [
        { id: 'approve', label: '取り込む' },
        { id: 'reject', label: '取り込まない' },
      ],
    };

    it('立てた選択肢が、判断待ちの列にそのまま出る', async () => {
      const { log, core } = await fresh();
      await core.requestDecision(withOptions);
      const pending = fold(await log.read()).pendingDecisions.get('d1');
      expect(pending?.options?.map((o) => o.id)).toEqual(['approve', 'reject']);
    });

    it('選んだ選択肢が、答えに残る', async () => {
      const { log, core } = await fresh();
      await core.requestDecision(withOptions);
      const result = await core.resolveDecision('d1', '取り込む', 'approve');
      expect(result.optionId).toBe('approve');
      expect(await log.read()).toContainEqual(
        expect.objectContaining({ type: 'decision.resolved', optionId: 'approve' }),
      );
    });

    // **どれも選べないのは普通のこと**（要件 A6 の「人が決める」）。
    // 選択肢を出したからといって、答えをそれに縛らない。
    it('選択肢があっても、自由に書いて答えられる', async () => {
      const { core } = await fresh();
      await core.requestDecision(withOptions);
      const result = await core.resolveDecision('d1', 'どちらでもなく、先に設計を見たい');
      expect(result.optionId).toBeNull();
    });

    // 出していない id を通すと、立てた側が読めない鍵が答えに載る（規則2）。
    it('知らない選択肢は断る', async () => {
      const { core } = await fresh();
      await core.requestDecision(withOptions);
      await expect(core.resolveDecision('d1', 'x', 'merge')).rejects.toThrow(/知らない選択肢/);
    });

    // 答えが判断待ちの列にしか残らないと、会話の側から見て**何も起きていない**。
    it('答えは、その判断が属するスレッドの会話に返る', async () => {
      const { log, core } = await fresh();
      await core.requestDecision(withOptions);
      const result = await core.resolveDecision('d1', '取り込む', 'approve');

      expect(result.deliveredTo).toBe('t1');
      const message = (await log.read()).find((e) => e.type === 'message.recorded');
      expect(message).toMatchObject({ threadId: 't1', role: 'user' });
    });

    it('属するスレッドが無ければ、返す先も無い', async () => {
      const { core } = await fresh();
      await core.requestDecision(decision); // threadId: null
      expect((await core.resolveDecision('d1', 'よい')).deliveredTo).toBeNull();
    });
  });

  it('読むときは畳まない。そのまま返す（規則3）', async () => {
    const { log, core } = await fresh();
    await log.append({ type: 'channel.created', channelId: 'c1', channelName: 'x' });
    await log.append({ type: 'thread.created', threadId: 't1', channelId: 'c1', title: 'a' });
    await log.append({ type: 'thread.created', threadId: 't2', channelId: 'c1', title: 'b' });

    expect(await core.read()).toHaveLength(3);
    expect((await core.read('t1')).map((e) => e.type)).toEqual(['thread.created']);
  });
});
