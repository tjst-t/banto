// toy な Event/State/apply/fold。banto の実際の Event 型・State 型を模倣しない
// （意図的に——これが本実装のスキーマだと誤読されないため）。
//
// 全 arm がこの apply/fold を「同一」で使う。arm ごとに fold の出来が違うと、
// read model の比較でなく fold の出来を比較することになる。

export const FOLD_VERSION = 'toy-v1';

export function empty() {
  return { counts: {}, lastByType: {}, total: 0 };
}

/** pure。s と e を書き換えない。 */
export function apply(s, e) {
  const counts = { ...s.counts, [e.type]: (s.counts[e.type] ?? 0) + 1 };
  const lastByType = { ...s.lastByType, [e.type]: { id: e.id, at: e.at } };
  return { counts, lastByType, total: s.total + 1 };
}

export function fold(events) {
  let s = empty();
  for (const e of events) s = apply(s, e);
  return s;
}

/** 全 arm・全チェックポイントで同じ順序に並ぶよう、キーをソートしてから比較する。 */
export function canonical(state) {
  return JSON.stringify(state, Object.keys(state).sort());
}

const EVENT_TYPES = ['project.created', 'thread.created', 'message.appended', 'memory.appended', 'tool.result'];

export function makeEvent(seedRng, seq, opts = {}) {
  const type = opts.type ?? EVENT_TYPES[Math.floor(seedRng() * EVENT_TYPES.length)];
  const at = opts.at ?? new Date(1735689600000 + seq * 1000).toISOString(); // 2025-01-01 起点、決定的
  const payload = opts.payload ?? makePayload(seedRng, type);
  return { v: 1, id: `ev-${seq}`, at, type, ...payload };
}

function makePayload(seedRng, type) {
  // v3 実測の分布に寄せる: p50 310B / p90 743B / p99 3247B / max 3247B。
  // tool.result だけ大きめの尾を持たせる（「10%が20KBの tool 結果」規模を作るため）。
  const r = seedRng();
  let textLen;
  if (type === 'tool.result' && r < 0.1) {
    textLen = 15000 + Math.floor(seedRng() * 10000); // 15-25KB の重い tool 結果
  } else if (r < 0.5) {
    textLen = 100 + Math.floor(seedRng() * 300); // p50 付近
  } else if (r < 0.9) {
    textLen = 400 + Math.floor(seedRng() * 500); // p90 付近
  } else {
    textLen = 1000 + Math.floor(seedRng() * 2200); // p99 付近
  }
  return { text: 'x'.repeat(textLen) };
}
