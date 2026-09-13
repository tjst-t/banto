// Runner に生やす組み込み tool（`adapter.ts` の `RUNNER_BUILTIN_TOOLS`）。
//
// **実測で見つかった穴の見張り**（2026-09-12）：SDK の `tools` は基底集合の
// **置き換え**なので、ここに書き忘れたものは黙って消える。実際
// `ListMcpResourcesTool` 等が落ちていて、**AI は Module の resource を1つも
// 読めなかった**——`vault://aliases` も FileSystem の資源も、存在しないのと
// 同じだった（仕様は「組み込み tool 経由で読む」と決めているのに、規則8）。
//
// 見るのは2方向。**在るべきものが在る**ことと、**在ってはならないものが
// 無い**こと——後者を落とすと Landlock で閉じ込めた Shell/FileSystem を
// 素通りできる（決定・2026-09-04）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { RUNNER_BUILTIN_TOOLS } from "./adapter.js";

test("Module の resource を読む口が生えている", () => {
  for (const name of ["ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool"]) {
    assert.ok(
      RUNNER_BUILTIN_TOOLS.includes(name),
      `${name} が無い——AI は Module の resource を1つも読めない（vault://aliases も含めて）`,
    );
  }
});

test("閉じ込めを素通りする口は生えていない", () => {
  // Bash/Read/Write/Edit は Landlock で絞った Shell・FileSystem の迂回路になる
  for (const name of ["Bash", "Read", "Write", "Edit", "NotebookEdit", "Task", "Skill"]) {
    assert.ok(
      !RUNNER_BUILTIN_TOOLS.includes(name),
      `${name} が生えている——Module 越しという境界が意味を失う（決定・2026-09-04）`,
    );
  }
});
