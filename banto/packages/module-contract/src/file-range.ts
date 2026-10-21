// **人の画面がログ・出力のファイルを少しずつ読む口**（決定・2026-10-20、docs/specs/v4-modules.md §2.3「人の画面——
// バックグラウンドのコマンド」の `readCommandOutput`・§4.2「人の画面——サービス」の `readServiceLog`）。
//
// 読み方は1つ：`fromByte` から `maxBytes` まで。`fromByte` を書かなければ**末尾の** `maxBytes`。1回の上限は
// `FILE_RANGE_MAX_BYTES`（越えて頼まれたら上限で切る——返す `toByte` で分かる）。
//
// **UTF-8 の文字の切れ目で切る**——文字の途中から始まる・途中で終わる範囲は、その文字を外して返す（化けた字を返さない）。
// 返す `fromByte`・`toByte` は切ったあとの実際の範囲なので、続きは `toByte` から、前は `fromByte` まで読めばよい。
// **行の頭に揃えるのは読む側**（画面）。ここは行を知らない。

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** 1回に読む上限（256 KiB） */
export const FILE_RANGE_MAX_BYTES = 256 * 1024;

export interface FileRange {
  text: string;
  /** 返した範囲の頭（バイト。含む） */
  fromByte: number;
  /** 返した範囲の終わり（バイト。含まない） */
  toByte: number;
  /** ファイル全体の大きさ（バイト。読んだ時点） */
  size: number;
  /**
   * **ファイルの世代**（`<dev>:<ino>`）。ログを回す（名前を付け替えて新しく作る）と変わる——読む側は、前と違えば頭から
   * 読み直す。ファイルが無ければ null
   */
  generation: string | null;
}

/** 文字の続きのバイト（10xxxxxx） */
const isContinuation = (b: number) => (b & 0xc0) === 0x80;

/** 先頭のバイトから、その文字が何バイトか（壊れた先頭は 1） */
function charLength(lead: number): number {
  if (lead < 0x80) return 1;
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  if ((lead & 0xf8) === 0xf0) return 4;
  return 1;
}

export function readUtf8Range(path: string, opts: { fromByte?: number; maxBytes?: number } = {}): FileRange {
  const max = Math.min(
    FILE_RANGE_MAX_BYTES,
    opts.maxBytes !== undefined && Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? Math.floor(opts.maxBytes) : FILE_RANGE_MAX_BYTES,
  );
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { text: "", fromByte: 0, toByte: 0, size: 0, generation: null };
    throw err;
  }
  try {
    // 大きさと世代は**開いたものから**取る——名前を見てから開く間に回されても、読んだものと食い違わない
    const st = fstatSync(fd);
    const size = st.size;
    const generation = `${st.dev}:${st.ino}`;
    let from =
      opts.fromByte !== undefined && Number.isFinite(opts.fromByte) ? Math.max(0, Math.floor(opts.fromByte)) : Math.max(0, size - max);
    if (from >= size) return { text: "", fromByte: Math.min(from, size), toByte: Math.min(from, size), size, generation };
    let to = Math.min(size, from + max);
    // 頭の前後 3 バイトも読む（文字の切れ目を見るため）
    const lookBehind = Math.min(from, 3);
    const buf = Buffer.alloc(to - from + lookBehind);
    const got = readSync(fd, buf, 0, buf.length, from - lookBehind);
    const bytes = buf.subarray(0, got);
    to = from - lookBehind + got;
    let start = lookBehind;
    // 頭：文字の途中から始まっていたら、その文字を外す（続きのバイトを飛ばす）
    if (from > 0) while (start < bytes.length && isContinuation(bytes[start]!)) start++;
    // 終わり：ファイルの終わりでなければ、欠けた最後の文字を外す
    let end = bytes.length;
    if (to < size) {
      let i = end - 1;
      while (i >= start && end - i <= 4 && isContinuation(bytes[i]!)) i--;
      if (i >= start && i + charLength(bytes[i]!) > end) end = i;
    }
    if (end < start) end = start;
    from = from - lookBehind + start;
    return { text: bytes.subarray(start, end).toString("utf8"), fromByte: from, toByte: from + (end - start), size, generation };
  } finally {
    closeSync(fd);
  }
}
