// 人が会話に添えた画像の置き場（決定・2026-09-26、アーキ仕様 §2.1「大きなバイト列はイベントに入れない」）。
//
// **中身の SHA-256 を名前にして置く**（Claim Check——イベントは名前だけを持つ）。
// 同じ画像は1つにまとまり、名前から中身を確かめられる。Event Store と同じく
// **書き換えも削除もしない**——イベントが指している先が消えると、会話が読めなくなる。
//
// 形式は**バイト列の先頭から決める**（規則3）。画面が言う `image/png` を信じて渡すと、
// 中身が違ったときに AI のターンが API で落ちるまで分からない。

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";

/** AI が読める形式だけ（Claude の画像入力が受けるもの）。 */
export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** 1枚の上限。根拠は `docs/notes/2026-09-26-composer-images.md`（15MB まで実測で通した） */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** 1回の発言に添えられる枚数 */
export const MAX_IMAGES_PER_MESSAGE = 10;

/** 断る理由が人に読める形になっているもの（HTTP では 400 にする）。 */
export class ImageRejectedError extends Error {}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/** 先頭の印（magic number）から形式を決める。どれでもなければ undefined。 */
export function sniffImageType(bytes: Uint8Array): ImageMediaType | undefined {
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && PNG.every((b, i) => bytes[i] === b)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

const ID = /^[0-9a-f]{64}$/;

export class ImageStore {
  constructor(private readonly dir: string) {}

  /**
   * 置いて、名前（SHA-256）を返す。**形式と大きさはここで確かめる**——置き場の手前で
   * 確かめ忘れた経路があっても、読めないものは置かれない。
   * 書き出しは tmp→fsync→rename→fsync(dir)（スナップショットと同じ、§2.1）——
   * イベントが先に確定して、指す先の中身が途中で切れている、を作らない。
   */
  async put(bytes: Buffer): Promise<{ id: string; mediaType: ImageMediaType }> {
    const mediaType = sniffImageType(bytes);
    if (!mediaType) throw new ImageRejectedError("送れる画像は PNG・JPEG・GIF・WebP だけです");
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new ImageRejectedError(
        `画像が大きすぎます（${(bytes.length / 1024 / 1024).toFixed(1)}MB、1枚 ${MAX_IMAGE_BYTES / 1024 / 1024}MB まで）`,
      );
    }
    const id = createHash("sha256").update(bytes).digest("hex");
    const path = join(this.dir, id);
    if (existsSync(path)) return { id, mediaType };

    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmpPath = `${path}.${randomUUID()}.tmp`;
    const fh = await open(tmpPath, "w", 0o600);
    try {
      await fh.writeFile(bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmpPath, path);
    const dh = await open(this.dir, "r");
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
    return { id, mediaType };
  }

  /** 名前で引く。名前の形が違う・無いなら undefined（どちらも「無い」として扱う）。 */
  async get(id: string): Promise<{ bytes: Buffer; mediaType: ImageMediaType } | undefined> {
    if (!ID.test(id)) return undefined;
    let bytes: Buffer;
    try {
      bytes = await readFile(join(this.dir, id));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    const mediaType = sniffImageType(bytes);
    // put で確かめたものしか置かれない——ここで形式が分からないのは、置き場が壊れている
    if (!mediaType) throw new Error(`画像 ${id} の中身が画像として読めません（置き場が壊れています）`);
    return { bytes, mediaType };
  }
}
