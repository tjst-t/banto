/**
 * ファイルを原子的に置き換える（task-0161）。
 *
 * **なぜ要るか。** ホストが OOM killer に殺される最中に `writeFileSync` が走っていると、
 * O_TRUNC で空にした直後・書き終える前に死ぬ窓がある。実際 2026-08-15〜16 に会話の記録
 * （数MBの JSONL）が壊れ、読み戻しで「読めない行」として黙って捨てられた。
 *
 * **やり方。** 同じディレクトリに tmp を書く → fd を fsync → close → rename →
 * 親ディレクトリを fsync。rename は同一ファイルシステム内では原子的なので、
 * **見えるのは「古い中身」か「新しい中身」のどちらかだけ**になる。
 * 親ディレクトリの fsync まで済ませて、rename 自体も電源断を越えて残す。
 *
 * D6: node:fs / node:path のみ（依存を足さない）。
 * I2: 書けなかったら握り潰さず投げる。そのとき元ファイルは1バイトも変わっていない。
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 原子的書き込みが使う fs の操作だけを切り出した口。
 *
 * 既定は node:fs そのもの。**差し替えは試験のためにある**——fsync が本当に呼ばれるか、
 * rename の前で落ちたときに元ファイルが無傷か、は外から観測できないので、ここを通す。
 */
export interface AtomicWriteOps {
  mkdirSync(dir: string, options: { recursive: true }): void;
  openSync(file: string, flags: string, mode?: number): number;
  writeSync(fd: number, buffer: Buffer, offset: number, length: number): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync(from: string, to: string): void;
  rmSync(file: string, options: { force: true }): void;
}

/** 既定の実装（node:fs）。 */
export const nodeAtomicWriteOps: AtomicWriteOps = {
  mkdirSync: (dir, options) => {
    fs.mkdirSync(dir, options);
  },
  openSync: (file, flags, mode) => fs.openSync(file, flags, mode),
  writeSync: (fd, buffer, offset, length) => fs.writeSync(fd, buffer, offset, length),
  fsyncSync: (fd) => fs.fsyncSync(fd),
  closeSync: (fd) => fs.closeSync(fd),
  renameSync: (from, to) => fs.renameSync(from, to),
  rmSync: (file, options) => {
    fs.rmSync(file, options);
  },
};

/** 同じ瞬間に同じ tmp 名が出ないようにするだけの通し番号。 */
let sequence = 0;

/**
 * `file` を `data` の中身で原子的に置き換える。
 *
 * 途中で失敗したら tmp を片付けて例外を投げる。**元ファイルには触れていない。**
 * 書き込みのモードは `fs.writeFileSync` の既定（0o666 & umask）に合わせてある
 * ——既存のファイルの見え方を変えないため。
 */
export function writeFileAtomicSync(
  file: string,
  data: string,
  ops: AtomicWriteOps = nodeAtomicWriteOps
): void {
  const dir = path.dirname(file);
  ops.mkdirSync(dir, { recursive: true });

  // 同じディレクトリに置く（rename が跨ぐと EXDEV で原子性が消える）。
  // 先頭のドットは、書いている最中の tmp を「記録のファイル」と取り違えないため
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${sequence++}`);
  const buffer = Buffer.from(data, "utf-8");

  let fd: number | undefined;
  try {
    // "wx": 既にあったら作らない（他の書き手の tmp を踏まない）
    fd = ops.openSync(tmp, "wx", 0o666);
    let written = 0;
    while (written < buffer.length) {
      written += ops.writeSync(fd, buffer, written, buffer.length - written);
    }
    ops.fsyncSync(fd); // 中身をディスクへ。これより前に rename すると空のまま残りうる
    ops.closeSync(fd);
    fd = undefined;
    ops.renameSync(tmp, file); // ここで初めて新しい中身が見える
  } catch (err) {
    if (fd !== undefined) {
      try {
        ops.closeSync(fd);
      } catch {
        // 後片付けの失敗で元の失敗を覆い隠さない（投げるのは下の err）
      }
    }
    try {
      ops.rmSync(tmp, { force: true });
    } catch {
      // 同上。tmp が残ることより、何が起きたかを伝えるほうが大事
    }
    throw err; // I2: 握り潰さない
  }

  // rename そのものを耐久化する。ここを飛ばすと、電源断でファイルが元に戻りうる
  const dirFd = ops.openSync(dir, "r");
  try {
    ops.fsyncSync(dirFd);
  } finally {
    ops.closeSync(dirFd);
  }
}
