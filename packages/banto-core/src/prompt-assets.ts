/**
 * Prompt asset loader for banto-core.
 *
 * Reads prompt assets (layer A) from the skills/ directory at the repository root.
 * Assets are plain Markdown files tracked in git, so changes are visible as diffs.
 *
 * D3: assets are files (intent), not embedded strings — editing them is a git diff.
 * D6: uses only node:fs and node:path (no extra dependencies).
 * I2: throws if the asset file is missing, so callers see a clear error.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/**
 * Resolve the repository root by walking up from this file's location.
 * This file lives at packages/banto-core/src/prompt-assets.ts, so
 * repo root is three levels up.
 *
 * At runtime (ts-node/tsx) import.meta.url gives the source path;
 * after compilation it gives the dist path — either way, three levels up lands at root.
 */
function resolveRepoRoot(): string {
  // __dirname equivalent for ESM
  const dir = path.dirname(fileURLToPath(import.meta.url));
  // packages/banto-core/src → packages/banto-core → packages → root
  return path.resolve(dir, "..", "..", "..");
}

/**
 * Load a prompt asset by name from the skills/ directory.
 *
 * @param name - asset filename without extension (e.g. "executor-system")
 * @returns file contents as a UTF-8 string
 * @throws Error if the asset file does not exist (I2: not swallowed)
 */
export function loadPromptAsset(name: string): string {
  const repoRoot = resolveRepoRoot();
  const assetPath = path.join(repoRoot, "skills", `${name}.md`);
  if (!fs.existsSync(assetPath)) {
    throw new Error(
      `Prompt asset not found: "${name}" (looked at ${assetPath}). ` +
        `Create skills/${name}.md to define this asset.`
    );
  }
  return fs.readFileSync(assetPath, "utf-8");
}

/**
 * 資産の**中身の指紋**（realign 第2便・段1）。監査の証拠に刻む「どの基準で見たか」。
 *
 * 版番号ではなく中身のハッシュにしているのは、これらが版を持たない Markdown だから
 * ——番号を別に振ると、書き換えても番号を上げ忘れる（そして証拠が嘘になる）。
 * 短く切っているのは帳簿と札に載せるため。衝突の心配より、読めることを取る。
 *
 * I2: 資産が無ければ `loadPromptAsset` が投げる。**「基準が無い」を静かに
 * 「基準はこれ」に丸めない**——ここで握ると、基準を見ていない監査に指紋が付く。
 */
export function promptAssetDigest(name: string): string {
  const content = loadPromptAsset(name);
  return createHash("sha256").update(content, "utf-8").digest("hex").slice(0, 12);
}
