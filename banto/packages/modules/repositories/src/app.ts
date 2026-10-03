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
/** core の新しい Project の画面に差し出す始め方（段階4）——clone・新しいリポジトリ */
export const PREPARE_CLONE_URI = "ui://banto-repositories/prepare-clone";
export const PREPARE_CREATE_URI = "ui://banto-repositories/prepare-create";

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
/* ---- このマシンから削除 ---- */
.losses ul { margin: 4px 0 0; padding-left: 1.2em; display: flex; flex-direction: column; gap: 2px; font-size: var(--t-sm); }
.btn.primary.danger { background: var(--danger); border-color: var(--danger); color: var(--bg); }
/* 差し出す面（core の新しい Project の画面の枠の中）——余白は枠の側が持つ */
.prep-body { padding: 0; }

/* ---- URL から clone・新しいリポジトリ（帯はモックの repo-root-preview と同じ形） ---- */
.band .pathrow { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; font-family: var(--mono); font-size: var(--t-lg); }
.band .pathrow .prefix { color: var(--ink-3); word-break: break-all; }
.band .pathrow input { flex: 1; min-width: 8rem; height: 30px; padding: 0 6px; border-radius: var(--r-sm); border: 1px solid var(--line-2); background: var(--bg); color: var(--ink); font: inherit; font-weight: 500; }
.band .v { font-size: var(--t-lg) !important; }
.dlg .field { display: flex; flex-direction: column; gap: 4px; }
.dlg .field input { height: 32px; padding: 0 10px; border-radius: var(--r-md); border: 1px solid var(--line-2); background: var(--bg); color: var(--ink); font-family: var(--mono); font-size: var(--t-xs); }
.dlg .lbl { font-size: var(--t-sm); font-weight: 500; }
.dlg .help { margin: 0; color: var(--ink-3); font-size: var(--t-xs); }
.warnline { margin: 0; color: var(--ink-2); font-size: var(--t-xs); padding: 6px 8px; border-radius: var(--r-sm); background: var(--warn-soft); }
.projopt { display: flex; align-items: flex-start; gap: 8px; padding-top: 12px; border-top: 1px solid var(--line); }
.projopt input { margin-top: 3px; }
.projopt .t { display: block; font-size: var(--t-sm); font-weight: 500; }
.projopt .d { display: block; font-size: var(--t-xs); color: var(--ink-3); }

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
  /** core の新しい Project の画面に差し出す始め方の面（段階4）——一覧は出さず、clone・新しいリポジトリの本体だけ */
  const PREPARE = MODE === "prepare-clone" || MODE === "prepare-create";
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
  /** 子を入れ替える——**出さないもの（null・false）は飛ばす**（replaceChildren に渡すと「null」という字になる） */
  function fill(el, ...kids) {
    el.replaceChildren(...kids.filter((k) => k !== null && k !== undefined && k !== false));
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
    // 差し出す面は一覧を持たない（中身は clone・新しいリポジトリの本体だけ）
    if (PREPARE) { reportSize(); return; }
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
      rows().length === 0 ? null : h("div", { class: "row-line" }, [importButton("btn"), cloneButton("btn"), createButton("btn")]),
    ]);
  }
  function cloneButton(cls) {
    return h("button", { class: cls, type: "button", "data-testid": "repo-clone-open", onclick: () => openClone("") }, [icon("cloudDown"), "URL から clone"]);
  }
  function createButton(cls) {
    return h("button", { class: cls, type: "button", "data-testid": "repo-create-open", onclick: () => openCreate("") }, [icon("plus"), "新しいリポジトリ"]);
  }
  function importButton(cls) {
    return h("button", { class: cls, type: "button", "data-testid": "repo-import-open", onclick: () => openImport() }, [icon("folderInput"), "フォルダを Import"]);
  }

  function emptyLedger() {
    return h("div", { class: "empty", "data-testid": "repo-list-empty" }, [
      h("p", { text: "まだ知っているリポジトリがありません。" }),
      h("p", { class: "hint", text: "手元にあるリポジトリを、そのままの場所で一覧に足すか、URL から clone・新しく作ってください。" }),
      h("div", { class: "row-line" }, [importButton("btn small"), cloneButton("btn small"), createButton("btn small")]),
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
      publish: "GitHub に公開する手は、まだ作っていません。",
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
      // 覚えている場所がある——元の場所へ clone し直す（clone のダイアログが「ここに clone し直します」と言う）
      const source = r.remote.kind === "github" ? r.remote.owner + "/" + r.remote.name : r.remote.url;
      kids.push(h("div", { class: "row-line" }, [
        h("button", { class: "btn small", type: "button", "data-testid": "repo-reclone", onclick: () => openClone(source) }, [icon("cloudDown"), "clone し直す"]),
        h("span", { class: "muted", text: "元の場所に戻します" }),
      ]));
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
    // 新しい Project の画面を、このフォルダで開く（作るのは人がそこで押したとき）
    return h("div", {}, [
      h("button", { class: "start", type: "button", "data-testid": "repo-start-project", onclick: () => openNewProject(r.path, r.name) }, [h("span", { class: "plus" }, [icon("plus")]), "Project を始める"]),
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
    const items = [item];
    // 段階4：アカウントを選ぶ（GitHub のものだけ）・このマシンから削除（フォルダがあるものだけ）
    if (r.remote && r.remote.kind === "github") {
      items.push(h("button", { type: "button", role: "menuitem", "data-testid": "repo-account-choose", onclick: (e) => { e.stopPropagation(); openAccountChooser(r); } }, [
        icon("link"), h("span", { style: "display:flex;flex-direction:column;gap:2px;min-width:0" }, [h("span", { class: "t", text: "アカウントを選ぶ" }), h("span", { class: "d", text: r.account && r.account.registered ? "いまは " + r.account.login + " で扱っています" : "いまは読むだけです" })]),
      ]));
    }
    if (r.state !== "missing") {
      items.push(h("button", { type: "button", role: "menuitem", "data-testid": "repo-delete-open", onclick: (e) => { e.stopPropagation(); openDelete(r); } }, [
        icon("folderX"), h("span", { style: "display:flex;flex-direction:column;gap:2px;min-width:0" }, [h("span", { class: "t", text: "このマシンから削除" }), h("span", { class: "d", text: "フォルダごと消します。先に、失われるものを調べます" })]),
      ]));
    }
    const pop = h("div", { class: "popover", role: "menu" }, items);
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
    // Vault の目録を読み終えたか（読み終える前の「選べる alias がありません」と、本当に無いのを分ける印）
    return h("div", { class: "form", "data-testid": "gh-account-form", "data-choices": a.choices ? "loaded" : a.choicesError ? "error" : "loading" }, kids);
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


  // ---- 新しい Project の画面を開く（banto の拡張 「dev.banto/open-new-project」。作るのは人がそこで押したとき） ----
  async function openNewProject(folder, name) {
    try {
      await request("dev.banto/open-new-project", { folder: folder, name: name });
    } catch (e) {
      setFlash("新しい Project の画面を開けませんでした：" + errText(e) + "（新しい Project の画面で、Root に " + folder + " を選んでください）");
      render();
    }
  }

  // ---- 帯（置く場所と、そこで何が起きるか。モックの repo-root-preview と同じ言い方） ----
  /** 置き場の下の名前の欄だけが打てる帯。欄は作り直さない（打っている途中の字を守る） */
  function makeBand(prefix, input, testIdBase) {
    const fixed = h("p", { class: "v", "data-testid": testIdBase + "-path" });
    const editable = h("div", { class: "pathrow" }, [h("span", { class: "prefix" }), input]);
    const say = h("div", { class: "say", "aria-live": "polite" });
    const root = h("section", { class: "preview band", "data-testid": testIdBase }, [h("div", { class: "top" }, [fixed, editable]), say]);
    return { root: root, fixed: fixed, editable: editable, prefix: editable.firstChild, say: say };
  }
  /** 帯の中身を描く——path を出すか（固定）・欄を出すか、言うこと・次の手 */
  function paintBand(band, o) {
    band.root.setAttribute("data-state", o.state || "");
    band.fixed.hidden = !o.fixedPath; band.editable.hidden = !!o.fixedPath;
    if (o.fixedPath) band.fixed.textContent = o.fixedPath;
    else band.prefix.textContent = o.home + "/";
    band.say.setAttribute("data-tone", o.tone || "plain");
    band.say.replaceChildren(
      h("span", { class: "mk" }, [icon(o.mark || "folder")]),
      h("div", { class: "body" }, [h("p", { "data-testid": "repo-band-message", text: o.message }), ...(o.next ? [h("div", { class: "row-line" }, o.next)] : [])]),
    );
  }
  /** 置く先の状態の言い方（clone と新しいリポジトリで共通。verb は「clone」「作成」） */
  function targetSay(t, verb, rename, useHere) {
    const st = t.state;
    const renameBtn = st.suggestion ? next(st.suggestion + " にする", () => rename(st.suggestion), "repo-band-rename") : null;
    if (t.folderInvalid) return { tone: "stop", mark: "ban", message: "使えるのは英数字と - _ . だけです。" };
    switch (st.kind) {
      case "taken-repo": return { tone: "stop", mark: "ban", message: "ここには、もう " + st.name + " があります（一覧にあります）。上書きしないので、" + verb + "できません。", next: [renameBtn] };
      case "taken-missing": return { tone: "stop", mark: "ban", message: "ここは一覧にある " + st.name + " の場所です（フォルダは見つかりません）。一覧から外すまで、ここには" + verb + "しません。", next: [renameBtn] };
      case "taken-unknown-repo": return { tone: "stop", mark: "ban", message: "ここには、一覧にまだ無い git のリポジトリがあります。上書きしないので、" + verb + "できません。", next: [renameBtn, useHere ? next("このフォルダで Project を始める", () => useHere(t.path), "repo-band-use-here") : null] };
      case "taken-folder": return { tone: "stop", mark: "ban", message: "ここには git でないフォルダがあります（" + st.entries + " 項目）。上書きしないので、" + verb + "できません。", next: [renameBtn] };
      case "taken-cloning": return { tone: "stop", mark: "ban", message: "ここには、いま別の clone が置こうとしています。", next: [renameBtn] };
      default: return null;
    }
  }
  function projectOption(holder, testId, onChange) {
    const box = h("input", { type: "checkbox", "data-testid": testId, checked: true });
    // ボタンの言い方（「clone して Project の作成へ」）も変わるので描き直す
    box.addEventListener("change", () => { holder.withProject = box.checked; onChange(); });
    return { box: box, root: h("label", { class: "projopt", "data-testid": "repo-project-option" }, [box, h("span", {}, [h("span", { class: "t", text: "Project も作る" }), h("span", { class: "d", text: "用意できたら、新しい Project の画面をこのフォルダで開きます（名前はそこで決めます）" })])]) };
  }

  // ---- URL から clone（clone は Module の背景の仕事。画面は進み具合を聞きに行く） ----
  /**
   * 差し出す面では、ダイアログの代わりに画面そのものに置く（core の新しい Project の画面の枠の中）。
   * 開く・閉じるの口は同じ形にしておく——閉じたら、同じ面に始めから出し直す
   */
  const prepSurface = PREPARE ? (() => {
    const el = h("div", { class: "prep", "data-testid": "repo-prepare-surface" });
    el.showModal = () => {};
    el.close = () => { el.dispatchEvent(new Event("close")); };
    Object.defineProperty(el, "open", { get: () => el.childNodes.length > 0 });
    app.replaceChildren(el);
    return el;
  })() : null;
  /** 用意できたフォルダを core に返す（banto の拡張「dev.banto/folder-prepared」）。返ったあとは core の画面が先を出す */
  async function prepared(folder) {
    try {
      await request("dev.banto/folder-prepared", folder);
    } catch (e) {
      prepSurface.append(h("p", { class: "stopline", role: "alert", text: "新しい Project の画面に渡せませんでした：" + errText(e) }));
      reportSize();
    }
  }
  const cloneDialog = prepSurface || document.getElementById("clone-dialog");
  const cl = { open: false, folderDraft: null, inspection: null, error: null, seq: 0, timer: 0, account: undefined, job: null, withProject: true, starting: false };
  let clParts = null;
  cloneDialog.addEventListener("cancel", (e) => { if (cl.job && cl.job.state === "running") e.preventDefault(); });
  cloneDialog.addEventListener("close", () => { cl.open = false; clParts = null; cloneDialog.replaceChildren(); document.body.style.minHeight = ""; reportSize(); });
  function openClone(initial) {
    state.menuFor = null;
    const trigger = document.activeElement;
    // 差し出す面では Project は core が作る——「Project も作る」は持たない
    Object.assign(cl, { open: true, folderDraft: null, inspection: null, error: null, account: undefined, job: null, withProject: !PREPARE, starting: false });
    clParts = buildClone();
    clParts.url.value = initial || "";
    if (!cloneDialog.open) cloneDialog.showModal();
    placeDialog(trigger, cloneDialog);
    clParts.url.focus();
    if (initial) inspectClone(); else renderClone();
  }
  function buildClone() {
    const url = h("input", { type: "text", id: "repo-clone-url", spellcheck: "false", autocomplete: "off", placeholder: "https://github.com/owner/repo", "data-testid": "repo-clone-url", "aria-describedby": "repo-clone-help" });
    url.addEventListener("input", () => { cl.folderDraft = null; cl.account = undefined; cl.job = null; scheduleInspectClone(); });
    url.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); startClone(); } });
    const folder = h("input", { type: "text", spellcheck: "false", autocomplete: "off", "aria-label": "フォルダ名", "data-testid": "repo-clone-folder" });
    folder.addEventListener("input", () => { cl.folderDraft = folder.value.trim(); scheduleInspectClone(); });
    const band = makeBand("", folder, "repo-clone-band");
    const help = h("p", { id: "repo-clone-help", class: "help", "data-testid": "repo-clone-help" });
    const account = h("div", { "data-testid": "repo-clone-account" });
    const opt = projectOption(cl, "repo-clone-with-project", () => renderClone());
    const foot = h("div", { class: "foot" });
    const desc = h("p", { class: "desc" });
    // 差し出す面では題を持たない（core のタブが言う）。新しいリポジトリから来たなら、戻る口を置く
    const back = MODE === "prepare-create"
      ? h("button", { class: "link", type: "button", "data-testid": "repo-prepare-back", text: "← 新しく作るほうに戻る", onclick: () => { cloneDialog.close(); openCreate(""); } })
      : null;
    const root = h("div", { class: PREPARE ? "dlg prep-body" : "dlg", "data-testid": "repo-clone-dialog" }, [
      back,
      PREPARE ? desc : h("div", {}, [h("h2", { text: "URL から clone" }), desc]),
      h("div", { class: "field" }, [h("label", { for: "repo-clone-url", class: "lbl", text: "リポジトリの URL" }), url, help]),
      account, band.root, PREPARE ? null : opt.root, foot,
    ]);
    cloneDialog.replaceChildren(root);
    return { url: url, folder: folder, band: band, help: help, account: account, opt: opt, foot: foot, desc: desc };
  }
  function scheduleInspectClone() {
    window.clearTimeout(cl.timer);
    renderClone();
    cl.timer = window.setTimeout(inspectClone, 250);
  }
  async function inspectClone() {
    if (!clParts) return;
    const seq = ++cl.seq;
    const source = clParts.url.value.trim();
    if (!source) { cl.inspection = null; renderClone(); return; }
    try {
      const r = await call("inspect_clone", cl.folderDraft !== null ? { source: source, folder: cl.folderDraft } : { source: source });
      if (seq !== cl.seq) return;
      cl.inspection = r; cl.error = null;
    } catch (e) {
      if (seq !== cl.seq) return;
      cl.inspection = null; cl.error = errText(e);
    }
    renderClone();
  }
  function chosenAccount() {
    const a = cl.inspection && cl.inspection.accounts;
    if (!a) return undefined;
    if (cl.account !== undefined) return cl.account;
    return a.preselected || (a.logins.length > 0 ? a.logins[0] : null);
  }
  function renderClone() {
    if (!clParts) return;
    const p = clParts, ins = cl.inspection, job = cl.job;
    const running = job && job.state === "running";
    p.desc.textContent = (state.home ? state.home.repoHome : "置き場") + " に clone して、一覧に足します。";
    p.url.disabled = !!running; p.folder.disabled = !!running;
    // URL の下の1行：読めない・GitHub の外・例
    const typed = p.url.value.trim();
    p.help.replaceChildren(
      !typed ? "GitHub の URL か owner/repo。GitHub の外（gitlab.com など）の URL も使えます。"
      : ins && ins.invalid ? h("span", { "data-testid": "repo-clone-invalid", text: ins.invalid + "（https://github.com/owner/repo・git@github.com:owner/repo.git・owner/repo の形）" })
      : ins && ins.source && ins.source.kind === "elsewhere" ? h("span", { "data-testid": "repo-clone-elsewhere", text: "GitHub の外（" + ins.source.host + "）です。登録した GitHub のアカウントは使わず、このマシンの git の設定で clone します。" })
      : "");
    // アカウント（GitHub で、まだ手元に無いとき）
    const acc = ins && ins.accounts && !ins.have ? ins.accounts : null;
    if (!acc) p.account.replaceChildren();
    else if (acc.logins.length === 0) p.account.replaceChildren(h("p", { class: "help", "data-testid": "repo-clone-no-account", text: "GitHub のアカウントが登録されていません。公開のリポジトリだけ clone できます（banto 全体の設定の Repositories で登録できます）。" }));
    else if (acc.logins.length === 1) p.account.replaceChildren(h("p", { class: "help", "data-testid": "repo-clone-account-one" }, [h("span", { class: "mark", "aria-hidden": "true", text: acc.logins[0].slice(0, 1) }), " " + acc.logins[0] + " で clone します"]));
    else {
      const cur = chosenAccount();
      p.account.replaceChildren(h("div", { class: "pills", role: "radiogroup", "aria-label": "clone に使うアカウント" }, acc.logins.map((l) => h("button", {
        class: "pill", type: "button", role: "radio", "aria-checked": String(cur === l), "aria-pressed": String(cur === l), "data-testid": "repo-clone-account-pick", "data-login": l, disabled: !!running,
        onclick: () => { cl.account = l; cl.job = null; renderClone(); },
      }, [l]))));
    }
    // 帯
    let o;
    if (!ins || ins.invalid) o = { state: "empty", home: state.home ? state.home.repoHome : "~", tone: "plain", mark: "cloudDown", message: typed && ins && ins.invalid ? "URL として読めると、置く場所を出します。" : "URL を入れると、置く場所を出します。" };
    else if (ins.have) o = { state: "have", fixedPath: ins.have.displayPath, tone: "ok", mark: "circleCheck", message: "もう手元にあります（" + ins.source.label + "）。新しくは clone しません。" + (ins.have.projects && ins.have.projects.length ? "Project「" + ins.have.projects.join("」「") + "」が使っています。" : "") };
    else if (job && job.state === "running") o = { state: "cloning", fixedPath: job.displayPath, tone: "plain", mark: "cloudDown", message: "clone しています…" + (job.progress ? " " + job.progress.phase + (job.progress.percent !== undefined ? " " + job.progress.percent + "%" : "") : "") };
    else if (job && job.state === "failed") o = { state: "clone-failed", fixedPath: job.displayPath, tone: "stop", mark: "ban", message: "clone できませんでした：" + job.error.message, next: failedNext(job) };
    else if (ins.reclone) o = { state: "reclone", fixedPath: ins.reclone.displayPath, tone: "plain", mark: "cloudDown", message: "ここに clone し直します——一覧にありますが、フォルダが見つかりません。" };
    else {
      const t = ins.target;
      if (document.activeElement !== p.folder && cl.folderDraft === null) p.folder.value = t.folder;
      else if (document.activeElement !== p.folder && p.folder.value !== t.folder) p.folder.value = t.folder;
      const taken = targetSay(t, "clone", (name) => { cl.folderDraft = name; p.folder.value = name; inspectClone(); }, (path) => {
        if (PREPARE) { prepared({ path: path, suggestedName: t.folder, summary: path + " をそのまま使います（clone はしていません）" }); return; }
        cloneDialog.close(); openNewProject(path, t.folder);
      });
      o = taken ? Object.assign({ state: t.state.kind, home: t.home }, taken)
        : { state: "free", home: t.home, tone: "plain", mark: "cloudDown", message: t.renamedFrom ? "ここに clone します。" + t.home + "/" + t.renamedFrom + " は、もう使っているので " + t.folder + " にしました。" : "ここに clone します。" };
    }
    if (o.home === undefined && !o.fixedPath) o.home = state.home ? state.home.repoHome : "~";
    paintBand(p.band, o);
    if (cl.error) p.band.say.append(h("p", { class: "stopline", role: "alert", text: "確かめられませんでした：" + cl.error }));
    // 台帳はこのリポジトリを覚えているが、その場所にあるものが違う——clone し直さない（上書き・消すことになる）
    if (ins && ins.misplaced && !(job && job.state === "running")) {
      p.band.say.append(h("p", { class: "warnline", "data-testid": "repo-clone-misplaced", text: "一覧にある " + ins.misplaced.displayPath + " には" + ins.misplaced.problem + "。そこには clone し直さず、上の場所に別に clone します（一覧のその行は、外すか直してください）。" }));
    }
    // 「Project も作る」：clone するときだけ（もう手元にある・読めない URL では出さない）
    const canClone = ins && !ins.invalid && !ins.have && (ins.reclone || (ins.target && !ins.target.folderInvalid && ins.target.state.kind === "free"));
    p.opt.root.hidden = !canClone && !running;
    p.opt.box.disabled = !!running;
    const verb = cl.withProject ? (ins && ins.reclone ? "clone し直して Project の作成へ" : "clone して Project の作成へ") : (ins && ins.reclone ? "clone し直す" : "clone する");
    fill(p.foot,
      running
        ? h("button", { class: "btn", type: "button", "data-testid": "repo-clone-cancel", text: "clone をやめる", onclick: cancelClone })
        : PREPARE ? null : h("button", { class: "btn", type: "button", text: "やめる", onclick: () => cloneDialog.close() }),
      ins && ins.have
        ? (PREPARE
          ? h("button", { class: "btn primary", type: "button", "data-testid": "repo-clone-use-have", text: "この場所を使う", onclick: () => prepared({ path: ins.have.path, suggestedName: ins.have.name, summary: "もう手元にある " + ins.have.displayPath + " を使います（clone はしていません）" }) })
          : h("button", { class: "btn primary", type: "button", "data-testid": "repo-clone-show", text: "一覧で見る", onclick: () => { cloneDialog.close(); showRow(ins.have.path); } }))
        : h("button", { class: "btn primary", type: "button", "data-testid": "repo-clone-submit", disabled: !canClone || !!running || cl.starting, text: running ? "clone しています…" : (job && job.state === "failed" ? "もう一度 " : "") + verb, onclick: startClone }),
    );
    reportSize();
  }
  function failedNext(job) {
    const acc = cl.inspection && cl.inspection.accounts;
    const kids = [];
    if (acc && (job.error.hint === "auth" || job.error.hint === "not-found")) {
      for (const l of acc.logins) if (l !== job.account) kids.push(next(l + " で clone する", () => { cl.account = l; cl.job = null; startClone(); }, "repo-clone-switch-account"));
      kids.push(h("span", { class: "muted", text: acc.logins.length === 0 ? "非公開なら、読めるアカウントを banto 全体の設定の Repositories で登録してから、もう一度押してください。" : "どれでも読めないなら、読めるアカウントを登録してください。" }));
    } else if (cl.inspection && cl.inspection.source && cl.inspection.source.kind === "elsewhere") {
      kids.push(h("span", { class: "muted", text: "URL を確かめてください。非公開なら、このマシンの git（SSH の鍵など）で読めるようにしてから、もう一度押してください。" }));
    }
    return kids;
  }
  async function startClone() {
    const ins = cl.inspection;
    if (!clParts || !ins || ins.invalid || ins.have || cl.starting) return;
    cl.starting = true; renderClone();
    const args = { source: clParts.url.value.trim() };
    if (ins.target) args.folder = ins.target.folder;
    const account = chosenAccount();
    if (account !== undefined) args.account = account;
    try {
      cl.job = await call("start_clone", args);
      cl.starting = false;
      renderClone();
      pollClone(cl.job.id);
    } catch (e) {
      cl.starting = false;
      cl.job = { state: "failed", displayPath: ins.reclone ? ins.reclone.displayPath : ins.target.displayPath, error: { message: errText(e), hint: "other" } };
      renderClone();
    }
  }
  async function pollClone(id) {
    while (cl.open && cl.job && cl.job.id === id && cl.job.state === "running") {
      await new Promise((r) => setTimeout(r, 600));
      if (!cl.open || !cl.job || cl.job.id !== id) return;
      try { cl.job = await call("clone_status", { jobId: id }); }
      catch (e) { cl.job = Object.assign({}, cl.job, { state: "failed", error: { message: errText(e), hint: "other" } }); }
      renderClone();
    }
    const job = cl.job;
    if (!job || job.id !== id || job.state !== "done") return;
    if (PREPARE) {
      prepared({ path: job.path, suggestedName: job.suggestedName, summary: job.recloned ? job.label + " を " + job.displayPath + " に clone し直しました" : job.label + " を " + job.displayPath + " に clone しました" });
      return;
    }
    const withProject = cl.withProject;
    cloneDialog.close();
    const head = job.recloned ? job.label + " を " + job.displayPath + " に clone し直しました" : job.label + " を " + job.displayPath + " に clone しました";
    setFlash(withProject ? head + "。Project の作成に進みます" : job.recloned ? head : head + "。一覧に足しました");
    await load();
    showRow(job.path);
    if (withProject) openNewProject(job.path, job.suggestedName);
  }
  async function cancelClone() {
    if (!cl.job || !cl.job.id) return;
    try { cl.job = await call("cancel_clone", { jobId: cl.job.id }); } catch (e) { setFlash("やめられませんでした：" + errText(e)); }
    renderClone();
  }

  // ---- 新しいリポジトリ ----
  const createDialog = prepSurface || document.getElementById("create-dialog");
  const cr = { inspection: null, error: null, seq: 0, timer: 0, busy: false, withProject: true, failed: null, confirmedFor: null };
  let crParts = null;
  createDialog.addEventListener("close", () => { crParts = null; createDialog.replaceChildren(); document.body.style.minHeight = ""; reportSize(); });
  function openCreate(initial) {
    state.menuFor = null;
    const trigger = document.activeElement;
    Object.assign(cr, { inspection: null, error: null, busy: false, withProject: !PREPARE, failed: null, confirmedFor: null });
    const name = h("input", { type: "text", spellcheck: "false", autocomplete: "off", placeholder: "名前", "aria-label": "リポジトリ名（フォルダ名）", "data-testid": "repo-create-name" });
    name.value = initial || "";
    name.addEventListener("input", () => { cr.failed = null; cr.confirmedFor = null; window.clearTimeout(cr.timer); renderCreate(); cr.timer = window.setTimeout(() => inspectCreate(false), 300); });
    name.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doCreate(); } });
    // 名前を決めたとき（欄を離れた）にだけ、GitHub に同じ名前があるかを聞く——打つたびには聞かない
    name.addEventListener("blur", () => { if (name.value.trim()) inspectCreate(true); });
    const band = makeBand("", name, "repo-create-band");
    const note = h("div", { "data-testid": "repo-create-github" });
    const opt = projectOption(cr, "repo-create-with-project", () => renderCreate());
    const foot = h("div", { class: "foot" });
    const desc = h("p", { class: "desc" });
    createDialog.replaceChildren(h("div", { class: PREPARE ? "dlg prep-body" : "dlg", "data-testid": "repo-create-dialog" }, [
      PREPARE ? desc : h("div", {}, [h("h2", { text: "新しいリポジトリ" }), desc]),
      band.root, note,
      h("p", { class: "help", text: "GitHub に公開するときも、この名前を使います（そのときに変えられます）。" }),
      PREPARE ? null : opt.root, foot,
    ]));
    crParts = { name: name, band: band, note: note, opt: opt, foot: foot, desc: desc };
    if (!createDialog.open) createDialog.showModal();
    placeDialog(trigger, createDialog);
    name.focus();
    if (initial) inspectCreate(true); else renderCreate();
  }
  async function inspectCreate(checkGithub) {
    if (!crParts) return;
    const seq = ++cr.seq;
    const name = crParts.name.value.trim();
    if (!name) { cr.inspection = null; renderCreate(); return; }
    try {
      const r = await call("inspect_new_repository", { name: name, checkGithub: !!checkGithub });
      if (seq !== cr.seq) return;
      cr.inspection = Object.assign(r, { githubChecked: !!checkGithub }); cr.error = null;
    } catch (e) {
      if (seq !== cr.seq) return;
      cr.inspection = null; cr.error = errText(e);
    }
    renderCreate();
  }
  function renderCreate() {
    if (!crParts) return;
    const p = crParts, ins = cr.inspection;
    const home = state.home ? state.home.repoHome : "~";
    p.desc.textContent = home + " に作って git init します。GitHub へは、あとで公開できます。";
    const typed = p.name.value.trim();
    const current = ins && ins.folder === typed ? ins : null;
    let o;
    if (!typed) o = { state: "empty", home: home, tone: "plain", mark: "plus", message: "名前を入れると、" + home + " の下に作ります。" };
    else if (!current) o = { state: "checking", home: home, tone: "plain", mark: "plus", message: "確かめています…" };
    else {
      const taken = targetSay(current, "作成", (n) => { p.name.value = n; inspectCreate(); }, null);
      o = taken ? Object.assign({ state: current.folderInvalid ? "invalid" : current.state.kind, home: current.home }, taken)
        : { state: "free", home: current.home, tone: "plain", mark: "plus", message: "ここに空のリポジトリを作ります（git init）。GitHub には、まだ作りません。" };
    }
    if (cr.failed) o = Object.assign({}, o, { tone: "stop", mark: "ban", message: "作れませんでした：" + cr.failed });
    paintBand(p.band, o);
    if (cr.error) p.band.say.append(h("p", { class: "stopline", role: "alert", text: "確かめられませんでした：" + cr.error }));
    const free = !!current && !current.folderInvalid && current.state.kind === "free";
    p.note.replaceChildren(
      ...(free && current.takenOnGithub ? [h("p", { class: "warnline", "data-testid": "repo-create-taken-on-github" }, [
        "GitHub の " + current.takenOnGithub + " には、もう " + current.folder + " があります。あとで公開するときは別の名前が要ります。その " + current.folder + " で作業するなら ",
        h("button", { class: "link", type: "button", "data-testid": "repo-create-clone-instead", text: "clone で始める", onclick: () => { const src = current.takenOnGithub + "/" + current.folder; createDialog.close(); openClone(src); } }),
      ])] : []),
      ...(free && current.githubCheckError ? [h("p", { class: "help", text: "GitHub に同じ名前があるか確かめられませんでした：" + current.githubCheckError }) ] : []),
    );
    p.opt.box.disabled = cr.busy;
    fill(p.foot,
      PREPARE ? null : h("button", { class: "btn", type: "button", text: "やめる", onclick: () => createDialog.close() }),
      h("button", { class: "btn primary", type: "button", "data-testid": "repo-create-submit", disabled: !free || cr.busy, text: cr.busy ? "作っています…" : (cr.confirmedFor === p.name.value.trim() ? "それでも" : "") + (cr.withProject ? "作って Project の作成へ" : "リポジトリを作る"), onclick: doCreate }),
    );
    reportSize();
  }
  async function doCreate() {
    if (!crParts || cr.busy) return;
    const name = crParts.name.value.trim();
    // 作る直前に、まだなら GitHub に同じ名前があるかを1回だけ聞く。あれば言って、もう一度押されたら作る（止めはしない）
    if (!cr.inspection || cr.inspection.folder !== name || !cr.inspection.githubChecked) await inspectCreate(true);
    if (!cr.inspection || cr.inspection.folder !== name || cr.inspection.folderInvalid || cr.inspection.state.kind !== "free") return;
    if (cr.inspection.takenOnGithub && cr.confirmedFor !== name) { cr.confirmedFor = name; renderCreate(); return; }
    cr.busy = true; renderCreate();
    try {
      const made = await call("create_repository", { name: name });
      if (PREPARE) {
        cr.busy = false; renderCreate();
        prepared({ path: made.path, suggestedName: made.name, summary: made.displayPath + " を作りました（git init、ブランチ " + made.branch + "）" });
        return;
      }
      const withProject = cr.withProject;
      createDialog.close();
      setFlash(withProject ? made.displayPath + " を作りました。Project の作成に進みます" : made.displayPath + " を作り、一覧に足しました（ブランチ " + made.branch + "）");
      await load();
      showRow(made.path);
      if (withProject) openNewProject(made.path, made.name);
    } catch (e) {
      cr.busy = false; cr.failed = errText(e); renderCreate();
    }
  }

  // ---- アカウントを選ぶ（段階4）。見えないアカウントは Module が断る。書けないなら、そう言って指定する ----
  const accountDialog = document.getElementById("account-dialog");
  const ac = { row: null, accounts: null, error: null, busy: false };
  accountDialog.addEventListener("close", () => { ac.row = null; accountDialog.replaceChildren(); document.body.style.minHeight = ""; reportSize(); });
  async function openAccountChooser(r) {
    state.menuFor = null;
    const trigger = document.activeElement;
    // 行の「…」を閉じる（開いたまま後ろに残ると、閉じたあとのクリックを遮る）
    render();
    Object.assign(ac, { row: r, accounts: null, error: null, busy: false });
    renderAccountChooser();
    if (!accountDialog.open) accountDialog.showModal();
    placeDialog(trigger, accountDialog);
    try { ac.accounts = (await call("list_github_accounts")).accounts; } catch (e) { ac.error = "アカウントを読めませんでした：" + errText(e); }
    renderAccountChooser();
  }
  function renderAccountChooser() {
    const r = ac.row;
    if (!r) return;
    const current = r.account && r.account.registered ? r.account.login : null;
    const kids = [
      h("div", {}, [h("h2", { text: "アカウントを選ぶ" }), h("p", { class: "desc", text: r.remote.owner + "/" + r.remote.name + " を、どのアカウントで扱うか（clone し直す・公開するときに使います）" })]),
    ];
    if (!ac.accounts && !ac.error) kids.push(h("p", { class: "muted", text: "読んでいます…" }));
    if (ac.accounts) {
      if (ac.accounts.length === 0) kids.push(h("p", { class: "help", text: "GitHub のアカウントが登録されていません（banto 全体の設定の Repositories で登録できます）。" }));
      kids.push(h("div", { class: "pills", role: "group", "aria-label": "アカウント" }, [
        ...ac.accounts.map((a) => h("button", {
          class: "pill", type: "button", "aria-pressed": String(current === a.login), "data-testid": "repo-account-pick", "data-login": a.login, disabled: ac.busy,
          onclick: () => assignAccount(r, a.login),
        }, [a.login])),
        h("button", { class: "pill", type: "button", "aria-pressed": String(current === null), "data-testid": "repo-account-pick-none", disabled: ac.busy, onclick: () => assignAccount(r, null) }, ["使わない（読むだけ）"]),
      ]));
      kids.push(h("p", { class: "help", text: "選ぶと、そのアカウントで " + r.remote.owner + "/" + r.remote.name + " が見えるかを GitHub に確かめます。見えないアカウントは選べません。" }));
    }
    if (ac.busy) kids.push(h("p", { class: "muted", role: "status", text: "GitHub に確かめています…" }));
    if (ac.error) kids.push(h("p", { class: "stopline", role: "alert", "data-testid": "repo-account-error", text: ac.error }));
    kids.push(h("div", { class: "foot" }, [h("button", { class: "btn", type: "button", text: "閉じる", onclick: () => accountDialog.close() })]));
    accountDialog.replaceChildren(h("div", { class: "dlg", "data-testid": "repo-account-dialog" }, kids));
    reportSize();
  }
  async function assignAccount(r, login) {
    ac.busy = true; ac.error = null; renderAccountChooser();
    try {
      const res = await call("set_repository_account", { path: r.path, login: login });
      accountDialog.close();
      setFlash(res.login === null
        ? r.name + " を読むだけに戻しました（持ち主と同じアカウントがあっても、自動では付け直しません）"
        : r.name + " を " + res.login + " で扱います" + (res.push ? "" : "（このアカウントは読めますが書けません——公開・push はできません）"));
      await load();
      showRow(r.path);
    } catch (e) {
      ac.busy = false; ac.error = errText(e); renderAccountChooser();
    }
  }

  // ---- このマシンから削除（段階4）。確かめるのは Module——画面は言い方と、打たせる欄を持つだけ ----
  const deleteDialog = document.getElementById("delete-dialog");
  const dl = { row: null, inspection: null, error: null, busy: false, closeProjects: true, seq: 0 };
  let dlTyped = null;
  deleteDialog.addEventListener("cancel", (e) => { if (dl.busy) e.preventDefault(); });
  deleteDialog.addEventListener("close", () => { dl.row = null; dlTyped = null; deleteDialog.replaceChildren(); document.body.style.minHeight = ""; reportSize(); });
  async function openDelete(r) {
    state.menuFor = null;
    const trigger = document.activeElement;
    // 行の「…」を閉じる（開いたまま後ろに残ると、閉じたあとのクリックを遮る）
    render();
    const seq = ++dl.seq;
    Object.assign(dl, { row: r, inspection: null, error: null, busy: false, closeProjects: true });
    dlTyped = null;
    renderDelete();
    if (!deleteDialog.open) deleteDialog.showModal();
    placeDialog(trigger, deleteDialog);
    try {
      const ins = await call("inspect_delete", { path: r.path });
      if (seq !== dl.seq) return;
      dl.inspection = ins;
    } catch (e) {
      if (seq !== dl.seq) return;
      dl.error = "調べられませんでした：" + errText(e);
    }
    renderDelete();
  }
  function lossLines(ins) {
    const l = ins.losses;
    const lines = [];
    for (const b of l.unpushed) lines.push("ブランチ " + b.branch + "：どのリモートにも無いコミット " + b.commits + " 件");
    if (l.detached > 0) lines.push("どのブランチにも無いコミット " + l.detached + " 件");
    if (l.localOnlyBranches.length > 0) lines.push("リモートに無いブランチ " + l.localOnlyBranches.length + " 本（" + l.localOnlyBranches.join("・") + "）");
    if (l.changed > 0) lines.push("コミットしていない変更 " + l.changed + " 件");
    if (l.untracked > 0) lines.push("追跡していないもの " + l.untracked + " 件（ignore 済みは数えていません）");
    if (l.stashes > 0) lines.push("stash " + l.stashes + " 件");
    if (ins.worktrees && ins.worktrees.length > 0) lines.push("このリポジトリの worktree " + ins.worktrees.length + " 個が使えなくなります（" + ins.worktrees.join("・") + "）");
    return lines;
  }
  function renderDelete() {
    const r = dl.row;
    if (!r) return;
    const ins = dl.inspection;
    const kids = [h("div", {}, [h("h2", { text: "このマシンから削除" }), h("p", { class: "desc", text: "フォルダごと消します。GitHub などのリモートには触りません。" })])];
    let canDelete = false, needsName = false;
    if (dl.error) kids.push(h("p", { class: "stopline", role: "alert", "data-testid": "repo-delete-error", text: dl.error }));
    if (!ins && !dl.error) kids.push(h("p", { class: "muted", role: "status", "data-testid": "repo-delete-checking", text: "失われるものを調べています…（大きいリポジトリでは時間がかかります）" }));
    if (ins && ins.refusal) {
      kids.push(h("p", { class: "stopline", role: "alert", "data-testid": "repo-delete-refusal", text: ins.displayPath + " は消せません：" + ins.refusal }));
    } else if (ins) {
      canDelete = true;
      needsName = !!ins.needsTypedName;
      kids.push(h("section", { class: "preview band" }, [
        h("div", { class: "top" }, [h("p", { class: "k", text: ins.kind === "worktree" ? "消す worktree（本体 " + ins.main + " は残します）" : "消すフォルダ" }), h("p", { class: "v", "data-testid": "repo-delete-path", text: ins.displayPath })]),
      ]));
      const lines = lossLines(ins);
      if (lines.length > 0) {
        kids.push(h("div", { class: "losses", "data-testid": "repo-delete-losses" }, [
          h("p", { class: "lbl", text: "消すと失われるもの" }),
          h("ul", {}, lines.map((t) => h("li", { "data-testid": "repo-delete-loss", text: t }))),
        ]));
      } else if (ins.losses.problems.length === 0) {
        kids.push(h("p", { "data-testid": "repo-delete-nothing", text: "push していないコミット・変更・stash などはありません。フォルダごと消えます（" + ins.displayPath + "）。" }));
      }
      for (const p of ins.losses.problems) kids.push(h("p", { class: "warnline", "data-testid": "repo-delete-problem", text: p + "——確かめられていないものは、失われるかもしれません" }));
      if (ins.projectsError) kids.push(h("p", { class: "warnline", text: "どの Project が使っているかを読めませんでした：" + ins.projectsError }));
      const active = (ins.projects || []).filter((p) => !p.closed);
      if (ins.projects && ins.projects.length > 0) {
        kids.push(h("p", { class: "warnline", "data-testid": "repo-delete-projects", text: "Project「" + ins.projects.map((p) => p.name).join("」「") + "」が使っています。消すと、その Project の Root が無くなります。" }));
        if (active.length > 0) {
          const box = h("input", { type: "checkbox", "data-testid": "repo-delete-close-projects", checked: dl.closeProjects, disabled: dl.busy });
          box.addEventListener("change", () => { dl.closeProjects = box.checked; });
          kids.push(h("label", { class: "projopt" }, [box, h("span", {}, [h("span", { class: "t", text: "Project も閉じる" }), h("span", { class: "d", text: "消したあと、banto の「Project を閉じる」の確かめを開きます（閉じるのはそこで押したとき）" })])]));
        }
      }
      if (needsName) {
        if (!dlTyped) {
          dlTyped = h("input", { type: "text", spellcheck: "false", autocomplete: "off", "data-testid": "repo-delete-typed", "aria-label": "リポジトリ名" });
          dlTyped.addEventListener("input", () => renderDeleteFoot());
          dlTyped.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doDelete(); } });
        }
        kids.push(h("div", { class: "field" }, [h("label", { class: "lbl", text: "承知のうえで消すなら、リポジトリ名「" + ins.name + "」を打ってください" }), dlTyped]));
      }
    }
    const foot = h("div", { class: "foot", "data-testid": "repo-delete-foot" });
    kids.push(foot);
    deleteDialog.replaceChildren(h("div", { class: "dlg", "data-testid": "repo-delete-dialog" }, kids));
    dl.canDelete = canDelete; dl.needsName = needsName;
    renderDeleteFoot();
    if (dlTyped && dlTyped.isConnected) dlTyped.focus();
  }
  function renderDeleteFoot() {
    const foot = deleteDialog.querySelector('[data-testid="repo-delete-foot"]');
    if (!foot) return;
    const ins = dl.inspection;
    const typedOk = !dl.needsName || (dlTyped && ins && dlTyped.value === ins.name);
    fill(foot,
      h("button", { class: "btn", type: "button", text: "やめる", disabled: dl.busy, onclick: () => deleteDialog.close() }),
      dl.canDelete ? h("button", { class: "btn primary danger", type: "button", "data-testid": "repo-delete-submit", disabled: dl.busy || !typedOk, text: dl.busy ? "消しています…" : dl.needsName ? "承知して削除" : "削除する", onclick: doDelete }) : null,
    );
    reportSize();
  }
  async function doDelete() {
    const r = dl.row, ins = dl.inspection;
    if (!r || !ins || !dl.canDelete || dl.busy) return;
    if (dl.needsName && (!dlTyped || dlTyped.value !== ins.name)) return;
    dl.busy = true; dl.error = null; renderDeleteFoot();
    try {
      const res = await call("delete_repository", Object.assign({ path: r.path, confirmed: true }, dl.needsName ? { typedName: dlTyped.value } : {}));
      const closeIds = dl.closeProjects ? res.projects.filter((p) => !p.closed).map((p) => p.id) : [];
      deleteDialog.close();
      setFlash(res.displayPath + " をこのマシンから削除しました（GitHub などのリモートには触っていません）");
      await load();
      // 使っていた Project を閉じるのは core の確かめで（Module は Project に触らない）
      if (closeIds.length > 0) {
        try { await request("dev.banto/close-projects", { projectIds: closeIds }); }
        catch (e) { setFlash("フォルダは消しました。Project を閉じる画面を開けませんでした：" + errText(e) + "（Project の設定から閉じられます）"); render(); }
      }
    } catch (e) {
      dl.busy = false;
      // 調べたあとに増えていた等——もう一度調べ直して見せる
      dl.error = errText(e);
      try { dl.inspection = await call("inspect_delete", { path: r.path }); } catch (e2) { /* 調べ直せなければ、前の結果のまま（理由は上に出ている） */ }
      renderDelete();
    }
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
  function placeDialog(trigger, el) {
    const d = el || dialog;
    if (PREPARE) return;
    if (document.body.dataset.mode === "fullscreen") return;
    const top = Math.max(8, (trigger ? trigger.getBoundingClientRect().top : 0) - 8);
    d.style.margin = "0 auto";
    d.style.top = top + "px";
    requestAnimationFrame(() => {
      document.body.style.minHeight = top + d.offsetHeight + 16 + "px";
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
    if (PREPARE) {
      // 置き場（説明の1行）だけを読み、clone・新しいリポジトリの本体を出す
      try { state.home = await call("get_repository_settings"); } catch (e) { /* 置き場が読めなくても、本体は出す（説明が「置き場」になるだけ） */ }
      if (MODE === "prepare-clone") openClone(""); else openCreate("");
      return;
    }
    await Promise.all([load(), MODE === "config" ? loadAccounts() : null]);
  })();
})();
`;

export function repositoriesAppHtml(mode: "launcher" | "config" | "prepare-clone" | "prepare-create"): string {
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
<dialog id="clone-dialog" aria-label="URL から clone"></dialog>
<dialog id="create-dialog" aria-label="新しいリポジトリ"></dialog>
<dialog id="account-dialog" aria-label="アカウントを選ぶ"></dialog>
<dialog id="delete-dialog" aria-label="このマシンから削除"></dialog>
<script>${script}</script>
</body>
</html>
`;
}
