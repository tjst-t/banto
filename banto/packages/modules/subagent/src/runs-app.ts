// **サブエージェントの入口**（launcher、決定・2026-09-24、ユーザー「launcher から一覧や状態を見られる UI」
// 「シンプルすぎるので良い UI に」）。Command Palette の「Module の入口」から開く——FileSystem の
// ファイルブラウザと同じ型（`dev.banto/canvas: "launcher"`、Module 自身の admin tool を呼ぶ）。
//
// 振る舞いは `ui/runs-view.ts`（ブラウザで動く JS。型を検査してから埋め込む）、見た目の土台は
// `ui/theme.ts`（banto の色と段）。ここはその2つとこの画面の見た目を1枚の HTML に組むだけ。

import { readFileSync } from "node:fs";
import { canvasHtml } from "./ui/theme.js";

export const RUNS_APP_URI = "ui://banto-subagent/runs";

const RUNS_CSS = `
#app { display: flex; flex-direction: column; min-height: 100vh; }
body[data-mode="fullscreen"] #app { height: 100vh; }

/* ---- 上：題とエージェント ---- */
.top { flex-shrink: 0; display: flex; flex-direction: column; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
.top-row { display: flex; align-items: center; gap: 8px; min-height: 24px; }
.title { margin: 0; font-size: var(--t-lg); font-weight: 600; line-height: 1.4; }
.agents { display: flex; flex-wrap: wrap; gap: 6px; }
.agent {
  display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 8px;
  border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--bg);
  font-size: var(--t-xs); color: var(--ink-2); max-width: 100%;
}
.agent .dot { color: var(--ok); }
.agent[data-tone="warn"] .dot { color: var(--warn); }
.agent[data-tone="danger"] .dot { color: var(--danger); }
.agent-name { color: var(--ink); font-weight: 500; }
.pill .dot[data-live] { animation: pulse 1.4s ease-in-out infinite; }

/* ---- 一覧と中身：狭いときは片方ずつ、広いときは左右 ---- */
.layout { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr); }
.layout .detail { display: none; }
.layout.show-detail .list { display: none; }
.layout.show-detail .detail { display: flex; }
.layout.wide { grid-template-columns: minmax(280px, 340px) minmax(0, 1fr); }
.layout.wide .detail { display: flex; border-left: 1px solid var(--line); }
.list { overflow: auto; padding: 4px 8px 12px; }
.list-label {
  display: flex; align-items: center; gap: 6px; margin: 12px 8px 4px;
  font-size: var(--t-xs); font-weight: 500; color: var(--ink-3);
}
.count { font-family: var(--mono); }
.more { display: flex; width: calc(100% - 16px); margin: 8px; justify-content: center; }

/* 「止める」は行の中（右下）に重ねる——行とは別のボタン（入れ子にできない）なので位置で合わせる */
.run-item { position: relative; }
.run-item .stop { position: absolute; right: 4px; bottom: 4px; height: 24px; padding: 0 8px; }
.run-item[data-status="running"] .run { padding-bottom: 12px; }
.run-item[data-status="running"] .run-live { padding-right: 76px; }
.run {
  width: 100%; min-width: 0; display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; gap: 0 10px;
  align-items: start; padding: 8px; border: 0; border-radius: var(--r-sm); background: transparent;
  text-align: left; cursor: pointer;
}
.run:hover { background: var(--bg-2); }
.run[aria-current="true"] { background: var(--accent-soft); }
.run-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.run-prompt {
  font-size: var(--t-md); line-height: 1.5; color: var(--ink);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word;
}
.run-meta { font-size: var(--t-xs); color: var(--ink-3); }
.nowrap { white-space: nowrap; }
.status-word { font-weight: 500; }
.status-running { color: var(--accent); }
.status-done { color: var(--ok); }
.status-error { color: var(--danger); }
.run-live {
  display: flex; align-items: center; gap: 6px; min-width: 0; margin-top: 2px;
  font: var(--t-xs)/1.6 var(--mono); color: var(--accent);
}
.run-when { padding-top: 2px; font-size: var(--t-xs); color: var(--ink-3); white-space: nowrap; }

.glyph {
  display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; margin-top: 2px; border-radius: 50%;
}
.glyph .icon { width: 10px; height: 10px; stroke-width: 3; }
.glyph-done { background: var(--ok-soft); color: var(--ok); }
.glyph-error { background: var(--danger-soft); color: var(--danger); }
.glyph-cancelled { background: var(--bg-2); color: var(--ink-3); }
.glyph-running { border: 2px solid var(--line); border-top-color: var(--accent); border-right-color: var(--accent); animation: spin 0.9s linear infinite; }

/* ---- 中身 ---- */
.detail { flex-direction: column; min-width: 0; min-height: 0; }
.detail-head {
  flex-shrink: 0; display: flex; align-items: center; gap: 8px; min-width: 0;
  padding: 8px 16px; border-bottom: 1px solid var(--line);
}
.detail-head { flex-wrap: wrap; row-gap: 6px; }
.detail-name { display: flex; flex-direction: column; min-width: 0; flex: 1 1 240px; }
.detail-title { font-size: var(--t-lg); font-weight: 500; line-height: 1.4; color: var(--ink); overflow-wrap: anywhere; }
.detail-agent { font-size: var(--t-xs); color: var(--ink-3); overflow-wrap: anywhere; }
.detail-state { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.detail-time { font-size: var(--t-xs); color: var(--ink-3); white-space: nowrap; }
.grow { flex: 1; }
.back { padding: 0 8px 0 4px; }
.detail-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 8px; padding: 12px 16px 20px; }
/* 中身の各節は縮ませない——縮めると、経過が長いときに「頼んだ内容」が1行未満に潰れる（2026-09-27）。
   はみ出た分は detail-body 自身が縦に流す */
.detail-body > * { flex-shrink: 0; }
.section-label { margin: 8px 0 0; font-size: var(--t-xs); font-weight: 500; color: var(--ink-3); }
.section-label:first-child { margin-top: 0; }
.section-count { margin-left: 8px; font-weight: 400; }

/* いまの状況——1件の中身の一番上（アーキ仕様 §4.1 の3） */
.now { display: flex; flex-direction: column; gap: 12px; padding: 12px; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--bg-2); }
.now-doing { display: flex; align-items: flex-start; gap: 10px; }
.now-doing .glyph { margin-top: 4px; flex-shrink: 0; }
.now-doing-main { display: flex; flex-direction: column; min-width: 0; }
.now-label { font-size: var(--t-xs); color: var(--ink-3); }
.now-doing-title { font-size: var(--t-lg); line-height: 1.5; color: var(--ink); overflow-wrap: anywhere; }
.now-doing-sub { font-size: var(--t-xs); color: var(--ink-3); word-break: break-all; }
.now-cols { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
@media (min-width: 1000px) { .now-cols { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } }
.now-block { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.now-side { gap: 14px; }
.now-sub { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.now-head { margin: 0; font-size: var(--t-sm); font-weight: 500; color: var(--ink); }
.now-count { margin-left: 8px; font-size: var(--t-xs); font-weight: 400; color: var(--ink-3); }
.bar { height: 4px; border-radius: 999px; background: var(--bg-3); overflow: hidden; }
.bar > span { display: block; height: 100%; background: var(--ok); }
.plan { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; font-size: var(--t-sm); }
.plan-item { display: flex; align-items: flex-start; gap: 8px; color: var(--ink-2); }
.plan-item > .icon, .plan-item > .glyph { margin-top: 4px; width: 12px; height: 12px; flex-shrink: 0; }
.plan-item > .glyph { margin-top: 4px; }
.plan-completed { color: var(--ink-3); }
.plan-completed > .icon { color: var(--ok); }
.plan-completed > span:last-child { text-decoration: line-through; text-decoration-color: color-mix(in srgb, currentColor 40%, transparent); }
.plan-in_progress { color: var(--ink); font-weight: 500; }
.plan-pending > .icon { color: var(--ink-3); }
/* 要約——いまやっていることの下（アーキ仕様 §4.1 の4） */
.summary-box { display: flex; flex-direction: column; gap: 8px; }
.summary-ask { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.summary-hint { font-size: var(--t-xs); }
.summary-working { display: flex; align-items: center; gap: 8px; font-size: var(--t-sm); color: var(--ink-2); }
.summary-working .glyph { margin: 0; }
.summary-failed { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 12px; border-radius: var(--r-md); background: var(--warn-soft); font-size: var(--t-sm); color: var(--ink); }
.summary-failed > .icon { width: 14px; height: 14px; flex-shrink: 0; color: var(--warn); }
.summary-failed > span { flex: 1 1 16em; min-width: 0; overflow-wrap: anywhere; }
.summary { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: var(--r-md); background: var(--bg); box-shadow: inset 0 0 0 1px var(--line); }
.summary-head { display: flex; align-items: center; gap: 6px; font-size: var(--t-xs); color: var(--ink-3); }
.summary-head > .icon { width: 12px; height: 12px; color: var(--accent); }
.summary-redo { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; }
.summary-redo .icon { width: 12px; height: 12px; }
.summary-text { margin: 0; font-size: var(--t-md); line-height: 1.7; color: var(--ink); overflow-wrap: anywhere; }
.summary-note { font-size: var(--t-xs); }
.summary-discarded { margin: 0; font-size: var(--t-xs); }
.quote { margin: 0; padding-left: 10px; border-left: 2px solid var(--line); font-size: var(--t-sm); line-height: 1.7; color: var(--ink-2); white-space: pre-wrap; overflow-wrap: anywhere; }
.clamp-2, .clamp-3 { display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; }
.clamp-2 { -webkit-line-clamp: 2; }
.clamp-3 { -webkit-line-clamp: 3; }
.link { align-self: flex-start; padding: 0; border: 0; background: none; font-size: var(--t-xs); color: var(--accent); cursor: pointer; }
.link:hover { text-decoration: underline; }
.files { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; }
.file { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: var(--t-xs); }
.file .icon { width: 12px; height: 12px; }
.file-wrote { color: var(--warn); }
.file-read { color: var(--ink-3); }
.file-path { color: var(--ink-2); }
.file-count { margin-left: auto; flex-shrink: 0; color: var(--ink-3); white-space: nowrap; }
.prompt {
  margin: 0; padding: 8px 12px; max-height: min(16em, 40vh); overflow: auto;
  border-left: 2px solid var(--line); border-radius: 0 var(--r-sm) var(--r-sm) 0; background: var(--bg-2);
  font-size: var(--t-md); line-height: 1.7; white-space: pre-wrap; word-break: break-word;
}

/* 経過——縦の線に、呼んだ順で節を打つ */
.trace { list-style: none; margin: 0; padding: 0; }
.step {
  position: relative; display: grid; grid-template-columns: 24px auto minmax(0, 1fr) auto;
  align-items: center; gap: 8px; min-height: 32px;
}
.step::before { content: ""; position: absolute; left: 12px; top: 0; bottom: 0; width: 1px; background: var(--line); }
.step:first-child::before { top: 50%; }
.step:last-child::before { bottom: 50%; }
.node {
  position: relative; z-index: 1; display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; border: 1px solid var(--line); border-radius: 50%; background: var(--bg); color: var(--ink-2);
}
.node .icon { width: 12px; height: 12px; }
.step-kind { font-size: var(--t-xs); color: var(--ink-3); }
.step-main { display: flex; flex-direction: column; min-width: 0; padding: 4px 0; }
.step-line { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.step-main .step-title { white-space: nowrap; }
.step-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--t-xs); color: var(--ink-3); }
.step-failed { font-size: var(--t-xs); color: var(--danger); }
.node-failed { color: var(--danger); border-color: var(--danger-soft); }
.step-live .step-title { font-weight: 500; }
.node .glyph { margin: 0; width: 14px; height: 14px; }
/* 発言は吹き出しで tool の間に挟む */
.step-message { align-items: start; padding: 4px 0; }
.step-message .bubble { grid-column: 2 / 4; justify-self: start; max-width: 44rem; margin: 0; padding: 6px 12px; border-radius: 4px var(--r-md) var(--r-md) var(--r-md); background: var(--bg-2); font-size: var(--t-sm); line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.step-message .step-at { padding-top: 6px; }
.node-message { color: var(--ink-3); }
.node-message .icon { width: 11px; height: 11px; }
/* 同じ種類の tool の連続を1行に */
.group-toggle { grid-column: 2 / 4; display: flex; align-items: center; gap: 6px; min-width: 0; padding: 0; border: 0; background: none; text-align: left; font-size: var(--t-sm); color: var(--ink-2); cursor: pointer; }
.group-toggle:hover { color: var(--ink); }
.group-names { font-size: var(--t-xs); color: var(--ink-3); }
@media (max-width: 480px) { .group-names { display: none; } }
.step-note > span:last-child { grid-column: 2 / 5; font-size: var(--t-xs); }
.step-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--t-sm); color: var(--ink); }
.step-title.mono { font-size: var(--t-xs); }
.step-at { font-size: var(--t-xs); color: var(--ink-3); }
.step-start .step-title, .step-end .step-title { grid-column: 2 / 4; }
.step-start .step-title { color: var(--ink-2); }
.step-start .node { color: var(--accent); }
.step-end.step-done .node { border-color: transparent; background: var(--ok-soft); color: var(--ok); }
.step-end.step-error .node { border-color: transparent; background: var(--danger-soft); color: var(--danger); }
.step-end.step-cancelled .node { color: var(--ink-3); }
.step-end.step-done .step-title { color: var(--ok); font-weight: 500; }
.step-end.step-error .step-title { color: var(--danger); font-weight: 500; }
.step-end.step-running .step-title { color: var(--accent); }
.node-live { justify-self: center; width: 10px; height: 10px; border: 0; background: var(--accent); animation: pulse 1.4s ease-in-out infinite; }

.reply-body {
  padding: 12px 16px; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--bg);
  font-size: var(--t-md); line-height: 1.7; white-space: pre-wrap; word-break: break-word;
}
.reply-live .reply-body { border-style: dashed; color: var(--ink-2); }
.callout { padding: 8px 12px; border-radius: var(--r-md); background: var(--bg-2); font-size: var(--t-sm); }
.callout[data-tone="warn"] { background: var(--warn-soft); }
.callout[data-tone="warn"] strong { color: var(--warn); }
.callout[data-tone="danger"] { background: var(--danger-soft); }
.callout[data-tone="danger"] strong { color: var(--danger); }
.callout p { margin: 2px 0 0; }
.callout ul { margin: 4px 0 0; padding-left: 16px; }
.callout pre { margin: 4px 0 0; font: var(--t-xs)/1.6 var(--mono); white-space: pre-wrap; word-break: break-word; }
.facts {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(144px, 1fr)); gap: 8px 16px;
  margin: 8px 0 0; padding-top: 12px; border-top: 1px solid var(--line);
}
.fact dt { font-size: var(--t-xs); color: var(--ink-3); }
.fact dd { margin: 0; font-size: var(--t-sm); color: var(--ink); word-break: keep-all; overflow-wrap: anywhere; }
.fact dd.mono { font-size: var(--t-xs); word-break: break-all; }
.selectable { user-select: all; }

.empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 40px 16px; text-align: center; color: var(--ink-3); }
.empty p { margin: 0; }
.empty-title { font-size: var(--t-md); font-weight: 500; color: var(--ink-2); }
.error { flex-shrink: 0; margin: 0; padding: 8px 16px; border-top: 1px solid var(--line); font-size: var(--t-xs); color: var(--danger); }
`;

// ブラウザで動く JS は、型を検査したものを dist から読む（`src/ui/runs-view.ts` → `dist/ui/runs-view.js`）
const SCRIPT = readFileSync(new URL("./ui/runs-view.js", import.meta.url), "utf8").replace(/^export \{\};\s*$/m, "");

export const RUNS_APP_HTML = canvasHtml({ css: RUNS_CSS, script: SCRIPT });
