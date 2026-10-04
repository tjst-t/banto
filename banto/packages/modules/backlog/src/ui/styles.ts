// 画面の見た目。**色と段は host（banto）が MCP Apps の標準の名前で渡す**（`hostContext.styles.variables`、
// v4-frontend.md §6.27）。この画面は banto の値を持たない——渡されないとき（banto の外の host）は、
// システム色と CSS の語で最低限の見た目にする。読み替えは repositories の THEME_CSS と同じ。
//
// 形はモック（mock/components/banto/canvas/backlog-*.tsx）を写した。塗りの役色は使わない
// （モックの「塗ってよいのは turn だけ」）——状態は輪の形と線の色で言う。

const CSS = `
:root {
  color-scheme: light;
  --bg: var(--color-background-primary, Canvas);
  --bg-2: var(--color-background-secondary, color-mix(in srgb, CanvasText 5%, Canvas));
  --bg-3: var(--color-background-tertiary, color-mix(in srgb, CanvasText 9%, Canvas));
  --ink: var(--color-text-primary, CanvasText);
  --ink-2: var(--color-text-secondary, color-mix(in srgb, CanvasText 70%, Canvas));
  --ink-3: var(--color-text-tertiary, GrayText);
  --line: var(--color-border-primary, color-mix(in srgb, CanvasText 12%, transparent));
  --line-2: var(--color-border-secondary, color-mix(in srgb, CanvasText 30%, transparent));
  --accent: var(--color-text-info, LinkText);
  --on-accent: var(--color-text-inverse, Canvas);
  --ok: var(--color-text-success, green);
  --ok-soft: var(--color-background-success, color-mix(in srgb, green 12%, Canvas));
  --warn: var(--color-text-warning, darkgoldenrod);
  --warn-soft: var(--color-background-warning, color-mix(in srgb, darkgoldenrod 14%, Canvas));
  --danger: var(--color-text-danger, crimson);
  --sans: var(--font-sans, system-ui, sans-serif);
  --mono: var(--font-mono, ui-monospace, monospace);
  --t-xs: var(--font-text-xs-size, 11px);
  --t-sm: var(--font-text-sm-size, 12px);
  --t-md: var(--font-text-md-size, 13px);
  --t-lg: var(--font-text-lg-size, 15px);
  --h-sm: var(--font-heading-sm-size, 17px);
  --r-sm: var(--border-radius-sm, 0.25rem);
  --r-md: var(--border-radius-md, 0.5rem);
  --sh-1: var(--shadow-sm, 0 1px 2px rgb(0 0 0 / 0.08));
  --sh-2: var(--shadow-md, 0 4px 16px rgb(0 0 0 / 0.12));
}
:root[data-theme="dark"] { color-scheme: dark; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; }
body { font: var(--t-sm)/1.6 var(--sans); color: var(--ink); background: transparent; }
body[data-mode="fullscreen"] { background: var(--bg); height: 100vh; overflow: hidden; }
button, input, textarea { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.icon { width: 14px; height: 14px; flex: none; }
.icon-md { width: 16px; height: 16px; flex: none; }
.mono { font-family: var(--mono); }
.num { flex: none; font-family: var(--mono); font-size: var(--t-xs); color: var(--ink-3); font-variant-numeric: tabular-nums; white-space: nowrap; }
.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }

.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px; flex: none;
  height: 28px; padding: 0 10px; border-radius: var(--r-md); cursor: pointer; white-space: nowrap;
  border: 1px solid var(--line-2); background: var(--bg); color: var(--ink); font-size: var(--t-md);
}
.btn:hover:not(:disabled) { background: var(--bg-3); }
.btn:disabled { opacity: .5; cursor: default; }
.btn.primary { background: var(--ink); color: var(--bg); border-color: var(--ink); }
.btn.primary:hover:not(:disabled) { opacity: .88; background: var(--ink); }
.btn.ghost { border-color: transparent; background: transparent; }
.btn.ghost:hover:not(:disabled) { background: var(--bg-2); }
.btn.xs { height: 24px; padding: 0 8px; font-size: var(--t-sm); gap: 4px; }
.icon-btn {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 24px; height: 24px; border-radius: var(--r-sm); border: 0; background: transparent;
  color: var(--ink-3); cursor: pointer; padding: 0;
}
.icon-btn:hover { background: var(--bg-2); color: var(--ink); }

/* ---- 全体（一覧＋詳細）---- */
#app { container-type: inline-size; height: 100%; }
body[data-mode="fullscreen"] #app { height: 100vh; }
.screen { display: flex; height: 100%; min-height: 0; background: var(--bg); outline: none; }
body:not([data-mode="fullscreen"]) .screen { height: 640px; }
.list-pane { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
.detail-pane { width: 100%; flex: none; min-height: 0; border-color: var(--line); }
.screen.peeking .list-pane { display: none; }
@container (min-width: 48rem) {
  .screen.peeking .list-pane { display: flex; }
  .detail-pane { width: 25rem; border-left: 1px solid var(--line); }
}
@container (min-width: 64rem) { .detail-pane { width: 28rem; } }
.wrap { max-width: 48rem; margin: 0 auto; padding: 0 16px; }
@container (min-width: 32rem) { .wrap { padding: 0 24px; } }

.head { flex: none; border-bottom: 1px solid var(--line); }
.head .wrap { display: flex; flex-direction: column; gap: 12px; padding-top: 16px; }
.head-row { display: flex; align-items: center; gap: 12px; min-width: 0; }
.head-row h2 { margin: 0; font-size: var(--t-lg); font-weight: 600; flex: none; }
.source { font: var(--t-xs)/1.4 var(--mono); color: var(--ink-3); }
.head-tools { margin-left: auto; display: flex; align-items: center; gap: 4px; flex: none; }
.filter-count { color: var(--accent); font-variant-numeric: tabular-nums; }
.views { display: flex; gap: 16px; margin-bottom: -1px; overflow-x: auto; scrollbar-width: none; }
.views button {
  display: flex; align-items: baseline; gap: 6px; flex: none; border: 0; background: none; cursor: pointer;
  border-bottom: 2px solid transparent; padding: 0 0 8px; font-size: var(--t-md); color: var(--ink-3); white-space: nowrap;
}
.views button:hover { color: var(--ink-2); }
.views button[aria-current="page"] { border-bottom-color: var(--ink); color: var(--ink); font-weight: 600; }
.views .count { font-size: var(--t-xs); font-weight: 400; color: var(--ink-3); font-variant-numeric: tabular-nums; }

.body { flex: 1; min-height: 0; overflow-y: auto; }
.body .wrap { display: flex; flex-direction: column; gap: 16px; padding-top: 16px; padding-bottom: 40px; }
.notice { display: flex; gap: 8px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--r-md); font-size: var(--t-md); color: var(--ink-2); }
.notice.warn { border-color: var(--warn); }
.notice.warn .icon { color: var(--warn); margin-top: 3px; }
.notice p { margin: 0; }
.notice ul { margin: 4px 0 0; padding-left: 18px; font-size: var(--t-sm); }
.notice code, .refused code { font: var(--t-xs)/1.6 var(--mono); background: var(--bg-2); padding: 2px 4px; border-radius: 4px; white-space: nowrap; }
.refused code.cmd, .notice code.cmd { white-space: normal; word-break: break-all; }
.notice code.cmd { display: block; margin-top: 4px; }
.notice > div { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.refused { display: flex; flex-direction: column; gap: 8px; padding: 24px 0; font-size: var(--t-md); color: var(--ink-2); }
.refused h3 { margin: 0; font-size: var(--t-lg); color: var(--ink); }
.refused p { margin: 0; }
.filtering { display: flex; align-items: center; gap: 8px; margin: 0; font-size: var(--t-xs); color: var(--ink-3); }
.linkish { border: 0; background: none; padding: 0; cursor: pointer; color: var(--ink-2); text-decoration: underline; text-underline-offset: 2px; font-size: inherit; }
.linkish:hover { color: var(--ink); }
.empty { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 24px 0; font-size: var(--t-md); color: var(--ink-2); }
.empty p { margin: 0; }
.keys { margin: 0; padding-top: 8px; font-size: var(--t-xs); color: var(--ink-3); display: none; }
@container (min-width: 32rem) { .keys { display: block; } }

/* ---- 一覧 ---- */
.groups { display: flex; flex-direction: column; gap: 28px; }
.group h3 {
  position: sticky; top: 0; z-index: 2; margin: 0 -8px 4px; padding: 6px 8px; background: var(--bg);
  display: flex; align-items: baseline; gap: 8px; font-size: var(--t-sm); font-weight: 600; color: var(--ink-2); white-space: nowrap;
}
.group h3 .n { font-weight: 400; color: var(--ink-3); font-variant-numeric: tabular-nums; }
.group h3 .hint { margin-left: auto; font-size: var(--t-xs); font-weight: 400; color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; min-width: 0; }
ul.rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.row {
  position: relative; display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 4px 0 2px;
  border-radius: var(--r-md);
}
.row:hover, .row[data-selected] { background: var(--bg-2); }
.row.dragging { opacity: .4; }
.row .drop { position: absolute; left: 4px; right: 4px; height: 2px; border-radius: 2px; background: var(--accent); pointer-events: none; }
.row .drop.before { top: -1px; }
.row .drop.after { bottom: -1px; }
.row .grip { position: absolute; left: -16px; top: 50%; transform: translateY(-50%); color: var(--ink-3); opacity: 0; cursor: grab; }
.row:hover .grip { opacity: 1; }
.chev { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; flex: none; border: 0; background: none; padding: 0; border-radius: var(--r-sm); color: var(--ink-3); cursor: pointer; }
.chev:hover { color: var(--ink); }
.chev svg { transition: transform .15s; }
.chev[aria-expanded="true"] svg { transform: rotate(90deg); }
@media (prefers-reduced-motion: reduce) { .chev svg { transition: none; } }
.chev-space { width: 16px; flex: none; }
.row-open {
  display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; height: 100%;
  border: 0; background: none; padding: 0; text-align: left; cursor: pointer; border-radius: var(--r-sm);
}
.row-title { font-size: var(--t-md); color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.row-title.dim { color: var(--ink-2); }
.row-title.closed { color: var(--ink-3); }
.row-title.story { font-weight: 600; color: var(--ink); }
.row-title.story.top { font-size: var(--t-lg); }
.row-story { max-width: 33%; flex: none; font-size: var(--t-md); color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-sep { flex: none; margin: 0 -4px; font-size: var(--t-md); color: var(--ink-3); }
.row-waiting { min-width: 0; max-width: 10rem; flex-shrink: 4; font-size: var(--t-xs); color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-note { min-width: 0; flex-shrink: 1; font-size: var(--t-xs); color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-right { margin-left: auto; display: flex; align-items: center; gap: 12px; padding-left: 8px; flex: none; }
.row-context { display: none; max-width: 12rem; font-size: var(--t-xs); color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@container (min-width: 32rem) { .row-context { display: inline; } }
.progress { font-size: var(--t-xs); color: var(--ink-3); font-variant-numeric: tabular-nums; }
.prio { font-size: var(--t-xs); font-weight: 600; color: var(--ink); white-space: nowrap; }
.bug-tag { flex: none; border: 1px solid var(--line); border-radius: var(--r-sm); padding: 0 4px; font-size: var(--t-xs); color: var(--ink-2); white-space: nowrap; }
.row-menu { opacity: 0; }
.row:hover .row-menu, .row-menu:focus-visible, .row-menu[aria-expanded="true"] { opacity: 1; }
@media (hover: none) { .row-menu { opacity: 1; } }
.kids { position: relative; margin-left: 19px; padding-left: 10px; border-left: 1px solid var(--line); }
.closed-kids { display: flex; align-items: center; gap: 8px; height: 28px; padding: 0 8px; border: 0; background: none; border-radius: var(--r-md); font-size: var(--t-xs); color: var(--ink-3); cursor: pointer; }
.closed-kids:hover { color: var(--ink-2); }
.closed-row { display: flex; align-items: center; gap: 10px; width: 100%; height: 32px; padding: 0 8px; border: 0; background: none; border-radius: var(--r-md); text-align: left; cursor: pointer; }
.closed-row:hover, .closed-row[data-selected] { background: var(--bg-2); }
.closed-row .t { font-size: var(--t-md); color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
.group-add { display: flex; align-items: center; gap: 8px; width: 100%; height: 32px; margin-top: 2px; padding: 0 8px; border: 0; background: none; border-radius: var(--r-md); text-align: left; font-size: var(--t-md); color: var(--ink-3); cursor: pointer; }
.group-add:hover { background: var(--bg-2); color: var(--ink-2); }

/* ---- 印 ---- */
.mark { position: relative; display: inline-flex; flex: none; width: 22px; height: 22px; color: var(--ink-3); }
.mark.small { width: 18px; height: 18px; }
.mark svg { width: 100%; height: 100%; }
.mark[data-state="actionable"], .mark[data-state="in-progress"] { color: var(--accent); }
.mark[data-state="done"] { color: var(--ok); }
.story-mark { display: inline-flex; flex: none; width: 22px; height: 22px; color: var(--ink-2); }
.story-mark.small { width: 18px; height: 18px; }
.story-mark[data-tone="done"] { color: var(--ok); }
.story-mark[data-tone="in-progress"] { color: var(--accent); }
.story-mark svg { width: 100%; height: 100%; }

/* ---- その場で足す ---- */
.composer { display: flex; flex-direction: column; gap: 8px; margin: 4px 0; padding: 8px 10px; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--bg); box-shadow: var(--sh-1); }
.composer-line { display: flex; align-items: center; gap: 8px; }
.composer-line .icon { color: var(--ink-3); }
.composer input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; font-size: var(--t-md); color: var(--ink); }
.composer input::placeholder { color: var(--ink-3); }
.composer-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding-left: 22px; font-size: var(--t-xs); color: var(--ink-3); }
.kinds { display: flex; gap: 4px; }
.kinds button { border: 0; background: none; padding: 0 6px; border-radius: var(--r-sm); font-size: var(--t-xs); color: var(--ink-3); cursor: pointer; }
.kinds button:hover { color: var(--ink); }
.kinds button[aria-checked="true"] { background: var(--bg-3); color: var(--ink); }

/* ---- 小窓（メニュー・選ぶ）---- */
.pop {
  position: fixed; z-index: 20; min-width: 11rem; max-width: min(22rem, calc(100vw - 16px)); max-height: min(22rem, calc(100vh - 16px)); overflow: auto;
  padding: 4px; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--bg); box-shadow: var(--sh-2);
}
.pop.wide { width: min(20rem, calc(100vw - 16px)); padding: 0; }
.pop .label { padding: 4px 8px; font-size: var(--t-xs); color: var(--ink-3); }
.pop .sep { height: 1px; margin: 4px -4px; background: var(--line); }
.pop .mi {
  display: flex; align-items: center; gap: 8px; width: 100%; min-height: 30px; padding: 4px 8px; border: 0; background: none;
  border-radius: var(--r-sm); text-align: left; font-size: var(--t-md); color: var(--ink); cursor: pointer;
}
.pop .mi:hover:not(:disabled), .pop .mi:focus-visible, .pop .mi[data-active] { background: var(--bg-2); outline: none; }
.pop .mi:disabled { color: var(--ink-3); cursor: default; }
.pop .mi .tick { width: 14px; flex: none; }
.pop .mi .sub { margin-left: auto; color: var(--ink-3); }
.pop .mi .k { margin-left: auto; font-size: var(--t-xs); color: var(--ink-3); flex: none; }
.pop .mi .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pop input { width: 100%; height: 28px; padding: 0 8px; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--bg); font-size: var(--t-md); outline: none; }
.pop .search { padding: 8px; border-bottom: 1px solid var(--line); }
.pop .search input { border: 0; padding: 0; }
.pop .results { padding: 4px; max-height: 16rem; overflow: auto; }
.pop .none { padding: 16px 8px; text-align: center; font-size: var(--t-xs); color: var(--ink-3); }

/* ---- 詳細 ---- */
.detail { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg); }
.detail-top { flex: none; display: flex; align-items: center; gap: 4px; padding: 12px 16px 4px; }
.detail-top .where { flex: 1; min-width: 0; margin: 0; font-size: var(--t-xs); color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail-top .where button { border: 0; background: none; padding: 0; font-size: inherit; color: inherit; cursor: pointer; border-radius: var(--r-sm); }
.detail-top .where button:hover { color: var(--ink); }
.detail-top .where .num { margin-right: 8px; }
.detail-body { flex: 1; min-height: 0; overflow-y: auto; padding: 0 16px 24px; }
.detail-title { margin: 0; font-size: var(--h-sm); font-weight: 600; line-height: 1.4; color: var(--ink); border-radius: var(--r-sm); cursor: text; }
.detail-title:hover { background: var(--bg-2); }
.title-input { width: 100%; font-size: var(--h-sm); font-weight: 600; padding: 4px 8px; border: 1px solid var(--line-2); border-radius: var(--r-md); background: var(--bg); outline: none; }
.props { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 12px; }
.prop {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 8px; border: 1px solid var(--line); border-radius: var(--r-sm);
  background: none; font-size: var(--t-md); color: var(--ink-2); white-space: nowrap; cursor: pointer;
}
.prop:hover:not(:disabled) { background: var(--bg-2); }
.prop:disabled { cursor: default; }
.prop.quiet { border-style: dashed; color: var(--ink-3); }
.prop.strong { font-weight: 600; color: var(--ink); }
.chip { display: inline-flex; align-items: center; gap: 4px; padding: 0 6px; border-radius: var(--r-sm); background: var(--bg-2); font-size: var(--t-xs); color: var(--ink-2); white-space: nowrap; }
.chip button { border: 0; background: none; padding: 0; color: var(--ink-3); cursor: pointer; font-size: inherit; }
.chip button:hover { color: var(--ink); }
.section { margin-top: 24px; }
.section-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; height: 24px; margin-bottom: 6px; }
.section-title h4 { margin: 0; font-size: var(--t-sm); font-weight: 600; color: var(--ink-2); }
.quiet-text { margin: 0; font-size: var(--t-md); color: var(--ink-3); }
.text-value { margin: 0; max-width: 65ch; font-size: var(--t-md); color: var(--ink); white-space: pre-wrap; }
.edit-area { display: flex; flex-direction: column; gap: 8px; }
.edit-area textarea, .split textarea { width: 100%; padding: 8px; border: 1px solid var(--line-2); border-radius: var(--r-md); background: var(--bg); font-size: var(--t-md); line-height: 1.6; resize: vertical; outline: none; }
.edit-area textarea:focus, .split textarea:focus, .title-input:focus, .drop-form input:focus { border-color: var(--accent); }
.actions-right { display: flex; justify-content: flex-end; gap: 8px; }
.item-line { display: flex; align-items: center; gap: 4px; }
.item-line .open {
  display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; height: 32px; padding: 0 6px; border: 0; background: none;
  border-radius: var(--r-md); text-align: left; cursor: pointer;
}
.item-line .open:hover { background: var(--bg-2); }
.item-line .t { flex: 1; min-width: 0; font-size: var(--t-md); color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item-line .t.self { font-weight: 600; color: var(--ink); }
.item-line .s { flex: none; font-size: var(--t-xs); color: var(--ink-3); }
.item-line .rm { opacity: 0; }
.item-line:hover .rm, .item-line .rm:focus-visible { opacity: 1; }
@media (hover: none) { .item-line .rm { opacity: 1; } }
.flow { position: relative; }
.flow .line { position: absolute; top: 16px; bottom: 16px; left: 15px; width: 1px; background: var(--line); }
.flow ol { position: relative; list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.flow li.self { border-radius: var(--r-md); background: var(--bg-2); }
.flow-summary { margin: 6px 0 0; padding-left: 6px; font-size: var(--t-xs); color: var(--ink-3); }
.kid-list { list-style: none; margin: 0; padding: 0; }
.all-done { margin: 8px 0 0; font-size: var(--t-md); color: var(--ink-2); }
.refs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.refs li { font: var(--t-xs)/1.6 var(--mono); color: var(--ink-2); word-break: break-all; }
.threads { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.threads li { display: inline-flex; align-items: center; gap: 6px; font-size: var(--t-md); color: var(--ink-2); }
.threads .icon { color: var(--ink-3); }
.stamp { margin: 24px 0 0; font-size: var(--t-xs); color: var(--ink-3); font-variant-numeric: tabular-nums; }
.detail-foot { flex: none; border-top: 1px solid var(--line); padding: 12px 16px; background: var(--bg); }
.foot-row { display: flex; align-items: center; gap: 8px; }
.foot-row.spread { justify-content: space-between; gap: 12px; }
.foot-row p { margin: 0; min-width: 0; font-size: var(--t-md); color: var(--ink-2); }
.foot-row p span { color: var(--ink-3); }
.drop-form { display: flex; flex-direction: column; gap: 8px; }
.drop-form input { width: 100%; height: 32px; padding: 0 8px; border: 1px solid var(--line-2); border-radius: var(--r-md); background: var(--bg); font-size: var(--t-md); outline: none; }
.split { display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 1px solid var(--line); border-radius: var(--r-md); }
.switch { display: flex; align-items: center; gap: 8px; font-size: var(--t-xs); color: var(--ink-2); cursor: pointer; }
.switch input { margin: 0; }

/* ---- 本文（Markdown の一部）---- */
.md { display: flex; flex-direction: column; gap: 10px; max-width: 65ch; font-size: var(--t-md); color: var(--ink-2); }
.md p { margin: 0; }
.md ul { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 2px; }
.md .h { font-weight: 600; color: var(--ink); }
.md code { font: var(--t-xs) var(--mono); background: var(--bg-2); padding: 0 4px; border-radius: 4px; }
.md strong { font-weight: 600; color: var(--ink); }

/* ---- 設定 ---- */
body[data-surface="config"] #app { padding: 12px; height: auto; }
.config { display: flex; flex-direction: column; gap: 10px; font-size: var(--t-md); }
.config label { display: flex; flex-direction: column; gap: 4px; }
.config .field { display: flex; gap: 8px; flex-wrap: wrap; }
.config input { flex: 1; min-width: 12rem; height: 32px; padding: 0 8px; border: 1px solid var(--line-2); border-radius: var(--r-md); background: var(--bg); font: var(--t-md) var(--mono); outline: none; }
.config input:focus { border-color: var(--accent); }
.config .note { margin: 0; font-size: var(--t-sm); color: var(--ink-3); }
.config .note.error { color: var(--danger); }

/* ---- 通知 ---- */
.toasts { position: fixed; right: 16px; bottom: 16px; z-index: 30; display: flex; flex-direction: column; gap: 8px; width: min(360px, calc(100vw - 32px)); pointer-events: none; }
.toast { pointer-events: auto; background: var(--bg); border: 1px solid var(--line); border-radius: var(--r-md); box-shadow: var(--sh-2); padding: 10px 14px; font-size: var(--t-sm); color: var(--ink); }
.toast .desc { margin-top: 2px; font-size: var(--t-xs); color: var(--ink-3); }
.toast.error { border-color: var(--danger); }
.toast.error .title { color: var(--danger); }
`;

export function installStyles(): void {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}

/** host が渡した標準の CSS 変数を当てる（渡されなければ上の最低限の見た目のまま）。 */
export function applyHostStyles(variables: Record<string, string | undefined> | undefined): void {
  for (const [name, value] of Object.entries(variables ?? {})) {
    if (name.startsWith("--") && typeof value === "string") document.documentElement.style.setProperty(name, value);
  }
}

export function applyTheme(theme: "light" | "dark" | undefined): void {
  if (theme) document.documentElement.dataset.theme = theme;
}
