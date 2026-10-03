// Backlog Module 自身の設定——tasks.json をどこに置くか（§4.4「場所の既定は docs/tasks.json で、
// Backlog の設定で変えられる」）。
//
// 置き場は FileSystem と同じく **host が必ず渡す** `BANTO_MODULE_DATA_DIR`。Project ごとの Module は
// 接続名が Project ごとに分かれ、置き場も Project ごとになる——**設定は Project ごと**。
// **Project の中には書かない**（設定の写しを人のリポジトリに置かない）。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { BacklogError } from "./model.js";

export const DEFAULT_TASKS_PATH = "docs/tasks.json";

export interface BacklogSettings {
  /** Project の根からの場所（`/` 区切り） */
  path: string;
}

function settingsPath(): string | undefined {
  const dir = process.env.BANTO_MODULE_DATA_DIR;
  return dir ? join(dir, "settings.json") : undefined;
}

/**
 * 場所として受け付けるか。**Project の根の外は指せない**（絶対パス・`..` を断る）。
 * 閉じ込めは host が別に掛けているが、ここでも言う——外を指した設定が「保存できたのに読めない」にならないように
 */
export function checkTasksPath(raw: string): string {
  const trimmed = raw.trim().replace(/\\/g, "/");
  if (trimmed === "") throw new BacklogError("場所が空です");
  if (trimmed.startsWith("/")) throw new BacklogError("Project の根からの場所を書きます（/ で始めない）");
  const normalized = posix.normalize(trimmed);
  if (normalized === ".." || normalized.startsWith("../")) throw new BacklogError("Project の根の外は指せません");
  if (!normalized.endsWith(".json")) throw new BacklogError("場所は .json のファイルです");
  return normalized;
}

export function readSettings(): BacklogSettings {
  const path = settingsPath();
  if (!path) return { path: DEFAULT_TASKS_PATH };
  let raw: Partial<BacklogSettings>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Partial<BacklogSettings>;
  } catch (err) {
    // まだ書かれていない——既定。**壊れているのは既定に落とさない**（違うファイルを黙って読み書きしない、規則2）
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { path: DEFAULT_TASKS_PATH };
    throw new BacklogError(`Backlog の設定を読めません（${path}）：${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof raw.path !== "string") return { path: DEFAULT_TASKS_PATH };
  return { path: checkTasksPath(raw.path) };
}

export function writeSettings(next: BacklogSettings): BacklogSettings {
  const path = settingsPath();
  // 置き場が渡されていないなら、**保存できたふりをしない**（規則2）
  if (!path) throw new BacklogError("設定の置き場が渡されていません（BANTO_MODULE_DATA_DIR）");
  const saved = { path: checkTasksPath(next.path) };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  return saved;
}
