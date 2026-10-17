// **npm の tarball から実行ファイル1本だけを取り出す**（アーキ仕様 §4.1「エージェントの本体を取ってくる」）。
//
// 外の `tar` に展開させない——展開すると、symlink・hardlink・`..` を含む名前で置き場の外へ書かれうる。Node で gzip を
// ほどき、tar の見出しを読み、**目録のパスと完全に一致する通常のファイル1件だけ**を書き出す。ほかの通常のファイル
// （`package/package.json`）とフォルダは読み飛ばす。symlink・hardlink・装置・`..` や `/` で始まる名前・同じパスの2件目・
// 大きさの上限超えは、どこにあっても tarball ごと断る（書きかけは呼び元が作業フォルダごと消す）

import { open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";

export class TarballRefused extends Error {}

const BLOCK = 512;
/** pax の見出し・GNU の長い名前の大きさの上限（名前を運ぶだけなので小さい） */
const META_MAX_BYTES = 64 * 1024;

interface Header {
  name: string;
  size: number;
  type: string;
}

function str(buf: Buffer, start: number, end: number): string {
  const slice = buf.subarray(start, end);
  const nul = slice.indexOf(0);
  return (nul < 0 ? slice : slice.subarray(0, nul)).toString("utf8");
}

function octal(buf: Buffer, start: number, end: number, what: string): number {
  // 先頭の bit が立っていれば base-256（8GB を越える大きさ）——そんな大きさは上限で断るので読まない
  if ((buf[start]! & 0x80) !== 0) throw new TarballRefused(`tar の${what}が大きすぎます`);
  const text = str(buf, start, end).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarballRefused(`tar の${what}が読めません（${JSON.stringify(text)}）`);
  return parseInt(text, 8);
}

function parseHeader(block: Buffer): Header {
  // 見出しの検査和：検査和の欄を空白にして全バイトを足したもの
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
  if (octal(block, 148, 156, "検査和") !== sum) throw new TarballRefused("tar の見出しが壊れています（検査和が合いません）");
  const name = str(block, 0, 100);
  const prefix = str(block, 257, 263).startsWith("ustar") ? str(block, 345, 500) : "";
  return {
    name: prefix ? `${prefix}/${name}` : name,
    size: octal(block, 124, 136, "大きさ"),
    type: String.fromCharCode(block[156]!),
  };
}

/** pax の見出しの `path=` を読む（無ければ undefined） */
function paxPath(body: Buffer): string | undefined {
  let path: string | undefined;
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    if (space < 0) break;
    const len = Number(body.subarray(at, space).toString("ascii"));
    if (!Number.isInteger(len) || len <= 0 || at + len > body.length) throw new TarballRefused("tar の pax の見出しが壊れています");
    const record = body.subarray(space + 1, at + len - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0 && record.slice(0, eq) === "path") path = record.slice(eq + 1);
    at += len;
  }
  return path;
}

function assertSafeName(name: string): void {
  if (name === "" || name.startsWith("/") || name.split("/").includes("..")) {
    throw new TarballRefused(`tar に置き場の外を指しうる名前があります（${JSON.stringify(name)}）`);
  }
}

/**
 * gzip の tarball（`tgz`）を読み、`wanted` と完全に一致する通常のファイルを `dest` に書く（0755）。書いたバイト数を返す。
 * 断る理由は `TarballRefused`。`maxBytes` は実行ファイルの上限で、ほどいた tar 全体も `maxBytes` ＋ 16MB で切る
 */
export async function extractSingleFile(tgz: string, wanted: string, dest: string, maxBytes: number): Promise<number> {
  const totalLimit = maxBytes + 16 * 1024 * 1024;
  let total = 0;
  let pending: Buffer = Buffer.alloc(0);
  let header: Header | undefined;
  /** いまの見出しの中身のうち、まだ読んでいない分（512 に切り上げた分を含む） */
  let remaining = 0;
  /** いまの見出しの中身のうち、本当の中身（切り上げの手前まで） */
  let dataLeft = 0;
  let meta: Buffer[] | undefined;
  let override: string | undefined;
  let out: Awaited<ReturnType<typeof open>> | undefined;
  let found = false;
  let written = 0;
  let ended = false;

  const gunzip = createGunzip();
  createReadStream(tgz).on("error", (err) => gunzip.destroy(err)).pipe(gunzip);
  try {
    for await (const chunk of gunzip as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > totalLimit) throw new TarballRefused(`tarball をほどくと上限（${totalLimit} バイト）を越えます`);
      if (ended) continue;
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      for (;;) {
        if (!header) {
          if (pending.length < BLOCK) break;
          const block = pending.subarray(0, BLOCK);
          pending = pending.subarray(BLOCK);
          if (block.every((b) => b === 0)) {
            // 終わりの印（空の見出し）。あとは読み飛ばす
            ended = true;
            break;
          }
          const h = parseHeader(block);
          const name = override ?? h.name;
          override = undefined;
          header = { ...h, name };
          dataLeft = h.size;
          remaining = Math.ceil(h.size / BLOCK) * BLOCK;
          if (h.type === "x" || h.type === "L") {
            if (h.size > META_MAX_BYTES) throw new TarballRefused("tar の名前の見出しが大きすぎます");
            meta = [];
          } else if (h.type === "g") {
            // 全体の pax の見出し（名前は運ばない）——読み飛ばす
          } else {
            assertSafeName(name);
            if (h.type === "1" || h.type === "2") throw new TarballRefused(`tar に${h.type === "1" ? " hardlink" : " symlink"}があります（${name}）`);
            if (h.type !== "0" && h.type !== "\0" && h.type !== "7" && h.type !== "5") {
              throw new TarballRefused(`tar に通常のファイルでもフォルダでもないものがあります（${name}・種類 ${JSON.stringify(h.type)}）`);
            }
            const regular = h.type !== "5";
            if (regular && name === wanted) {
              if (found) throw new TarballRefused(`tar に ${wanted} が2つあります`);
              if (h.size > maxBytes) throw new TarballRefused(`${wanted} が上限（${maxBytes} バイト）より大きい（${h.size} バイト）`);
              found = true;
              out = await open(dest, "wx", 0o755);
            }
          }
          if (remaining === 0) {
            if (out) {
              await out.close();
              out = undefined;
            }
            finishEntry();
          }
          continue;
        }
        if (pending.length === 0) break;
        const take = Math.min(remaining, pending.length);
        const piece = pending.subarray(0, take);
        pending = pending.subarray(take);
        const data = piece.subarray(0, Math.min(dataLeft, piece.length));
        dataLeft -= data.length;
        remaining -= take;
        if (meta) meta.push(data);
        else if (out) {
          await out.write(data);
          written += data.length;
        }
        if (remaining === 0) {
          if (out) {
            await out.close();
            out = undefined;
          }
          finishEntry();
        }
      }
    }
  } finally {
    await out?.close().catch(() => undefined);
  }
  if (header) throw new TarballRefused("tar が途中で終わっています");
  if (!found) throw new TarballRefused(`tarball に ${wanted} がありません`);
  return written;

  function finishEntry(): void {
    if (meta && header) {
      const body = Buffer.concat(meta);
      override = header.type === "L" ? str(body, 0, body.length) : paxPath(body);
    }
    meta = undefined;
    header = undefined;
  }
}
