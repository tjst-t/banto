// FileSystem Module 自身の設定（決定・2026-09-07）。
//
// **設定の中身は Module が持つ**（v4-frontend.md §6.2）——banto の Configuration は
// core 自身の設定であって、Module の設定を預かる登録簿ではない。だからここに置く。
//
// 置き場は **host が必ず渡す** `BANTO_MODULE_DATA_DIR`（改訂・2026-09-07）。
// 宣言（`launch.env`）に書かせる形にしていたが、**宣言の写しを持っている
// Project だけが古いまま**になり、設定を保存できなかった（規則3）。
// host が作り、閉じ込めの許可も host が出している場所なので、host が渡す。
// **Project の中には書かない**——人のリポジトリを汚さない。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface FileSystemSettings {
  /** 隠しファイル（`.` で始まるもの）を一覧に出すか。 */
  showHidden: boolean;
}

const DEFAULTS: FileSystemSettings = { showHidden: true };

function settingsPath(): string | undefined {
  const dir = process.env.BANTO_MODULE_DATA_DIR;
  return dir ? join(dir, "settings.json") : undefined;
}

export function readSettings(): FileSystemSettings {
  const path = settingsPath();
  if (!path) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<FileSystemSettings>;
    return { showHidden: typeof raw.showHidden === "boolean" ? raw.showHidden : DEFAULTS.showHidden };
  } catch {
    // まだ書かれていない・壊れている——**既定に落ちる**（読めないまま進まない）
    return { ...DEFAULTS };
  }
}

export function writeSettings(next: FileSystemSettings): void {
  const path = settingsPath();
  if (!path) {
    // 置き場が渡されていないなら、**保存できたふりをしない**（規則2）
    throw new Error("設定の置き場が渡されていません（BANTO_MODULE_DATA_DIR）");
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2), { mode: 0o600 });
}
