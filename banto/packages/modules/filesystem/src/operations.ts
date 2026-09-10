// docs/specs/v4-modules.md §2.2 FileSystem のインターフェースの実装。
//
// **強制境界は Landlock**（Project 根の外に出さない、v4-security.md）。ただし
// Landlock の許可リストは**プロセスを起動するための都合**で根より広い
// （node のバイナリ・`/etc`・`/proc`・Module のインストール先）。つまり
// `readFile("/etc/passwd")` は OS には止められない——**tool の契約としては
// 通してはいけない**（決定・2026-09-10、`filesystem-path-scope`）。
//
// そこで **tool の引数は「Project の根の中を指しているか」で見る**。相対でも
// 絶対でもよく、`..` や記号リンクを解いた**実体**が根の外なら断る。
// **Landlock を置き換えるのではなく、その上に契約を1枚置く**——アプリ層の検査
// だけに頼らない、という元の決定はそのまま。
//
// **「相対パスだけを受ける」形は実測でやめた**（2026-09-10）：AI は根の中の
// ファイルを**絶対パスで**指してくる（`/tmp/…/one.txt`）。断ると同じ呼び出しを
// 繰り返して行き詰まる——守りたいのは「根の外へ出さない」であって「書き方」では
// ないので、根の中を指す絶対パスは受ける。

import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";

export class PathOutsideRootError extends Error {}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const TEXT_EXT = new Set([
  ".txt", ".md", ".json", ".ts", ".tsx", ".js", ".jsx", ".yaml", ".yml", ".toml",
  ".html", ".css", ".py", ".rs", ".sh", ".rb", ".go",
]);

/** 記号リンクを解いた実体。**まだ無いパスは、いちばん近い親で見る**（新規作成のため）。 */
function realpathOfNearestExisting(p: string): string {
  let probe = p;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return probe;
    probe = parent;
  }
  return realpathSync(probe);
}

function absPath(root: string, path: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new PathOutsideRootError("path が空です（Project の根からの相対パス、または根の中の絶対パス）");
  }
  // `~` は展開しない（ここはシェルではない）。黙って別の意味に解釈するより、
  // 何が起きているかを言って断る（規則2）
  if (path === "~" || path.startsWith("~/")) {
    throw new PathOutsideRootError(
      `home からの指定（~）は扱えません。Project の根からの相対パスで指定します: ${path}`,
    );
  }
  const target = resolve(root, path);
  const realRoot = realpathSync(root);
  const real = realpathOfNearestExisting(target);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new PathOutsideRootError(`Project の根の外は扱えません: ${path}`);
  }
  return target;
}

export interface FileContentBlock {
  type: "text" | "image" | "resource";
  text?: string;
  data?: string;
  mimeType?: string;
}

export async function readFileOp(root: string, path: string): Promise<FileContentBlock> {
  const p = absPath(root, path);
  const ext = extname(p).toLowerCase();
  if (IMAGE_EXT.has(ext)) {
    const buf = await fsReadFile(p);
    return { type: "image", data: buf.toString("base64"), mimeType: `image/${ext.slice(1)}` };
  }
  if (TEXT_EXT.has(ext) || ext === "") {
    const text = await fsReadFile(p, "utf8");
    return { type: "text", text };
  }
  const buf = await fsReadFile(p);
  return { type: "resource", data: buf.toString("base64"), mimeType: "application/octet-stream" };
}

export async function writeFileOp(root: string, path: string, content: string): Promise<void> {
  const p = absPath(root, path);
  await mkdir(join(p, ".."), { recursive: true });
  await fsWriteFile(p, content, "utf8");
}

export interface Edit {
  oldText: string;
  newText: string;
}

export async function editFileOp(root: string, path: string, edits: Edit[]): Promise<{ before: string; after: string }> {
  const p = absPath(root, path);
  const before = await fsReadFile(p, "utf8");
  let after = before;
  for (const edit of edits) {
    if (!after.includes(edit.oldText)) {
      throw new Error(`editFile: oldText not found in ${path}: ${JSON.stringify(edit.oldText.slice(0, 80))}`);
    }
    after = after.replace(edit.oldText, edit.newText);
  }
  await fsWriteFile(p, after, "utf8");
  return { before, after };
}

export interface DirEntry {
  name: string;
  type: "file" | "directory";
}

export async function listDirectoryOp(
  root: string,
  path: string,
  options: { showHidden?: boolean } = {},
): Promise<DirEntry[]> {
  const p = absPath(root, path);
  const entries = await readdir(p, { withFileTypes: true });
  const showHidden = options.showHidden !== false;
  return entries
    .filter((e) => showHidden || !e.name.startsWith("."))
    .map((e) => ({ name: e.name, type: e.isDirectory() ? "directory" : "file" }));
}

export async function searchFilesOp(root: string, path: string, pattern: string): Promise<string[]> {
  const p = absPath(root, path);
  const regex = new RegExp(pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"));
  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (regex.test(e.name)) {
        results.push(full.slice(root.length + 1));
      }
    }
  }
  await walk(p);
  return results;
}

export async function createDirectoryOp(root: string, path: string): Promise<void> {
  await mkdir(absPath(root, path), { recursive: true });
}

export async function moveFileOp(root: string, from: string, to: string): Promise<void> {
  const src = absPath(root, from);
  const dst = absPath(root, to);
  await mkdir(join(dst, ".."), { recursive: true });
  await rename(src, dst);
}

export async function deleteFileOp(root: string, path: string): Promise<void> {
  await rm(absPath(root, path), { recursive: true, force: false });
}

export interface FileInfo {
  size: number;
  mtime: string;
  type: "file" | "directory";
}

export async function getFileInfoOp(root: string, path: string): Promise<FileInfo> {
  const s = await stat(absPath(root, path));
  return { size: s.size, mtime: s.mtime.toISOString(), type: s.isDirectory() ? "directory" : "file" };
}
