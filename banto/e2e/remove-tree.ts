// **置き場を消す**（追加・2026-10-17）。banto が取ってきたエージェントの本体の版のフォルダは 0555（アーキ仕様 §4.1
// 「エージェントの本体を取ってくる」）で、そのままでは中を消せない——断られたら書けるようにしてから消し直す
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

export function removeTree(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EACCES") throw err;
    spawnSync("chmod", ["-R", "u+w", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
}
