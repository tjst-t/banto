/**
 * 観測の畳み込み。**LLM を呼ばない**（要件 F2）。材料は各ターンの usage だけ。
 *
 * ここは入力源を知らない純関数にしてある。理由は1つ：
 * 同じ畳み込みを「自分のイベントログ」と「既知の答えがある Claude の
 * トランスクリプト」の両方に当てられるようにするため。既知の答えで先に
 * 検算しておかないと、数字が出たときに**畳み込みのバグなのか機構のバグなのか
 * 分離できない**（教訓3）。
 */

import { contextSize, type TurnUsage } from '@banto/core';

/** 観測に必要な最小の形。どこから来たかは問わない。 */
export interface Turn {
  /** 系列を切る単位。**スレッドをまたいで並べない**——fork や別会話の下降を圧縮と誤認する。 */
  readonly seriesId: string;
  /** 系列内の順序。 */
  readonly index: number;
  readonly usage: TurnUsage;
}

export interface ObserveOptions {
  /**
   * 量の警報：1ターンの文脈がこれを超えたら立てる。
   * 実測（2026-08-20 測り直し）では 200k 超のターンが 30.1% だった。
   */
  readonly contextLimit: number;
  /**
   * 不在の警報：文脈が一度も下がらないままこのターン数を超えたら立てる。
   * **鋭いのはこちら。**「増えている」は正常な会話でも起きるが、
   * 「一度も下がらない」は機構の故障を名指しする（要件 F1）。
   */
  readonly absenceTurns: number;
  /**
   * 「圧縮が発火した」とみなす下降の割合（0〜1）。直前のターンからの相対。
   *
   * **この閾値は仮置きである。** 圧縮の目印は滅多に残らない（実測で 1,110
   * セッション中 2 件）ので、事後は usage の下降から導くしかない。閾値未満の
   * 下降も `decreases` として別に数え、両方を返す——1つの数にまとめると
   * 閾値の選びかたが結果に化ける。
   *
   * 0.2 という値の根拠：実測で見つかった本物の圧縮 2 件はどちらも 94% の下降
   * だった。残る 17 件の下降はすべて 5% 未満だったので、その間ならどこでも
   * 同じ答えになる。**間が広いうちは、この閾値は効いていない**——狭くなったら
   * 測り直す。
   */
  readonly compactionDropRatio: number;
}

export const DEFAULT_OPTIONS: ObserveOptions = {
  contextLimit: 200_000,
  absenceTurns: 50,
  compactionDropRatio: 0.2,
};

export type AlarmKind = 'quantity' | 'absence';

export interface Alarm {
  readonly kind: AlarmKind;
  readonly seriesId: string;
  readonly detail: string;
}

export interface SeriesObservation {
  readonly seriesId: string;
  readonly turns: number;
  /** 1ターンごとの文脈サイズ。完了条件が求めている数値そのもの。 */
  readonly contextSizes: number[];
  readonly maxContext: number;
  readonly p50Context: number;
  readonly p90Context: number;
  readonly p99Context: number;
  /** 下降した回数（大きさを問わない）。 */
  readonly decreases: number;
  /** そのうち閾値を超えたもの＝圧縮の発火とみなした回数。 */
  readonly compactionFirings: number;
  /** 最後に下降してから何ターン経ったか。一度も下がっていなければ turns と同じ。 */
  readonly turnsSinceLastDecrease: number;
  readonly alarms: Alarm[];
}

export interface Observation {
  readonly totals: {
    readonly series: number;
    readonly turns: number;
    readonly inputTokens: number;
    readonly cacheCreationTokens: number;
    readonly cacheReadTokens: number;
    readonly outputTokens: number;
    /** キャッシュ読みの割合。入力側の総量に対する比。 */
    readonly cacheReadRatio: number;
    readonly decreases: number;
    readonly compactionFirings: number;
    readonly turnsOverContextLimit: number;
  };
  readonly series: SeriesObservation[];
  readonly alarms: Alarm[];
  readonly options: ObserveOptions;
}

export function observe(
  turns: readonly Turn[],
  options: ObserveOptions = DEFAULT_OPTIONS,
): Observation {
  const bySeries = new Map<string, Turn[]>();
  for (const turn of turns) {
    let bucket = bySeries.get(turn.seriesId);
    if (!bucket) {
      bucket = [];
      bySeries.set(turn.seriesId, bucket);
    }
    bucket.push(turn);
  }

  const series: SeriesObservation[] = [];
  const alarms: Alarm[] = [];

  let inputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let turnsOverContextLimit = 0;

  for (const [seriesId, bucket] of bySeries) {
    bucket.sort((a, b) => a.index - b.index);

    const contextSizes: number[] = [];
    let decreases = 0;
    let compactionFirings = 0;
    let lastDecreaseAt = -1;

    for (let i = 0; i < bucket.length; i++) {
      const turn = bucket[i];
      if (turn === undefined) continue;
      const size = contextSize(turn.usage);
      contextSizes.push(size);

      inputTokens += turn.usage.inputTokens;
      cacheCreationTokens += turn.usage.cacheCreationInputTokens;
      cacheReadTokens += turn.usage.cacheReadInputTokens;
      outputTokens += turn.usage.outputTokens;
      if (size > options.contextLimit) turnsOverContextLimit += 1;

      const previous = contextSizes[i - 1];
      if (previous !== undefined && size < previous) {
        decreases += 1;
        lastDecreaseAt = i;
        if (previous > 0 && (previous - size) / previous >= options.compactionDropRatio) {
          compactionFirings += 1;
        }
      }
    }

    const turnsSinceLastDecrease =
      lastDecreaseAt === -1 ? contextSizes.length : contextSizes.length - 1 - lastDecreaseAt;

    const seriesAlarms: Alarm[] = [];
    const maxContext = contextSizes.length === 0 ? 0 : Math.max(...contextSizes);

    if (maxContext > options.contextLimit) {
      seriesAlarms.push({
        kind: 'quantity',
        seriesId,
        detail: `文脈が閾値を超えた: max ${maxContext} > ${options.contextLimit}`,
      });
    }
    // 不在の警報。ターン数が閾値に届いていないうちは「まだ分からない」ので立てない。
    if (contextSizes.length >= options.absenceTurns && turnsSinceLastDecrease >= options.absenceTurns) {
      seriesAlarms.push({
        kind: 'absence',
        seriesId,
        detail: `文脈が ${turnsSinceLastDecrease} ターン一度も下がっていない（圧縮が発火していない疑い）`,
      });
    }

    alarms.push(...seriesAlarms);
    series.push({
      seriesId,
      turns: contextSizes.length,
      contextSizes,
      maxContext,
      p50Context: percentile(contextSizes, 0.5),
      p90Context: percentile(contextSizes, 0.9),
      p99Context: percentile(contextSizes, 0.99),
      decreases,
      compactionFirings,
      turnsSinceLastDecrease,
      alarms: seriesAlarms,
    });
  }

  const inputSide = inputTokens + cacheCreationTokens + cacheReadTokens;

  return {
    totals: {
      series: series.length,
      turns: turns.length,
      inputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      outputTokens,
      cacheReadRatio: inputSide === 0 ? 0 : cacheReadTokens / inputSide,
      decreases: series.reduce((sum, s) => sum + s.decreases, 0),
      compactionFirings: series.reduce((sum, s) => sum + s.compactionFirings, 0),
      turnsOverContextLimit,
    },
    series,
    alarms,
    options,
  };
}

/** 最近接順位法。空なら 0。 */
export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(q * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index] ?? 0;
}
