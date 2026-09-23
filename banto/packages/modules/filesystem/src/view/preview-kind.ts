// 拡張子 → 描き方の対応表（v4-modules.md §2.2「Canvas のプレビューは拡張子／MIME→
// レンダラーの内部対応表を持つ」）。**対応形式を増やすときはここに1行足すだけ**
// ——tool/resource の契約には現れない（Module の画面の内部詳細）。
//
// DOM に触らない（試験から直接読むため）。

export type PreviewKind = "markdown" | "html" | "svg" | "image" | "pdf" | "spreadsheet" | "source";

const PREVIEW_KIND_BY_EXT: Readonly<Record<string, PreviewKind>> = {
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
  svg: "svg",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  pdf: "pdf",
  csv: "spreadsheet",
  tsv: "spreadsheet",
};

/** 拡張子（小文字・ドット無し）。無ければ空文字。`.gitignore` のような名前は拡張子なし。 */
export function extOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function previewKindFor(path: string): PreviewKind {
  return PREVIEW_KIND_BY_EXT[extOf(path)] ?? "source";
}

/** CSV か TSV か（表として読むときの区切り）。 */
export function delimiterFor(path: string): "," | "\t" {
  return extOf(path) === "tsv" ? "\t" : ",";
}

export type FileIconKind = "code" | "text" | "image" | "sheet" | "file";

const ICON_KIND_BY_EXT: Readonly<Record<string, FileIconKind>> = {
  ts: "code",
  tsx: "code",
  js: "code",
  jsx: "code",
  mjs: "code",
  cjs: "code",
  json: "code",
  html: "code",
  htm: "code",
  css: "code",
  py: "code",
  rs: "code",
  go: "code",
  rb: "code",
  sh: "code",
  md: "text",
  markdown: "text",
  txt: "text",
  pdf: "text",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  csv: "sheet",
  tsv: "sheet",
};

export function iconKindFor(name: string): FileIconKind {
  return ICON_KIND_BY_EXT[extOf(name)] ?? "file";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
