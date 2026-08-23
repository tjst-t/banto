import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  appendBase,
  baseCharacters,
  baseLimitDecisionId,
  checkBaseAppend,
  ensureSharedBaseThread,
  invalidateBase,
  reactivateBase,
} from './base.js';
import { effectiveBase, fold, SHARED_BASE_THREAD_ID } from './fold.js';
import { EventLog } from './log.js';

/** 本物のログに書く。偽物は本物の制約を持たないので、偽物で通っても何も分からない（教訓1）。 */
async function freshLog(): Promise<EventLog> {
  return new EventLog(await mkdtemp(path.join(tmpdir(), 'banto-base-')));
}

/** チャンネル1本・スレッド1本まで作った状態。 */
async function withThread(): Promise<EventLog> {
  const log = await freshLog();
  await log.append({ type: 'channel.created', channelId: 'c1', channelName: 'banto' });
  await log.append({ type: 'thread.created', threadId: 't1', channelId: 'c1', title: '一本目' });
  return log;
}

const state = async (log: EventLog) => fold(await log.read());

describe('base のゲート（要件 R8・決定4）', () => {
  it('閾値の内側なら追記され、版が進む', async () => {
    const log = await withThread();
    const gate = await appendBase(log, await state(log), 't1', '依頼: Phase 2', 100);

    expect(gate.ok).toBe(true);
    const after = await state(log);
    expect(effectiveBase(after, 't1')).toEqual(['依頼: Phase 2']);
    expect(after.threads.get('t1')?.baseVersion).toBe(1);
  });

  // ここを追記「前」で見ると、1回の巨大な追記が素通りする。
  it('判定は追記の「後」で行う——1回の巨大な追記も止まる', async () => {
    const log = await withThread();
    const gate = checkBaseAppend(await state(log), 't1', 'x'.repeat(500), 100);

    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.characters).toBe(0);
      expect(gate.wouldBe).toBe(500);
    }
  });

  it('拒否したとき base は伸びない', async () => {
    const log = await withThread();
    await appendBase(log, await state(log), 't1', 'x'.repeat(500), 100);

    const after = await state(log);
    expect(effectiveBase(after, 't1')).toEqual([]);
    expect(after.threads.get('t1')?.baseVersion).toBe(0);
    expect((await log.read()).some((e) => e.type === 'base.appended')).toBe(false);
  });

  it('拒否したとき、選択肢としての R5 が判断待ちに立つ（要件 A6）', async () => {
    const log = await withThread();
    await appendBase(log, await state(log), 't1', 'x'.repeat(500), 100);

    const pending = (await state(log)).pendingDecisions.get(baseLimitDecisionId('t1'));
    expect(pending?.source).toBe('observer');
    expect(pending?.threadId).toBe('t1');
    expect(pending?.question).toContain('R5');
  });

  // 何度でも拒否されるので、都度立てると同じ判断がキューを埋める。
  it('何度拒否されても、判断は1つしか立たない', async () => {
    const log = await withThread();
    for (let i = 0; i < 5; i += 1) {
      await appendBase(log, await state(log), 't1', 'x'.repeat(500), 100);
    }

    const decisions = (await log.read()).filter((e) => e.type === 'decision.requested');
    expect(decisions).toHaveLength(1);
    expect((await state(log)).pendingDecisions.size).toBe(1);
  });

  // 費用を持つのは実効の base。継承分を数えないと、fork するたびに上限が復活する。
  it('fork が継承した分も大きさに数える（要件 R4）', async () => {
    const log = await withThread();
    await appendBase(log, await state(log), 't1', 'x'.repeat(80), 100);
    await log.append({
      type: 'thread.forked',
      threadId: 't2',
      channelId: 'c1',
      title: '枝',
      from: { threadId: 't1', baseVersion: 1 },
      mode: 'base',
    });

    const forked = await state(log);
    expect(baseCharacters(forked, 't2')).toBe(80);

    const gate = await appendBase(log, forked, 't2', 'x'.repeat(30), 100);
    expect(gate.ok).toBe(false);
  });

  it('知らないスレッドへの追記は握りつぶさず止まる（規則2）', async () => {
    const log = await withThread();
    await expect(async () => appendBase(log, await state(log), 'nope', 'x')).rejects.toThrow(
      /知らないスレッド/,
    );
  });
});

