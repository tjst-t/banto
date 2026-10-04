// Backlog Module 自身の設定——一覧を置くブランチの名前（§4.4「設定」。既定 `backlog`、中のファイルは tasks.json 固定）。
//
// 置き場は FileSystem と同じく **host が必ず渡す** `BANTO_MODULE_DATA_DIR`。Project ごとの Module は
// 接続名が Project ごとに分かれ、置き場も Project ごとになる——**設定は Project ごと**。
// **Project の中には書かない**（設定の写しを人のリポジトリに置かない）。
//
// 以前の設定（`path`——作業ツリーの tasks.json の場所、2026-10-04 まで）は読まない。残っていても既定のブランチになる。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BacklogError } from "./model.js";

export const DEFAULT_BRANCH = "backlog";

export interface BacklogSettings {
  /** 一覧を置くブランチ（`refs/heads/` の下の名前） */
  branch: string;
}

function settingsPath(): string | undefined {
  const dir = process.env.BANTO_MODULE_DATA_DIR;
  return dir ? join(dir, "settings.json") : undefined;
}

/**
 * ブランチ名として受け付けるか。git の決まり（`check-ref-format`）のうち、ここで要るものを見る——コマンドの引数と
 * refspec に入れるので、`-` で始まるもの・記号（`:` `+` `*` `~` `^` `?` `[` 空白など）・`..`・`@{`・`.lock` で終わるもの等は断る
 */
export function checkBranch(raw: string): string {
  const name = raw.trim().replace(/^refs\/heads\//, "");
  if (name === "") throw new BacklogError("ブランチ名が空です");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(name)) {
    throw new BacklogError("ブランチ名に使えるのは英数字と . _ / - です（英数字で始める）");
  }
  if (name.includes("..") || name.includes("//") || name.includes("/.") || name.includes("@{")) {
    throw new BacklogError("ブランチ名に .. ・ // ・ /. は使えません");
  }
  if (name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) throw new BacklogError("ブランチ名を / ・ . ・ .lock で終えられません");
  return name;
}

export function readSettings(): BacklogSettings {
  const path = settingsPath();
  if (!path) return { branch: DEFAULT_BRANCH };
  let raw: Partial<BacklogSettings>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Partial<BacklogSettings>;
  } catch (err) {
    // まだ書かれていない——既定。**壊れているのは既定に落とさない**（違うブランチを黙って読み書きしない、規則2）
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { branch: DEFAULT_BRANCH };
    throw new BacklogError(`Backlog の設定を読めません（${path}）：${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof raw.branch !== "string") return { branch: DEFAULT_BRANCH };
  return { branch: checkBranch(raw.branch) };
}

export function writeSettings(next: BacklogSettings): BacklogSettings {
  const path = settingsPath();
  // 置き場が渡されていないなら、**保存できたふりをしない**（規則2）
  if (!path) throw new BacklogError("設定の置き場が渡されていません（BANTO_MODULE_DATA_DIR）");
  const saved = { branch: checkBranch(next.branch) };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  return saved;
}
