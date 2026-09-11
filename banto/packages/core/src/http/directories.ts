// **フォルダを選べるようにするための、一覧**（決定・2026-09-11、ユーザー要望）。
//
// Project の Root は手で打つしかなかった。**選べるようにする**ために、host が
// 「このフォルダの中にあるフォルダ」を答える。
//
// **返すのはフォルダの名前だけ**——ファイルの中身も、ファイル名も返さない。
// これは AI の道具ではなく、**人が根を選ぶための窓**（合言葉を持っている人＝
// その機械の持ち主にしか見えない）。閉じ込め（Landlock）は Module に掛かるもので、
// この口とは層が違う（`docs/specs/v4-security.md`）。

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface DirectoryListing {
  /** 実際に開いた場所（`~` は展開し、相対は絶対にする） */
  path: string;
  /** 1つ上。根（`/`）なら undefined */
  parent?: string;
  entries: Array<{ name: string; path: string }>;
}

/** `~` を展開し、絶対パスにする（画面が打った文字をそのまま渡してくる） */
export function resolveBrowsePath(input: string | undefined): string {
  const raw = (input ?? "").trim();
  if (!raw) return homedir();
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
  return isAbsolute(raw) ? resolve(raw) : resolve(homedir(), raw);
}

/**
 * そのフォルダの中にあるフォルダを返す。
 *
 * **読めないものは黙って飛ばす**——権限が無いフォルダが1つあるだけで一覧全体が
 * 出ないほうが困る（ここは「選ぶための窓」であって、権限の検査ではない）。
 * 開こうとした場所そのものが読めないときは、呼び出し側にそのまま投げる（規則2）。
 */
export async function listDirectories(input: string | undefined): Promise<DirectoryListing> {
  const path = resolveBrowsePath(input);
  const dirents = await readdir(path, { withFileTypes: true });
  const entries: Array<{ name: string; path: string }> = [];
  for (const dirent of dirents) {
    const full = join(path, dirent.name);
    if (dirent.isDirectory()) {
      entries.push({ name: dirent.name, path: full });
      continue;
    }
    // symlink の先がフォルダなら、フォルダとして出す（`~/work` が link のことがある）
    if (dirent.isSymbolicLink()) {
      try {
        if ((await stat(full)).isDirectory()) entries.push({ name: dirent.name, path: full });
      } catch {
        // 切れたリンク——出さない
      }
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, "ja"));
  const parent = dirname(path);
  return { path, ...(parent !== path ? { parent } : {}), entries };
}
