/**
 * AC-S254276-3-3: 実行者システムプロンプトがプロンプト資産(層A)ファイルから読み込まれ、
 * 変更がgit差分として見える。
 *
 * 検証内容:
 *   1. loadPromptAsset("executor-system") がファイルから読み込んだ非空文字列を返す
 *   2. 返された文字列に実行者の役割説明とツール使用方法が含まれる
 *   3. skills/executor-system.md がリポジトリルートに実在する (git-tracked)
 *   4. 存在しない資産名ではエラーがスローされる (I2)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { loadPromptAsset } from "@banto/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

describe("[AC-S254276-3-3] Prompt assets are loaded from file (skills/ directory)", () => {
  it("[AC-S254276-3-3] skills/executor-system.md exists at repo root", () => {
    const assetPath = path.join(repoRoot, "skills", "executor-system.md");
    assert.ok(
      fs.existsSync(assetPath),
      `skills/executor-system.md must exist at ${assetPath}`
    );
  });

  it("[AC-S254276-3-3] loadPromptAsset('executor-system') returns non-empty string from file", () => {
    const result = loadPromptAsset("executor-system");
    assert.equal(typeof result, "string", "loadPromptAsset must return a string");
    assert.ok(result.length > 0, "Prompt asset must not be empty");
  });

  it("[AC-S254276-3-3] executor-system asset contains role description", () => {
    const result = loadPromptAsset("executor-system");
    // Should contain either Japanese or English role indicator
    const hasRole =
      result.includes("実行者") ||
      result.includes("executor") ||
      result.includes("Executor");
    assert.ok(hasRole, "Prompt asset must contain executor role description");
  });

  it("[AC-S254276-3-3] executor-system asset contains tool usage instructions", () => {
    const result = loadPromptAsset("executor-system");
    const hasToolRef =
      result.includes("report_phase") ||
      result.includes("report_done") ||
      result.includes("フェーズ報告");
    assert.ok(hasToolRef, "Prompt asset must contain tool usage instructions");
  });

  it("[AC-S254276-3-3] executor-system asset is read from file (not a hardcoded string)", () => {
    // Read the file directly and compare — confirms loadPromptAsset reads from disk
    const assetPath = path.join(repoRoot, "skills", "executor-system.md");
    const fileContent = fs.readFileSync(assetPath, "utf-8");
    const loaded = loadPromptAsset("executor-system");
    assert.equal(loaded, fileContent, "loadPromptAsset must return the exact file contents");
  });

  it("[AC-S254276-3-3] loadPromptAsset throws for non-existent asset (I2: not swallowed)", () => {
    assert.throws(
      () => loadPromptAsset("__nonexistent_asset_xyz__"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("not found") || err.message.includes("__nonexistent_asset_xyz__"),
          "Error message should identify the missing asset"
        );
        return true;
      }
    );
  });
});
