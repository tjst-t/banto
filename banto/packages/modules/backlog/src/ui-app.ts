// Backlog Module が描く画面（MCP Apps）。FileSystem と同じく、画面の JS は `src/ui/` に TypeScript で書き、
// 組み立てて1本にしたもの（`dist/ui/app.bundle.js`、scripts/bundle-ui.mjs）を HTML に埋める
// ——Canvas の CSP は外の script を読ませない。**この HTML は banto を知らない**（MCP Apps の約束だけ）。

import { readFileSync } from "node:fs";

export const UI_APP_MIME = "text/html;profile=mcp-app";

/** 一覧（人が入口から開く）。 */
export const BOARD_APP_URI = "ui://banto-backlog/items";

/** 設定 Canvas（tasks.json の場所）。 */
export const CONFIG_APP_URI = "ui://banto-backlog/config";

export type AppSurface = "board" | "config";

let bundle: string | undefined;

function loadBundle(): string {
  if (bundle !== undefined) return bundle;
  const url = new URL("./ui/app.bundle.js", import.meta.url);
  try {
    // `</script` が中に出ると HTML の方で script が閉じてしまう。JS としては同じ意味の形に直す
    bundle = readFileSync(url, "utf8").replace(/<\/(script)/gi, "<\\/$1");
  } catch (err) {
    // **壊れた画面を配らない**（規則2）
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
