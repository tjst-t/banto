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
