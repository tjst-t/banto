/**
 * file.browser のプレビュー種別判定（epic-0011・task-0050〜0055）。
 *
 * 「どの拡張子を preview でどう描くか」の判断を UI から分離してここに置く。純粋関数のみ——
 * ブラウザ（FileBrowser.tsx）にも node:test（tests/acceptance）からも読めるように、
 * 依存（react・DOM・shiki 等）を一切持たない。
 *
 * 拡張子リストは提案（docs/proposals/2026-07-30-file-browser-preview-mode.md）の表のとおり。
 */

export type FilePreviewKind =
  | "markdown"
  | "mermaid"
  | "csv"
  | "diff"
  | "html"
  | "image"
  | "code"
  | "plain";

/** これを超える行数のファイルは preview を無効化し source 表示に落とす（task-0050 a4）。 */
export const PREVIEW_MAX_LINES = 2000;

/** 提案の表：Markdown */
const MARKDOWN_EXTS = ["md"];
/** 提案の表：図（Mermaid） */
const MERMAID_EXTS = ["mmd", "mermaid"];
/** 提案の表：CSV/TSV */
const CSV_EXTS = ["csv", "tsv"];
/** 提案の表：diff/patch */
const DIFF_EXTS = ["diff", "patch"];
/**
 * HTML（spec-file-browser §5.9）。**隔離した iframe で描く**——中身は `file.read` では
 * 運ばず、`file.raw` の URL を src にする（相対パスの資産がそれでしか解決しない）。
 */
const HTML_EXTS = ["html", "htm"];
/**
 * 画像（§5.10）。`svg` は**入れない**——`file.raw` が画像として配らない（スクリプトを
 * 持てるため素のテキストに落とす）ので、画面だけ画像のつもりで描くと食い違う。
 */
const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "avif", "ico"];
/**
 * 提案の表：ソースコード（値は shiki の言語ID。task-0052 のハイライト対象）。
 * ハイライト対象拡張子の拡充は「都度の追加とする」（task-0052 スコープ外）。
 */
const CODE_LANG_BY_EXT: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  // 種別としては `html`（§5.9）だが、原文（source）ではマークアップとして色を付ける
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  xml: "xml",
  sh: "shell",
  toml: "toml",
  rb: "ruby",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  dart: "dart",
};

/** パスの末尾から拡張子を切り出す（大文字小文字は揃える）。無ければ空文字。 */
export function extOfPath(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  // 先頭ドットの隠しファイル（.gitignore 等）は「拡張子なし」扱い
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** ファイル種別の判定（提案の表）。該当しない拡張子は source モード固定の plain。 */
export function kindOfPath(path: string): FilePreviewKind {
  const ext = extOfPath(path);
  if (MARKDOWN_EXTS.includes(ext)) return "markdown";
  if (MERMAID_EXTS.includes(ext)) return "mermaid";
  if (CSV_EXTS.includes(ext)) return "csv";
  if (DIFF_EXTS.includes(ext)) return "diff";
  if (HTML_EXTS.includes(ext)) return "html";
  if (IMAGE_EXTS.includes(ext)) return "image";
  if (ext in CODE_LANG_BY_EXT) return "code";
  return "plain";
}

/**
 * 中身を `file.read` で運ばない種別（§5.1）。
 *
 * `image` はバイナリで端から読めず、`html` は URL を渡す形でしか相対パスの資産が
 * 解決しない。どちらも `file.raw` の URL を直接使う。
 */
export function isRawKind(kind: FilePreviewKind): boolean {
  return kind === "html" || kind === "image";
}

/** コード種別ファイルの shiki 言語ID（code 以外は undefined）。 */
export function codeLangOfPath(path: string): string | undefined {
  return CODE_LANG_BY_EXT[extOfPath(path)];
}

/**
 * diff 1行の色分けクラス（task-0055）。GitViewer（DiffBody）と同じ判定を流用し、
 * 既存の gv-add / gv-del / gv-hunk スタイルを使う。
 */
export function classifyDiffLine(line: string): string | undefined {
  if (line.startsWith("+") && !line.startsWith("+++")) return "gv-add";
  if (line.startsWith("-") && !line.startsWith("---")) return "gv-del";
  if (line.startsWith("@@")) return "gv-hunk";
  if (line.startsWith("diff --git")) return "gv-file";
  return undefined;
}
