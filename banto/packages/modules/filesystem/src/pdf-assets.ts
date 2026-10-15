// **pdf.js が描くのに使う同梱の資料**（CMap・標準フォント、追加・2026-10-15、v4-modules.md §2.2「PDF・Office…」）。
//
// pdf.js は日本語などの文字の対応表（`cmaps/*.bcmap`）と、埋め込まれていない欧文の標準フォント
// （`standard_fonts/`）を **URL から fetch して**読む。Canvas の CSP は `connect-src` を塞いでいる（緩めない）ので、
// 画面は fetch できない——そこで画面向けの tool（`readPdfAsset`、`admin`）でこの Module から渡す。
// 中身は pdfjs-dist のパッケージに入っているものだけ。**名前は1つのファイル名に限る**（フォルダの外を指させない）

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export type PdfAssetKind = "cmap" | "standardFont";

const FOLDERS: Record<PdfAssetKind, string> = { cmap: "cmaps", standardFont: "standard_fonts" };

let packageDir: string | undefined;

function pdfjsDir(): string {
  packageDir ??= dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  return packageDir;
}

export function isPdfAssetKind(value: unknown): value is PdfAssetKind {
  return value === "cmap" || value === "standardFont";
}

export async function readPdfAsset(kind: PdfAssetKind, name: string): Promise<Buffer> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.length > 100) {
    throw new Error(`pdf.js の資料の名前として使えません: ${name}`);
  }
  return readFile(join(pdfjsDir(), FOLDERS[kind], name));
}
