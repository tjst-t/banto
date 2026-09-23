// Module の画面からのダウンロード（MCP Apps の `ui/download-file`）——保存するときの名前と中身。

import { test } from "node:test";
import assert from "node:assert/strict";
import { downloadNameOf, prepareDownload } from "./canvas-download.ts";

test("保存する名前は URI の最後の部分（%xx は戻す）", () => {
  assert.equal(downloadNameOf("file:///docs/README.md"), "README.md");
  assert.equal(downloadNameOf("file:///docs/%E4%BA%88%E7%AE%97.csv"), "予算.csv");
  assert.equal(downloadNameOf("file:///banto-files.zip?x=1#y"), "banto-files.zip");
});

test("保存する名前に、区切りや制御文字・空・`..` を使わない", () => {
  assert.equal(downloadNameOf("file:///a/..%2F..%2Fetc%2Fpasswd"), ".._.._etc_passwd");
  assert.equal(downloadNameOf("file:///"), "download");
  assert.equal(downloadNameOf("file:///.."), "download");
  assert.equal(downloadNameOf("file:///a%00b.txt"), "a_b.txt");
});

test("中身は blob（base64）ならバイト列のまま、text なら文字のまま", async () => {
  const bytes = await prepareDownload({ uri: "file:///x.bin", mimeType: "application/octet-stream", blob: "AAEC/w==" }).blob.arrayBuffer();
  assert.deepEqual([...new Uint8Array(bytes)], [0, 1, 2, 255]);
  const text = prepareDownload({ uri: "file:///x.txt", mimeType: "text/plain", text: "こんにちは" });
  assert.equal(await text.blob.text(), "こんにちは");
  assert.equal(text.blob.type, "text/plain");
});
