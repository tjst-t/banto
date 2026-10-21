// **入口「バックグラウンドのコマンド」**（launcher、決定・2026-10-20、docs/specs/v4-modules.md §2.3「人の画面——バックグラウンドの
// コマンド」、Backlog #491）。Command Palette の「Module の入口」から開く——Subagent の入口と同じ型（`dev.banto/canvas: "launcher"`、
// Module 自身の admin の道具を呼ぶ）。**待たない形が使える Shell（コンテナの中）だけが名乗る**
//
// 振る舞いは `ui/commands-view.ts`（ブラウザで動く JS。型を検査してから埋め込む）、見た目の土台は `ui/theme.ts`
// （banto の色と段）。ここはその2つとこの画面の見た目を1枚の HTML に組むだけ。

import { readFileSync } from "node:fs";
import { canvasHtml } from "./ui/theme.js";

export const COMMANDS_APP_URI = "ui://banto-shell/commands";

const COMMANDS_CSS = `
#app { display: flex; flex-direction: column; min-height: 100vh; }
body[data-mode="fullscreen"] #app { height: 100vh; }
.top { flex-shrink: 0; display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--line); color: var(--ink-3); }
.title { margin: 0; font-size: var(--t-lg); font-weight: 600; line-height: 1.4; color: var(--ink); }
.top .pill { margin-left: 4px; }
.top .pill .dot { animation: pulse 1.4s ease-in-out infinite; }

/* ---- 一覧と中身：狭いときは片方ずつ、広いときは左右 ---- */
.layout { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr); }
.layout .detail { display: none; }
.layout.show-detail .list { display: none; }
.layout.show-detail .detail { display: flex; }
.layout.wide { grid-template-columns: minmax(260px, 320px) minmax(0, 1fr); }
.layout.wide .detail { display: flex; border-left: 1px solid var(--line); }
.list { overflow: auto; padding: 4px 8px 12px; display: flex; flex-direction: column; gap: 2px; }
.list-label { display: flex; align-items: center; gap: 6px; margin: 12px 8px 4px; font-size: var(--t-xs); font-weight: 500; color: var(--ink-3); }
.count { font-family: var(--mono); }
.row {
  width: 100%; min-width: 0; display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border: 0;
  border-radius: var(--r-sm); background: transparent; text-align: left; cursor: pointer;
}
.row:hover { background: var(--bg-2); }
.row[aria-current="true"] { background: var(--bg-2); }
.row-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.row-title { font-size: var(--t-md); color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row[data-status]:not([data-status="running"]) .row-title { color: var(--ink-2); }
.row-when { margin-left: auto; font-size: var(--t-xs); color: var(--ink-3); font-variant-numeric: tabular-nums; white-space: nowrap; }
.row-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 10px; font-size: var(--t-xs); }

/* ---- 中身 ---- */
.detail { flex-direction: column; min-width: 0; min-height: 0; }
.detail-head { flex-shrink: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 10px 16px; border-bottom: 1px solid var(--line); }
.back { padding: 0 8px 0 4px; flex-basis: 100%; justify-content: flex-start; }
.title-box { display: flex; flex-direction: column; min-width: 0; flex: 1 1 200px; }
.detail-title { font-size: var(--t-lg); font-weight: 500; color: var(--ink); overflow-wrap: anywhere; }
.detail-head > .btn:not(.back) { margin-left: auto; }
.confirm {
  flex-shrink: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 10px 16px;
  border-bottom: 1px solid var(--line); background: var(--warn-soft); font-size: var(--t-sm);
}
/* 狭いときは文を1行、ボタンをその下の右に（v4-modules.md §2.3「狭い画面」） */
.confirm-text { flex: 1 1 240px; }
.confirm-buttons { display: flex; gap: 6px; margin-left: auto; }
.btn-danger-solid { background: var(--danger); border-color: transparent; color: var(--on-accent); }
.btn-danger-solid:hover:not(:disabled) { background: var(--danger); filter: brightness(1.08); }
.detail-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 12px; padding: 12px 16px 16px; }
.detail-body > * { flex-shrink: 0; }
.callout { padding: 8px 12px; border-radius: var(--r-md); background: var(--bg-2); font-size: var(--t-sm); }
.callout[data-tone="warn"] { background: var(--warn-soft); }
.callout[data-tone="danger"] { background: var(--danger-soft); }
.facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px 16px; margin: 0; }
.fact dt { font-size: var(--t-xs); color: var(--ink-3); }
.fact dd { margin: 0; font-size: var(--t-sm); color: var(--ink); overflow-wrap: anywhere; }
.command {
  margin: 0; padding: 8px 12px; max-height: min(12em, 30vh); overflow: auto; border-radius: var(--r-sm); background: var(--bg-2);
  font: var(--t-xs)/1.6 var(--mono); white-space: pre-wrap; word-break: break-all;
}

/* ---- 出力：広いときは横に送り、狭いときは折り返す ---- */
.out-box { display: flex; flex-direction: column; gap: 6px; flex: 1 0 auto; min-height: 0; }
.out-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; font-size: var(--t-xs); color: var(--ink-3); }
.link { border: 0; padding: 0; background: none; color: var(--accent); cursor: pointer; font-size: var(--t-xs); }
.link:hover { text-decoration: underline; }
.link[hidden] { display: none; }
.out {
  margin: 0; height: 55vh; min-height: 12em; overflow: auto; padding: 8px 12px; border-radius: var(--r-sm);
  background: var(--bg-3); font: var(--t-xs)/1.6 var(--mono); color: var(--ink); white-space: pre;
}
.layout:not(.wide) .out { white-space: pre-wrap; overflow-wrap: anywhere; }
.out-foot { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: var(--t-xs); color: var(--ink-3); }
.path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: var(--t-xs)/1.6 var(--mono); }
.selectable { user-select: all; }
.copy { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; }
.size { margin-left: auto; flex-shrink: 0; font-variant-numeric: tabular-nums; }
.callout[hidden] { display: none; }

.empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 40px 16px; text-align: center; color: var(--ink-3); }
.empty p { margin: 0; }
.empty-title { font-size: var(--t-md); font-weight: 500; color: var(--ink-2); }
.error { flex-shrink: 0; margin: 0; padding: 8px 16px; border-top: 1px solid var(--line); font-size: var(--t-xs); color: var(--danger); }
`;

// ブラウザで動く JS は、型を検査したものを dist から読む（`src/ui/commands-view.ts` → `dist/ui/commands-view.js`）
const SCRIPT = readFileSync(new URL("./ui/commands-view.js", import.meta.url), "utf8").replace(/^export \{\};\s*$/m, "");

export const COMMANDS_APP_HTML = canvasHtml({ css: COMMANDS_CSS, script: SCRIPT });
