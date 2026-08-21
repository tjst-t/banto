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

  it('読むときは畳まない。そのまま返す（規則3）', async () => {
    const { log, core } = await fresh();
    await log.append({ type: 'channel.created', channelId: 'c1', channelName: 'x' });
    await log.append({ type: 'thread.created', threadId: 't1', channelId: 'c1', title: 'a' });
    await log.append({ type: 'thread.created', threadId: 't2', channelId: 'c1', title: 'b' });

    expect(await core.read()).toHaveLength(3);
    expect((await core.read('t1')).map((e) => e.type)).toEqual(['thread.created']);
  });
});
