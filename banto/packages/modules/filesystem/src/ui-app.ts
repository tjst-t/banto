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

export type AppSurface = "browser" | "edit-diff" | "file";

let bundle: string | undefined;

function loadBundle(): string {
  if (bundle !== undefined) return bundle;
  const url = new URL("./ui/app.bundle.js", import.meta.url);
  try {
    // `</script` が中に出ると HTML の方で script が閉じてしまう。JS としては同じ意味の形に直す
    bundle = readFileSync(url, "utf8").replace(/<\/(script)/gi, "<\\/$1");
  } catch (err) {
    // **壊れた画面を配らない**（規則2）——組み立てを忘れたまま動かしている、と言う
    throw new Error(
      `画面の JS がありません（${url.pathname}）。\`npm run build\` で組み立ててください: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return bundle;
}

export function appHtml(surface: AppSurface): string {
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
