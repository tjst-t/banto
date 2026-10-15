// FileSystem Module が描く画面（MCP Apps、決定・2026-09-06）。
//
// **banto は「どこに出すか」しか決めない。中身は Module 発**（§6.2）。
// この HTML は banto を一切知らない——MCP Apps の約束（postMessage の JSON-RPC）
// だけを使って親と話す。
//
// **画面の JS は `src/ui/` に TypeScript で書き、組み立てて1本にしたもの
// （`dist/ui/app.bundle.js`）をここで HTML に埋める**（2026-09-23）。
// Canvas の CSP は外の script を読ませないので、1枚の HTML に全部入っている必要がある。
// 組み立ては tsc と小さなスクリプト（`scripts/bundle-ui.mjs`）だけで、依存を足していない
// （規則10）。以前のように HTML の文字列の中に JS を直接書くと、ファイルブラウザ・
// プレビュー・編集の量では型も試験も効かない。

import { readFileSync } from "node:fs";

/** 仕様で決まっている画面資源の MIME。 */
export const UI_APP_MIME = "text/html;profile=mcp-app";

/**
 * ファイルブラウザ（listDirectory の画面・人が直接開く入口）。
 * **URI は `directory` のまま**——会話の記録と開いている画面の URL がこの名前を指している。
 */
export const BROWSER_APP_URI = "ui://banto-filesystem/directory";

/** editFile の結果（差分）の画面。 */
export const EDIT_DIFF_APP_URI = "ui://banto-filesystem/edit-diff";

/** showFile の画面——人に見せるファイル1つ（大きく開くとブラウザになる）。 */
export const FILE_APP_URI = "ui://banto-filesystem/file";

/**
 * showFile の画面のうち PDF・Word・表（追加・2026-10-15、v4-modules.md §2.2「PDF・Office…」）。pdf.js（約 1.7MB）と
 * docx-preview・JSZip（約 0.2MB）・SheetJS（約 0.3MB）を同梱するのでテキストの画面（`file`）とは分ける——どちらを出すかは
 * host が引数の拡張子で選ぶ（`dev.banto/ui-by-extension`）。PDF・Word・表のどれで描くかは、画面が同じ拡張子で選ぶ
 * （`ui/document-app.ts`）。
 */
export const DOCUMENT_APP_URI = "ui://banto-filesystem/document";

export type AppSurface = "browser" | "edit-diff" | "file" | "document";

const scripts = new Map<string, string>();

function loadScript(url: URL): string {
  const cached = scripts.get(url.href);
  if (cached !== undefined) return cached;
  let text: string;
  try {
    // `</script` が中に出ると HTML の方で script が閉じてしまう。JS としては同じ意味の形に直す
    text = readFileSync(url, "utf8").replace(/<\/(script)/gi, "<\\/$1");
  } catch (err) {
    // **壊れた画面を配らない**（規則2）——組み立てを忘れたまま動かしている、と言う
    throw new Error(
      `画面の JS がありません（${url.pathname}）。\`npm run build\` で組み立ててください: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  scripts.set(url.href, text);
  return text;
}

function loadBundle(): string {
  return loadScript(new URL("./ui/app.bundle.js", import.meta.url));
}

/**
 * **PDF の画面**：pdf.js の worker を**同じ画面の中**で動かす（fake worker）。Canvas の CSP は Worker を塞いでいる
 * （緩めない）ので、`pdf.worker.mjs` を先に読み込んで `globalThis.pdfjsWorker` に置かせ、pdf.js はそれを見つけて
 * Worker を作らずに同じ流れで動く。3本とも module の script——順に走る（pdf.js の2本は自分で globalThis に置く）
 */
function documentScripts(): string {
  const pdfjs = new URL("./", import.meta.resolve("pdfjs-dist/build/pdf.min.mjs"));
  const worker = loadScript(new URL("pdf.worker.min.mjs", pdfjs));
  const lib = loadScript(new URL("pdf.min.mjs", pdfjs));
  const app = loadScript(new URL("./ui/document.bundle.js", import.meta.url));
  return [...docxScripts(), xlsxScript(), ...[worker, lib, app].map((js) => `<script type="module">\n${js}\n</script>`)].join("\n");
}

/**
 * **Word の描き手**（docx-preview 0.4 と、それが使う JSZip 3）。どちらも UMD の min を普通の script で置く——
 * JSZip が `globalThis.JSZip` に置かれ、docx-preview はそれを見て `globalThis.docx` に置く。普通の script は
 * module の script より先に走るので、画面（module）が動くときには揃っている
 */
function docxScripts(): string[] {
  const jszip = loadScript(new URL(import.meta.resolve("jszip/dist/jszip.min.js")));
  const docx = loadScript(new URL("./docx-preview.min.js", import.meta.resolve("docx-preview")));
  return [jszip, docx].map((js) => `<script>\n${js}\n</script>`);
}

/**
 * **表の読み手**（SheetJS 0.20.3 の mini——xlsx を読み、数の書式で値を書く。npm の `xlsx` は 0.18.5 で止まっていて古いので、
 * cdn.sheetjs.com の tgz を入れている）。普通の script で置くと `globalThis.XLSX` に置かれる。読むのは変換役が書き出し直した
 * xlsx だけなので、xls・ods を読む部分の無い mini で足りる
 */
function xlsxScript(): string {
  return `<script>\n${loadScript(new URL(import.meta.resolve("xlsx/dist/xlsx.mini.min.js")))}\n</script>`;
}

export function appHtml(surface: AppSurface): string {
  if (surface === "document") {
    return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body data-surface="document">
<div id="app"></div>
${documentScripts()}
</body>
</html>
`;
  }
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body data-surface="${surface}">
<div id="app"></div>
<script>
${loadBundle()}
</script>
</body>
</html>
`;
}
