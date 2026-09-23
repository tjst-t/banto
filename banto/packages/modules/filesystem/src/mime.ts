// ファイルの種類を決める（v4-modules.md §2.2「返り値の型は MIME で出し分ける」）。
//
// **拡張子の表と、中身の検査の二段**。表に無い拡張子を一律にバイナリ扱いすると、
// `.csv` や `.sql` のような普通のテキストが AI にも画面にも読めなくなる
// （実際 `.csv` は表に無く、中身の代わりに base64 が返っていた）。
// 表に無いものは**中身を見て決める**——先頭に NUL を含むか、UTF-8 として
// 読めないならバイナリ。git が差分を出すかどうかの判定と同じ考え方（規則12）。

/** 画像として AI にも見せるもの（MCP の `image` content block になる）。 */
const IMAGE_MIME: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** 中身を見るまでもなくバイナリと分かるもの。 */
const BINARY_MIME: Readonly<Record<string, string>> = {
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
};

/** テキストで、種類に名前があるもの（画面が描き分けに使う）。 */
const TEXT_MIME: Readonly<Record<string, string>> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

export type FileKind =
  | { kind: "image"; mimeType: string }
  | { kind: "binary"; mimeType: string }
  | { kind: "text"; mimeType: string };

/** 拡張子だけで決まるなら決める。決まらなければ undefined（中身を見る）。 */
export function kindByExtension(ext: string): FileKind | undefined {
  const e = ext.toLowerCase();
  if (IMAGE_MIME[e]) return { kind: "image", mimeType: IMAGE_MIME[e] };
  if (BINARY_MIME[e]) return { kind: "binary", mimeType: BINARY_MIME[e] };
  if (TEXT_MIME[e]) return { kind: "text", mimeType: TEXT_MIME[e] };
  return undefined;
}

/** 中身から決める。**先頭 8000 バイトに NUL があるか、UTF-8 として壊れていればバイナリ**。 */
export function kindByContent(buf: Buffer): FileKind {
  const head = buf.subarray(0, 8000);
  if (head.includes(0)) return { kind: "binary", mimeType: "application/octet-stream" };
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return { kind: "binary", mimeType: "application/octet-stream" };
  }
  return { kind: "text", mimeType: "text/plain" };
}
