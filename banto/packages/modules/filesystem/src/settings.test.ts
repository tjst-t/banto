// Module 自身の設定（決定・2026-09-07）。
//
// **置き場は host が渡す**（`BANTO_MODULE_DATA_DIR`）。宣言に書かせる形に
// していたら、**宣言の写しを持っている Project だけが古いまま**になり、
// 設定を保存できなかった（ユーザー報告・2026-09-07）。ここでは
// 「渡されていれば残る」「渡されていなければ保存できたふりをしない」を見る。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings, writeSettings } from "./settings.js";

test("host が置き場を渡していれば、書いた設定は残る", () => {
  const dir = mkdtempSync(join(tmpdir(), "banto-fs-settings-"));
  const before = process.env.BANTO_MODULE_DATA_DIR;
  process.env.BANTO_MODULE_DATA_DIR = dir;
  try {
    // 既定は「隠しファイルも出す」
    assert.deepEqual(readSettings(), { showHidden: true });

    writeSettings({ showHidden: false });
    assert.deepEqual(readSettings(), { showHidden: false }, "書いた設定が残っていない");
  } finally {
    process.env.BANTO_MODULE_DATA_DIR = before;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("置き場が無ければ、**保存できたふりをしない**（規則2）", () => {
  const before = process.env.BANTO_MODULE_DATA_DIR;
  delete process.env.BANTO_MODULE_DATA_DIR;
  try {
    // 読むほうは既定に落ちてよい（まだ書かれていないのと区別がつかない）
    assert.deepEqual(readSettings(), { showHidden: true });
    // **書くほうは黙って捨てない**
    assert.throws(() => writeSettings({ showHidden: false }), /BANTO_MODULE_DATA_DIR/);
  } finally {
    if (before !== undefined) process.env.BANTO_MODULE_DATA_DIR = before;
  }
});
