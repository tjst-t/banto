import { describe, expect, it } from 'vitest';

import { contextSize, LOG_VERSION, type BantoEvent, type NewEvent } from './event.js';
import { effectiveBase, fold, pendingQueue } from './fold.js';

let clock = 0;
/** 封筒を埋める。試験では時刻を単調増加させ、順序が効くことを確かめられるようにする。 */
function ev(event: NewEvent): BantoEvent {
  clock += 1;
  return {
    v: LOG_VERSION,
    id: `e${clock}`,
    at: new Date(Date.UTC(2026, 7, 20, 0, 0, clock)).toISOString(),
    ...event,
  } as BantoEvent;
}

describe('fold', () => {
  it('Channel にスレッドがぶら下がる', () => {
    const state = fold([
      ev({ type: 'channel.created', channelId: 'c1', name: 'banto' }),
      ev({ type: 'thread.created', threadId: 't1', channelId: 'c1', title: '一本目' }),
      ev({ type: 'thread.created', threadId: 't2', channelId: 'c1', title: '二本目' }),
    ]);
    expect(state.channels.get('c1')?.threadIds).toEqual(['t1', 't2']);
    expect(state.threads.get('t1')?.status).toBe('working');
  });

  it('base は追記のみで積み上がる', () => {
    const state = fold([
      ev({ type: 'channel.created', channelId: 'c1', name: 'banto' }),
      ev({ type: 'thread.created', threadId: 't1', channelId: 'c1', title: '一本目' }),
      ev({ type: 'base.appended', threadId: 't1', baseVersion: 1, text: '依頼: Phase 0' }),
      ev({ type: 'base.appended', threadId: 't1', baseVersion: 2, text: '制約: モジュールを増やさない' }),
    ]);
    expect(effectiveBase(state, 't1')).toEqual(['依頼: Phase 0', '制約: モジュールを増やさない']);
    expect(state.threads.get('t1')?.baseVersion).toBe(2);
  });

  // 要件 R4：既存のブランチは追記を見ない。古い base のまま完結する。
  // これが破れるとキャッシュの前方一致が壊れ、分岐が安いという前提そのものが崩れる。
  it('fork したスレッドは、切った後の親の追記を見ない', () => {
    const state = fold([
      ev({ type: 'channel.created', channelId: 'c1', name: 'banto' }),
      ev({ type: 'thread.created', threadId: 't1', channelId: 'c1', title: '親' }),
      ev({ type: 'base.appended', threadId: 't1', baseVersion: 1, text: '依頼' }),
      ev({ type: 'base.appended', threadId: 't1', baseVersion: 2, text: '制約' }),
      ev({
        type: 'thread.forked',
        threadId: 't2',
        channelId: 'c1',
        title: '枝',
        from: { threadId: 't1', baseVersion: 2 },
        mode: 'base',
      }),
      // fork の後で親に足す。枝はこれを見てはいけない。
      ev({ type: 'base.appended', threadId: 't1', baseVersion: 3, text: '親だけの決定' }),
      ev({ type: 'base.appended', threadId: 't2', baseVersion: 3, text: '枝だけの決定' }),
    ]);

    expect(effectiveBase(state, 't1')).toEqual(['依頼', '制約', '親だけの決定']);
    expect(effectiveBase(state, 't2')).toEqual(['依頼', '制約', '枝だけの決定']);
    expect(effectiveBase(state, 't2')).not.toContain('親だけの決定');
  });

  it('fork は既定で base から切る', () => {
    const state = fold([
      ev({ type: 'channel.created', channelId: 'c1', name: 'banto' }),
      ev({ type: 'thread.created', threadId: 't1', channelId: 'c1', title: '親' }),
      ev({ type: 'base.appended', threadId: 't1', baseVersion: 1, text: '依頼' }),
      ev({
        type: 'thread.forked',
        threadId: 't2',
        channelId: 'c1',
        title: '枝',
        from: { threadId: 't1', baseVersion: 1 },
        mode: 'base',
      }),
    ]);
    expect(state.threads.get('t2')?.forkedFrom).toEqual({
      threadId: 't1',
      baseVersion: 1,
      mode: 'base',
    });
  });

  it('多段の fork でも継承が切れる位置を守る', () => {
    const state = fold([
      ev({ type: 'channel.created', channelId: 'c1', name: 'banto' }),
      ev({ type: 'thread.created', threadId: 't1', channelId: 'c1', title: '親' }),
      ev({ type: 'base.appended', threadId: 't1', baseVersion: 1, text: 'A' }),
      ev({ type: 'base.appended', threadId: 't1', baseVersion: 2, text: 'B' }),
      ev({
        type: 'thread.forked',
        threadId: 't2',
        channelId: 'c1',
        title: '子',
        from: { threadId: 't1', baseVersion: 2 },
        mode: 'base',
      }),
      ev({ type: 'base.appended', threadId: 't2', baseVersion: 3, text: 'C' }),
      // 孫は子の版2（＝A,B まで）で切る。子の C は入らない。
      ev({
        type: 'thread.forked',
        threadId: 't3',
        channelId: 'c1',
        title: '孫',
        from: { threadId: 't2', baseVersion: 2 },
        mode: 'base',
      }),
      ev({ type: 'base.appended', threadId: 't3', baseVersion: 3, text: 'D' }),
    ]);

    expect(effectiveBase(state, 't2')).toEqual(['A', 'B', 'C']);
    expect(effectiveBase(state, 't3')).toEqual(['A', 'B', 'D']);
  });

  it('判断待ちは1本の列に集まり、解決すると消える', () => {
    const state = fold([
      ev({ type: 'channel.created', channelId: 'c1', name: 'banto' }),
      ev({ type: 'thread.created', threadId: 't1', channelId: 'c1', title: '一本目' }),
      ev({ type: 'decision.requested', decisionId: 'd1', source: 'thread', threadId: 't1', question: 'この方針でよいか' }),
      ev({ type: 'decision.requested', decisionId: 'd2', source: 'observer', threadId: null, question: '文脈が下がっていない' }),
      ev({ type: 'decision.requested', decisionId: 'd3', source: 'factory', threadId: 't1', question: 'マージしてよいか' }),
      ev({ type: 'decision.resolved', decisionId: 'd2', answer: '見た' }),
    ]);

    const queue = pendingQueue(state);
    // 出所が違っても1本。3本の列を作れば見に行く先が3つになる（要件 A6）。
    expect(queue.map((d) => d.decisionId)).toEqual(['d1', 'd3']);
    expect(new Set(queue.map((d) => d.source))).toEqual(new Set(['thread', 'factory']));
    // 古い順＝待たせている順。
    expect(queue[0]?.since.localeCompare(queue[1]?.since ?? '')).toBeLessThan(0);
  });

  it('スレッドの状態が最後の宣言に従う', () => {
    const state = fold([
      ev({ type: 'channel.created', channelId: 'c1', name: 'banto' }),
      ev({ type: 'thread.created', threadId: 't1', channelId: 'c1', title: '一本目' }),
      ev({ type: 'thread.status', threadId: 't1', status: 'waiting-on-human' }),
      ev({ type: 'thread.status', threadId: 't1', status: 'done' }),
    ]);
    expect(state.threads.get('t1')?.status).toBe('done');
  });
});

describe('contextSize', () => {
  // 規則3：導出できる値を保存しない。ここが唯一の定義。
  it('入力側の3つの和であり、output は足さない', () => {
    expect(
      contextSize({
        inputTokens: 2,
        cacheCreationInputTokens: 11_666,
        cacheReadInputTokens: 17_029,
        outputTokens: 999,
      }),
    ).toBe(28_697);
  });
});
