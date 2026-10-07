// Factory の画面（入口・設定）が共有する見た目の土台（Subagent の theme.ts と同じもの——Module は互いの中を import しない）。
//
// **色と段は host（banto）が MCP Apps の標準の名前で渡す**（`hostContext.styles.variables`、
// 決定・2026-09-25、v4-frontend.md §6.27）。**この画面は banto の値を持たない**（要件E9・規則3）——
// 元は banto の `globals.css` の層A の1箇所。渡されないとき（banto の外の host）は、システム色と
// CSS の語で最低限の見た目にする（banto の写しではない）。
//
// 余白は標準の名前が無いので渡らない——4 の倍数だけを使う。

export const THEME_CSS = `
:root {
  color-scheme: light;
  --bg: var(--color-background-primary, Canvas);
  --bg-2: var(--color-background-secondary, color-mix(in srgb, CanvasText 5%, Canvas));
  --bg-3: var(--color-background-tertiary, color-mix(in srgb, CanvasText 9%, Canvas));
  --ink: var(--color-text-primary, CanvasText);
  --ink-2: var(--color-text-secondary, color-mix(in srgb, CanvasText 70%, Canvas));
  --ink-3: var(--color-text-tertiary, GrayText);
  --line: var(--color-border-primary, color-mix(in srgb, CanvasText 12%, transparent));
  --line-2: var(--color-border-secondary, color-mix(in srgb, CanvasText 6%, transparent));
  --accent: var(--color-text-info, LinkText);
  --accent-soft: var(--color-background-info, color-mix(in srgb, LinkText 12%, Canvas));
  --on-accent: var(--color-text-inverse, Canvas);
  --ok: var(--color-text-success, green);
  --ok-soft: var(--color-background-success, color-mix(in srgb, green 12%, Canvas));
  --warn: var(--color-text-warning, darkgoldenrod);
  --warn-soft: var(--color-background-warning, color-mix(in srgb, darkgoldenrod 14%, Canvas));
  --danger: var(--color-text-danger, crimson);
  --danger-soft: var(--color-background-danger, color-mix(in srgb, crimson 12%, Canvas));
  --sans: var(--font-sans, system-ui, sans-serif);
  --mono: var(--font-mono, ui-monospace, monospace);
  --t-xs: var(--font-text-xs-size, x-small);
  --t-sm: var(--font-text-sm-size, small);
  --t-md: var(--font-text-md-size, small);
  --t-lg: var(--font-text-lg-size, medium);
  --r-sm: var(--border-radius-sm, 0.25rem);
  --r-md: var(--border-radius-md, 0.5rem);
}
:root[data-theme="dark"] { color-scheme: dark; }
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
.btn-primary { background: var(--accent); border-color: transparent; color: var(--on-accent); }
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
