// G3/G4/G5 の実測（同一プロセス内、warm な状態での定常コスト）。
// G0/G1/G2 は shared/bench-cold-start.mjs（毎回新しい子プロセス）で別途測る
// ——cold start は warm なループでは測れない（計画の「誤誘導を潰す」）。
import { StoreC } from './arm-c.mjs';
import { StoreB } from './arm-b.mjs';
import { makeEvent } from './shared/fold.mjs';
import { xorshift32 } from './shared/rand.mjs';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node bench.mjs <dir-with-1M-log-and-snapshot>');
  process.exit(1);
}

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function summarize(label, samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  console.log(`${label}: p50=${percentile(sorted, 0.5).toFixed(2)}ms p95=${percentile(sorted, 0.95).toFixed(2)}ms max=${sorted[sorted.length - 1].toFixed(2)}ms (n=${samples.length})`);
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted[sorted.length - 1] };
}

console.log('--- open (StoreC, snapshot あり想定) ---');
const t0 = performance.now();
const store = await StoreC.open(dir);
console.log('open took', (performance.now() - t0).toFixed(2), 'ms; cursor.seq=', store.cursor().seq);

// G3: append -> subscriber 通知までの遅延
const rng = xorshift32(777);
const N_APPEND = 50;
const subscriberLatencies = [];
const appendLatencies = [];
let pendingResolve = null;
const unsub = store.subscribe(() => {
  if (pendingResolve) {
    subscriberLatencies.push(performance.now() - pendingResolve.t0);
    pendingResolve.resolve();
  }
});

for (let i = 0; i < N_APPEND; i++) {
  const event = makeEvent(rng, 2000000 + i);
  const t0a = performance.now();
  const notified = new Promise((resolve) => { pendingResolve = { t0: t0a, resolve }; });
  await store.append(event);
  appendLatencies.push(performance.now() - t0a); // G4: append(fsync 込み) の p99
  await notified; // 同期呼び出しなのですぐ解決するはずだが、経路として記録する
}
unsub();

console.log('--- G4: append (fsync 込み) レイテンシ ---');
summarize('append', appendLatencies);
console.log('--- G3: append -> subscriber 通知レイテンシ ---');
summarize('append->subscriber', subscriberLatencies);

// G5: 0 からの再計算（rebuildFromScratch）
console.log('--- G5: 0 からの再計算 ---');
const t1 = performance.now();
await store.rebuildFromScratch();
console.log('rebuildFromScratch:', (performance.now() - t1).toFixed(2), 'ms');

// 比較のため StoreB（スナップショット機構なし）でも同じ再計算を測る
console.log('--- 比較: StoreB（スナップショット無し）の open（毎回全件 fold） ---');
const t2 = performance.now();
await StoreB.open(dir);
console.log('StoreB.open:', (performance.now() - t2).toFixed(2), 'ms');
