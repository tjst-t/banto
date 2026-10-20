import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDirectory, folderNameProblem, listDirectories } from "./directories.js";

test("createDirectory：見ている場所の中に1段だけ作り、絶対パスを返す。同じ名前・親が無い・変な名前は断る", async () => {
  const base = mkdtempSync(join(tmpdir(), "banto-dir-create-"));
  const made = await createDirectory(base, "新しい作業");
  assert.equal(made, join(base, "新しい作業"));
  assert.ok(statSync(made).isDirectory());
  assert.deepEqual((await listDirectories(base)).entries.map((e) => e.name), ["新しい作業"]);
  await assert.rejects(createDirectory(base, "新しい作業"), { code: "EEXIST" });
  await assert.rejects(createDirectory(join(base, "無い"), "x"), { code: "ENOENT" });
  // mkdir -p はしない
  await assert.rejects(createDirectory(base, "a/b"), /名前に \/ や \.\. は使えません/);
  mkdirSync(join(base, "既に"));
  await assert.rejects(createDirectory(base, "既に"), { code: "EEXIST" });
});

test("folderNameProblem：区切り・. ・..・空・前後の空白・NUL・改行を断る", () => {
  assert.equal(folderNameProblem("ok-1"), undefined);
  for (const bad of ["", "  ", " a", "a ", "a/b", "a\\b", ".", "..", "a\0b", "a\nb"]) assert.ok(folderNameProblem(bad), JSON.stringify(bad));
  assert.ok(folderNameProblem("あ".repeat(100)));
});
