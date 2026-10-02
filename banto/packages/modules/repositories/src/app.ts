// Repositories Module が描く画面（MCP Apps）。**1つの HTML を2か所で使う**（Skill の置き場と同じ形）：
//
// - **入口**（launcher）——Command Palette の「Module の入口」から、会話の隣に開く。どの Project からも開ける
// - **banto 全体の設定の Repositories の面**——同じ一覧を埋め込み、その下に既定の置き場と GitHub のアカウント
//   （段階2。見た目の正はモックの `settings/github-accounts-section.tsx`。秘密の値は画面に戻らない——Module が返すのは
//   login と alias の在りかだけ。貼った PAT は入力欄から Module へ渡したら、欄を空にする）
//
// 見た目と振る舞いの正はモック（`mock/components/banto/canvas/repo-list-view.tsx`・`repo-import-dialog.tsx`・
// `settings/repo-home-section.tsx`）。まだ無いもの（clone・新しいリポジトリ・GitHub に公開）の
// うち、**事実の隣の次の手**（Project を始める・GitHub に公開・clone し直す）は出し、押したら「まだ作っていない」と
// 言う（嘘をつかない）。見出しの右の「URL から clone」「新しいリポジトリ」は出さない（規則13——繋がっていないものは隠す）。
//
// **塗る色は2つだけ**（§2.4）：見つからない・読めない（人の手が要る）と、このマシンにだけ。banto が渡す色は MCP Apps の
// 標準の名前だけなので、前者はモックの turn ではなく danger（banto の stop）で塗る——標準の名前に turn は無い。
//
// **色と段は banto が渡す**（v4-frontend.md §6.27）。土台は publish-directory の `published-app.ts` と同じ読み替えの表
// （パッケージをまたいで共有する口がまだ無いので写した）。MCP Apps の約束（postMessage の JSON-RPC）だけで親と話す。

export const UI_APP_MIME = "text/html;profile=mcp-app";
/** 入口（launcher）——一覧 */
export const LIST_APP_URI = "ui://banto-repositories/list";
/** banto 全体の設定の面——一覧と既定の置き場 */
export const SETTINGS_APP_URI = "ui://banto-repositories/settings";

const THEME_CSS = `
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
  --accent-soft: var(--color-background-info, color-mix(in srgb, LinkText 12%, Canvas));
  --ok: var(--color-text-success, green);
  --ok-soft: var(--color-background-success, color-mix(in srgb, green 12%, Canvas));
  --warn: var(--color-text-warning, darkgoldenrod);
  --warn-soft: var(--color-background-warning, color-mix(in srgb, darkgoldenrod 14%, Canvas));
  --danger: var(--color-text-danger, crimson);
  --danger-soft: var(--color-background-danger, color-mix(in srgb, crimson 12%, Canvas));
  --sans: var(--font-sans, system-ui, sans-serif);
  --mono: var(--font-mono, ui-monospace, monospace);
  --t-xs: var(--font-text-xs-size, 11px);
  --t-sm: var(--font-text-sm-size, 12px);
  --t-md: var(--font-text-md-size, 13px);
  --t-lg: var(--font-text-lg-size, 15px);
  --h-sm: var(--font-heading-sm-size, 17px);
  --r-sm: var(--border-radius-sm, 0.25rem);
  --r-md: var(--border-radius-md, 0.5rem);
  --shadow: var(--shadow-md, 0 4px 16px rgba(0,0,0,.12));
}
:root[data-theme="dark"] { color-scheme: dark; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; }
body { font: var(--t-sm)/1.6 var(--sans); color: var(--ink); background: transparent; }
body[data-mode="fullscreen"] { background: var(--bg); }
button, input { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.mono { font-family: var(--mono); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
`;

