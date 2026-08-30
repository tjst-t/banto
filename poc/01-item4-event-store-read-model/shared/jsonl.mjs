// JSONL の枠組み。全 arm がこれを共有する（読み取り経路を揃えないと
// read model の比較ではなく IO 戦略の比較になる——計画の「誤誘導を潰す」）。
//
// 1レコード = JSON.stringify(event) + '\n'
// 末尾が '\n' で終わっていない最終レコードは「無い」とみなす（torn write の回復）。
// オフセットは Buffer.byteLength で計算する（日本語はマルチバイトなので
// 文字列 .length では壊れる）。

import { createReadStream, promises as fsp } from 'node:fs';
import { createInterface } from 'node:readline';

let fdCache = null; // { path, fd } — 追記用に長生きの fd を1つだけ持つ（appendFile は毎回 open/close する）

export async function openAppend(path) {
  if (fdCache && fdCache.path === path) return fdCache.fd;
  if (fdCache) await fdCache.fd.close();
  const fd = await fsp.open(path, 'a');
  fdCache = { path, fd };
  return fd;
}

export async function closeAppend() {
  if (fdCache) {
    await fdCache.fd.close();
    fdCache = null;
  }
}

/**
 * 追記して fsync する。解決したときにはディスクに乗っている。
 * 戻り値は書き込んだバイト数（cursor の内部計算に使う。呼び出し側には出さない）。
 */
export async function appendLine(path, obj) {
  const fd = await openAppend(path);
  const line = JSON.stringify(obj) + '\n';
  const buf = Buffer.from(line, 'utf8');
  await fd.write(buf, 0, buf.length, null);
  await fd.sync();
  return buf.length;
}

/**
 * torn な最終レコードを切り捨てる。切り捨てたら true を返す（規則2:
 * 黙って捨てず、呼び出し側に知らせる）。
 */
export async function truncateTornTail(path) {
  let fh;
  try {
    fh = await fsp.open(path, 'r+');
    const { size } = await fh.stat();
    if (size === 0) return false;
    // 末尾 1 バイトが '\n' (0x0a) かどうかだけ見る
    const buf = Buffer.alloc(1);
    await fh.read(buf, 0, 1, size - 1);
    if (buf[0] === 0x0a) return false; // 正常終端
    // '\n' まで巻き戻して切り捨てる
    const CHUNK = 65536;
    let pos = size;
    let lastNewline = -1;
    while (pos > 0 && lastNewline === -1) {
      const start = Math.max(0, pos - CHUNK);
      const len = pos - start;
      const chunk = Buffer.alloc(len);
      await fh.read(chunk, 0, len, start);
      const idx = chunk.lastIndexOf(0x0a);
      if (idx !== -1) lastNewline = start + idx + 1;
      pos = start;
    }
    const truncateAt = lastNewline === -1 ? 0 : lastNewline;
    await fh.truncate(truncateAt);
    return true;
  } finally {
    if (fh) await fh.close();
  }
}

/**
 * cursor から先を1行ずつ AsyncIterable で返す。配列化しない
 * （「配列を返す口を落とす」が G0 の主張そのもの）。
 * cursor は不透明: { seq, byteOffset }。byteOffset を外に出すのは
 * このモジュール内だけ（呼び出し側は seq 比較だけで十分なようにする）。
 */
export async function* readFrom(path, fromCursor) {
  let seq = fromCursor ? fromCursor.seq : 0;
  let startByte = fromCursor ? fromCursor.byteOffset : 0;

  let exists = true;
  try {
    await fsp.access(path);
  } catch {
    exists = false;
  }
  if (!exists) return;

  const stream = createReadStream(path, { start: startByte, encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let byteOffset = startByte;
  for await (const line of rl) {
    if (line.length === 0) continue; // 末尾の空行（trailing \n の後）
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // + '\n'
    seq += 1;
    byteOffset += lineBytes;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      // torn な最終行を読み切ってしまった場合はここに来る。無いものとして扱う。
      break;
    }
    yield { event, cursor: { seq, byteOffset } };
  }
}

export function zeroCursor() {
  return { seq: 0, byteOffset: 0 };
}
