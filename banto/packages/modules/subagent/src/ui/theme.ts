// サブエージェントの画面（入口・設定）が共有する見た目の土台。
//
// **色の名前は MCP Apps の標準の CSS 変数**（`--color-background-primary` など、host が
// `hostContext.styles.variables` で渡す口）を先に見て、渡されなければ banto の色を使う——FileSystem の
// 画面（`packages/modules/filesystem/src/ui/styles.ts`）と同じ作法・同じ値。**値の出どころは
// `apps/frontend/app/globals.css` の層A**（要件E9）で、ここにあるのは既定値の写し。host が色を渡すように
// なれば、そちらが勝つ（tasks.json `canvas-host-style-variables`）。
//
// 字の段（11・12・13・15px）・角（6・10px）・余白（4 の倍数）も banto の段だけを使う。

export const THEME_CSS = `
:root {
  --b-bg: #ffffff; --b-bg-2: #edeff3; --b-bg-3: #e3e6ec;
  --b-ink: #14171c; --b-ink-2: #545b66; --b-ink-3: #8b93a0;
  --b-line: rgba(17, 22, 31, 0.1); --b-line-2: rgba(17, 22, 31, 0.06);
  --b-accent: #3b5bdb; --b-accent-soft: #e9eefc; --b-accent-ink: #2a44ac;
  --b-ok: #2f7a57; --b-ok-soft: #e6f1eb;
  --b-stop: #6e56cf; --b-stop-soft: #eeeafb;
  --b-turn: #ce4620; --b-turn-soft: #fcede7;
  --b-warn: #9c6b12; --b-warn-soft: #faf0dc;
  --b-on-color: #ffffff;
  --b-sh-1: 0 1px 2px rgba(17, 22, 31, 0.05);
  color-scheme: light;
}
:root[data-theme="dark"] {
  --b-bg: #16191f; --b-bg-2: #1d2128; --b-bg-3: #262b33;
  --b-ink: #e8ebf0; --b-ink-2: #a1a9b5; --b-ink-3: #6b7380;
  --b-line: rgba(255, 255, 255, 0.1); --b-line-2: rgba(255, 255, 255, 0.06);
  --b-accent: #7c9cf5; --b-accent-soft: rgba(124, 156, 245, 0.14); --b-accent-ink: #a8befa;
  --b-ok: #6bbf8a; --b-ok-soft: rgba(107, 191, 138, 0.14);
  --b-stop: #a78bfa; --b-stop-soft: rgba(167, 139, 250, 0.14);
  --b-turn: #f07b58; --b-turn-soft: rgba(240, 123, 88, 0.15);
  --b-warn: #ddae55; --b-warn-soft: rgba(221, 174, 85, 0.14);
  --b-on-color: #11141a;
  --b-sh-1: 0 1px 2px rgba(0, 0, 0, 0.3);
  color-scheme: dark;
}
:root {
  --bg: var(--color-background-primary, var(--b-bg));
  --bg-2: var(--color-background-secondary, var(--b-bg-2));
  --bg-3: var(--color-background-tertiary, var(--b-bg-3));
  --ink: var(--color-text-primary, var(--b-ink));
  --ink-2: var(--color-text-secondary, var(--b-ink-2));
  --ink-3: var(--color-text-tertiary, var(--b-ink-3));
  --line: var(--color-border-primary, var(--b-line));
  --line-2: var(--color-border-secondary, var(--b-line-2));
  --accent: var(--color-text-info, var(--b-accent));
  --accent-soft: var(--color-background-info, var(--b-accent-soft));
  --ok: var(--color-text-success, var(--b-ok));
  --ok-soft: var(--color-background-success, var(--b-ok-soft));
  --warn: var(--color-text-warning, var(--b-warn));
  --warn-soft: var(--color-background-warning, var(--b-warn-soft));
  --danger: var(--color-text-danger, var(--b-turn));
  --danger-soft: var(--color-background-danger, var(--b-turn-soft));
  --sans: var(--font-sans, ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif);
  --mono: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  --t-xs: 11px; --t-sm: 12px; --t-md: 13px; --t-lg: 15px;
  --r-sm: 6px; --r-md: 10px;
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body { font: var(--t-sm)/1.7 var(--sans); color: var(--ink); background: transparent; }
body[data-mode="fullscreen"] { background: var(--bg); }
button { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.mono { font-family: var(--mono); }
.muted { color: var(--ink-3); }
.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.icon { width: 14px; height: 14px; flex-shrink: 0; }
.icon-md { width: 16px; height: 16px; flex-shrink: 0; }

.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 28px; padding: 0 10px; border-radius: var(--r-sm); cursor: pointer;
  border: 1px solid var(--line); background: var(--bg); color: var(--ink);
  font-size: var(--t-sm); white-space: nowrap;
}
.btn:hover:not(:disabled) { background: var(--bg-3); }
.btn:disabled { opacity: 0.5; cursor: default; }
.btn-primary { background: var(--accent); border-color: transparent; color: var(--b-on-color); }
.btn-primary:hover:not(:disabled) { background: var(--accent); filter: brightness(1.08); }
.btn-quiet { border-color: transparent; background: transparent; color: var(--ink-2); }
.btn-quiet:hover:not(:disabled) { background: var(--bg-3); color: var(--ink); }
.btn-danger { color: var(--danger); }
.btn-danger:hover:not(:disabled) { background: var(--danger-soft); }

/* 状態の小札——色は「何の状態か」だけを言う（accent＝動いている、ok＝終わった・使える、
   warn＝要る物が足りない、danger＝失敗、無色＝取り消し） */
.pill {
  display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 8px;
  border-radius: 999px; font-size: var(--t-xs); font-weight: 500; white-space: nowrap;
  background: var(--bg-2); color: var(--ink-2);
}
.pill[data-tone="accent"] { background: var(--accent-soft); color: var(--accent); }
.pill[data-tone="ok"] { background: var(--ok-soft); color: var(--ok); }
.pill[data-tone="warn"] { background: var(--warn-soft); color: var(--warn); }
.pill[data-tone="danger"] { background: var(--danger-soft); color: var(--danger); }
.dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex-shrink: 0; }

@keyframes spin { to { transform: rotate(360deg); } }
@keyframes pulse { 0%, 100% { box-shadow: 0 0 0 0 var(--accent-soft); } 50% { box-shadow: 0 0 0 5px var(--accent-soft); } }
@keyframes rise { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
.spin { animation: spin 0.9s linear infinite; }
@media (prefers-reduced-motion: reduce) {
  .spin, [data-live] { animation: none !important; }
}
`;

/** 画面の HTML を組む（見た目の土台＋その画面の見た目＋その画面の JS） */
export function canvasHtml(opts: { css: string; script: string }): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>${THEME_CSS}${opts.css}</style>
</head>
<body>
<div id="app"></div>
<script>${opts.script}</script>
</body>
</html>
`;
}
