import { describe, expect, it } from 'vitest';

import { isSettled, nextStage, type Observation } from './stage.js';

/** 何も済んでいない状態。各試験は、そこから1つだけ動かす。 */
const fresh: Observation = {
  failed: false,
  hasWorktree: false,
  environment: 'gone',
  hasCommits: false,
  head: null,
  testedHead: null,
  review: 'not-required',
  merged: false,
};

const at = (o: Partial<Observation>): Observation => ({ ...fresh, ...o });

describe('次の段を、世界を見て決める（仕様 §5.3）', () => {
  it('順に進む', () => {
    expect(nextStage(fresh)).toBe('worktree');
    expect(nextStage(at({ hasWorktree: true }))).toBe('environment');
    expect(nextStage(at({ hasWorktree: true, environment: 'ready' }))).toBe('implement');
    expect(
      nextStage(at({ hasWorktree: true, environment: 'ready', hasCommits: true, head: 'abc' })),
    ).toBe('test');
    expect(
      nextStage(
        at({
          hasWorktree: true,
          environment: 'ready',
          hasCommits: true,
          head: 'abc',
          testedHead: { passed: true },
        }),
      ),
    ).toBe('merge');
  });

  // 記録された失敗が最優先。記録しないと、機構は永久に同じ段を試み続ける。
  it('失敗が記録されていれば、他に何が済んでいても止まる', () => {
    expect(nextStage(at({ failed: true, hasWorktree: true, merged: true }))).toBe('failed');
  });

  // これを先に見ないと、畳んだあとに「環境が無い」と言って作り直しに戻る。
  it('取り込み済みなら、残るのは後片付けだけ', () => {
    expect(nextStage(at({ merged: true, environment: 'ready' }))).toBe('teardown');
    expect(nextStage(at({ merged: true, environment: 'gone' }))).toBe('done');
  });

  it('落ちたテストを黙って通さない', () => {
    const o = at({
      hasWorktree: true,
      environment: 'ready',
      hasCommits: true,
      head: 'abc',
      testedHead: { passed: false },
    });
    expect(nextStage(o)).toBe('failed');
  });

  // 鍵が sha なので、載せ直して先端が変わると結果は「無い」になる——明示的に消さない。
  it('先端が変われば、テスト結果は無いものとして測り直しになる', () => {
    const tested = at({
      hasWorktree: true,
      environment: 'ready',
      hasCommits: true,
      head: 'abc',
      testedHead: { passed: true },
    });
    expect(nextStage(tested)).toBe('merge');
    // 載せ直し後は、その sha の結果が無いので null になる。
    expect(nextStage({ ...tested, head: 'def', testedHead: null })).toBe('test');
  });

  it('既定では人を待たない（要件 B4）', () => {
    const ready = at({
      hasWorktree: true,
      environment: 'ready',
      hasCommits: true,
      head: 'abc',
      testedHead: { passed: true },
    });
    expect(nextStage(ready)).toBe('merge');
    expect(nextStage({ ...ready, review: 'waiting' })).toBe('review');
    expect(nextStage({ ...ready, review: 'approved' })).toBe('merge');
  });

  // 「答えが出た＝進んでよい」にしない（規則2）。選ばれていないなら、まだ答えではない。
  it('却下されたら、取り込まずに畳んで終わる', () => {
    const reviewed = at({
      hasWorktree: true,
      environment: 'ready',
      hasCommits: true,
      head: 'abc',
      testedHead: { passed: true },
      review: 'rejected',
    });
    expect(nextStage(reviewed)).toBe('teardown');
    // 畳んだあと、作業ツリーが無いのを見て**作り直しに戻らない**。
    expect(nextStage({ ...reviewed, environment: 'gone', hasWorktree: false })).toBe('rejected');
  });

  it('終端は3つ。却下は失敗ではない', () => {
    expect(isSettled('done')).toBe(true);
    expect(isSettled('failed')).toBe(true);
    expect(isSettled('rejected')).toBe(true);
    expect(isSettled('merge')).toBe(false);
  });
});
