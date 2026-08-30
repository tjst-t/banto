// G1: cold start → 最初の state() までの時間。
// 毎回「新しい子プロセス」で測る（ウォームな JIT・page cache に頼らない——計画の
// 「誤誘導を潰す」）。--expose-gc で起動し、直後の GC 後 RSS も G2 用に一緒に返す。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [, , armName, dir] = process.argv;

const t0 = performance.now();
const mod = await import(path.join(here, '..', `arm-${armName}.mjs`));

let store;
let state;
if (armName === 'a') {
  const { fold } = await import(path.join(here, 'fold.mjs'));
  store = new mod.StoreA(dir);
  state = await store.stateViaFullFold(fold); // Aの「最初の state」は毎回全件 fold
} else {
  const StoreCtor = armName === 'b' ? mod.StoreB : mod.StoreC;
  store = await StoreCtor.open(dir);
  state = store.state();
}
const t1 = performance.now();
void state;

if (global.gc) global.gc();
const rssAfterGc = process.memoryUsage().rss;
const heapUsedAfterGc = process.memoryUsage().heapUsed;

process.stdout.write(JSON.stringify({
  coldStartMs: t1 - t0,
  rssAfterGcBytes: rssAfterGc,
  heapUsedAfterGcBytes: heapUsedAfterGc,
  gcAvailable: !!global.gc,
}));
