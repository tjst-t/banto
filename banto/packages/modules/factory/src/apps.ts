// Factory の画面（入口と設定）を1枚の HTML に組む。振る舞いは `ui/runs-view.ts`・`ui/settings-view.ts`（ブラウザで動く JS。
// 型を検査してから dist から読んで埋める）、見た目の土台は `ui/theme.ts`。形はモック（mock/components/banto/canvas/factory-view.tsx・
// settings/factory-config-section.tsx、決定・2026-10-07、ユーザー）。

import { readFileSync } from "node:fs";
import { canvasHtml } from "./ui/theme.js";

export const UI_APP_MIME = "text/html;profile=mcp-app";
export const RUNS_APP_URI = "ui://banto-factory/runs";
export const CONFIG_APP_URI = "ui://banto-factory/config";

const RUNS_CSS = `
#app { display: flex; flex-direction: column; min-height: 100vh; }
body[data-mode="fullscreen"] #app { height: 100vh; }
.top { flex-shrink: 0; display: flex; align-items: center; gap: 12px; height: 44px; padding: 0 12px; border-bottom: 1px solid var(--line); }
.title { margin: 0; font-size: var(--t-md); font-weight: 600; }
.layout { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr); }
.layout .detail { display: none; }
.layout.show-detail .list { display: none; }
.layout.show-detail .detail { display: flex; }
.layout.wide.show-detail { grid-template-columns: minmax(300px, 420px) minmax(0, 1fr); }
.layout.wide.show-detail .list { display: block; border-right: 1px solid var(--line); }
.list { overflow: auto; padding: 0 8px 16px; }
.sec-title { display: flex; align-items: center; gap: 6px; margin: 12px 8px 4px; font-size: var(--t-sm); font-weight: 600; color: var(--ink-2); }
.sec-title[data-tone="human"] { color: var(--warn); }
.sec-title .count { font-weight: 400; color: var(--ink-3); }
.fold { width: calc(100% - 0px); display: flex; align-items: center; gap: 6px; height: 32px; margin-top: 8px; padding: 0 8px; border: 0; border-radius: var(--r-sm); background: transparent; cursor: pointer; font-size: var(--t-sm); font-weight: 600; color: var(--ink-2); }
.fold:hover { background: var(--bg-2); }
.none { padding: 6px 8px; margin: 0; color: var(--ink-3); }

.row { width: 100%; display: flex; align-items: flex-start; gap: 12px; padding: 8px; border: 0; border-radius: var(--r-sm); background: transparent; text-align: left; cursor: pointer; }
.row:hover, .row[aria-current="true"] { background: var(--bg-2); }
.row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.row-title { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.num { flex-shrink: 0; color: var(--ink-3); }
.row-name { font-size: var(--t-md); color: var(--ink); }
.row[data-status="dropped"] .row-name { color: var(--ink-3); text-decoration: line-through; }
.row-sub { font-size: var(--t-sm); color: var(--ink-3); }
.row-sub[data-tone="human"] { color: var(--warn); }
.row-side { flex-shrink: 0; display: flex; flex-direction: column; align-items: flex-end; font-size: var(--t-sm); color: var(--ink-2); }
.row-side[data-tone="human"] { color: var(--warn); }
.row-side .t { font-size: var(--t-xs); color: var(--ink-3); }
.row-side .t[data-long] { color: var(--warn); }

/* 段の目盛り——済んだ段は ok、いまの段は accent（止まっていれば warn）、まだは薄い線 */
.ticks { flex-shrink: 0; display: flex; gap: 2px; width: 64px; margin-top: 9px; }
.ticks.lg { width: 100%; gap: 4px; margin-top: 0; }
.tick { flex: 1; height: 0; border-top: 4px solid var(--bg-3); border-radius: 999px; }
.ticks.lg .tick { border-top-width: 6px; }
.tick[data-s="done"] { border-color: var(--ok); }
.tick[data-s="now"] { border-color: var(--accent); }
.tick[data-s="human"], .tick[data-s="long"] { border-color: var(--warn); }

.detail { flex-direction: column; min-height: 0; min-width: 0; }
.d-top { flex-shrink: 0; display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 8px; border-bottom: 1px solid var(--line); color: var(--ink-3); }
.d-body { flex: 1; min-height: 0; overflow: auto; padding: 16px 16px 24px; }
.d-title { margin: 0; font-size: var(--t-lg); font-weight: 600; line-height: 1.4; }
.d-meta { margin: 4px 0 0; color: var(--ink-3); }
.stages { margin-top: 16px; }
.stage-names { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 4px; margin: 6px 0 0; padding: 0; list-style: none; }
.stage-names li { min-width: 0; }
.stage-name { display: flex; align-items: center; gap: 4px; color: var(--ink-3); }
.stage-name[data-s="done"] { color: var(--ink-2); }
.stage-name[data-s="done"] svg { color: var(--ok); }
.stage-name[data-s="now"] { color: var(--ink); font-weight: 600; }
.stage-name[data-s="human"] { color: var(--warn); font-weight: 600; }
.stage-sub { display: block; font-size: var(--t-xs); color: var(--ink-3); }
.stage-sub[data-long] { color: var(--warn); }
.callout-human { margin-top: 20px; padding: 12px; border: 1px solid var(--warn); border-radius: var(--r-md); background: var(--warn-soft); }
.callout-human .why { display: flex; align-items: center; gap: 6px; margin: 0; font-size: var(--t-md); font-weight: 600; color: var(--warn); }
.callout-human .note { margin: 4px 0 0; font-size: var(--t-xs); color: var(--ink-3); }
.callout-human textarea { width: 100%; min-height: 64px; margin-top: 12px; padding: 8px; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--bg); color: var(--ink); font: var(--t-md)/1.6 var(--sans); resize: vertical; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; }
.actions .push { margin-left: auto; }
.btn-human { background: var(--warn); border-color: transparent; color: var(--on-accent); }
.btn-human:hover:not(:disabled) { background: var(--warn); filter: brightness(1.08); }
.menu { position: relative; }
.menu-list { position: absolute; z-index: 5; top: 32px; left: 0; min-width: 160px; margin: 0; padding: 4px; list-style: none; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--bg); box-shadow: 0 4px 16px color-mix(in srgb, CanvasText 12%, transparent); }
.menu-list button { width: 100%; height: 28px; padding: 0 8px; border: 0; border-radius: var(--r-sm); background: transparent; text-align: left; cursor: pointer; }
.menu-list button:hover { background: var(--bg-2); }
.now { display: flex; align-items: center; gap: 12px; margin-top: 16px; padding: 8px 12px; border: 1px solid var(--line); border-radius: var(--r-md); }
.now .now-text { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.now .btn { flex-shrink: 0; }
.top .open-settings { margin-left: auto; }
.empty .btn { margin-top: 8px; }
.now .who { font-size: var(--t-sm); color: var(--ink-3); }
.now .what { font-size: var(--t-md); color: var(--ink); }
.result { margin: 16px 0 0; font-size: var(--t-md); color: var(--ink-2); }
.result[data-tone="ok"] { color: var(--ok); }
.d-sec { margin-top: 24px; }
.d-sec h3 { margin: 0 0 8px; font-size: var(--t-sm); font-weight: 600; color: var(--ink-2); }
.d-sec h3[data-tone="ok"] { color: var(--ok); }
.d-sec h3[data-tone="danger"] { color: var(--danger); }
.cmd { margin: 0 0 6px; font: var(--t-xs)/1.6 var(--mono); color: var(--ink-3); }
.out { max-height: 192px; overflow: auto; margin: 0; padding: 10px; border-radius: var(--r-sm); background: var(--bg-2); font: var(--t-xs)/1.6 var(--mono); white-space: pre-wrap; word-break: break-word; color: var(--ink-2); }
.review-list, .files, .journal { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; }
.review-list { gap: 8px; }
.review-list .where { margin-left: 6px; font-size: var(--t-sm); color: var(--ink-3); }
.review-list .why { display: block; font-size: var(--t-sm); color: var(--ink-3); }
.files { gap: 2px; }
.files li { display: flex; align-items: baseline; gap: 8px; }
.files .path { flex: 1; min-width: 0; font: var(--t-xs)/1.6 var(--mono); color: var(--ink-2); }
.add { font-size: var(--t-xs); color: var(--ok); }
.del { font-size: var(--t-xs); color: var(--danger); }
.journal li { display: flex; gap: 12px; padding: 3px 0; }
.journal .when { width: 56px; flex-shrink: 0; text-align: right; font-size: var(--t-xs); color: var(--ink-3); font-variant-numeric: tabular-nums; }
.journal .stage { width: 64px; flex-shrink: 0; font-size: var(--t-xs); color: var(--ink-3); }
.journal .text { flex: 1; min-width: 0; color: var(--ink-2); }
.journal [data-k="test-fail"] .text, .journal [data-k="review-changes"] .text, .journal [data-k="fail"] .text { color: var(--danger); }
.journal [data-k="ask"] .text { color: var(--warn); }
.journal [data-k="answer"] .text { color: var(--ink); }
.d-foot { flex-shrink: 0; display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--line); }
.d-foot .path { flex: 1; min-width: 0; font: var(--t-xs)/1.6 var(--mono); color: var(--ink-3); }
.empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 48px 24px; text-align: center; }
.empty p { margin: 0; max-width: 28rem; }
.empty .lead { font-size: var(--t-md); color: var(--ink-2); }
.empty .sub { color: var(--ink-3); }
.error { flex-shrink: 0; margin: 0; padding: 8px 16px; border-top: 1px solid var(--line); font-size: var(--t-xs); color: var(--danger); }
`;

