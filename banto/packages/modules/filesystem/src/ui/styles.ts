// 画面の見た目。**色の名前は MCP Apps の標準の CSS 変数**（`--color-background-primary`
// など、host が `hostContext.styles.variables` で渡す口）を先に見て、渡されなければ
// banto の色（`apps/frontend/app/globals.css` の層A）を使う。ここにある値は既定値で
// あって真実ではない——host が渡せばそちらが勝つ（規則3）。
//
// 字の大きさ・角の丸み・影も banto の段に揃える（モック `mock/` の見た目を再現する）。

const CSS = `
:root {
  --b-bg: #ffffff; --b-bg-2: #edeff3; --b-bg-3: #e3e6ec;
  --b-ink: #14171c; --b-ink-2: #545b66; --b-ink-3: #8b93a0;
  --b-line: rgba(17, 22, 31, 0.1);
  --b-accent: #3b5bdb; --b-accent-soft: #e9eefc; --b-accent-ink: #2a44ac;
  --b-ok: #2f7a57; --b-ok-soft: #e6f1eb;
  --b-stop: #6e56cf; --b-stop-soft: #eeeafb;
  --b-turn: #ce4620; --b-turn-soft: #fcede7;
  --b-warn: #9c6b12;
  --b-on-color: #ffffff;
  --b-sh-1: 0 1px 2px rgba(17, 22, 31, 0.05);
  --b-sh-2: 0 4px 16px rgba(17, 22, 31, 0.08), 0 1px 3px rgba(17, 22, 31, 0.05);
  --b-sh-3: 0 16px 48px rgba(17, 22, 31, 0.16), 0 2px 8px rgba(17, 22, 31, 0.08);
  --b-scrim: rgba(17, 22, 31, 0.4);
  color-scheme: light;
}
:root[data-theme="dark"] {
  --b-bg: #16191f; --b-bg-2: #1d2128; --b-bg-3: #262b33;
  --b-ink: #e8ebf0; --b-ink-2: #a1a9b5; --b-ink-3: #6b7380;
  --b-line: rgba(255, 255, 255, 0.1);
  --b-accent: #7c9cf5; --b-accent-soft: rgba(124, 156, 245, 0.14); --b-accent-ink: #a8befa;
  --b-ok: #6bbf8a; --b-ok-soft: rgba(107, 191, 138, 0.14);
  --b-stop: #a78bfa; --b-stop-soft: rgba(167, 139, 250, 0.14);
  --b-turn: #f07b58; --b-turn-soft: rgba(240, 123, 88, 0.15);
  --b-warn: #ddae55;
  --b-on-color: #11141a;
  --b-sh-1: 0 1px 2px rgba(0, 0, 0, 0.3);
  --b-sh-2: 0 4px 16px rgba(0, 0, 0, 0.4), 0 1px 3px rgba(0, 0, 0, 0.3);
  --b-sh-3: 0 16px 48px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.35);
  --b-scrim: rgba(0, 0, 0, 0.55);
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
  --accent: var(--color-text-info, var(--b-accent));
  --danger: var(--color-text-danger, var(--b-turn));
  --sans: var(--font-sans, ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif);
  --mono: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  font: 12px/1.7 var(--sans);
  color: var(--ink);
  background: transparent;
}
body[data-mode="fullscreen"] { background: var(--bg); height: 100vh; overflow: hidden; }
button { font: inherit; color: inherit; }
.icon { width: 14px; height: 14px; flex-shrink: 0; }
.icon-md { width: 16px; height: 16px; flex-shrink: 0; }
.icon-lg { width: 24px; height: 24px; flex-shrink: 0; }
.icon-xl { width: 32px; height: 32px; flex-shrink: 0; }
.icon-2xl { width: 40px; height: 40px; flex-shrink: 0; }
.muted { color: var(--ink-3); }
.spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.mono { font-family: var(--mono); }

.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 28px; padding: 0 10px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--line); background: var(--bg); color: var(--ink);
  font-size: 12px; white-space: nowrap;
}
.btn:hover:not(:disabled) { background: var(--bg-3); }
.btn:disabled { opacity: 0.5; cursor: default; }
.btn-primary { background: var(--accent); border-color: transparent; color: var(--b-on-color); }
.btn-primary:hover:not(:disabled) { background: var(--accent); filter: brightness(1.08); }
.icon-btn {
  display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
  width: 24px; height: 24px; border-radius: 6px; border: 0; background: transparent;
  color: var(--ink-3); cursor: pointer; padding: 0;
}
.icon-btn:hover { background: var(--bg-3); color: var(--ink); }
.icon-btn.strong { color: var(--ink-2); }
.badge {
  display: inline-flex; align-items: center; max-width: 100%;
  border: 1px solid var(--line); border-radius: 6px; padding: 0 6px;
  font: 11px/1.8 var(--mono); color: var(--ink);
}

/* ---- ファイルブラウザ（fullscreen）---- */
.browser { display: flex; flex-direction: column; height: 100vh; min-height: 0; }
.panes { display: flex; flex: 1; min-height: 0; }
.tree { width: min(288px, 45vw); flex-shrink: 0; display: flex; flex-direction: column; border-right: 1px solid var(--line); min-height: 0; }
.tree-rail { width: 40px; flex-shrink: 0; display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 8px 0; border-right: 1px solid var(--line); background: var(--bg-2); }
.tree-rail .icon-btn { width: 28px; height: 28px; color: var(--ink-2); }
.tree-head { display: flex; align-items: center; gap: 4px; padding: 8px; border-bottom: 1px solid var(--line); }
.root-path { flex: 1; direction: rtl; text-align: left; font: 11px/1.6 var(--mono); color: var(--ink-2); }
.tree-tools { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
.tree-body { flex: 1; min-height: 0; overflow: auto; padding: 6px; }
.row {
  display: flex; align-items: center; gap: 4px; padding: 4px 6px; border-radius: 6px;
  font-size: 12px; color: var(--ink-2); cursor: pointer; user-select: none; outline: none;
}
.row:hover { background: var(--bg-3); }
.row:focus-visible { box-shadow: inset 0 0 0 1px var(--accent); }
.row.active { background: var(--bg-2); }
.row.selected { background: var(--bg-3); color: var(--b-accent-ink); }
.row.dir .name { color: var(--ink); }
.row .chev, .row .spacer { width: 14px; height: 14px; flex-shrink: 0; color: var(--ink-3); }
.row .kind { color: var(--ink-3); }
.row-note { padding: 4px 6px; font-size: 11px; color: var(--ink-3); }
.row-note.error { color: var(--danger); }
.draft-input {
  flex: 1; min-width: 0; border: 1px solid var(--b-accent-ink); border-radius: 4px;
  background: var(--bg); padding: 0 4px; font: 12px/1.6 var(--sans); color: var(--ink); outline: none;
}
.tree-foot { flex-shrink: 0; border-top: 1px solid var(--line); padding: 8px; background: linear-gradient(to bottom, var(--bg), var(--bg-2)); }
.foot-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.foot-grid.single { grid-template-columns: 1fr; }
.foot-btn { flex-direction: column; height: auto; padding: 8px 0; gap: 4px; }
.foot-btn span { font-size: 11px; }
.content { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.content-head { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--line); flex-shrink: 0; min-width: 0; }
.content-body { flex: 1; min-height: 0; }
.empty { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; color: var(--ink-3); padding: 16px; text-align: center; }
.hint { flex-shrink: 0; border-top: 1px solid var(--line); padding: 10px 16px; font-size: 11px; color: var(--ink-3); }
.summary { height: 100%; overflow: auto; padding: 16px; }
.summary-title { margin: 0 0 12px; font-size: 12px; font-weight: 500; color: var(--ink); }
.summary-list { border: 1px solid var(--line); border-radius: 6px; background: var(--bg); }
.summary-row { display: flex; align-items: center; gap: 8px; padding: 8px 12px; }
.summary-row + .summary-row { border-top: 1px solid var(--line); }
.summary-row .path { flex: 1; color: var(--ink-2); }
.summary-row .size { flex-shrink: 0; font-size: 11px; color: var(--ink-3); }
.summary-note { margin: 12px 0 0; font-size: 11px; color: var(--ink-3); }

/* ---- 中身（ビューア）---- */
.viewer { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.viewer-bar { display: flex; align-items: center; gap: 6px; padding: 6px 12px; border-bottom: 1px solid var(--line); flex-shrink: 0; min-height: 41px; }
.viewer-bar .spacer-fill { flex: 1; }
.viewer-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.viewer-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; }
.tab-list { display: inline-flex; gap: 2px; padding: 3px; background: var(--bg-2); border-radius: 8px; }
.tab { border: 0; background: transparent; padding: 3px 10px; border-radius: 6px; font-size: 12px; color: var(--ink-2); cursor: pointer; }
.tab[aria-selected="true"] { background: var(--bg); color: var(--ink); box-shadow: var(--b-sh-1); }
.tab-panel { flex: 1; min-height: 0; overflow: auto; }
pre.source { margin: 0; padding: 12px; white-space: pre-wrap; word-break: break-word; font: 11px/1.7 var(--mono); color: var(--ink-2); }
textarea.editor {
  flex: 1; width: 100%; min-height: 100%; resize: none; border: 0; outline: none;
  background: var(--bg); color: var(--ink); padding: 12px; font: 11px/1.7 var(--mono);
}
iframe.html-preview { display: block; width: 100%; height: 100%; min-height: 224px; border: 0; background: #ffffff; }
.image-view { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 16px; min-height: 224px; }
.image-view img { max-width: 100%; max-height: calc(100vh - 180px); object-fit: contain; border-radius: 6px; background: repeating-conic-gradient(var(--bg-2) 0% 25%, transparent 0% 50%) 50% / 16px 16px; }
.placeholder { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; min-height: 224px; background: var(--bg-2); color: var(--ink-3); text-align: center; padding: 16px; }
.placeholder p, .empty p { margin: 0; }
.placeholder .name { font-size: 12px; color: var(--ink-2); }
.placeholder .meta { font-size: 11px; }
.state { padding: 16px; font-size: 12px; color: var(--ink-3); display: flex; align-items: center; gap: 8px; }
.state.error { color: var(--danger); }
.sheet-wrap { padding: 12px; overflow: auto; }
table.sheet { width: 100%; border-collapse: collapse; font-size: 12px; }
table.sheet th, table.sheet td { border: 1px solid var(--line); padding: 4px 8px; text-align: left; vertical-align: top; white-space: pre-wrap; }
table.sheet th { background: var(--bg-2); font-weight: 500; color: var(--ink); }
table.sheet td { color: var(--ink-2); }
table.sheet .cell { padding: 0; }
table.sheet .cell input { width: 100%; min-width: 4em; border: 0; outline: none; background: transparent; padding: 4px 8px; font: inherit; color: inherit; }
table.sheet .cell input:focus { box-shadow: inset 0 0 0 1px var(--accent); }

/* ---- Markdown ---- */
.md { padding: 16px; font-size: 13px; line-height: 1.7; color: var(--ink-2); word-break: break-word; }
.md > :first-child { margin-top: 0; }
.md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { color: var(--ink); line-height: 1.4; margin: 1.1em 0 0.4em; }
.md h1 { font-size: 17px; font-weight: 700; }
.md h2 { font-size: 15px; font-weight: 600; }
.md h3 { font-size: 13px; font-weight: 600; }
.md h4, .md h5, .md h6 { font-size: 12px; font-weight: 600; }
.md p { margin: 0.4em 0; }
.md ul, .md ol { margin: 0.4em 0; padding-left: 1.6em; }
.md li.task { list-style: none; margin-left: -1.3em; }
.md li.task input { margin: 0 4px 0 0; vertical-align: -1px; }
.md code { font: 11px var(--mono); background: var(--bg-2); padding: 1px 4px; border-radius: 4px; }
.md pre { background: var(--bg-2); padding: 10px 12px; border-radius: 6px; overflow: auto; }
.md pre code { background: none; padding: 0; font-size: 11px; line-height: 1.6; }
.md blockquote { margin: 0.5em 0; padding: 0 12px; border-left: 3px solid var(--line); color: var(--ink-3); }
.md table { border-collapse: collapse; margin: 0.6em 0; font-size: 12px; }
.md th, .md td { border: 1px solid var(--line); padding: 4px 8px; }
.md th { background: var(--bg-2); color: var(--ink); font-weight: 500; }
.md hr { border: 0; border-top: 1px solid var(--line); margin: 1em 0; }
.md .md-link { color: var(--accent); text-decoration: underline dotted; cursor: help; }
.md .md-img { color: var(--ink-3); }

/* ---- ダイアログ・通知 ---- */
.overlay { position: fixed; inset: 0; background: var(--b-scrim); display: flex; align-items: center; justify-content: center; z-index: 20; padding: 16px; }
.dialog { width: min(440px, 100%); background: var(--bg); border-radius: 14px; box-shadow: var(--b-sh-3); padding: 20px; display: flex; flex-direction: column; gap: 14px; max-height: 100%; overflow: auto; }
.dialog h2 { margin: 0; font-size: 15px; font-weight: 600; color: var(--ink); }
.dialog .desc { margin: 4px 0 0; font-size: 12px; color: var(--ink-3); }
.dropzone { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 32px 16px; border: 1px dashed var(--ink-3); border-radius: 6px; background: var(--bg-2); color: var(--ink-3); text-align: center; cursor: pointer; font-size: 12px; }
.dropzone:hover, .dropzone.over { background: var(--bg-3); }
.dropzone .sub { font-size: 11px; }
.file-list { max-height: 160px; overflow: auto; border: 1px solid var(--line); border-radius: 6px; }
.file-row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; font-size: 12px; }
.file-row + .file-row { border-top: 1px solid var(--line); }
.file-row .name { flex: 1; color: var(--ink-2); }
.file-row .size { flex-shrink: 0; font-size: 11px; color: var(--ink-3); }
.file-row .flag { flex-shrink: 0; font-size: 11px; color: var(--b-warn); }
.file-row .flag.error { color: var(--danger); }
.dialog-foot { display: flex; justify-content: flex-end; gap: 8px; }
.toasts { position: fixed; right: 16px; bottom: 16px; z-index: 30; display: flex; flex-direction: column; gap: 8px; width: min(360px, calc(100vw - 32px)); pointer-events: none; }
.toast { pointer-events: auto; background: var(--bg); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--b-sh-2); padding: 10px 14px; font-size: 12px; color: var(--ink); }
.toast .desc { margin-top: 2px; font-size: 11px; color: var(--ink-3); }
.toast.error { border-color: var(--danger); }
.toast.error .title { color: var(--danger); }

/* ---- 会話の中の一覧（inline）---- */
.inline-card { padding: 12px; }
.inline-head { display: flex; align-items: center; gap: 6px; margin: 0 0 6px; font-size: 12px; font-weight: 600; color: var(--ink); }
.inline-list { list-style: none; margin: 0; padding: 0; }
.inline-list li { display: flex; align-items: center; gap: 6px; padding: 2px 0; font-size: 12px; color: var(--ink-2); }
.inline-list li.dir { color: var(--ink); }
.inline-list .icon { color: var(--ink-3); }
.inline-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.note { margin: 8px 0 0; font-size: 11px; color: var(--ink-3); }
.note.error { color: var(--danger); }

/* ---- 見せるファイル（showFile の inline）---- */
.file-card-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line); min-width: 0; }
.file-card-head .spacer-fill { flex: 1; }
.file-card-body { height: 440px; display: flex; flex-direction: column; }
.file-card .note { padding: 0 12px 10px; }

/* ---- 差分（editFile）---- */
.diff-head { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--line); min-width: 0; }
.diff-stat { font-size: 11px; color: var(--ink-3); flex-shrink: 0; }
.diff-stat .add { color: var(--b-ok); }
.diff-stat .del { color: var(--b-stop); }
.diff-body { padding: 12px; overflow: auto; font: 11px/1.7 var(--mono); }
.diff-row { display: flex; white-space: pre; border-radius: 4px; padding: 0 8px 0 0; min-width: max-content; }
.diff-row .ln { width: 3.2em; flex-shrink: 0; text-align: right; padding-right: 8px; color: var(--ink-3); user-select: none; }
.diff-row .sign { width: 1.2em; flex-shrink: 0; user-select: none; }
.diff-row.add { background: var(--b-ok-soft); color: var(--b-ok); }
.diff-row.remove { background: var(--b-stop-soft); color: var(--b-stop); }
.diff-row.context { color: var(--ink-2); }
.diff-row.hunk { color: var(--ink-3); padding-left: 8px; }
`;

export function installStyles(): void {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}

/** host が渡した標準の CSS 変数を当てる（渡されなければ上の既定値のまま）。 */
export function applyHostStyles(variables: Record<string, string | undefined> | undefined): void {
  for (const [name, value] of Object.entries(variables ?? {})) {
    if (name.startsWith("--") && typeof value === "string") document.documentElement.style.setProperty(name, value);
  }
}

export function applyTheme(theme: "light" | "dark" | undefined): void {
  if (theme) document.documentElement.dataset.theme = theme;
}
