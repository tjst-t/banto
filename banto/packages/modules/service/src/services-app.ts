// **入口「サービス」**（launcher、決定・2026-10-20、docs/specs/v4-modules.md §4.2「人の画面——サービス」）。Command Palette の
// 「Module の入口」から開く——Subagent の入口と同じ型（`dev.banto/canvas: "launcher"`、Module 自身の tool を呼ぶ）。
//
// 振る舞いは `ui/services-view.ts`（ブラウザで動く JS。型を検査してから埋め込む）、見た目の土台は `ui/theme.ts`
// （banto の色と段）。ここはその2つとこの画面の見た目を1枚の HTML に組むだけ。

import { readFileSync } from "node:fs";
import { canvasHtml } from "./ui/theme.js";

export const SERVICES_APP_URI = "ui://banto-service/services";

const SERVICES_CSS = `
#app { display: flex; flex-direction: column; min-height: 100vh; }
body[data-mode="fullscreen"] #app { height: 100vh; }
.top { flex-shrink: 0; display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--line); color: var(--ink-3); }
.title { margin: 0; font-size: var(--t-lg); font-weight: 600; line-height: 1.4; color: var(--ink); }
.top .muted { margin-left: auto; font-size: var(--t-xs); }

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
.list-foot { margin: 12px 8px 0; font-size: var(--t-xs); line-height: 1.6; }
.row {
  width: 100%; min-width: 0; display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border: 0;
  border-radius: var(--r-sm); background: transparent; text-align: left; cursor: pointer;
}
.row:hover { background: var(--bg-2); }
.row[aria-current="true"] { background: var(--bg-2); }
.row[data-state="crashed"] { box-shadow: inset 2px 0 0 var(--danger); }
.row-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.row-name { font-size: var(--t-md); color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-when { margin-left: auto; font-size: var(--t-xs); color: var(--ink-3); font-variant-numeric: tabular-nums; white-space: nowrap; }
.row-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 10px; font-size: var(--t-xs); }
.port { font-family: var(--mono); color: var(--ink-2); }
.port.off { color: var(--ink-3); text-decoration: line-through; }

/* ---- 中身 ---- */
.detail { flex-direction: column; min-width: 0; min-height: 0; }
.detail-head { flex-shrink: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 10px 16px; border-bottom: 1px solid var(--line); }
.back { padding: 0 8px 0 4px; flex-basis: 100%; justify-content: flex-start; }
.title-box { display: flex; flex-direction: column; min-width: 0; flex: 1 1 200px; }
.detail-name { font-size: var(--t-lg); font-weight: 500; color: var(--ink); }
.detail-command { font: var(--t-xs)/1.6 var(--mono); color: var(--ink-2); word-break: break-all; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; margin-left: auto; }
.confirm {
  flex-shrink: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 10px 16px;
  border-bottom: 1px solid var(--line); background: var(--warn-soft); font-size: var(--t-sm);
}
.confirm > .icon { color: var(--warn); }
.confirm > span:not(.confirm-buttons) { flex: 1 1 200px; }
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
.port-fact { margin-right: 8px; font-variant-numeric: tabular-nums; }

/* ---- ログ：広いときは横に送り、狭いときは折り返す ---- */
.log-box { display: flex; flex-direction: column; gap: 6px; flex: 1 0 auto; min-height: 0; }
.log-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; font-size: var(--t-xs); color: var(--ink-3); }
.link { border: 0; padding: 0; background: none; color: var(--accent); cursor: pointer; font-size: var(--t-xs); }
.link:hover { text-decoration: underline; }
.link[hidden] { display: none; }
.log {
  margin: 0; height: 55vh; min-height: 12em; overflow: auto; padding: 8px 12px; border-radius: var(--r-sm);
  background: var(--bg-3); font: var(--t-xs)/1.6 var(--mono); color: var(--ink); white-space: pre;
}
.layout:not(.wide) .log { white-space: pre-wrap; overflow-wrap: anywhere; }
.ln.err { color: var(--danger); }
.ts { color: var(--ink-3); margin-right: 8px; }

.empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 40px 16px; text-align: center; color: var(--ink-3); }
.empty p { margin: 0; }
.empty-title { font-size: var(--t-md); font-weight: 500; color: var(--ink-2); }
.flash { flex-shrink: 0; margin: 0; padding: 8px 16px; border-top: 1px solid var(--line); font-size: var(--t-xs); color: var(--ink-2); }
.error { flex-shrink: 0; margin: 0; padding: 8px 16px; border-top: 1px solid var(--line); font-size: var(--t-xs); color: var(--danger); }
`;

// ブラウザで動く JS は、型を検査したものを dist から読む（`src/ui/services-view.ts` → `dist/ui/services-view.js`）
const SCRIPT = readFileSync(new URL("./ui/services-view.js", import.meta.url), "utf8").replace(/^export \{\};\s*$/m, "");

export const SERVICES_APP_HTML = canvasHtml({ css: SERVICES_CSS, script: SCRIPT });
