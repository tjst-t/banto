import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImageRejectedError, ImageStore, MAX_IMAGE_BYTES, sniffImageType } from "./store.js";

/** 1×1 の PNG（本物の画像。先頭の印だけでなく、ブラウザで開ける） */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);

async function withStore(fn: (store: ImageStore, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "banto-images-"));
  try {
    await fn(new ImageStore(join(dir, "images")), join(dir, "images"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("形式は中身の先頭から決める（画面が言う形式は信じない）", () => {
  assert.equal(sniffImageType(TINY_PNG), "image/png");
  assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), "image/jpeg");
  assert.equal(sniffImageType(Buffer.from("GIF89a....")), "image/gif");
  assert.equal(sniffImageType(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  // AI が読めないもの・画像でないもの
  assert.equal(sniffImageType(Buffer.from("BM......")), undefined, "BMP");
  assert.equal(sniffImageType(Buffer.from("<svg xmlns=")), undefined, "SVG（中で JS が走りうる）");
  assert.equal(sniffImageType(Buffer.from("")), undefined);
});

test("置いたものを名前（SHA-256）で引ける。同じ中身は1つにまとまる", async () => {
  await withStore(async (store, dir) => {
    const a = await store.put(TINY_PNG);
    assert.equal(a.id, createHash("sha256").update(TINY_PNG).digest("hex"));
    assert.equal(a.mediaType, "image/png");
    const b = await store.put(Buffer.from(TINY_PNG));
    assert.equal(b.id, a.id);
    assert.deepEqual(await readdir(dir), [a.id], "同じ中身が2つ置かれた／書きかけが残った");

    const got = await store.get(a.id);
    assert.ok(got);
    assert.deepEqual(got.bytes, TINY_PNG);
    assert.equal(got.mediaType, "image/png");
    // 人の画像なので、ほかの利用者には読ませない
    assert.equal((await stat(join(dir, a.id))).mode & 0o777, 0o600);
  });
});

test("読めない形式・大きすぎる画像は置かずに、人に読める理由で断る", async () => {
  await withStore(async (store, dir) => {
    await assert.rejects(store.put(Buffer.from("BM this is a bitmap")), ImageRejectedError);
    const big = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    TINY_PNG.copy(big);
    await assert.rejects(store.put(big), (err: Error) => err instanceof ImageRejectedError && /大きすぎます/.test(err.message));
    await assert.rejects(readdir(dir), "断ったのに置き場ができている");
  });
});

test("名前の形が違う・無い画像は「無い」（置き場の外は読まない）", async () => {
  await withStore(async (store) => {
    await store.put(TINY_PNG);
    assert.equal(await store.get("../../etc/passwd"), undefined);
    assert.equal(await store.get("0".repeat(64)), undefined);
    assert.equal(await store.get(""), undefined);
  });
});