// PO指摘 2026-08-22：訂正は上書きではなく無効化で行うべき。無効化した分だけ
// 閾値の予算が実際に空くことが、この機構の本題（「単調増加で文脈を食いつぶす」への答え）。
describe('無効化・有効化（PO指摘 2026-08-22）', () => {
  it('無効化すると閾値の予算が空き、以前は断られた追記が通るようになる', async () => {
    const log = await withThread();
    await appendBase(log, await state(log), 't1', 'x'.repeat(80), 100);

    // 残り20文字しかないので、30文字の追記は断られる。
    const refused = await appendBase(log, await state(log), 't1', 'y'.repeat(30), 100);
    expect(refused.ok).toBe(false);

    // 第1版を無効化すると、80文字ぶんの予算が空く。
    const gate = await invalidateBase(log, await state(log), 't1', 1);
    expect(gate.ok).toBe(true);
    expect(baseCharacters(await state(log), 't1')).toBe(0);

    // 今度は通る。
    const accepted = await appendBase(log, await state(log), 't1', 'y'.repeat(30), 100);
    expect(accepted.ok).toBe(true);
  });

  it('無効化しても base.appended 自体は消えない。有効化すればまた戻る', async () => {
    const log = await withThread();
    await appendBase(log, await state(log), 't1', '大事な決定', 100);
    await invalidateBase(log, await state(log), 't1', 1);
    expect(effectiveBase(await state(log), 't1')).toEqual([]);
    expect((await log.read()).some((e) => e.type === 'base.appended')).toBe(true);

    await reactivateBase(log, await state(log), 't1', 1);
    expect(effectiveBase(await state(log), 't1')).toEqual(['大事な決定']);
  });

  it('無い版・他人の版・すでに無効化した版は断る（握りつぶさない）', async () => {
    const log = await withThread();
    await appendBase(log, await state(log), 't1', 'A', 100);

    const noSuchVersion = await invalidateBase(log, await state(log), 't1', 99);
    expect(noSuchVersion.ok).toBe(false);

    const noSuchThread = await invalidateBase(log, await state(log), 'nope', 1);
    expect(noSuchThread.ok).toBe(false);

    await invalidateBase(log, await state(log), 't1', 1);
    const already = await invalidateBase(log, await state(log), 't1', 1);
    expect(already.ok).toBe(false);
  });

  it('有効な版をもう一度有効化しようとしたら断る', async () => {
    const log = await withThread();
    await appendBase(log, await state(log), 't1', 'A', 100);
    const already = await reactivateBase(log, await state(log), 't1', 1);
    expect(already.ok).toBe(false);
  });
});

describe('共有baseスレッド（決定30）', () => {
  it('無ければ作る。作った後は appendBase が通る', async () => {
    const log = await freshLog();
    await ensureSharedBaseThread(log, await state(log));

    const after = await state(log);
    expect(after.threads.has(SHARED_BASE_THREAD_ID)).toBe(true);

    const gate = await appendBase(log, after, SHARED_BASE_THREAD_ID, '一般的な事実', 100);
    expect(gate.ok).toBe(true);
  });

  it('二重に作らない', async () => {
    const log = await freshLog();
    await ensureSharedBaseThread(log, await state(log));
    await ensureSharedBaseThread(log, await state(log));

    const events = await log.read();
    const created = events.filter(
      (e) => e.type === 'thread.created' && e.threadId === SHARED_BASE_THREAD_ID,
    );
    expect(created).toHaveLength(1);
  });
});
