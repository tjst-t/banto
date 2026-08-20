/**
 * banto 自身のイベントログを、観測の入力に変える。
 *
 * **この経路は host のプロセスに触れない。** ディスク上のログだけを読む。
 * 観測を機構の中に置くと、機構が止まったとき観測も一緒に止まる（ADR-0001 決定8）。
 */

import { EventLog, type BantoEvent } from '@banto/core';

import type { Turn } from './observe.js';

/** ランタイムが明示した圧縮。usage から導いた発火回数と突き合わせるために別に数える。 */
export interface ReportedCompaction {
  readonly threadId: string;
  readonly detail: string;
}

export interface LogSource {
  readonly turns: Turn[];
  readonly reportedCompactions: ReportedCompaction[];
}

export function turnsFromEvents(events: readonly BantoEvent[]): LogSource {
  const turns: Turn[] = [];
  const reportedCompactions: ReportedCompaction[] = [];

  for (const event of events) {
    if (event.type === 'turn.usage') {
      // 系列はスレッド単位。fork した別スレッドと混ぜない。
      turns.push({ seriesId: event.threadId, index: event.turnIndex, usage: event.usage });
    } else if (event.type === 'compaction.reported') {
      reportedCompactions.push({ threadId: event.threadId, detail: event.detail });
    }
  }

  return { turns, reportedCompactions };
}

export async function readLogSource(dataDir: string): Promise<LogSource> {
  const log = new EventLog(dataDir);
  return turnsFromEvents(await log.read());
}
