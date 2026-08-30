import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { makeEvent } from './fold.mjs';
import { xorshift32 } from './rand.mjs';

/**
 * n 件のイベントを dir/log.jsonl に直接書き出す（Store 経由の append ではなく、
 * バルクの writeFile で高速に用意する——フィクスチャ生成はベンチの対象ではない）。
 * seed を固定すれば同じ内容が再現できる。
 */
export async function writeFixtureLog(dir, n, seed = 1) {
  const rng = xorshift32(seed);
  await fsp.mkdir(dir, { recursive: true });
  const logPath = path.join(dir, 'log.jsonl');
  const fh = await fsp.open(logPath, 'w');
  const CHUNK = 5000;
  let buf = '';
  for (let i = 0; i < n; i++) {
    buf += JSON.stringify(makeEvent(rng, i)) + '\n';
    if ((i + 1) % CHUNK === 0) {
      await fh.write(buf);
      buf = '';
    }
  }
  if (buf) await fh.write(buf);
  await fh.sync();
  await fh.close();
  return logPath;
}