const PAGE_CSS = `
#app { container-type: inline-size; }
body[data-mode="fullscreen"] #app { max-width: 56rem; margin: 0 auto; padding: 32px 20px; }
/* 設定の面は banto が枠を描く——枠の内側に余白を取る（Skill の置き場の面と同じ 12px） */
body[data-surface="config"] #app { padding: 12px; }
.stack { display: flex; flex-direction: column; gap: 20px; }

/* ---- 上：題・説明・入口 ---- */
.head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 12px 16px; }
.title { margin: 0; font-size: var(--h-sm); font-weight: 600; line-height: 1.4; }
body[data-surface="config"] .title { font-size: var(--t-md); }
.lead { margin: 4px 0 0; color: var(--ink-2); font-size: var(--t-md); }
.lead .mono { font-size: var(--t-sm); }
.lead .aside { color: var(--ink-3); }

.btn {
  display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; white-space: nowrap;
  border-radius: var(--r-md); border: 1px solid var(--line-2); background: var(--bg); color: var(--ink);
  font-size: var(--t-sm); cursor: pointer;
}
.btn.small { height: 28px; padding: 0 10px; }
.btn:hover:not(:disabled) { background: var(--bg-3); }
.btn:disabled { opacity: .5; cursor: default; }
.btn.primary { background: var(--ink); color: var(--bg); border-color: var(--ink); }
.btn.primary:hover:not(:disabled) { opacity: .88; background: var(--ink); }
.btn.ghost { border-color: transparent; background: transparent; }
.link {
  border: 0; background: none; padding: 0; cursor: pointer; color: var(--ink); font-weight: 500;
  text-decoration: underline; text-decoration-color: var(--line-2); text-underline-offset: 2px;
}
.link:hover { text-decoration-color: currentColor; }
.icon { width: 14px; height: 14px; flex: none; }

/* ---- 絞り込みと検索 ---- */
.tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.pills { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.pill {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 999px;
  border: 1px solid var(--line); background: transparent; cursor: pointer; font-size: var(--t-sm); color: var(--ink-2);
}
.pill[aria-pressed="true"] { border-color: var(--ink); color: var(--ink); font-weight: 600; }
.pill .count { font-weight: 400; color: var(--ink-3); font-variant-numeric: tabular-nums; }
.search { position: relative; margin-left: auto; width: 100%; }
@container (min-width: 28rem) { .search { width: 12rem; } }
.search input, .field input {
  width: 100%; height: 32px; padding: 0 10px; border-radius: var(--r-md); border: 1px solid var(--line-2);
  background: var(--bg); font-size: var(--t-sm);
}

/* ---- 表（2つの節、列はそろえる。狭い幅は行ごとに縦に積む） ---- */
.groups { display: flex; flex-direction: column; gap: 32px; }
.group h3 { margin: 0 0 8px; display: flex; align-items: baseline; gap: 8px; font-size: var(--t-md); font-weight: 600; }
.group h3 .count { font-size: var(--t-xs); font-weight: 400; color: var(--ink-3); font-variant-numeric: tabular-nums; }
table { width: 100%; border-collapse: collapse; font-size: var(--t-xs); display: block; border-top: 1px solid var(--ink-3); }
thead { display: none; }
tbody { display: block; }
tr.repo {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 12px; padding: 12px 0;
  border-bottom: 1px solid var(--line); transition: background-color .7s;
}
tr.repo[data-highlighted] { background: var(--bg-2); }
@media (prefers-reduced-motion: reduce) { tr.repo { transition: none; } }
td { vertical-align: top; min-width: 0; padding: 0; }
td.main { grid-column: 1; grid-row: 1; }
td.menu { grid-column: 2; grid-row: 1; }
td.cell { grid-column: 1 / span 2; display: grid; grid-template-columns: 4.5rem minmax(0, 1fr); gap: 0 12px; }
td.cell[data-empty] { display: none; }
td.cell > .label { color: var(--ink-3); }
@container (min-width: 42rem) {
  table { display: table; table-layout: fixed; border-top: 0; }
  thead { display: table-header-group; }
  tbody { display: table-row-group; }
  th { text-align: left; color: var(--ink-3); font-weight: 500; padding: 8px 16px 8px 0; border-bottom: 1px solid var(--ink-3); }
  tr.repo { display: table-row; }
  td { display: table-cell; padding: 12px 16px 12px 0; }
  td.cell, td.cell[data-empty] { display: table-cell; }
  td.cell > .label { display: none; }
  td.menu { padding: 8px 0; }
  col.c-remote { width: 13rem; } col.c-account { width: 5rem; } col.c-project { width: 11rem; } col.c-menu { width: 2.5rem; }
}
.name { margin: 0; font-size: var(--t-md); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.path { margin: 0; color: var(--ink-3); font-family: var(--mono); word-break: break-all; }
.muted { color: var(--ink-3); }
.ink2 { color: var(--ink-2); }
.wrap-slash { overflow-wrap: anywhere; }
.flag {
  display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px; border-radius: var(--r-sm); font-weight: 500; color: var(--ink);
}
.flag.stop { background: var(--danger-soft); } .flag.stop .icon { color: var(--danger); }
.flag.warn { background: var(--warn-soft); } .flag.warn .icon { color: var(--warn); }
.under { margin-top: 6px; display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
.row-line { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; }
.note { margin: 4px 0 0; color: var(--ink-2); }
.notyet { margin: 4px 0 0; color: var(--ink-2); font-size: var(--t-xs); max-width: 40ch; }
.corrected { margin-top: 6px; display: flex; align-items: flex-start; gap: 4px; color: var(--ink-2); }
.x { border: 0; background: none; cursor: pointer; color: var(--ink-3); width: 20px; height: 20px; border-radius: var(--r-sm); line-height: 1; }
.x:hover { background: var(--bg-3); color: var(--ink); }
.proj { display: flex; flex-direction: column; line-height: 1.3; }
.proj .closed { color: var(--ink-3); }
.start {
  display: inline-flex; align-items: center; gap: 8px; border: 0; background: none; cursor: pointer; padding: 0 8px 0 0;
  color: var(--ink-3); font-size: var(--t-sm);
}
.start:hover { color: var(--ink); }
.start .plus { width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; border: 1px dashed var(--line-2); border-radius: var(--r-md); }

/* ---- 行の「…」 ---- */
.menu-wrap { position: relative; display: flex; justify-content: flex-end; }
.dots { width: 32px; height: 32px; border: 0; background: none; border-radius: var(--r-md); cursor: pointer; color: var(--ink-3); }
.dots:hover, .dots[aria-expanded="true"] { background: var(--bg-3); color: var(--ink); }
.popover {
  position: absolute; right: 0; top: 34px; z-index: 5; width: 18rem; padding: 4px; border-radius: var(--r-md);
  border: 1px solid var(--line); background: var(--bg); box-shadow: var(--shadow);
}
.popover button {
  display: flex; width: 100%; gap: 8px; align-items: flex-start; text-align: left; padding: 8px; border: 0; border-radius: var(--r-sm);
  background: none; cursor: pointer;
}
.popover button:hover, .popover button:focus-visible { background: var(--bg-3); }
.popover .t { font-weight: 500; font-size: var(--t-sm); }
.popover .d { display: flex; flex-direction: column; gap: 2px; font-size: var(--t-xs); color: var(--ink-3); }
.popover .d .lead2 { color: var(--ink-2); }

/* ---- 空・失敗・お知らせ ---- */
.empty { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; padding: 20px 16px; border: 1px dashed var(--line-2); border-radius: var(--r-md); color: var(--ink-2); font-size: var(--t-md); }
.empty p { margin: 0; }
.empty .hint { color: var(--ink-3); font-size: var(--t-sm); }
.none { padding: 24px 0; color: var(--ink-2); font-size: var(--t-md); }
.none p { margin: 0 0 8px; }
.error { margin: 0; padding: 8px 12px; border-radius: var(--r-md); background: var(--danger-soft); color: var(--ink); }
.status {
  position: sticky; bottom: 12px; display: flex; align-items: center; gap: 12px; margin-top: 16px; padding: 8px 12px;
  border-radius: var(--r-md); background: var(--ink); color: var(--bg); font-size: var(--t-sm); box-shadow: var(--shadow);
}
/* 設定の面は中身の高さまで伸びる——下に貼り付けると入力欄に重なるので、流れの中に置く */
body[data-surface="config"] .status { position: static; }
.status .btn { height: 26px; background: transparent; color: var(--bg); border-color: color-mix(in srgb, var(--bg) 40%, transparent); }

/* ---- 既定の置き場（設定の面） ---- */
.home { display: flex; flex-direction: column; gap: 6px; padding: 12px; border: 1px solid var(--line); border-radius: var(--r-md); }
.home label { font-size: var(--t-sm); font-weight: 500; }
.home .line { display: flex; gap: 6px; }
.home .line input {
  flex: 1; min-width: 0; height: 32px; padding: 0 10px; border-radius: var(--r-md); border: 1px solid var(--line-2);
  background: var(--bg); font-family: var(--mono); font-size: var(--t-sm);
}
.home p { margin: 0; color: var(--ink-3); font-size: var(--t-xs); }
.home .stopline { color: var(--danger); }

/* ---- ダイアログ（Import・置き場を選ぶ） ---- */
dialog {
  width: min(34rem, calc(100vw - 24px)); padding: 0; border: 1px solid var(--line); border-radius: var(--r-md);
  background: var(--bg); color: var(--ink); box-shadow: var(--shadow);
}
dialog::backdrop { background: rgba(0,0,0,.35); }
.dlg { display: flex; flex-direction: column; gap: 12px; padding: 20px; }
.dlg h2 { margin: 0; font-size: var(--t-lg); font-weight: 600; }
.dlg .desc { margin: 2px 0 0; color: var(--ink-2); font-size: var(--t-sm); }
.nav { display: flex; gap: 6px; align-items: center; }
.nav input { flex: 1; min-width: 0; height: 32px; padding: 0 10px; border-radius: var(--r-md); border: 1px solid var(--line-2); background: var(--bg); font-family: var(--mono); font-size: var(--t-xs); }
.folders { max-height: 14rem; min-height: 6rem; overflow: auto; border: 1px solid var(--line); border-radius: var(--r-md); margin: 0; padding: 0; list-style: none; }
.folders button {
  display: flex; width: 100%; align-items: center; gap: 8px; padding: 6px 10px; border: 0; background: none; cursor: pointer;
  text-align: left; font-size: var(--t-xs); color: var(--ink-2);
}
.folders button:hover, .folders button:focus-visible { background: var(--bg-3); color: var(--ink); }
.folders .fname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.folders .mark { color: var(--ink-3); }
.folders .nothing { padding: 16px; text-align: center; color: var(--ink-3); font-size: var(--t-xs); }
.preview { border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; }
.preview .top { padding: 10px 12px; background: var(--bg-2); }
.preview .top .k { margin: 0; color: var(--ink-3); font-size: var(--t-xs); }
.preview .top .v { margin: 0; font-family: var(--mono); font-size: var(--t-md); word-break: break-all; }
.preview .say { display: flex; gap: 8px; align-items: flex-start; padding: 10px 12px; border-top: 1px solid var(--line); font-size: var(--t-xs); }
.preview .say[data-tone="ok"] { background: var(--ok-soft); }
.preview .say[data-tone="stop"] { background: var(--danger-soft); }
.preview .say .mk { flex: none; margin-top: 2px; }
.preview .say[data-tone="ok"] .mk { color: var(--ok); }
.preview .say[data-tone="stop"] .mk { color: var(--danger); }
.preview .say[data-tone="go"] .mk { color: var(--accent); }
.preview .say .body { display: flex; flex-direction: column; gap: 6px; min-width: 0; flex: 1; }
.preview .say p { margin: 0; }
.facts { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 2px 12px; margin: 0; color: var(--ink-2); }
.facts dt { color: var(--ink-3); } .facts dd { margin: 0; word-break: break-all; }
.foot { display: flex; justify-content: flex-end; gap: 8px; }

/* ---- GitHub のアカウント（設定の面） ---- */
.accts { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--line); border-radius: var(--r-md); }
.accts h3 { margin: 0; font-size: var(--t-sm); font-weight: 500; }
.accts .help { margin: 0; color: var(--ink-3); font-size: var(--t-xs); }
.accts ul.list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; }
.accts li.acct { display: flex; align-items: flex-start; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--line); }
.accts li.acct:last-child { border-bottom: 0; }
.mark {
  flex: none; width: 18px; height: 18px; margin-top: 1px; border-radius: 999px; background: var(--bg-3); color: var(--ink-2);
  display: inline-flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 600; text-transform: uppercase;
}
.acct .who { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.acct .login { font-size: var(--t-sm); font-weight: 500; }
.acct .sub { color: var(--ink-3); font-size: var(--t-xs); overflow-wrap: anywhere; }
.acct .acts { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
.okline { margin: 0; color: var(--ok); font-size: var(--t-xs); }
.stopline { margin: 0; color: var(--danger); font-size: var(--t-xs); }
.form { display: flex; flex-direction: column; gap: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
.form fieldset { margin: 0; padding: 0; border: 0; display: flex; flex-direction: column; gap: 6px; }
.form legend, .form .lbl { padding: 0; margin-bottom: 4px; font-size: var(--t-sm); font-weight: 500; }
.form .choice { display: flex; align-items: flex-start; gap: 8px; font-size: var(--t-sm); }
.form .choice input { margin-top: 3px; }
.form .choice[data-disabled] { color: var(--ink-3); }
.form .choice .d { display: block; color: var(--ink-3); font-size: var(--t-xs); }
.form input[type="password"], .form input[type="text"], .form select, .accts .client input {
  width: 100%; height: 32px; padding: 0 10px; border-radius: var(--r-md); border: 1px solid var(--line-2);
  background: var(--bg); color: var(--ink); font-family: var(--mono); font-size: var(--t-xs);
}
.form select { font-family: var(--sans); font-size: var(--t-sm); }
.steps { margin: 4px 0 0; padding-left: 1.4em; color: var(--ink-2); font-size: var(--t-xs); display: flex; flex-direction: column; gap: 2px; }
.device { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: var(--r-md); background: var(--bg-2); }
.device .code { font-family: var(--mono); font-size: 22px; font-weight: 600; letter-spacing: .12em; user-select: all; }
.device p { margin: 0; font-size: var(--t-sm); }
.device .muted { font-size: var(--t-xs); }
.accts .client { display: flex; flex-direction: column; gap: 6px; padding-top: 12px; border-top: 1px solid var(--line); }
.accts .client .line { display: flex; gap: 6px; }
.acct-cell { display: inline-flex; align-items: center; gap: 6px; }
`;

// 線の絵（lucide の形を写した。依存を足さない、規則10）
const ICONS: Record<string, string> = {
  folderX:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="m9.5 10.5 5 5"/><path d="m14.5 10.5-5 5"/>',
  hardDrive:
    '<line x1="22" x2="2" y1="12" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" x2="6.01" y1="16" y2="16"/><line x1="10" x2="10.01" y1="16" y2="16"/>',
  link: '<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  dots: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  listX: '<path d="M11 12H3"/><path d="M16 6H3"/><path d="M16 18H3"/><path d="m19 10-4 4"/><path d="m15 10 4 4"/>',
  folderInput:
    '<path d="M2 9V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1"/><path d="M2 13h10"/><path d="m9 16 3-3-3-3"/>',
  cloudUp: '<path d="M12 13v8"/><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="m8 17 4-4 4 4"/>',
  cloudDown: '<path d="M12 13v8l-4-4"/><path d="m12 21 4-4"/><path d="M4.393 15.269A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.436 8.284"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  up: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  circleCheck: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
};