const CONFIG_CSS = `
#app { padding: 4px 0 12px; max-width: 46rem; }
.field { margin-top: 20px; }
.field:first-child { margin-top: 0; }
label.lead, .lead { display: block; font-size: var(--t-md); font-weight: 600; color: var(--ink); }
label.name, .name { display: block; font-size: var(--t-sm); font-weight: 600; color: var(--ink-2); }
.hint { margin: 2px 0 0; font-size: var(--t-sm); color: var(--ink-3); }
.need { margin: 4px 0 0; font-size: var(--t-sm); color: var(--warn); }
input[type="text"], input[type="number"], select {
  height: 32px; margin-top: 6px; padding: 0 8px; border: 1px solid var(--line); border-radius: var(--r-sm);
  background: var(--bg); color: var(--ink); font: var(--t-sm)/1 var(--sans);
}
input[type="text"] { width: 100%; font-family: var(--mono); }
input[type="text"][data-need] { border-color: var(--warn); }
input[type="number"] { width: 96px; font-variant-numeric: tabular-nums; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
.grid3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-top: 6px; }
.small-name { display: block; font-size: var(--t-sm); color: var(--ink-2); }
.agent-row { display: flex; gap: 8px; }
.agent-row select:first-child { width: 140px; }
.agent-row select:last-child, .agent-row input { flex: 1; min-width: 0; }
.save-row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 24px; padding-top: 12px; border-top: 1px solid var(--line); }
.save-note { font-size: var(--t-sm); color: var(--ink-3); }
.error { margin: 8px 0 0; font-size: var(--t-sm); color: var(--danger); }
`;

const script = (name: string) =>
  readFileSync(new URL(`./ui/${name}.js`, import.meta.url), "utf8").replace(/^export \{\};\s*$/m, "");

export const RUNS_APP_HTML = canvasHtml({ css: RUNS_CSS, script: script("runs-view") });
export const CONFIG_APP_HTML = canvasHtml({ css: CONFIG_CSS, script: script("settings-view") });
