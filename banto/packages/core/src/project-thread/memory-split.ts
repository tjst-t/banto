// docs/specs/v4-architecture.md §2.3 の「確定した分／確定より後の分」の分け方。
// Project Memory（§2.2）と Global Memory（§2.2）で同じ規律なので、
// 判断はここ1箇所に置く（規則3——同じ規則を2箇所に書かない）。
//
// 物差しは Event Store の seq そのもの。どちらの Memory も同じ1本の時間軸に
// 並ぶので、Thread が持つ境界（`memoryBaselineSeq`）と届けた位置
// （`memoryDeliveredSeq`）は種類ごとに分かれていない。

import type { EstablishedMemory, MemoryEntry, PendingMemoryChange } from "./types.js";

export interface MemorySplit {
  /** system prompt に入れる分。確定時点での見え方で固定する。 */
  established: EstablishedMemory[];
  /** ターンに添えて届ける分（まだ届けていないものだけ）。 */
  pending: PendingMemoryChange[];
}

export function splitMemory(
  entries: readonly MemoryEntry[],
  baselineSeq: number,
  deliveredSeq: number,
): MemorySplit {
  const established: EstablishedMemory[] = [];
  const pending: PendingMemoryChange[] = [];

  for (const m of entries) {
    if (m.seq <= baselineSeq) {
      established.push({
        seq: m.seq,
        text: m.text,
        // 確定より後の無効化は反映しない——反映すると走行中の枝の先頭が
        // 変わり、そこから後ろのキャッシュが崩れる（§3）。
        invalidated: m.invalidatedAtSeq !== undefined && m.invalidatedAtSeq <= baselineSeq,
      });
      if (
        m.invalidatedAtSeq !== undefined &&
        m.invalidatedAtSeq > baselineSeq &&
        m.invalidatedAtSeq > deliveredSeq
      ) {
        pending.push({
          kind: "invalidated",
          seq: m.seq,
          text: m.text,
          originThreadId: m.originThreadId,
          changedAtSeq: m.invalidatedAtSeq,
        });
      }
      continue;
    }

    if (m.seq > deliveredSeq) {
      // まだ「足された」を届けていない。足されてすぐ取り消されたものは、
      // 足ったことすら伝える必要が無い——届けない。
      if (m.invalidatedAtSeq !== undefined) continue;
      pending.push({
        kind: "appended",
        seq: m.seq,
        text: m.text,
        originThreadId: m.originThreadId,
        changedAtSeq: m.seq,
      });
      continue;
    }

    // 「足された」は届け済み。そのあと取り消されたなら、それは伝える。
    if (m.invalidatedAtSeq !== undefined && m.invalidatedAtSeq > deliveredSeq) {
      pending.push({
        kind: "invalidated",
        seq: m.seq,
        text: m.text,
        originThreadId: m.originThreadId,
        changedAtSeq: m.invalidatedAtSeq,
      });
    }
  }

  pending.sort((a, b) => a.changedAtSeq - b.changedAtSeq);
  return { established, pending };
}
