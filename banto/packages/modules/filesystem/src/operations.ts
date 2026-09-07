// docs/specs/v4-modules.md §2.2 FileSystem のインターフェースの実装。
// Landlockが強制境界（Project根の外に出さない）を担うので、ここではパスの
// 単純な正規化だけ行う——アプリ層の検査には頼らない（決定済み、v4-security.md）。

import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const TEXT_EXT = new Set([
  ".txt", ".md", ".json", ".ts", ".tsx", ".js", ".jsx", ".yaml", ".yml", ".toml",
  ".html", ".css", ".py", ".rs", ".sh", ".rb", ".go",
]);

function absPath(root: string, path: string): string {
  return resolve(root, path);
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
