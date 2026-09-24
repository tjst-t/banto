// サブエージェントの**設定 Canvas**（決定・2026-09-24、ユーザー「OpenCode の Secret は設定から入れられるといい」
// 「鍵の設定は Project ではなく Global に」「シンプルすぎるので良い UI に」）。banto 全体の設定に出る
// （`settings-server.ts` が持つ）。FileSystem の設定 Canvas と同じ形（`dev.banto/canvas: "config"`、
// Module 自身の admin tool を呼ぶ）。
//
// 振る舞いは `ui/settings-view.ts`（型を検査してから埋め込む）、見た目の土台は `ui/theme.ts`。
// **鍵は Module が持たない**——Vault（banto 全体）の決まった名前に置き、どの Project でも使う。

import { readFileSync } from "node:fs";
import { canvasHtml } from "./ui/theme.js";

export const CONFIG_APP_URI = "ui://banto-subagent/config";

const CONFIG_CSS = `
#app { display: flex; flex-direction: column; gap: 12px; padding: 4px 0 12px; }
.card { border: 1px solid var(--line); border-radius: var(--r-md); background: var(--bg); padding: 12px 16px; }
.card-head { display: flex; align-items: center; gap: 8px; }
.card-title { margin: 0; font-size: var(--t-md); font-weight: 600; }
.card-note { margin: 4px 0 0; font-size: var(--t-sm); color: var(--ink-2); }
.keys { margin-top: 8px; }
.key {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 12px; align-items: center;
  padding: 8px 0; border-top: 1px solid var(--line-2);
}
.key-name { display: flex; flex-direction: column; min-width: 0; }
.key-name code { font-size: var(--t-sm); color: var(--ink); }
.key-name .muted { font-size: var(--t-xs); }
.key .pill { justify-self: end; }
.key-actions { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 6px; }
.key-actions:empty { display: none; }
.paste { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 6px; }
.paste input {
  flex: 1; min-width: 12em; height: 28px; padding: 0 8px; border: 1px solid var(--line); border-radius: var(--r-sm);
  background: var(--bg); color: var(--ink); font: var(--t-sm)/1 var(--mono);
}
.paste input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.message { margin: 0; font-size: var(--t-sm); }
.message-ok { color: var(--ok); }
.message-danger { color: var(--danger); }
@media (min-width: 560px) {
  .key { grid-template-columns: minmax(10em, 1fr) auto minmax(0, auto); }
  .key .pill { justify-self: start; }
  .key-actions { grid-column: auto; justify-content: flex-end; }
}
`;

// ブラウザで動く JS は、型を検査したものを dist から読む（`src/ui/settings-view.ts` → `dist/ui/settings-view.js`）
const SCRIPT = readFileSync(new URL("./ui/settings-view.js", import.meta.url), "utf8").replace(/^export \{\};\s*$/m, "");

export const CONFIG_APP_HTML = canvasHtml({ css: CONFIG_CSS, script: SCRIPT });
