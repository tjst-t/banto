/**
 * 警報を、判断待ちの1本の列へ流す（要件 F1 →  A6）。
 *
 * 出所が違っても、人にとっては同じ「自分が見ないと進まないもの」。
 * 3本の列を作れば見に行く先が3つになり、目的に逆行する。
 *
 * ここは観測の中で唯一ログに書く経路なので、次の2つを守る：
 *  - **決定 id を警報の内容から決める。** 同じ警報を繰り返し立てない
 *  - **すでに立っているなら何もしない。** `since` を上書きすると滞留の時計が
 *    毎回巻き戻り、A7 の「滞留したら鳴らす」が永久に発火しなくなる
 */

import { EventLog, fold, type DecisionId } from '@banto/core';

import type { Alarm, Observation } from './observe.js';

/** 警報の内容から決まる id。同じ警報は同じ id になる。 */
export function alarmDecisionId(alarm: Alarm): DecisionId {
  return `alarm:${alarm.kind}:${alarm.seriesId}`;
}

export interface RaiseResult {
  readonly raised: DecisionId[];
  readonly alreadyPending: DecisionId[];
  readonly resolved: DecisionId[];
}

/**
 * いまの観測結果に合わせて、警報由来の判断待ちを立てる／畳む。
 *
 * 消えた警報は解決済みにする。残しておくと列が嘘をつき、
 * 「1画面で分かる」が成り立たなくなる。
 */
export async function raiseAlarms(
  dataDir: string,
  observation: Observation,
): Promise<RaiseResult> {
  const log = new EventLog(dataDir);
  const state = fold(await log.read());

  const wanted = new Map<DecisionId, Alarm>();
  for (const alarm of observation.alarms) wanted.set(alarmDecisionId(alarm), alarm);

  const raised: DecisionId[] = [];
  const alreadyPending: DecisionId[] = [];
  const resolved: DecisionId[] = [];

  for (const [decisionId, alarm] of wanted) {
    if (state.pendingDecisions.has(decisionId)) {
      alreadyPending.push(decisionId);
      continue;
    }
    await log.append({
      type: 'decision.requested',
      decisionId,
      source: 'observer',
      threadId: alarm.seriesId,
      question: alarm.detail,
    });
    raised.push(decisionId);
  }

  for (const decisionId of state.pendingDecisions.keys()) {
    if (!decisionId.startsWith('alarm:')) continue;
    if (wanted.has(decisionId)) continue;
    await log.append({
      type: 'decision.resolved',
      // 機構が畳んだので、人は何も選んでいない。
      optionId: null,
      decisionId,
      answer: '警報の条件が解消した',
    });
    resolved.push(decisionId);
  }

  return { raised, alreadyPending, resolved };
}
