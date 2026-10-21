import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_RANGE_MAX_BYTES, readUtf8Range } from "./file-range.js";

const tmp = () => mkdtempSync(join(tmpdir(), "banto-file-range-"));

test("fromByte を書かなければ末尾、書けばそこから maxBytes まで。全体の大きさを返す", () => {
  const path = join(tmp(), "log");
  writeFileSync(path, "0123456789");
  assert.deepEqual(
    (({ text, fromByte, toByte, size }) => ({ text, fromByte, toByte, size }))(readUtf8Range(path, { maxBytes: 4 })),
    { text: "6789", fromByte: 6, toByte: 10, size: 10 },
  );
  const mid = readUtf8Range(path, { fromByte: 2, maxBytes: 3 });
  assert.equal(mid.text, "234");
  assert.equal(mid.toByte, 5);
  // 終わりより先は空（大きさは返る——読む側は縮んだと分かる）
  const past = readUtf8Range(path, { fromByte: 50 });
  assert.equal(past.text, "");
  assert.equal(past.size, 10);
  assert.equal(past.toByte, 10);
});

test("UTF-8 の文字の切れ目で切る——頭の欠けた文字・終わりの欠けた文字を外し、実際の範囲を返す", () => {
  const path = join(tmp(), "out");
  // 「あ」「い」「う」は 3 バイトずつ、😀 は 4 バイト
  writeFileSync(path, "aあいう😀b");
  // 2 バイト目（「あ」の途中）から 5 バイト——「あ」の残りを飛ばし、「い」は全部入るまで
  const r = readUtf8Range(path, { fromByte: 2, maxBytes: 5 });
  assert.equal(r.text, "い");
  assert.equal(r.fromByte, 4);
  assert.equal(r.toByte, 7);
  // 絵文字の途中で終わる
  const e = readUtf8Range(path, { fromByte: 10, maxBytes: 3 });
  assert.equal(e.text, "");
  assert.equal(e.fromByte, 10);
  assert.equal(e.toByte, 10);
  // 続けて読めば欠けずにつながる
  let at = 0;
  let all = "";
  for (let i = 0; i < 20 && at < r.size; i++) {
    const part = readUtf8Range(path, { fromByte: at, maxBytes: 5 });
    all += part.text;
    at = part.toByte;
  }
  assert.equal(all, "aあいう😀b");
  // 末尾を読む形でも、頭の欠けた文字を外す
  const tail = readUtf8Range(path, { maxBytes: 6 });
  assert.equal(tail.text, "😀b");
  assert.equal(tail.fromByte, 10);
});

test("1回の上限を越えて頼まれたら上限で切る", () => {
  const path = join(tmp(), "big");
  writeFileSync(path, "x".repeat(FILE_RANGE_MAX_BYTES + 100));
  const r = readUtf8Range(path, { fromByte: 0, maxBytes: FILE_RANGE_MAX_BYTES * 4 });
  assert.equal(r.text.length, FILE_RANGE_MAX_BYTES);
  assert.equal(r.toByte, FILE_RANGE_MAX_BYTES);
});

test("世代：名前を付け替えて作り直すと変わる。書き足しでは変わらない。無いファイルは空で null", () => {
  const dir = tmp();
  const path = join(dir, "log");
  assert.deepEqual(readUtf8Range(path), { text: "", fromByte: 0, toByte: 0, size: 0, generation: null });
  writeFileSync(path, "one\n");
  const first = readUtf8Range(path).generation;
  appendFileSync(path, "two\n");
  assert.equal(readUtf8Range(path).generation, first);
  renameSync(path, `${path}.1`);
  writeFileSync(path, "three\n");
  assert.notEqual(readUtf8Range(path).generation, first);
  assert.equal(readUtf8Range(`${path}.1`).generation, first);
});
