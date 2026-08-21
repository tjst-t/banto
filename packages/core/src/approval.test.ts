import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  APPROVE,
  NOTHING_APPROVED,
  approvalId,
  fingerprint,
  foldApprovals,
  ledgerOf,
  requestApproval,
} from './approval.js';
import { fold } from './fold.js';
import { EventLog } from './log.js';

async function freshLog(): Promise<EventLog> {
  return new EventLog(await mkdtemp(path.join(tmpdir(), 'banto-approval-')));
}

const ledgerOfLog = async (log: EventLog) => ledgerOf(foldApprovals(await log.read()));

describe('承認の台帳（決定16 の安全上の②）', () => {
  it('渡し忘れたら全部通る、にしない——既定は何も承認されていない', () => {
    expect(NOTHING_APPROVED.isApproved('any', 'any')).toBe(false);
  });

  it('内容が1バイト変われば別の指紋になる', () => {
    expect(fingerprint('#!/bin/sh\n')).not.toBe(fingerprint('#!/bin/sh\n\n'));
  });

  it('承認されたものだけが通る', async () => {
    const log = await freshLog();
    const print = fingerprint('body');
    await log.append({
      type: 'decision.resolved',
      decisionId: approvalId('repo:script/env-create', print),
      optionId: null,
      answer: APPROVE,
    });

    const ledger = await ledgerOfLog(log);
    expect(ledger.isApproved('repo:script/env-create', print)).toBe(true);
    // 同じ主題でも、内容が違えば通らない。
    expect(ledger.isApproved('repo:script/env-create', fingerprint('other'))).toBe(false);
  });

  // 「解決済みだから通す」ではない。却下は承認していないことである。
  it('APPROVE 以外の答えは承認にならない', async () => {
    const log = await freshLog();
    const id = approvalId('s', fingerprint('body'));
    await log.append({ type: 'decision.resolved', decisionId: id, optionId: null, answer: 'はい' });
    expect((await ledgerOfLog(log)).isApproved('s', fingerprint('body'))).toBe(false);
  });

  it('一度承認したものを、後から却下できる', async () => {
    const log = await freshLog();
    const print = fingerprint('body');
    const id = approvalId('s', print);
    await log.append({ type: 'decision.resolved', decisionId: id, optionId: null, answer: APPROVE });
    await log.append({ type: 'decision.resolved', decisionId: id, optionId: null, answer: 'reject' });
    expect((await ledgerOfLog(log)).isApproved('s', print)).toBe(false);
  });

  it('承認を求める判断が、判断待ちの1本のキューに立つ（要件 A6）', async () => {
    const log = await freshLog();
    const print = fingerprint('body');
    await requestApproval(log, await log.read(), 's', print, '承認してよいか');

    const pending = fold(await log.read()).pendingDecisions.get(approvalId('s', print));
    expect(pending?.source).toBe('observer');
    expect(pending?.question).toBe('承認してよいか');
  });

  it('同じ内容について二重に立てない', async () => {
    const log = await freshLog();
    const print = fingerprint('body');
    for (let i = 0; i < 3; i += 1) {
      await requestApproval(log, await log.read(), 's', print, '承認してよいか');
    }
    expect((await log.read()).filter((e) => e.type === 'decision.requested')).toHaveLength(1);
  });

  // 却下したものを、次に走らせようとしたときにまた聞き直すと、却下が意味を失う。
  it('すでに答えが出ているものを、聞き直さない', async () => {
    const log = await freshLog();
    const print = fingerprint('body');
    await log.append({
      type: 'decision.resolved',
      decisionId: approvalId('s', print),
      optionId: null,
      answer: 'reject',
    });
    await requestApproval(log, await log.read(), 's', print, '承認してよいか');
    expect((await log.read()).filter((e) => e.type === 'decision.requested')).toHaveLength(0);
  });
});
