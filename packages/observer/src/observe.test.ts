import { describe, expect, it } from 'vitest';

import { DEFAULT_OPTIONS, observe, percentile, type ObserveOptions, type Turn } from './observe.js';

/** 文脈サイズが `sizes` になる系列を作る。増分は cacheRead に載せる（実データと同じ形）。 */
function series(seriesId: string, sizes: number[]): Turn[] {
  return sizes.map((size, index) => ({
    seriesId,
    index,
    usage: {
      inputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: size,
      outputTokens: 10,
    },
  }));
}

const options: ObserveOptions = { contextLimit: 1_000, absenceTurns: 5, compactionDropRatio: 0.2 };

describe('observe', () => {
  it('1ターンごとの文脈サイズを返す', () => {
    const result = observe(series('t1', [100, 200, 300]), options);
    expect(result.series[0]?.contextSizes).toEqual([100, 200, 300]);
    expect(result.totals.turns).toBe(3);
  });

  it('単調増加なら発火 0 で、不在の警報が立つ', () => {
    // 実測で起きていた形：長い会話 38 本中 35 本が、最大 60 万トークンを超えても
    // 一度も下がらなかった。
    const result = observe(series('t1', [10, 20, 30, 40, 50, 60]), options);
    expect(result.totals.compactionFirings).toBe(0);
    expect(result.totals.decreases).toBe(0);
    expect(result.series[0]?.turnsSinceLastDecrease).toBe(6);
    expect(result.alarms.map((a) => a.kind)).toContain('absence');
  });

  it('ターン数が閾値に届かないうちは不在の警報を立てない（まだ分からない）', () => {
    const result = observe(series('t1', [10, 20, 30]), options);
    expect(result.alarms.filter((a) => a.kind === 'absence')).toHaveLength(0);
  });

  it('閾値を超える下降を発火として数える', () => {
    // 500 → 100 は 80% の下降。
    const result = observe(series('t1', [100, 300, 500, 100, 200]), options);
    expect(result.totals.decreases).toBe(1);
    expect(result.totals.compactionFirings).toBe(1);
    expect(result.series[0]?.turnsSinceLastDecrease).toBe(1);
  });

  it('小さい下降は数えるが、発火とはみなさない（1つの数にまとめない）', () => {
    // 500 → 480 は 4% の下降。閾値 20% 未満。
    const result = observe(series('t1', [100, 500, 480]), options);
    expect(result.totals.decreases).toBe(1);
    expect(result.totals.compactionFirings).toBe(0);
  });

  it('下降が閾値ちょうどなら発火に数える', () => {
    const result = observe(series('t1', [1000, 800]), options);
    expect(result.totals.compactionFirings).toBe(1);
  });

  it('横ばいは下降ではない（同一 message.id の重複で誤検知しない）', () => {
    const result = observe(series('t1', [500, 500, 500]), options);
    expect(result.totals.decreases).toBe(0);
  });

  // ここが崩れると、fork や別会話の下降を「圧縮が効いた」と誤って読む。
  it('系列をまたいで並べない', () => {
    const turns = [...series('t1', [900, 950]), ...series('t2', [100, 120])];
    const result = observe(turns, options);
    expect(result.series).toHaveLength(2);
    // t1 の 950 の次に t2 の 100 が来ても、下降として数えてはいけない。
    expect(result.totals.decreases).toBe(0);
  });

  it('順序が乱れて届いても index で並べ直す', () => {
    const shuffled = [...series('t1', [100, 200, 50])].reverse();
    const result = observe(shuffled, options);
    expect(result.series[0]?.contextSizes).toEqual([100, 200, 50]);
    expect(result.totals.compactionFirings).toBe(1);
  });

  it('量の警報は閾値を超えたときだけ立つ', () => {
    expect(observe(series('t1', [999]), options).alarms).toHaveLength(0);
    const over = observe(series('t1', [1001]), options);
    expect(over.alarms.map((a) => a.kind)).toEqual(['quantity']);
    expect(over.totals.turnsOverContextLimit).toBe(1);
  });

  it('キャッシュ読みの割合は入力側の総量に対する比', () => {
    const result = observe(
      [
        {
          seriesId: 't1',
          index: 0,
          usage: {
            inputTokens: 10,
            cacheCreationInputTokens: 10,
            cacheReadInputTokens: 80,
            outputTokens: 999,
          },
        },
      ],
      options,
    );
    // output は分母に入れない。入れると「文脈に入っていた量」の比でなくなる。
    expect(result.totals.cacheReadRatio).toBeCloseTo(0.8, 10);
  });

  it('空でも落ちない', () => {
    const result = observe([], DEFAULT_OPTIONS);
    expect(result.totals.turns).toBe(0);
    expect(result.totals.cacheReadRatio).toBe(0);
    expect(result.alarms).toEqual([]);
  });
});

describe('percentile', () => {
  it('最近接順位法', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(values, 0.5)).toBe(5);
    expect(percentile(values, 0.9)).toBe(9);
    expect(percentile(values, 0.99)).toBe(10);
  });

  it('空なら 0', () => {
    expect(percentile([], 0.5)).toBe(0);
  });

  it('並んでいない入力でも正しい', () => {
    expect(percentile([10, 1, 5], 0.5)).toBe(5);
  });
});
