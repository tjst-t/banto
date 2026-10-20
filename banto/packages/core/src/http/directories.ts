// **フォルダを選べるようにするための、一覧**（決定・2026-09-11、ユーザー要望）。
//
// Project の Root は手で打つしかなかった。**選べるようにする**ために、host が
// 「このフォルダの中にあるフォルダ」を答える。
//
// **返すのはフォルダの名前だけ**——ファイルの中身も、ファイル名も返さない。
// これは AI の道具ではなく、**人が根を選ぶための窓**（合言葉を持っている人＝
// その機械の持ち主にしか見えない）。閉じ込め（Landlock）は Module に掛かるもので、
// この口とは層が違う（`docs/specs/v4-security.md`）。

import { mkdir, readdir, stat } from "node:fs/promises";
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

/** 新しいフォルダの名前として使えるか（1段だけ。区切り・`.`・`..`・NUL・改行は使えない） */
export function folderNameProblem(name: string): string | undefined {
  if (!name.trim()) return "フォルダの名前が空です";
  if (name !== name.trim()) return "名前の前後に空白は使えません";
  if (/[/\\\0\n\r]/.test(name) || name === "." || name === "..") return "名前に / や .. は使えません";
  if (Buffer.byteLength(name) > 255) return "名前が長すぎます";
  return undefined;
}

/**
 * **フォルダを1つ作る**（追加・2026-10-20、ユーザー「フォルダ作成が UI からできないので GUI で Project の作成が完結しない」）。
 * 新しい Project の「選ぶ」の画面から、いま見ている場所の中に1段だけ作る（`mkdir -p` はしない——親はある場所に限る）。
 * 同じ名前があれば断る。作ったフォルダの絶対パスを返す
 */
export async function createDirectory(parentInput: string | undefined, name: string): Promise<string> {
  const problem = folderNameProblem(name);
  if (problem) throw new Error(problem);
  const parent = resolveBrowsePath(parentInput);
  if (!(await stat(parent)).isDirectory()) throw new Error(`${parent} はフォルダではありません`);
  const path = join(parent, name);
  await mkdir(path, { mode: 0o755 });
  return path;
}
