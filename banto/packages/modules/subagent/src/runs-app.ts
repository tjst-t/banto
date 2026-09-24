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
.detail-agent { font-size: var(--t-sm); color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.grow { flex: 1; }
.back { padding: 0 8px 0 4px; }
.detail-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 8px; padding: 12px 16px 20px; }
.section-label { margin: 8px 0 0; font-size: var(--t-xs); font-weight: 500; color: var(--ink-3); }
.section-label:first-child { margin-top: 0; }
.prompt {
  margin: 0; padding: 8px 12px; max-height: 16em; overflow: auto;
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