const SCRIPT = String.raw`
(() => {
  const MODE = "__MODE__";
  const ICONS = __ICONS__;

  // ---- 親との話し方（MCP Apps） ----
  let nextId = 1;
  const waiting = new Map();
  const send = (m) => window.parent.postMessage(Object.assign({ jsonrpc: "2.0" }, m), "*");
  const request = (method, params) => {
    const id = nextId++;
    send({ id: id, method: method, params: params });
    return new Promise((resolve, reject) => waiting.set(id, { resolve: resolve, reject: reject }));
  };
  function applyAppearance(ctx) {
    if (!ctx) return;
    if (ctx.theme) document.documentElement.dataset.theme = ctx.theme;
    const vars = (ctx.styles && ctx.styles.variables) || {};
    for (const k of Object.keys(vars)) if (k.startsWith("--") && typeof vars[k] === "string") document.documentElement.style.setProperty(k, vars[k]);
  }
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;
    if (msg.id !== undefined && waiting.has(msg.id)) {
      const w = waiting.get(msg.id); waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error.message || "呼び出しに失敗しました")); else w.resolve(msg.result);
      return;
    }
    if (msg.method === "ui/notifications/host-context-changed") applyAppearance(msg.params);
  });
  async function call(name, args) {
    const r = await request("tools/call", { name: name, arguments: args || {} });
    const t = r && r.content && r.content[0] && r.content[0].text;
    if (!r || r.isError) throw new Error(t || name + " が失敗しました");
    return JSON.parse(t);
  }
  const reportSize = () => send({ method: "ui/notifications/size-changed", params: { height: document.documentElement.scrollHeight } });
  const errText = (e) => String(e && e.message ? e.message : e);

  // ---- 部品 ----
  function h(tag, attrs, children) {
    const e = document.createElement(tag);
    for (const k of Object.keys(attrs || {})) {
      const v = attrs[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === "text") e.textContent = v;
      else if (k === "onclick") e.addEventListener("click", v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children || []) if (c !== null && c !== undefined && c !== false) e.append(c);
    return e;
  }
  function icon(name) {
    const span = document.createElement("span");
    span.innerHTML = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + "</svg>";
    return span.firstChild;
  }
  /** コミット数は飾り——数えられなかったら、そう言う（理由は Module が添える） */
  function commitsText(x) {
    if (x.commits === undefined) return "コミット数を数えられませんでした" + (x.commitsProblem ? "（" + x.commitsProblem + "）" : "");
    return x.commits > 0 ? x.commits + " コミット" : "コミットなし";
  }
  /** owner/name を「/」の後で折れるように */
  function slashWrap(owner, name) {
    return h("span", { class: "mono wrap-slash" }, [owner + "/", h("wbr"), name]);
  }

  // ---- 状態 ----
  const app = document.getElementById("app");
  const state = {
    listing: null, loadError: null, home: null,
    filter: "all", query: "",
    highlight: null, menuFor: null,
    /** 押したが、まだ作っていない手（{ path, what }） */
    notYet: null,
    /** 外したあとのお知らせと「元に戻す」 */
    flash: null,
    homeDraft: null, homeError: null, homeBusy: false,
    /** GitHub のアカウント（設定の面だけ） */
    acct: {
      list: null, error: null,
      choices: null, choicesError: null,
      /** 登録の欄（{ method, patAlias, ssh, busy, error }）。貼った PAT は state に持たない——入力欄から直接読む */
      form: null,
      /** ブラウザでログインの途中（{ flowId, userCode, verificationUri, expiresAt, state, error, openError }） */
      login: null,
      clientDraft: null, clientError: null, clientBusy: false,
      /** 確かめた結果（login → { busy, ok, error }） */
      verify: {},
      /** 「外す」を押して確かめている login */
      removing: null, removeError: null,
    },
  };
  let flashTimer = 0;
  let highlightTimer = 0;

  const rows = () => (state.listing ? state.listing.rows : []);
  const isLocalOnly = (r) => r.state === "ok" && r.remote && r.remote.kind === "none";
  const needsHand = (r) => r.state !== "ok";
  function originText(r) {
    if (!r.remote) return "";
    if (r.remote.kind === "github") return r.remote.owner + "/" + r.remote.name;
    if (r.remote.kind === "elsewhere") return r.remote.url;
    return "";
  }
  function shownRows() {
    const q = state.query.trim().toLowerCase();
    return rows().filter((r) =>
      (state.filter === "all" || (state.filter === "local" ? isLocalOnly(r) : needsHand(r))) &&
      // 引くのは画面に出ている字だけ（名前・場所・owner/name）——見えていない絶対パスで当たると、なぜ残ったか分からない
      (q === "" || (r.name + " " + r.displayPath + " " + originText(r)).toLowerCase().includes(q)));
  }

  // ---- 描画 ----
  // 検索の欄は作り直さない（打っている途中で焦点が外れる）——表と札だけを描き直す
  let searchInput = null;
  function render() {
    const kids = [];
    kids.push(head());
    if (state.loadError) kids.push(h("p", { class: "error", role: "alert", text: state.loadError }));
    if (state.listing) {
      if (state.listing.projectsError) {
        kids.push(h("p", { class: "error", role: "alert", "data-testid": "repo-projects-error", text: "どの Project が使っているかを読めませんでした：" + state.listing.projectsError }));
      }
      if (rows().length === 0) kids.push(emptyLedger());
      else { kids.push(tools()); kids.push(body()); }
    } else if (!state.loadError) {
      kids.push(h("p", { class: "muted", text: "読んでいます…" }));
    }
    if (MODE === "config") { kids.push(homeSection()); kids.push(accountsSection()); }
    if (state.flash) kids.push(flashBar());
    const focused = document.activeElement === searchInput || (patInput && document.activeElement === patInput) ? document.activeElement : null;
    app.replaceChildren(h("div", { class: "stack", "data-testid": "repo-list-view" }, kids));
    if (focused && focused.isConnected) focused.focus();
    reportSize();
  }

  function head() {
    const home = state.home ? state.home.repoHome : "…";
    const lead = h("p", { class: "lead", "data-testid": "repo-list-lead" }, [
      "このマシンで扱うリポジトリ。clone・新しく作るものは ",
      h("span", { class: "mono", text: home }),
      " に置きます",
      MODE === "config"
        ? h("span", { class: "aside" }, ["（", h("button", { class: "link", type: "button", onclick: () => { const el = document.getElementById("repo-home"); if (el) { el.scrollIntoView({ block: "center" }); el.focus(); } }, text: "変える" }), "）"])
        // 入口からは設定の面へ移る口が無い（画面は banto の中を動かせない）——どこで変えるかを言う
        : h("span", { class: "aside", text: "（banto 全体の設定の Repositories で変えられます）" }),
    ]);
    return h("header", { class: "head" }, [
      h("div", {}, [h("h2", { class: "title", text: "リポジトリ" }), lead]),
      rows().length === 0 ? null : importButton("btn"),
    ]);
  }
  function importButton(cls) {
    return h("button", { class: cls, type: "button", "data-testid": "repo-import-open", onclick: () => openImport() }, [icon("folderInput"), "フォルダを Import"]);
  }

  function emptyLedger() {
    return h("div", { class: "empty", "data-testid": "repo-list-empty" }, [
      h("p", { text: "まだ知っているリポジトリがありません。" }),
      h("p", { class: "hint", text: "手元にあるリポジトリを、そのままの場所で一覧に足してください。フォルダは移しません。" }),
      importButton("btn small"),
    ]);
  }

  function tools() {
    const all = rows();
    const local = all.filter(isLocalOnly).length;
    const missing = all.filter(needsHand).length;
    if (state.filter === "missing" && missing === 0) state.filter = "all";
    const pill = (value, text, count) => h("button", {
      class: "pill", type: "button", "aria-pressed": String(state.filter === value), "data-filter": value,
      onclick: () => { state.filter = value; render(); },
    }, [text, h("span", { class: "count", text: String(count) })]);
    if (!searchInput) {
      searchInput = h("input", { type: "search", placeholder: "名前・場所で絞る", "aria-label": "名前・場所で絞る", "data-testid": "repo-search" });
      searchInput.addEventListener("input", () => { state.query = searchInput.value; render(); });
    }
    return h("div", { class: "tools" }, [
      h("div", { class: "pills", role: "group", "aria-label": "絞り込み", "data-testid": "repo-filter" }, [
        pill("all", "すべて", all.length),
        pill("local", "このマシンにだけ", local),
        // 見つからないものが無ければ札を出さない（いつも0の札は飾りになる）
        missing > 0 ? pill("missing", "見つからない", missing) : null,
      ]),
      h("div", { class: "search" }, [searchInput]),
    ]);
  }

  function body() {
    const shown = shownRows();
    if (shown.length === 0) {
      const q = state.query.trim();
      const message = q ? "「" + q + "」に当たるリポジトリはありません。"
        : state.filter === "missing" ? "フォルダが見つからないものはありません。"
        : "このマシンにだけあるものはありません。どれも GitHub かほかの場所にあります。";
      return h("div", { class: "none", "data-testid": "repo-list-none" }, [
        h("p", { text: message }),
        h("button", { class: "link", type: "button", text: "すべて表示する", onclick: () => { state.filter = "all"; state.query = ""; if (searchInput) searchInput.value = ""; render(); } }),
      ]);
    }
    const groups = state.listing.projectsError
      ? [{ id: "unknown", title: "リポジトリ", items: shown }]
      : [
          { id: "used", title: "Project で使っている", items: shown.filter((r) => r.section === "used") },
          { id: "unused", title: "Project はまだ無い", items: shown.filter((r) => r.section === "unused") },
        ];
    // 0件の節は見出しごと出さない
    return h("div", { class: "groups" }, groups.filter((g) => g.items.length > 0).map((g) =>
      h("section", { class: "group", "data-testid": "repo-group", "data-group": g.id, "aria-labelledby": "repo-group-" + g.id }, [
        h("h3", { id: "repo-group-" + g.id }, [g.title, h("span", { class: "count", text: g.items.length + " 件" })]),
        table("repo-group-" + g.id, g.items),
      ])));
  }

  function table(labelledBy, items) {
    return h("table", { "data-testid": "repo-table", "aria-labelledby": labelledBy }, [
      h("colgroup", {}, [h("col"), h("col", { class: "c-remote" }), h("col", { class: "c-account" }), h("col", { class: "c-project" }), h("col", { class: "c-menu" })]),
      h("thead", {}, [h("tr", {}, [
        h("th", { scope: "col", text: "リポジトリ" }), h("th", { scope: "col", text: "GitHub" }),
        h("th", { scope: "col", text: "アカウント" }), h("th", { scope: "col", text: "Project" }),
        h("th", { scope: "col" }, [h("span", { class: "sr-only", text: "操作" })]),
      ])]),
      h("tbody", {}, items.map(row)),
    ]);
  }

  function cell(label, testId, content) {
    const empty = content === null;
    return h("td", { class: "cell", "data-testid": testId, "data-empty": empty }, [
      h("span", { class: "label", "aria-hidden": "true", text: label }),
      empty ? h("span", { class: "muted", text: "—" }) : h("div", {}, [content]),
    ]);
  }

  function notYetNote(r, what) {
    if (!state.notYet || state.notYet.path !== r.path || state.notYet.what !== what) return null;
    const text = {
      start: "Project を始める手は、まだ作っていません。新しい Project の画面で、Root にこのフォルダ（" + r.displayPath + "）を選んでください。",
      publish: "GitHub に公開する手は、まだ作っていません。",
      reclone: "clone し直す手は、まだ作っていません。",
    }[what];
    return h("p", { class: "notyet", role: "status", "data-testid": "repo-not-yet", text: text });
  }
  function notYetButton(r, what, attrs, children) {
    attrs.onclick = () => { state.notYet = { path: r.path, what: what }; render(); };
    return h("button", attrs, children);
  }

  function row(r) {
    const tr = h("tr", {
      class: "repo", "data-testid": "repo-item", "data-repo-path": r.path, "data-state": r.state,
      "data-highlighted": state.highlight === r.path,
    }, [
      h("td", { class: "main" }, [
        h("p", { class: "name", text: r.name, title: r.name }),
        h("p", { class: "path", "data-testid": "repo-path", text: r.displayPath }),
        r.state === "ok" ? null : needsHandLine(r),
      ]),
      cell("GitHub", "repo-remote", remoteCell(r)),
      cell("アカウント", "repo-account", accountCell(r)),
      cell("Project", "repo-projects", projectCell(r)),
      h("td", { class: "menu" }, [rowMenu(r)]),
    ]);
    return tr;
  }

  /** フォルダが見つからない・リポジトリでなくなった・読めない——人の手が要る（塗る） */
  function needsHandLine(r) {
    const label = r.state === "missing" ? "フォルダが見つかりません" : r.state === "not-repo" ? "リポジトリではなくなっています" : "読めません";
    const kids = [h("span", { class: "flag stop", "data-testid": "repo-missing-flag" }, [icon("folderX"), label])];
    if (r.problem) kids.push(h("p", { class: "note", text: r.problem }));
    if (r.state === "missing" && r.remote && r.remote.kind !== "none") {
      // 覚えている場所がある——元の場所へ clone し直す（段階1ではまだ作っていない）
      kids.push(h("div", { class: "row-line" }, [
        notYetButton(r, "reclone", { class: "btn small", type: "button", "data-testid": "repo-reclone" }, [icon("cloudDown"), "clone し直す"]),
        h("span", { class: "muted", text: "元の場所に戻します" }),
      ]));
      kids.push(notYetNote(r, "reclone"));
    } else {
      kids.push(h("div", { class: "row-line" }, [
        h("button", { class: "btn small", type: "button", "data-testid": "repo-remove-inline", onclick: (e) => remove(r, e.currentTarget) }, [icon("listX"), "一覧から外す"]),
        r.state === "missing" ? h("button", { class: "link", type: "button", text: "移したなら、移した先を Import", onclick: () => openImport() }) : null,
      ]));
    }
    return h("div", { class: "under", "data-testid": "repo-missing" }, kids);
  }

  function remoteCell(r) {
    const remote = r.remote;
    if (r.state !== "ok") {
      if (!remote) return h("span", { class: "muted" }, [h("span", { text: "無い" }), h("br"), "戻す手はありません"]);
      if (remote.kind === "github") return h("span", { class: "proj" }, [slashWrap(remote.owner, remote.name), h("span", { class: "muted", text: "覚えている場所" })]);
      return h("span", { class: "proj" }, [h("span", { class: "ink2" }, [icon("link"), " GitHub の外"]), h("span", { class: "mono muted wrap-slash", text: remote.url }), h("span", { class: "muted", text: "覚えている場所" })]);
    }
    if (remote.kind === "none") {
      // この一覧で塗るのは、ここと「フォルダが見つかりません」の2つだけ。次の手（GitHub に公開）はすぐ下に
      return h("span", { class: "under", style: "margin-top:0" }, [
        h("span", { class: "flag warn", "data-testid": "repo-local-only" }, [icon("hardDrive"), "このマシンにだけ"]),
        h("span", { class: "row-line" }, [
          notYetButton(r, "publish", { class: "link", type: "button", "data-testid": "repo-publish-open" }, [icon("cloudUp"), " GitHub に公開"]),
          h("span", { class: "muted", "data-testid": "repo-commits", title: r.commitsProblem || null, text: "· " + commitsText(r) }),
        ]),
        notYetNote(r, "publish"),
      ]);
    }
    const corrected = r.correctedFrom ? h("div", { class: "corrected", "data-testid": "repo-corrected" }, [
      icon("history"),
      h("p", { style: "margin:0;flex:1;min-width:0" }, ["origin に合わせて直しました", h("span", { class: "muted", style: "display:block" }, ["前は ", slashWrap(r.correctedFrom.owner, r.correctedFrom.name)])]),
      h("button", { class: "x", type: "button", "aria-label": "お知らせを閉じる", title: "閉じる", "data-testid": "repo-corrected-dismiss", text: "×", onclick: () => dismiss(r) }),
    ]) : null;
    if (remote.kind === "elsewhere") {
      return h("span", { class: "proj" }, [h("span", { class: "ink2" }, [icon("link"), " GitHub の外"]), h("span", { class: "mono muted", text: remote.host }), corrected]);
    }
    return h("span", { class: "proj" }, [slashWrap(remote.owner, remote.name), corrected]);
  }

  /**
   * 扱うアカウント（GitHub のリポジトリだけ）。origin の持ち主と同じ login のアカウントが登録されていれば Module が
   * 台帳に覚える。無ければ「読むだけ」——登録は banto 全体の設定の Repositories で
   */
  function accountCell(r) {
    if (!r.remote || r.remote.kind !== "github") return null;
    if (r.account && r.account.registered) {
      return h("span", { class: "acct-cell" }, [h("span", { class: "mark", "aria-hidden": "true", text: r.account.login.slice(0, 1) }), h("span", { "data-testid": "repo-account-login", text: r.account.login })]);
    }
    if (r.account) {
      return h("span", { class: "proj", "data-testid": "repo-account-readonly" }, [
        h("span", { class: "muted", text: "読むだけ" }),
        h("span", { class: "muted", text: r.account.login + " は登録が外れています" }),
      ]);
    }
    return h("span", { class: "muted", "data-testid": "repo-account-readonly", title: r.remote.owner + " のアカウントが登録されていません（banto 全体の設定の Repositories で登録できます）", text: "読むだけ" });
  }

  function projectCell(r) {
    if (!r.projects) return null;
    if (r.projects.length > 0) {
      return h("div", { class: "proj", style: "gap:4px" }, r.projects.map((p) => h("span", { class: "proj", "data-testid": "repo-project" }, [
        h("span", { class: p.closed ? "closed" : "", text: p.name }),
        p.closed || p.viaWorktree ? h("span", { class: "muted", text: [p.closed ? "閉じた Project" : null, p.viaWorktree ? "worktree で" : null].filter(Boolean).join(" · ") }) : null,
      ])));
    }
    if (r.state !== "ok") return null;
    return h("div", {}, [
      notYetButton(r, "start", { class: "start", type: "button", "data-testid": "repo-start-project" }, [h("span", { class: "plus" }, [icon("plus")]), "Project を始める"]),
      notYetNote(r, "start"),
    ]);
  }

  // ---- 行の「…」（いまは「一覧から外す」だけ。押す前にフォルダは消えないことを言う） ----
  function rowMenu(r) {
    const open = state.menuFor === r.path;
    const btn = h("button", {
      class: "dots", type: "button", "data-testid": "repo-row-menu", "aria-label": r.name + " の操作",
      "aria-haspopup": "menu", "aria-expanded": String(open),
      onclick: (e) => { e.stopPropagation(); state.menuFor = open ? null : r.path; render(); },
    }, [icon("dots")]);
    if (!open) return h("div", { class: "menu-wrap" }, [btn]);
    const github = r.remote && r.remote.kind === "github" ? r.remote.owner + "/" + r.remote.name : null;
    const note = r.state === "missing"
      ? h("span", { class: "d", "data-testid": "repo-remove-note" }, ["一覧の記録だけを消します。" + (github ? "GitHub の " + github + " には触りません。" : "")])
      : h("span", { class: "d", "data-testid": "repo-remove-note" }, [
          h("span", { class: "lead2", text: "フォルダは消さず、そのまま残ります" }),
          h("span", { class: "mono", style: "word-break:break-all", text: r.displayPath }),
          r.projects && r.projects.length > 0 ? h("span", { text: "Project「" + r.projects.map((p) => p.name).join("」「") + "」もそのまま使えます" }) : null,
        ]);
    const item = h("button", { type: "button", role: "menuitem", "data-testid": "repo-remove", onclick: (e) => { e.stopPropagation(); remove(r, btn); } }, [
      icon("listX"), h("span", { style: "display:flex;flex-direction:column;gap:2px;min-width:0" }, [h("span", { class: "t", text: "一覧から外す" }), note]),
    ]);
    const pop = h("div", { class: "popover", role: "menu" }, [item]);
    queueMicrotask(() => item.focus());
    return h("div", { class: "menu-wrap" }, [btn, pop]);
  }
  document.addEventListener("click", () => { if (state.menuFor) { state.menuFor = null; render(); } });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.menuFor) {
      const path = state.menuFor; state.menuFor = null; render();
      const back = document.querySelector('[data-repo-path="' + CSS.escape(path) + '"] [data-testid="repo-row-menu"]');
      if (back) back.focus();
    }
  });

  // ---- 操作 ----
  async function load() {
    try {
      const [listing, home] = await Promise.all([call("list_repositories"), call("get_repository_settings")]);
      state.listing = listing; state.home = home; state.loadError = null;
    } catch (e) {
      state.loadError = "読み込めませんでした：" + errText(e);
    }
    render();
  }

  function setFlash(text, undo) {
    window.clearTimeout(flashTimer);
    state.flash = { text: text, undo: undo || null };
    flashTimer = window.setTimeout(() => { state.flash = null; render(); }, 10000);
  }
  function flashBar() {
    const f = state.flash;
    return h("div", { class: "status", role: "status", "aria-live": "polite", "data-testid": "repo-flash" }, [
      h("span", { style: "flex:1", text: f.text }),
      f.undo ? h("button", { class: "btn", type: "button", "data-testid": "repo-undo", text: "元に戻す", onclick: () => restore(f.undo) }) : null,
    ]);
  }

  function showRow(path) {
    window.clearTimeout(highlightTimer);
    state.highlight = path;
    render();
    const tr = document.querySelector('[data-repo-path="' + CSS.escape(path) + '"]');
    if (tr) tr.scrollIntoView({ block: "nearest" });
    highlightTimer = window.setTimeout(() => { state.highlight = null; render(); }, 2400);
  }

  async function remove(r, trigger) {
    // 行が消えると焦点の行き先が無くなる——次の行の「…」、無ければ前の行、それも無ければ「フォルダを Import」へ
    const menus = Array.from(document.querySelectorAll('[data-testid="repo-row-menu"]'));
    const own = trigger && trigger.closest("tr") ? trigger.closest("tr").querySelector('[data-testid="repo-row-menu"]') : null;
    const at = own ? menus.indexOf(own) : -1;
    const nextPath = at >= 0 ? ((menus[at + 1] || menus[at - 1]) || null) : null;
    const nextRowPath = nextPath && nextPath.closest("tr") ? nextPath.closest("tr").getAttribute("data-repo-path") : null;
    state.menuFor = null;
    try {
      const res = await call("remove_repository", { path: r.path });
      const kept = [
        r.state === "missing" ? null : "フォルダは " + r.displayPath + " のまま",
        r.projects && r.projects.length > 0 ? "Project「" + r.projects.map((p) => p.name).join("」「") + "」もそのまま" : null,
      ].filter(Boolean);
      setFlash(r.name + " を一覧から外しました" + (kept.length ? "（" + kept.join("・") + "です）" : ""), res.removed);
      await load();
      const next = nextRowPath ? document.querySelector('[data-repo-path="' + CSS.escape(nextRowPath) + '"] [data-testid="repo-row-menu"]') : null;
      (next || document.querySelector('[data-testid="repo-import-open"]') || document.body).focus();
    } catch (e) {
      setFlash("外せませんでした：" + errText(e));
      render();
    }
  }

  async function restore(entry) {
    try {
      await call("restore_repository", { entry: entry });
      window.clearTimeout(flashTimer); state.flash = null;
      await load();
      showRow(entry.path);
    } catch (e) {
      setFlash("元に戻せませんでした：" + errText(e));
      render();
    }
  }

  async function dismiss(r) {
    try { await call("dismiss_correction", { path: r.path }); await load(); }
    catch (e) { setFlash("閉じられませんでした：" + errText(e)); render(); }
  }

  // ---- 既定の置き場（設定の面） ----
  function homeSection() {
    const home = state.home;
    if (!home) return null;
    const value = state.homeDraft !== null ? state.homeDraft : home.repoHome;
    const changed = state.homeDraft !== null && state.homeDraft.trim().replace(/\/+$/, "") !== home.repoHome;
    const input = h("input", { id: "repo-home", type: "text", value: value, spellcheck: "false", "data-testid": "repo-home-input", "aria-describedby": "repo-home-help" });
    input.addEventListener("input", () => { state.homeDraft = input.value; state.homeError = null; renderKeepFocus(input); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveHome(); } });
    const shown = value.trim().replace(/\/+$/, "") || "~";
    return h("section", { class: "home", "data-testid": "repo-home-section" }, [
      h("label", { for: "repo-home", text: "既定の置き場" }),
      h("div", { class: "line" }, [
        input,
        h("button", { class: "btn", type: "button", text: "選ぶ", onclick: () => openPicker(value) }),
      ]),
      h("p", { id: "repo-home-help" }, [
        "clone・新しく作るリポジトリを、この下に ", h("span", { class: "mono", text: shown + "/<名前>" }), " で置きます。変えても、今あるフォルダは動かしません。",
        !changed && !home.exists ? " まだ無いフォルダなら、最初に使うときに作ります。" : "",
      ]),
      state.homeError ? h("p", { class: "stopline", role: "alert", "data-testid": "repo-home-error", text: state.homeError }) : null,
      changed || !home.isDefault ? h("div", { class: "row-line", style: "padding-top:4px" }, changed ? [
        h("button", { class: "btn small primary", type: "button", "data-testid": "repo-home-save", disabled: state.homeBusy, text: "変える", onclick: saveHome }),
        h("button", { class: "btn small ghost", type: "button", text: "やめる", onclick: () => { state.homeDraft = null; state.homeError = null; render(); } }),
      ] : [
        h("button", { class: "btn small ghost", type: "button", "data-testid": "repo-home-reset", text: "既定（" + home.defaultRepoHome + "）に戻す", onclick: () => saveHome(null) }),
      ]) : null,
    ]);
  }
  function renderKeepFocus(input) {
    const pos = input.selectionStart;
    render();
    const again = document.getElementById("repo-home");
    if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) {} }
  }
  async function saveHome(explicit) {
    const next = explicit === null ? null : state.homeDraft;
    if (explicit !== null && next === null) return;
    state.homeBusy = true; render();
    try {
      state.home = await call("set_repository_home", { repoHome: next });
      state.homeDraft = null; state.homeError = null;
      setFlash(next === null ? "既定の置き場を " + state.home.repoHome + " に戻しました" : "既定の置き場を " + state.home.repoHome + " にしました（今あるフォルダは動かしていません）");
    } catch (e) {
      state.homeError = errText(e);
    }
    state.homeBusy = false;
    render();
  }

  // ---- GitHub のアカウント（設定の面だけ。§2.4「アカウント」） ----
  // 貼った PAT の欄は作り直さない——描き直しで打った値が消えないように（値は state に写さない）
  let patInput = null;
  function patField() {
    if (!patInput) {
      patInput = h("input", { id: "gh-pat", type: "password", autocomplete: "off", spellcheck: "false", "data-testid": "gh-pat-input", "aria-describedby": "gh-pat-help" });
      patInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submitAccount(); } });
    }
    return patInput;
  }
  function clearPat() { if (patInput) patInput.value = ""; }

  async function loadAccounts() {
    try { state.acct.list = await call("list_github_accounts"); state.acct.error = null; }
    catch (e) { state.acct.error = "アカウントを読み込めませんでした：" + errText(e); }
    render();
  }
  async function loadChoices() {
    try { state.acct.choices = await call("list_credential_aliases"); state.acct.choicesError = null; }
    catch (e) { state.acct.choices = null; state.acct.choicesError = "Vault の一覧を読めませんでした：" + errText(e); }
    render();
  }
  const placeKey = (p) => p ? [p.implementation, p.group || "", p.name].join("|") : "";
  function placeFrom(list, key) { return (list || []).find((p) => placeKey(p) === key) || null; }
  function aliasLabel(p) { return "$" + p.name + "（" + p.implementation + (p.group ? " · " + p.group : "") + "）"; }

  function accountsSection() {
    const a = state.acct;
    const kids = [
      h("h3", { id: "gh-accounts-title", text: "GitHub のアカウント" }),
      h("p", { class: "help", text: "API の資格情報と SSH 鍵は Vault に預けます（ここには alias の名前だけを出します）。origin の持ち主と同じ login のアカウントで、そのリポジトリを扱います。" }),
    ];
    if (a.error) kids.push(h("p", { class: "error", role: "alert", text: a.error }));
    if (a.list) {
      kids.push(a.list.accounts.length === 0
        ? h("p", { class: "ink2", "data-testid": "gh-accounts-empty", style: "margin:0", text: "まだありません。登録すると、GitHub のリポジトリをそのアカウントで扱えます。" })
        : h("ul", { class: "list", "data-testid": "gh-accounts", "aria-labelledby": "gh-accounts-title" }, a.list.accounts.map(accountRow)));
    } else if (!a.error) kids.push(h("p", { class: "muted", style: "margin:0", text: "読んでいます…" }));
    if (a.login) kids.push(devicePanel());
    else if (a.form) kids.push(accountForm());
    else if (a.list) kids.push(h("div", {}, [h("button", { class: "btn small", type: "button", "data-testid": "gh-account-add", onclick: openAccountForm }, [icon("plus"), "アカウントを登録"])]));
    if (a.list) kids.push(clientSection());
    return h("section", { class: "accts", "data-testid": "gh-accounts-section", "aria-labelledby": "gh-accounts-title" }, kids);
  }

  function accountRow(acc) {
    const a = state.acct;
    const c = acc.credential;
    const cred = c.kind === "pat" ? ["PAT ", h("span", { class: "mono", text: aliasLabel(c.alias) })] : ["ブラウザでログイン（GitHub App）· ", h("span", { class: "mono", text: aliasLabel(c.alias) })];
    const ssh = acc.ssh ? ["SSH 鍵 ", h("span", { class: "mono", text: aliasLabel(acc.ssh) })] : ["SSH 鍵なし（HTTPS で clone・push）"];
    const v = a.verify[acc.login] || {};
    const confirming = a.removing === acc.login;
    const whoKids = [
      h("span", { class: "login", "data-testid": "gh-account-login", text: acc.login }),
      h("span", { class: "sub", "data-testid": "gh-account-credential" }, cred),
      h("span", { class: "sub", "data-testid": "gh-account-ssh" }, ssh),
    ];
    if (acc.refreshFailure) {
      whoKids.push(h("p", { class: "stopline", role: "alert", "data-testid": "gh-account-refresh-failure", text: "ログインを更新できませんでした：" + acc.refreshFailure.message }));
      whoKids.push(h("div", {}, [h("button", { class: "btn small", type: "button", "data-testid": "gh-account-relogin", onclick: () => startLogin(null) }, ["もう一度ブラウザでログイン"])]));
    }
    if (v.ok) whoKids.push(h("p", { class: "okline", role: "status", "data-testid": "gh-account-verified", text: v.ok }));
    if (v.error) whoKids.push(h("p", { class: "stopline", role: "alert", "data-testid": "gh-account-verify-error", text: v.error }));
    if (confirming) {
      whoKids.push(h("p", { class: "note", "data-testid": "gh-account-remove-note", text: c.kind === "app"
        ? "登録を外し、Vault に置いたログイン情報も消します（GitHub 側の許可は github.com の Settings → Applications で取り消せます）。"
        : "登録だけを外します。PAT は Vault に残ります（消すなら Vault の画面で）。" }));
      if (a.removeError) whoKids.push(h("p", { class: "stopline", role: "alert", text: a.removeError }));
    }
    const acts = confirming
      ? [
          h("button", { class: "btn small primary", type: "button", "data-testid": "gh-account-remove-confirm", text: "外す", onclick: () => removeAccount(acc) }),
          h("button", { class: "btn small ghost", type: "button", text: "やめる", onclick: () => { a.removing = null; a.removeError = null; render(); } }),
        ]
      : [
          h("button", { class: "btn small", type: "button", "data-testid": "gh-account-verify", disabled: v.busy, text: v.busy ? "確かめています…" : "確かめる", onclick: () => verifyAccount(acc) }),
          h("button", { class: "btn small ghost", type: "button", "data-testid": "gh-account-remove", "aria-label": acc.login + " を外す", text: "外す", onclick: () => { a.removing = acc.login; a.removeError = null; render(); } }),
        ];
    return h("li", { class: "acct", "data-testid": "gh-account", "data-login": acc.login }, [
      h("span", { class: "mark", "aria-hidden": "true", text: acc.login.slice(0, 1) }),
      h("div", { class: "who" }, whoKids),
      h("div", { class: "acts" }, acts),
    ]);
  }

  async function verifyAccount(acc) {
    state.acct.verify[acc.login] = { busy: true };
    render();
    try {
      const r = await call("verify_github_account", { login: acc.login });
      state.acct.verify[acc.login] = { ok: "GitHub に " + r.login + " として入れました" };
    } catch (e) {
      state.acct.verify[acc.login] = { error: errText(e) };
    }
    // 更新に失敗したら、その印は一覧の側に出る（読み直す）
    await loadAccounts();
  }

  async function removeAccount(acc) {
    try {
      const r = await call("remove_github_account", { login: acc.login });
      state.acct.removing = null; state.acct.removeError = null;
      delete state.acct.verify[acc.login];
      setFlash(acc.login + " の登録を外しました" + (r.loginRemoved ? "（Vault のログイン情報も消しました）" : acc.credential.kind === "pat" ? "（PAT は Vault に残しています）" : ""));
      await loadAccounts();
      await load();
    } catch (e) {
      state.acct.removeError = "外せませんでした：" + errText(e);
      render();
    }
  }

  function openAccountForm() {
    clearPat();
    const hasClient = !!(state.acct.list && state.acct.list.appClientId);
    state.acct.form = { method: hasClient ? "browser" : "paste", patAlias: "", ssh: "", busy: false, error: null };
    render();
    loadChoices();
  }

  function accountForm() {
    const a = state.acct;
    const f = a.form;
    const hasClient = !!(a.list && a.list.appClientId);
    const choice = (value, title, desc, disabled) => {
      const input = h("input", { type: "radio", name: "gh-method", value: value, checked: f.method === value, disabled: disabled, "data-testid": "gh-method-" + value });
      input.addEventListener("change", () => { f.method = value; f.error = null; render(); });
      return h("label", { class: "choice", "data-disabled": disabled }, [input, h("span", {}, [title, h("span", { class: "d", text: desc })])]);
    };
    const secrets = a.choices ? a.choices.secrets : [];
    const sshKeys = a.choices ? a.choices.sshKeys : [];
    const kids = [
      h("fieldset", {}, [
        h("legend", { text: "API の資格情報" }),
        choice("browser", "ブラウザでログイン（GitHub App）", hasClient ? "github.com で許可します。トークンは8時間で切れ、banto が自動で更新します" : "GitHub App の client ID を下で入れると選べます", !hasClient),
        choice("paste", "PAT を貼る", "fine-grained PAT。Vault に預けます", false),
        choice("alias", "Vault の alias を選ぶ", "Vault に前から預けてある PAT", false),
      ]),
    ];
    if (f.method === "paste") {
      kids.push(h("div", {}, [
        h("label", { class: "lbl", for: "gh-pat", text: "PAT" }),
        patField(),
        h("p", { id: "gh-pat-help", class: "help", style: "margin-top:4px", text: "GitHub に聞いて誰のものかを確かめてから、Vault に github-<login>-pat として預けます。値はここに戻しません。" }),
      ]));
    }
    if (f.method === "alias") {
      const sel = h("select", { id: "gh-pat-alias", "data-testid": "gh-pat-alias" }, [
        h("option", { value: "", text: secrets.length ? "選んでください" : "選べる alias がありません" }),
        ...secrets.map((p) => h("option", { value: placeKey(p), selected: f.patAlias === placeKey(p), text: aliasLabel(p) })),
      ]);
      sel.addEventListener("change", () => { f.patAlias = sel.value; f.error = null; render(); });
      kids.push(h("div", {}, [h("label", { class: "lbl", for: "gh-pat-alias", text: "PAT の alias" }), sel]));
    }
    const sshSel = h("select", { id: "gh-ssh", "data-testid": "gh-ssh" }, [
      ...sshKeys.map((p) => h("option", { value: placeKey(p), selected: f.ssh === placeKey(p), text: aliasLabel(p) })),
      h("option", { value: "", selected: f.ssh === "", text: "使わない（HTTPS で clone・push）" }),
    ]);
    sshSel.addEventListener("change", () => { f.ssh = sshSel.value; render(); });
    kids.push(h("div", {}, [h("label", { class: "lbl", for: "gh-ssh", text: "SSH 鍵" }), sshSel]));
    if (a.choicesError) kids.push(h("p", { class: "stopline", role: "alert", "data-testid": "gh-choices-error", text: a.choicesError }));
    if (f.error) kids.push(h("p", { class: "stopline", role: "alert", "data-testid": "gh-account-error", text: f.error }));
    const submitLabel = f.method === "browser" ? "ブラウザでログイン" : "登録する";
    kids.push(h("div", { class: "row-line" }, [
      h("button", { class: "btn small primary", type: "button", "data-testid": "gh-account-submit", disabled: f.busy || (f.method === "alias" && !f.patAlias), text: f.busy ? "確かめています…" : submitLabel, onclick: submitAccount }),
      h("button", { class: "btn small ghost", type: "button", text: "やめる", onclick: () => { clearPat(); state.acct.form = null; render(); } }),
    ]));
    return h("div", { class: "form", "data-testid": "gh-account-form" }, kids);
  }

  async function submitAccount() {
    const a = state.acct;
    const f = a.form;
    if (!f || f.busy) return;
    const ssh = placeFrom(a.choices && a.choices.sshKeys, f.ssh);
    if (f.method === "browser") { startLogin(ssh); return; }
    const args = {};
    if (f.method === "paste") {
      const pat = patInput ? patInput.value : "";
      if (!pat.trim()) { f.error = "PAT を貼ってください"; render(); return; }
      args.pat = pat;
    } else {
      const p = placeFrom(a.choices && a.choices.secrets, f.patAlias);
      if (!p) { f.error = "PAT の alias を選んでください"; render(); return; }
      args.patAlias = p;
    }
    if (ssh) args.ssh = ssh;
    f.busy = true; f.error = null; render();
    try {
      const added = await call("add_github_account_with_pat", args);
      clearPat();
      state.acct.form = null;
      setFlash(added.login + " を登録しました");
      await loadAccounts();
      await load();
    } catch (e) {
      f.busy = false; f.error = errText(e); render();
    }
  }

  // ---- ブラウザでログイン（デバイスフロー）。待つのは Module——画面は結果を聞き続けるだけ ----
  async function startLogin(ssh) {
    const a = state.acct;
    if (a.form) { a.form.busy = true; a.form.error = null; }
    render();
    try {
      const r = await call("start_github_login", ssh ? { ssh: ssh } : {});
      a.login = { flowId: r.flowId, userCode: r.userCode, verificationUri: r.verificationUri, expiresAt: r.expiresAt, state: "waiting", error: null, openError: null };
      if (a.form) a.form.busy = false;
      render();
      pollLogin(r.flowId);
    } catch (e) {
      if (a.form) { a.form.busy = false; a.form.error = "ログインを始められませんでした：" + errText(e); }
      else setFlash("ログインを始められませんでした：" + errText(e));
      render();
    }
  }
  async function pollLogin(flowId) {
    const a = state.acct;
    while (a.login && a.login.flowId === flowId && a.login.state === "waiting") {
      let r;
      try { r = await call("poll_github_login", { flowId: flowId }); }
      catch (e) {
        if (a.login && a.login.flowId === flowId) { a.login.state = "error"; a.login.error = errText(e); render(); }
        return;
      }
      if (!a.login || a.login.flowId !== flowId) return; // やめた
      if (r.state === "pending") { render(); continue; }
      if (r.state === "done") {
        a.login = null; a.form = null; clearPat();
        setFlash(r.relogin ? r.account.login + " のログインを新しくしました" : r.account.login + " をブラウザでログインして登録しました");
        await loadAccounts();
        await load();
        return;
      }
      a.login.state = r.state; render();
      return;
    }
  }
  function cancelLogin() {
    const l = state.acct.login;
    state.acct.login = null;
    render();
    if (l && l.state === "waiting") call("cancel_github_login", { flowId: l.flowId }).catch(() => {});
  }
  async function openDevicePage() {
    const l = state.acct.login;
    if (!l) return;
    try {
      const r = await request("ui/open-link", { url: l.verificationUri });
      if (r && r.isError) throw new Error("開けませんでした");
      l.openError = null;
    } catch (e) {
      l.openError = "開けませんでした。別のタブで " + l.verificationUri + " を開いてください";
    }
    render();
  }
  function devicePanel() {
    const l = state.acct.login;
    const kids = [];
    if (l.state === "waiting") {
      const mins = Math.max(0, Math.ceil((l.expiresAt - Date.now()) / 60000));
      kids.push(h("p", {}, [h("span", { class: "mono", text: l.verificationUri.replace(/^https?:\/\//, "") }), " を開いて、このコードを入れてください"]));
      kids.push(h("div", { class: "code", "data-testid": "gh-login-code", text: l.userCode }));
      kids.push(h("div", { class: "row-line" }, [
        h("button", { class: "btn small primary", type: "button", "data-testid": "gh-login-open", onclick: openDevicePage }, [l.verificationUri.replace(/^https?:\/\//, "") + " を開く"]),
        h("button", { class: "btn small ghost", type: "button", "data-testid": "gh-login-cancel", text: "やめる", onclick: cancelLogin }),
      ]));
      if (l.openError) kids.push(h("p", { class: "stopline", role: "alert", text: l.openError }));
      kids.push(h("p", { class: "muted", role: "status", "data-testid": "gh-login-status", text: "GitHub で許可されるのを待っています（このコードはあと " + mins + " 分で切れます）" }));
    } else {
      const text = l.state === "expired" ? "コードの期限が切れました。" : l.state === "denied" ? "GitHub で許可されませんでした。" : "ログインできませんでした：" + l.error;
      kids.push(h("p", { class: "stopline", role: "alert", "data-testid": "gh-login-ended", text: text }));
      kids.push(h("div", { class: "row-line" }, [
        h("button", { class: "btn small", type: "button", "data-testid": "gh-login-retry", text: "もう一度", onclick: () => { state.acct.login = null; startLogin(placeFrom(state.acct.choices && state.acct.choices.sshKeys, state.acct.form ? state.acct.form.ssh : "")); } }),
        h("button", { class: "btn small ghost", type: "button", text: "やめる", onclick: cancelLogin }),
      ]));
    }
    return h("div", { class: "device", "data-testid": "gh-login" }, kids);
  }

  // ---- GitHub App の client ID（秘密ではない。人が GitHub App を作って写す） ----
  function clientSection() {
    const a = state.acct;
    const current = a.list.appClientId || "";
    const value = a.clientDraft !== null ? a.clientDraft : current;
    const changed = a.clientDraft !== null && a.clientDraft.trim() !== current;
    const input = h("input", { id: "gh-client-id", type: "text", value: value, spellcheck: "false", placeholder: "Iv23li…", "data-testid": "gh-client-id" });
    input.addEventListener("input", () => { a.clientDraft = input.value; a.clientError = null; renderKeepFocusOn(input, "gh-client-id"); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveClientId(a.clientDraft); } });
    const kids = [
      h("label", { class: "lbl", for: "gh-client-id", style: "font-size:var(--t-sm);font-weight:500", text: "ブラウザでログインに使う GitHub App の client ID" }),
      h("div", { class: "line" }, [
        input,
        changed ? h("button", { class: "btn small primary", type: "button", "data-testid": "gh-client-id-save", disabled: a.clientBusy, text: "保存", onclick: () => saveClientId(a.clientDraft) }) : null,
        !changed && current ? h("button", { class: "btn small ghost", type: "button", "data-testid": "gh-client-id-clear", text: "消す", onclick: () => saveClientId(null) }) : null,
      ]),
    ];
    if (a.clientError) kids.push(h("p", { class: "stopline", role: "alert", "data-testid": "gh-client-id-error", text: a.clientError }));
    if (!current) {
      kids.push(h("ol", { class: "steps", "data-testid": "gh-client-id-steps" }, [
        h("li", { text: "GitHub の Settings → Developer settings → GitHub Apps → New GitHub App で App を作る（Callback URL と Webhook は要りません）" }),
        h("li", { text: "「Enable Device Flow」に印を入れる" }),
        h("li", { text: "作った App の Client ID（Iv で始まる）をここに写し、App を自分のアカウントに Install する" }),
      ]));
    }
    return h("div", { class: "client", "data-testid": "gh-client-section" }, kids);
  }
  function renderKeepFocusOn(input, id) {
    const pos = input.selectionStart;
    render();
    const again = document.getElementById(id);
    if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) {} }
  }
  async function saveClientId(next) {
    const a = state.acct;
    a.clientBusy = true; render();
    try {
      await call("set_github_app_client_id", { clientId: next === null ? null : next });
      a.clientDraft = null; a.clientError = null;
      setFlash(next === null ? "client ID を消しました（ブラウザでログインは選べなくなります）" : "client ID を保存しました");
      await loadAccounts();
    } catch (e) {
      a.clientError = errText(e);
    }
    a.clientBusy = false;
    render();
  }

  // ---- フォルダをたどるダイアログ（Import・置き場を選ぶ） ----
  const dialog = document.getElementById("dialog");
  const dlg = { kind: null, at: "~", listing: null, listError: null, inspection: null, inspectError: null, draft: null, busy: false, seq: 0 };
  dialog.addEventListener("close", () => {
    dlg.kind = null;
    // 中身も消す——開き直したときに前のフォルダの判断が一瞬見えないように（骨組みも作り直す）
    dialog.replaceChildren();
    dlgParts = null;
    delete dialog.dataset.focused;
    document.body.style.minHeight = "";
    reportSize();
  });

  /**
   * **設定の面に埋め込まれたときは、押したところの近くに出す**。面の iframe は中身の高さまで伸びるので、真ん中に
   * 出すと画面の外になりうる。押したボタンは見えているので、その近くに置き、足りない高さは iframe に言って伸ばす
   */
  function placeDialog(trigger) {
    if (document.body.dataset.mode === "fullscreen") return;
    const top = Math.max(8, (trigger ? trigger.getBoundingClientRect().top : 0) - 8);
    dialog.style.margin = "0 auto";
    dialog.style.top = top + "px";
    requestAnimationFrame(() => {
      document.body.style.minHeight = top + dialog.offsetHeight + 16 + "px";
      reportSize();
    });
  }
  function openDialog(kind, start) {
    state.menuFor = null;
    const trigger = document.activeElement;
    dlg.kind = kind; dlg.inspection = null; dlg.inspectError = null; dlg.listing = null; dlg.listError = null;
    go(start);
    if (!dialog.open) dialog.showModal();
    placeDialog(trigger);
  }
  function openImport() { openDialog("import", "~"); }
  function openPicker(start) { openDialog("pick", start || "~"); }

  async function go(path) {
    const seq = ++dlg.seq;
    dlg.at = path; dlg.draft = null; dlg.busy = true;
    renderDialog();
    const browse = call("browse_folders", { path: path }).then((l) => ({ ok: l }), (e) => ({ err: errText(e) }));
    const inspect = dlg.kind === "import" ? call("inspect_import", { path: path }).then((i) => ({ ok: i }), (e) => ({ err: errText(e) })) : Promise.resolve(null);
    const [b, i] = await Promise.all([browse, inspect]);
    if (seq !== dlg.seq) return; // 先に別のフォルダへ移った
    dlg.listing = b.ok || null; dlg.listError = b.err || null;
    if (b.ok) dlg.at = b.ok.displayPath;
    if (i) { dlg.inspection = i.ok || null; dlg.inspectError = i.err || null; if (i.ok) dlg.at = i.ok.displayPath; }
    // 無いパスでも、たどった先は打った字のまま見せる（次の手が「いちばん近い上へ」）
    if (!b.ok && i && i.ok) dlg.at = i.ok.displayPath;
    dlg.busy = false;
    renderDialog();
  }

  /**
   * **骨組みは開くときに1回だけ作る**（訂正・2026-10-02）。以前は描き直すたびに入力欄ごと作り直していたので、
   * 開いた直後の読み込みが返ったとき、打っている途中の欄が差し替わって字の位置がずれた（打った字の後ろに「~」が
   * 残る、E2E で 5 回に 1 回）。入力欄と「上へ」は同じものを使い続け、中身（一覧・判断・ボタン）だけを描き直す
   */
  let dlgParts = null;
  function buildDialog() {
    const path = h("input", { type: "text", spellcheck: "false", "aria-label": "フォルダのパス", "data-testid": "repo-import-path" });
    path.addEventListener("input", () => { dlg.draft = path.value; });
    path.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); if (dlg.draft !== null) go(dlg.draft); } });
    path.addEventListener("blur", () => { if (dlg.draft !== null && dlg.draft !== dlg.at) go(dlg.draft); });
    const up = h("button", { class: "btn small ghost", type: "button", onclick: () => { const p = dlg.listing && dlg.listing.parent; if (p) go(p.displayPath); } }, [icon("up"), "上へ"]);
    const parts = { title: h("h2"), desc: h("p", { class: "desc" }), up: up, path: path, list: h("div", { class: "folders" }), preview: h("div"), foot: h("div", { class: "foot" }) };
    parts.root = h("div", { class: "dlg" }, [h("div", {}, [parts.title, parts.desc]), h("div", { class: "nav" }, [up, path]), parts.list, parts.preview, parts.foot]);
    dialog.replaceChildren(parts.root);
    return parts;
  }
  function renderDialog() {
    if (!dlg.kind) return;
    if (!dlgParts) dlgParts = buildDialog();
    const p = dlgParts;
    const isImport = dlg.kind === "import";
    p.root.setAttribute("data-testid", isImport ? "repo-import-dialog" : "repo-pick-dialog");
    p.title.textContent = isImport ? "フォルダを Import" : "置き場を選ぶ";
    p.desc.textContent = isImport ? "手元のリポジトリを、今の場所のまま一覧に足します。フォルダは移しません。" : "clone・新しく作るリポジトリを、このフォルダの下に置きます。";
    p.up.disabled = !(dlg.listing && dlg.listing.parent);
    // 人が打っている途中の字は上書きしない。同じ値なら触らない（触ると選んでいる範囲・字の位置が消える）
    if (dlg.draft === null && p.path.value !== dlg.at) p.path.value = dlg.at;
    p.list.replaceChildren(dlg.listError
      ? h("div", { class: "nothing" }, [dlg.inspection && dlg.inspection.check.kind === "missing" ? "このフォルダはありません" : "読めませんでした：" + dlg.listError])
      : !dlg.listing ? h("div", { class: "nothing", text: "読んでいます…" })
      : dlg.listing.entries.length === 0 ? h("div", { class: "nothing", text: "この中にフォルダはありません" })
      : h("ul", { class: "folders", "aria-label": dlg.listing.displayPath + " の中のフォルダ", style: "border:0" }, dlg.listing.entries.map((e) => h("li", {}, [
          h("button", { type: "button", "data-testid": "repo-import-entry", "data-known": e.known, onclick: () => go(e.displayPath) }, [
            icon("folder"), h("span", { class: "fname", text: e.name }),
            e.known ? h("span", { class: "mark" }, [icon("check"), " 一覧にあります"]) : null,
            icon("chevron"),
          ]),
        ]))));
    p.preview.hidden = !isImport;
    p.preview.replaceChildren(...(isImport ? [importPreview()] : []));
    p.foot.replaceChildren(
      h("button", { class: "btn", type: "button", text: "やめる", onclick: () => dialog.close() }),
      isImport
        ? h("button", { class: "btn primary", type: "button", "data-testid": "repo-import-submit", disabled: dlg.busy || !dlg.inspection || dlg.inspection.check.kind !== "ready", text: "Import する", onclick: doImport })
        : h("button", { class: "btn primary", type: "button", "data-testid": "repo-pick-submit", disabled: dlg.busy || !dlg.listing, text: "このフォルダにする", onclick: () => { state.homeDraft = dlg.at; dialog.close(); render(); } }),
    );
    if (!dialog.dataset.focused) { p.path.focus(); dialog.dataset.focused = "1"; }
  }

  /** いま開いているフォルダを Import すると何が起きるか（判断は Module の inspectImport の1箇所） */
  function importPreview() {
    let tone = "plain", mark = "folder", message = "", detail = null, state_ = "loading";
    const ins = dlg.inspection;
    if (dlg.inspectError) { tone = "stop"; mark = "ban"; message = "読めませんでした：" + dlg.inspectError; state_ = "error"; }
    else if (!ins || dlg.busy) { message = "確かめています…"; }
    else {
      const c = ins.check; state_ = c.kind;
      if (c.kind === "ready") { tone = "ok"; mark = "circleCheck"; message = "git のリポジトリです。この場所のまま一覧に足します。"; detail = facts(c); }
      else if (c.kind === "known") { tone = "go"; mark = "arrow"; message = ins.name + " は、もう一覧にあります。"; detail = next("一覧で見る", () => { dialog.close(); showRow(ins.path); }, "repo-import-show"); }
      else if (c.kind === "worktree") {
        tone = c.mainKnown ? "go" : "stop"; mark = c.mainKnown ? "arrow" : "ban";
        message = "これは " + c.main.displayPath + " の worktree です。" + (c.mainKnown ? c.main.name + " は、もう一覧にあります。" : "Import できるのはリポジトリの本体だけです。");
        detail = c.mainKnown ? next("一覧で見る", () => { dialog.close(); showRow(c.main.path); }, "repo-import-show") : next(c.main.name + " を選ぶ", () => go(c.main.displayPath), "repo-import-go-main");
      }
      else if (c.kind === "inside") { tone = "stop"; mark = "ban"; message = c.top.name + " のリポジトリの中のフォルダです。Import できるのはリポジトリの一番上だけです。"; detail = next(c.top.name + " を選ぶ", () => go(c.top.displayPath), "repo-import-go-top"); }
      else if (c.kind === "not-git") {
        const inside = dlg.listing && dlg.listing.entries.length > 0;
        tone = inside ? "plain" : "stop"; mark = inside ? "folder" : "ban";
        message = inside ? "ここは git のリポジトリではありません。中のリポジトリを足すなら、上の一覧から1つずつ選んでください。" : "git のリポジトリではありません。Import できるのは git のリポジトリだけです。";
      }
      else if (c.kind === "bare") { tone = "stop"; mark = "ban"; message = "作業ツリーの無い（bare）リポジトリです。Import できるのは作業ツリーのあるリポジトリだけです。clone した作業ツリーを選んでください。"; }
      else if (c.kind === "git-dir") { tone = "stop"; mark = "ban"; message = "git の管理用のフォルダです。Import できるのは作業ツリーの一番上だけです。"; }
      else if (c.kind === "missing") { tone = "stop"; mark = "ban"; message = "このフォルダはありません。"; detail = next(c.nearest.displayPath + " へ", () => go(c.nearest.displayPath), "repo-import-go-nearest"); }
    }
    return h("section", { class: "preview", "data-testid": "repo-import-preview", "data-state": state_ }, [
      h("div", { class: "top" }, [h("p", { class: "k", text: "Import するフォルダ" }), h("p", { class: "v", text: ins ? ins.displayPath : dlg.at })]),
      h("div", { class: "say", "data-tone": tone, "aria-live": "polite" }, [
        h("span", { class: "mk" }, [icon(mark)]),
        h("div", { class: "body" }, [h("p", { "data-testid": "repo-import-message", text: message }), detail]),
      ]),
    ]);
  }
  function next(label, onclick, testId) {
    return h("button", { class: "btn small", type: "button", "data-testid": testId, onclick: onclick, style: "width:fit-content" }, [label, icon("arrow")]);
  }
  function facts(c) {
    const r = c.remote;
    const origin = r.kind === "github" ? "github.com/" + r.owner + "/" + r.name : r.kind === "elsewhere" ? r.host + "（GitHub の外）" : "無し——このマシンにだけあります";
    const rows_ = [["origin", origin], ["ブランチ", (c.branch || "（ブランチなし）") + " · " + commitsText(c)]];
    if (r.kind === "github") rows_.push(["アカウント", c.account ? c.account + " で扱います" : r.owner + " のアカウントが登録されていないので、読むだけです（push はできません）"]);
    return h("dl", { class: "facts", "data-testid": "repo-import-facts" }, rows_.flatMap((x) => [h("dt", { text: x[0] }), h("dd", { class: x[0] === "origin" ? "mono" : "", text: x[1] })]));
  }
  async function doImport() {
    const ins = dlg.inspection;
    if (!ins || ins.check.kind !== "ready") return;
    dlg.busy = true; renderDialog();
    try {
      const added = await call("import_repository", { path: ins.path });
      dialog.close();
      setFlash(added.name + " を一覧に足しました（フォルダは " + added.displayPath + " のまま）");
      await load();
      showRow(added.path);
    } catch (e) {
      dlg.busy = false; dlg.inspectError = errText(e); renderDialog();
    }
  }

  // ---- 始める ----
  (async () => {
    try {
      const init = await request("ui/initialize", {
        protocolVersion: "2026-01-26",
        appInfo: { name: "banto-repositories", version: "0.1.0" },
        appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
      });
      const ctx = (init && init.hostContext) || {};
      applyAppearance(ctx);
      document.body.dataset.mode = ctx.displayMode === "fullscreen" ? "fullscreen" : "inline";
      document.body.dataset.surface = MODE;
      send({ method: "ui/notifications/initialized", params: {} });
    } catch (e) {
      app.textContent = "画面を始められませんでした：" + errText(e);
      return;
    }
    render();
    await Promise.all([load(), MODE === "config" ? loadAccounts() : null]);
  })();
})();
`;

export function repositoriesAppHtml(mode: "launcher" | "config"): string {
  // 置き換えは関数で（文字列で渡すと `$&` などが特別な意味を持つ）
  const script = SCRIPT.replace("__MODE__", () => mode).replace("__ICONS__", () => JSON.stringify(ICONS));
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>${THEME_CSS}${PAGE_CSS}</style>
</head>
<body>
<main id="app"></main>
<dialog id="dialog" aria-label="フォルダを選ぶ"></dialog>
<script>${script}</script>
</body>
</html>
`;
}
