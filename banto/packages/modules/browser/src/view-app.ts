// **人の画面「ブラウザ」**（launcher、v4-modules.md §4.1「人の画面」）。
//
// 上に戻る/進む/読み直し・URL 欄・タブの並び・「AI に触らせない」・「画面に合わせる」・「ブラウザの記録を消す」、
// 真ん中にページの絵、下に通信とコンソールの欄（DevTools の Network と Console に倣う）。絵と入力は共通の流れの口
// （アーキ仕様 §5.8、`@banto/stream-client` を埋め込む）に乗る。流れの名前は `browser`、params は
// `{ width, height, dpr, visible }`（絵を出す場所の CSS ピクセルと devicePixelRatio）。中身の約束は view-stream.ts。
//
// - 絵は描き終えたら受け取りの印（`ack`）を返す——Module はそれまで次を送らない
// - ページの大きさは1つで、絵を出す場所に合わせて縮めて映す。「画面に合わせる」でページの大きさをこの画面に合わせる
// - 文字は隠した入力欄で受ける（日本語の変換・携帯の画面のキーボードのため）。変換を終えた文字は insertText で送る
// - 携帯（指）はタッチをタッチ入力のまま送る
// - 通信とコンソールの欄・HAR・記録を消す・「AI に触らせない」は admin の道具（tools/call）
//
// 色と段は banto が MCP Apps の標準の名前で渡す（v4-frontend.md §6.27）。

import { STREAM_CLIENT_SCRIPT } from "@banto/stream-client";

export const BROWSER_VIEW_URI = "ui://banto-browser/view";

const PAGE_CSS = `
:root {
  color-scheme: light;
  --bg: var(--color-background-primary, Canvas);
  --bg-2: var(--color-background-secondary, color-mix(in srgb, CanvasText 5%, Canvas));
  --bg-3: var(--color-background-tertiary, color-mix(in srgb, CanvasText 9%, Canvas));
  --ink: var(--color-text-primary, CanvasText);
  --ink-2: var(--color-text-secondary, color-mix(in srgb, CanvasText 70%, Canvas));
  --ink-3: var(--color-text-tertiary, GrayText);
  --line: var(--color-border-primary, color-mix(in srgb, CanvasText 12%, transparent));
  --accent: var(--color-text-info, LinkText);
  --accent-soft: var(--color-background-info, color-mix(in srgb, LinkText 12%, Canvas));
  --warn: var(--color-text-warning, darkgoldenrod);
  --warn-soft: var(--color-background-warning, color-mix(in srgb, darkgoldenrod 14%, Canvas));
  --danger: var(--color-text-danger, crimson);
  --danger-soft: var(--color-background-danger, color-mix(in srgb, crimson 12%, Canvas));
  --ok: var(--color-text-success, seagreen);
  --sans: var(--font-sans, system-ui, sans-serif);
  --mono: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  --t-xs: var(--font-text-xs-size, x-small);
  --t-sm: var(--font-text-sm-size, small);
  --r-sm: var(--border-radius-sm, 0.25rem);
  --r-md: var(--border-radius-md, 0.5rem);
}
:root[data-theme="dark"] { color-scheme: dark; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; height: 100%; }
body { font: var(--t-sm)/1.5 var(--sans); color: var(--ink); background: var(--bg); overflow: hidden; }
button, input, select, textarea { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

#app { display: flex; flex-direction: column; height: 100%; }
.bar { display: flex; align-items: center; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.btn { height: 28px; min-width: 28px; padding: 0 8px; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--bg); cursor: pointer; white-space: nowrap; }
.btn:hover:not(:disabled) { background: var(--bg-3); }
.btn:disabled { opacity: .45; cursor: default; }
.btn[data-armed] { color: var(--danger); background: var(--danger-soft); border-color: var(--danger); }
.url { flex: 1 1 240px; min-width: 0; display: flex; }
.url input { flex: 1; min-width: 0; height: 28px; padding: 0 8px; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--bg-2); font-family: var(--mono); font-size: var(--t-xs); }
.state { color: var(--ink-3); font-size: var(--t-xs); white-space: nowrap; }
.state[data-state="open"] { color: var(--ink-2); }
.state[data-state="reconnecting"] { color: var(--warn); }
.toggle { display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 8px; border: 1px solid var(--line); border-radius: var(--r-sm); cursor: pointer; user-select: none; font-size: var(--t-xs); white-space: nowrap; }
.toggle:has(input:checked) { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
.toggle.block:has(input:checked) { background: var(--warn-soft); border-color: var(--warn); color: var(--warn); }
.toggle input { margin: 0; }
.dim { color: var(--ink-3); font-size: var(--t-xs); white-space: nowrap; }

.tabs { display: flex; gap: 2px; padding: 4px 8px; border-bottom: 1px solid var(--line); overflow-x: auto; }
.tab { display: inline-flex; align-items: center; max-width: 220px; height: 28px; border-radius: var(--r-sm); border: 1px solid transparent; flex: none; }
.tab[aria-selected="true"] { background: var(--bg-3); border-color: var(--line); }
.tab-name { height: 100%; padding: 0 8px; border: 0; background: transparent; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 190px; }
.tab-id { color: var(--ink-3); font-family: var(--mono); font-size: var(--t-xs); margin-right: 4px; }
.tab-act { height: 100%; width: 24px; border: 0; background: transparent; color: var(--ink-3); cursor: pointer; border-radius: var(--r-sm); flex: none; }
.tab-act:hover { color: var(--ink); background: var(--bg-2); }

.notice { margin: 6px 8px 0; padding: 6px 10px; border-radius: var(--r-md); background: var(--warn-soft); font-size: var(--t-xs); }
.notice p { margin: 0; }
.error { margin: 6px 8px 0; padding: 6px 10px; border-radius: var(--r-md); background: var(--danger-soft); color: var(--danger); font-size: var(--t-xs); display: flex; gap: 8px; }
.error span { flex: 1; }

.stage { position: relative; flex: 1; min-height: 120px; display: flex; align-items: center; justify-content: center; overflow: hidden; background: var(--bg-2); }
#screen { display: block; touch-action: none; cursor: default; background: white; box-shadow: 0 0 0 1px var(--line); }
#screen[hidden] { display: none; }
.empty { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 16px; color: var(--ink-2); text-align: center; }
.empty p { margin: 0; max-width: 46ch; }
.ime { position: absolute; left: 0; top: 0; width: 1px; height: 1px; opacity: 0; border: 0; padding: 0; resize: none; font-size: 16px; pointer-events: none; }
.ai-banner { position: absolute; left: 50%; top: 8px; transform: translateX(-50%); max-width: calc(100% - 16px); display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: var(--r-md); background: var(--accent); color: var(--bg); box-shadow: 0 2px 8px rgba(0,0,0,.25); font-size: var(--t-xs); pointer-events: auto; }
.ai-banner .who { opacity: .85; white-space: nowrap; }
.ai-banner button { border: 1px solid currentColor; background: transparent; border-radius: var(--r-sm); padding: 0 6px; cursor: pointer; color: inherit; font-size: var(--t-xs); white-space: nowrap; }
.ai-box { position: absolute; border: 2px solid var(--accent); border-radius: 3px; box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 35%, transparent); pointer-events: none; animation: ai-box 1.4s ease-out forwards; }
@keyframes ai-box { 0% { opacity: 1; } 70% { opacity: 1; } 100% { opacity: 0; } }

.foot { display: flex; align-items: center; gap: 4px; padding: 4px 8px; border-top: 1px solid var(--line); flex-wrap: wrap; }
.foot .btn[aria-pressed="true"] { background: var(--bg-3); border-color: var(--ink-3); }
.count { color: var(--ink-3); font-size: var(--t-xs); margin-left: 2px; }
.panel { height: 42%; min-height: 140px; display: flex; flex-direction: column; border-top: 1px solid var(--line); }
.panel-bar { display: flex; align-items: center; gap: 4px; padding: 4px 8px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.panel-bar input[type="search"] { height: 26px; width: 16ch; padding: 0 6px; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--bg); font-size: var(--t-xs); }
.panel-bar select { height: 26px; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--bg); font-size: var(--t-xs); }
.panel-body { flex: 1; min-height: 0; display: flex; }
.list { flex: 1; min-width: 0; overflow: auto; font-size: var(--t-xs); }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 2px 6px; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { position: sticky; top: 0; background: var(--bg-2); font-weight: normal; color: var(--ink-2); }
td.u { max-width: 1px; width: 100%; overflow: hidden; text-overflow: ellipsis; font-family: var(--mono); }
tr.row { cursor: pointer; }
tr.row:hover { background: var(--bg-2); }
tr.row[aria-selected="true"] { background: var(--accent-soft); }
tr.row[data-bad] td.s { color: var(--danger); }
.detail { flex: 1; min-width: 0; overflow: auto; border-left: 1px solid var(--line); padding: 6px 8px; font-size: var(--t-xs); }
.detail h4 { margin: 8px 0 2px; font-size: var(--t-xs); color: var(--ink-2); }
.detail pre { margin: 0; white-space: pre-wrap; word-break: break-all; font-family: var(--mono); background: var(--bg-2); padding: 4px 6px; border-radius: var(--r-sm); max-height: 260px; overflow: auto; }
.detail dl { display: grid; grid-template-columns: max-content 1fr; gap: 0 8px; margin: 0; }
.detail dt { color: var(--ink-3); }
.detail dd { margin: 0; font-family: var(--mono); word-break: break-all; }
.con { padding: 3px 8px; border-bottom: 1px solid var(--line); font-family: var(--mono); white-space: pre-wrap; word-break: break-word; }
.con[data-level="error"] { color: var(--danger); background: var(--danger-soft); }
.con[data-level="warning"] { color: var(--warn); background: var(--warn-soft); }
.con .at { color: var(--ink-3); }
.blank { padding: 12px; color: var(--ink-3); }
@media (max-width: 640px) {
  .panel-body { flex-direction: column; }
  .detail { border-left: 0; border-top: 1px solid var(--line); }
  .panel { height: 50%; }
}
`;

const SCRIPT = String.raw`
(() => {
  const STREAM = "browser";
  const TOUCH = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  const BANNER_MS = 4000;

  // ---- 親との話し方（MCP Apps） ----
  let nextId = 1;
  const waiting = new Map();
  const send = (m) => window.parent.postMessage(Object.assign({ jsonrpc: "2.0" }, m), "*");
  const request = (method, params) => {
    const id = nextId++;
    send({ id, method, params });
    return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
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
    const r = await request("tools/call", { name, arguments: args || {} });
    const t = r && r.content && r.content[0] && r.content[0].text;
    if (!r || r.isError) throw new Error(t || name + " が失敗しました");
    return JSON.parse(t);
  }

  /*STREAM_CLIENT*/

  // ---- 部品 ----
  const $ = (id) => document.getElementById(id);
  function h(tag, attrs, children) {
    const e = document.createElement(tag);
    for (const k of Object.keys(attrs || {})) {
      const v = attrs[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children || []) if (c) e.append(c);
    return e;
  }
  function bytes(n) {
    if (n === undefined || n === null) return "";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }
  let errorTimer = 0;
  function showError(text) {
    const el = $("error");
    el.hidden = !text;
    $("error-text").textContent = text || "";
    window.clearTimeout(errorTimer);
    if (text) errorTimer = window.setTimeout(() => { el.hidden = true; }, 8000);
  }

  // ---- 状態 ----
  /** Module が送ってくる様子（動いているか・タブ・ページの大きさ・AI に触らせない） */
  let view = { running: false, starting: true, aiBlocked: false, tabs: [], current: null, viewport: null, fit: false, fitByOther: false, log: { records: 0, console: 0 } };
  /** いま描いている絵の頭（{ seq, tab, width, height }） */
  let frame = null;
  let frames = 0;
  let progress = "";
  let stream = null;
  let wantFit = false;
  const canvas = $("screen");
  const g = canvas.getContext("2d");
  const stage = $("stage");
  const ime = $("ime");

  // ---- 絵 ----
  async function onFrame(buf) {
    const dv = new DataView(buf);
    const len = dv.getUint32(0);
    let head;
    try { head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, len))); }
    catch (e) { showError("絵の頭が読めませんでした"); return; }
    try {
      const bmp = await createImageBitmap(new Blob([new Uint8Array(buf, 4 + len)], { type: "image/jpeg" }));
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) { canvas.width = bmp.width; canvas.height = bmp.height; }
      g.drawImage(bmp, 0, 0);
      bmp.close();
      frame = head;
      frames += 1;
      canvas.dataset.seq = String(head.seq);
      canvas.dataset.tab = head.tab;
      canvas.dataset.pageWidth = String(head.width);
      canvas.dataset.pageHeight = String(head.height);
      canvas.dataset.frames = String(frames);
      layout();
      renderEmpty();
    } catch (e) {
      showError("絵を描けませんでした：" + e.message);
    } finally {
      // 描き終えた（描けなかった）——次の絵を頼む。返さないと Module は次を送らない
      if (stream) stream.send(JSON.stringify({ type: "ack", seq: head.seq }));
    }
  }

  /** 絵を出す場所に合わせて縮めて置く（縦横の比は保つ） */
  function layout() {
    if (!frame) return;
    const r = stage.getBoundingClientRect();
    const scale = Math.min(r.width / frame.width, r.height / frame.height);
    canvas.style.width = Math.max(1, Math.floor(frame.width * scale)) + "px";
    canvas.style.height = Math.max(1, Math.floor(frame.height * scale)) + "px";
  }

  /** 画面の座標 → ページの CSS ピクセル */
  function toPage(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    return { x: (clientX - r.left) / r.width * frame.width, y: (clientY - r.top) / r.height * frame.height };
  }

  function sendMsg(m) { if (stream) stream.send(JSON.stringify(m)); }
  function modifiers(e) { return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0); }

  // ---- マウスとタッチ ----
  const BUTTONS = ["left", "middle", "right"];
  const touches = new Map();
  let lastDown = { t: 0, x: 0, y: 0, n: 0 };
  let movePending = null;
  function flushMove() {
    const m = movePending; movePending = null;
    if (m) sendMsg(m);
  }
  function touchPoints() { return [...touches.entries()].map(([id, p]) => ({ id, x: p.x, y: p.y })); }

  canvas.addEventListener("pointerdown", (e) => {
    if (!frame) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const p = toPage(e.clientX, e.clientY);
    if (e.pointerType === "touch") {
      touches.set(e.pointerId, p);
      sendMsg({ type: "touch", event: "start", points: touchPoints(), modifiers: 0 });
      return;
    }
    const now = performance.now();
    const n = now - lastDown.t < 450 && Math.abs(p.x - lastDown.x) < 5 && Math.abs(p.y - lastDown.y) < 5 ? lastDown.n + 1 : 1;
    lastDown = { t: now, x: p.x, y: p.y, n };
    flushMove();
    sendMsg({ type: "mouse", event: "down", x: p.x, y: p.y, button: BUTTONS[e.button] || "left", buttons: e.buttons, clickCount: n, modifiers: modifiers(e) });
    // 文字は隠した入力欄で受ける（日本語の変換のため）。指の端末では画面のキーボードを勝手に出さない
    if (!TOUCH) ime.focus({ preventScroll: true });
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!frame) return;
    const p = toPage(e.clientX, e.clientY);
    if (e.pointerType === "touch") {
      if (!touches.has(e.pointerId)) return;
      touches.set(e.pointerId, p);
      const first = movePending === null;
      movePending = { type: "touch", event: "move", points: touchPoints(), modifiers: 0 };
      if (first) requestAnimationFrame(flushMove);
      return;
    }
    const first = movePending === null;
    movePending = { type: "mouse", event: "move", x: p.x, y: p.y, button: e.buttons & 1 ? "left" : e.buttons & 2 ? "right" : e.buttons & 4 ? "middle" : "none", buttons: e.buttons, modifiers: modifiers(e) };
    if (first) requestAnimationFrame(flushMove);
  });
  function pointerEnd(e, cancelled) {
    if (!frame) return;
    const p = toPage(e.clientX, e.clientY);
    if (e.pointerType === "touch") {
      if (!touches.has(e.pointerId)) return;
      touches.delete(e.pointerId);
      flushMove();
      sendMsg({ type: "touch", event: cancelled ? "cancel" : "end", points: touchPoints(), modifiers: 0 });
      return;
    }
    if (cancelled) return;
    flushMove();
    sendMsg({ type: "mouse", event: "up", x: p.x, y: p.y, button: BUTTONS[e.button] || "left", buttons: e.buttons, clickCount: lastDown.n, modifiers: modifiers(e) });
  }
  canvas.addEventListener("pointerup", (e) => pointerEnd(e, false));
  canvas.addEventListener("pointercancel", (e) => pointerEnd(e, true));
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("wheel", (e) => {
    if (!frame) return;
    e.preventDefault();
    const p = toPage(e.clientX, e.clientY);
    const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    sendMsg({ type: "mouse", event: "wheel", x: p.x, y: p.y, button: "none", deltaX: e.deltaX * k, deltaY: e.deltaY * k, modifiers: modifiers(e) });
  }, { passive: false });

  // ---- キーと文字（隠した入力欄） ----
  /** 文字を伴わないキー（そのままキーとして送る） */
  const SPECIAL = new Set(["Enter", "Backspace", "Tab", "Escape", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Insert"]);
  const KEYCODES = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34, Insert: 45 };
  function keyPair(key, code, keyCode, text, mods) {
    sendMsg({ type: "key", event: "down", key, code, keyCode, text, modifiers: mods || 0 });
    sendMsg({ type: "key", event: "up", key, code, keyCode, modifiers: mods || 0 });
  }
  ime.addEventListener("keydown", (e) => {
    if (e.isComposing || e.key === "Process" || e.key === "Unidentified" || e.keyCode === 229) return; // 変換中——入力欄に任せる
    const mods = modifiers(e);
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
    // 貼り付けはブラウザに任せる（paste で受ける）
    if ((e.ctrlKey || e.metaKey) && (e.key === "v" || e.key === "V")) return;
    if (!printable && !SPECIAL.has(e.key) && !(e.ctrlKey || e.metaKey || e.altKey) && !/^F\d+$/.test(e.key)) return;
    e.preventDefault();
    const text = e.key === "Enter" ? "\r" : printable ? e.key : undefined;
    sendMsg({ type: "key", event: "down", key: e.key, code: e.code, keyCode: e.keyCode || KEYCODES[e.key] || 0, text, modifiers: mods });
  });
  ime.addEventListener("keyup", (e) => {
    if (e.isComposing || e.key === "Process" || e.key === "Unidentified" || e.keyCode === 229) return;
    sendMsg({ type: "key", event: "up", key: e.key, code: e.code, keyCode: e.keyCode || KEYCODES[e.key] || 0, modifiers: modifiers(e) });
  });
  ime.addEventListener("input", (e) => {
    if (e.isComposing) return;
    const t = e.inputType;
    if (t === "insertText" || t === "insertReplacementText" || t === "insertFromPaste") { if (e.data) sendMsg({ type: "insertText", text: e.data }); }
    else if (t === "insertLineBreak" || t === "insertParagraph") keyPair("Enter", "Enter", 13, "\r");
    else if (t === "deleteContentBackward") keyPair("Backspace", "Backspace", 8);
    else if (t === "deleteContentForward") keyPair("Delete", "Delete", 46);
    ime.value = "";
  });
  ime.addEventListener("compositionend", (e) => {
    if (e.data) sendMsg({ type: "insertText", text: e.data });
    ime.value = "";
  });
  ime.addEventListener("paste", (e) => {
    e.preventDefault();
    const text = e.clipboardData && e.clipboardData.getData("text/plain");
    if (text) sendMsg({ type: "insertText", text });
  });

  // ---- 大きさと見えているか ----
  function stageSize() {
    const r = stage.getBoundingClientRect();
    return { width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)), dpr: window.devicePixelRatio || 1 };
  }
  let sizeTimer = 0;
  new ResizeObserver(() => {
    layout();
    window.clearTimeout(sizeTimer);
    sizeTimer = window.setTimeout(() => sendMsg(Object.assign({ type: "size" }, stageSize())), 120);
  }).observe(stage);
  document.addEventListener("visibilitychange", () => sendMsg({ type: "visible", visible: document.visibilityState === "visible" }));

  // ---- AI が触った ----
  let bannerTimer = 0;
  let aiCount = 0;
  function onAi(ev) {
    aiCount += 1;
    const b = $("ai-banner");
    b.replaceChildren(
      h("span", { text: "AI が操作中：" + ev.text }),
      ev.thread ? h("span", { class: "who", text: "（Thread " + ev.thread.slice(0, 8) + "）" }) : null,
      ev.thread ? h("button", { type: "button", text: "その会話を開く", onclick: () => openThread(ev.thread) }) : null,
    );
    b.dataset.count = String(aiCount);
    b.hidden = false;
    window.clearTimeout(bannerTimer);
    bannerTimer = window.setTimeout(() => { b.hidden = true; }, BANNER_MS);
    // 押した要素の枠（いま映しているタブのときだけ）
    if (ev.box && frame && ev.tab === frame.tab) {
      const r = canvas.getBoundingClientRect();
      const s = stage.getBoundingClientRect();
      const kx = r.width / frame.width, ky = r.height / frame.height;
      const box = h("div", { class: "ai-box", "data-testid": "ai-box" });
      box.style.left = (r.left - s.left + ev.box.x * kx - 2) + "px";
      box.style.top = (r.top - s.top + ev.box.y * ky - 2) + "px";
      box.style.width = (ev.box.width * kx + 4) + "px";
      box.style.height = (ev.box.height * ky + 4) + "px";
      stage.append(box);
      window.setTimeout(() => box.remove(), 1500);
    }
  }
  async function openThread(threadId) {
    try { await request("dev.banto/open-surface", { surface: "thread", threadId }); }
    catch (e) { showError("会話を開けませんでした：" + e.message); }
  }

  // ---- 上の帯 ----
  function render() {
    const tabs = $("tabs");
    tabs.replaceChildren(...view.tabs.map((t) => h("div", { class: "tab", role: "tab", "aria-selected": t.id === view.current ? "true" : "false", "data-tab": t.id }, [
      h("button", { class: "tab-name", title: t.url, onclick: () => { if (t.id !== view.current) sendMsg({ type: "tab", action: "select", tab: t.id }); } }, [
        h("span", { class: "tab-id", text: t.id }),
        document.createTextNode(t.title || t.url || "（空のタブ）"),
      ]),
      h("button", { class: "tab-act", text: "×", title: "タブを閉じる", "aria-label": t.id + " を閉じる", onclick: () => sendMsg({ type: "tab", action: "close", tab: t.id }) }),
    ])), h("button", { class: "tab-act", text: "＋", title: "新しいタブ", "aria-label": "新しいタブ", onclick: () => sendMsg({ type: "tab", action: "new" }) }));
    const cur = view.tabs.find((t) => t.id === view.current);
    const url = $("url");
    if (document.activeElement !== url) url.value = cur ? cur.url : "";
    const has = Boolean(cur);
    for (const id of ["back", "forward", "reload"]) $(id).disabled = !has;
    $("ai-blocked").checked = view.aiBlocked;
    $("block-note").hidden = !view.aiBlocked;
    $("fit").checked = view.fit;
    $("viewport").textContent = view.viewport ? "ページ " + view.viewport.width + "×" + view.viewport.height + (view.fitByOther ? "（ほかの画面に合わせています）" : "") : "";
    $("count-network").textContent = String(view.log.records);
    $("count-console").textContent = String(view.log.console);
    renderEmpty();
  }

  function renderEmpty() {
    const cur = view.tabs.find((t) => t.id === view.current);
    const showing = Boolean(frame && cur && frame.tab === cur.id && view.running);
    canvas.hidden = !showing;
    const empty = $("empty");
    empty.hidden = showing;
    if (showing) return;
    const start = $("start");
    start.hidden = true;
    let text;
    if (view.starting) text = "ブラウザを起こしています…" + (progress ? "\n" + progress : "");
    else if (!view.running) { text = "ブラウザは止まっています。" + (view.lastStop ? "（" + view.lastStop.reason + "）" : ""); start.hidden = false; }
    else if (!cur) text = "開いているページはありません。上の欄に URL を入れてください（例 localhost:3000）。";
    else text = "映しています…";
    $("empty-text").textContent = text;
  }

  $("url-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("url").value.trim();
    if (!v) return;
    $("url").blur();
    sendMsg({ type: "navigate", url: v });
  });
  $("back").addEventListener("click", () => sendMsg({ type: "history", action: "back" }));
  $("forward").addEventListener("click", () => sendMsg({ type: "history", action: "forward" }));
  $("reload").addEventListener("click", () => sendMsg({ type: "history", action: "reload" }));
  $("start").addEventListener("click", () => sendMsg({ type: "start" }));
  $("error-close").addEventListener("click", () => showError(""));
  $("ai-blocked").addEventListener("change", async (e) => {
    const on = e.target.checked;
    try { const r = await call("setAiBlocked", { blocked: on }); view.aiBlocked = r.aiBlocked; }
    catch (err) { showError("切り替えられませんでした：" + err.message); }
    render();
  });
  $("fit").addEventListener("change", (e) => {
    wantFit = e.target.checked;
    sendMsg({ type: "fit", on: wantFit });
  });
  let clearArmed = 0;
  $("clear-data").addEventListener("click", async () => {
    const b = $("clear-data");
    if (!clearArmed) {
      b.dataset.armed = "";
      b.textContent = "もう一度押すと消します";
      clearArmed = window.setTimeout(() => { clearArmed = 0; delete b.dataset.armed; b.textContent = "ブラウザの記録を消す"; }, 4000);
      return;
    }
    window.clearTimeout(clearArmed); clearArmed = 0; delete b.dataset.armed; b.textContent = "ブラウザの記録を消す";
    try {
      await call("clearBrowserData", {});
      frame = null;
      sendMsg({ type: "start" });
      if (panel) loadPanel();
    } catch (err) { showError("消せませんでした：" + err.message); }
  });
  $("keyboard").hidden = !TOUCH;
  $("keyboard").addEventListener("click", () => { ime.focus({ preventScroll: true }); });

  // ---- 通信とコンソールの欄 ----
  let panel = null;
  let selected = null;
  let loading = false;
  let again = false;
  function setPanel(name) {
    panel = panel === name ? null : name;
    $("show-network").setAttribute("aria-pressed", panel === "network" ? "true" : "false");
    $("show-console").setAttribute("aria-pressed", panel === "console" ? "true" : "false");
    $("panel-network").hidden = panel !== "network";
    $("panel-console").hidden = panel !== "console";
    if (panel) loadPanel();
  }
  $("show-network").addEventListener("click", () => setPanel("network"));
  $("show-console").addEventListener("click", () => setPanel("console"));
  $("net-filter").addEventListener("input", () => loadPanel());
  $("net-status").addEventListener("change", () => loadPanel());
  $("con-level").addEventListener("change", () => loadPanel());
  $("net-clear").addEventListener("click", async () => {
    try { await call("clearNetworkLog", {}); selected = null; loadPanel(); } catch (err) { showError("消せませんでした：" + err.message); }
  });
  $("con-clear").addEventListener("click", async () => {
    try { await call("clearNetworkLog", {}); loadPanel(); } catch (err) { showError("消せませんでした：" + err.message); }
  });
  $("har").addEventListener("click", saveHar);

  async function loadPanel() {
    if (!panel) return;
    if (loading) { again = true; return; }
    loading = true;
    try {
      if (panel === "network") await loadNetwork(); else await loadConsole();
    } catch (err) {
      showError("記録を読めませんでした：" + err.message);
    } finally {
      loading = false;
      if (again) { again = false; loadPanel(); }
    }
  }

  async function loadNetwork() {
    const args = { limit: 300 };
    const f = $("net-filter").value.trim();
    if (f) args.urlContains = f;
    const st = $("net-status").value;
    if (st) args.status = st;
    const r = await call("listNetworkRecords", args);
    const body = $("net-rows");
    if (r.records.length === 0) {
      body.replaceChildren(h("tr", {}, [h("td", { colspan: "6", class: "blank", text: r.total === 0 ? "まだ通信はありません" : "当てはまる通信はありません" })]));
    } else {
      body.replaceChildren(...r.records.map((rec) => {
        const status = rec.failed ? "失敗" : rec.status !== undefined ? String(rec.status) : rec.done ? "" : "…";
        const bad = Boolean(rec.failed) || (rec.status !== undefined && rec.status >= 400);
        return h("tr", { class: "row", "data-id": rec.id, "aria-selected": rec.id === selected ? "true" : "false", "data-bad": bad, onclick: () => { selected = rec.id; loadDetail(rec.id); markSelected(); } }, [
          h("td", { class: "s", text: status, title: rec.failed || rec.statusText || "" }),
          h("td", { text: rec.method }),
          h("td", { text: rec.type }),
          h("td", { class: "u", text: rec.url, title: rec.url }),
          h("td", { text: bytes(rec.encodedBytes) }),
          h("td", { text: rec.durationMs !== undefined ? Math.round(rec.durationMs) + " ms" : "" }),
        ]);
      }));
    }
    if (selected && r.records.some((x) => x.id === selected)) await loadDetail(selected);
  }
  function markSelected() {
    for (const tr of $("net-rows").querySelectorAll("tr.row")) tr.setAttribute("aria-selected", tr.dataset.id === selected ? "true" : "false");
  }

  function headersPre(hs) {
    const lines = Object.entries(hs || {}).map(([k, v]) => k + ": " + v);
    return h("pre", { text: lines.length ? lines.join("\n") : "（なし）" });
  }
  function bodyPre(text, info, base64) {
    if (text === undefined || text === null) return h("pre", { text: "（なし）" });
    let shown = base64 ? "（2進・base64）\n" + text.slice(0, 4000) : text;
    if (shown.length > 20000) shown = shown.slice(0, 20000) + "\n…（ここで切りました）";
    if (info && info.stored < info.size) shown += "\n…（記録は頭の " + bytes(info.stored) + " だけ。全体 " + bytes(info.size) + "）";
    return h("pre", { text: shown });
  }
  async function loadDetail(id) {
    const el = $("net-detail");
    el.hidden = false;
    let r;
    try { r = await call("getNetworkRecord", { id }); }
    catch (err) { el.replaceChildren(h("p", { class: "blank", text: err.message })); return; }
    if (selected !== id) return;
    const rec = r.record;
    const general = [["URL", rec.url], ["メソッド", rec.method], ["状態", rec.failed ? "失敗：" + rec.failed : (rec.status !== undefined ? rec.status + " " + (rec.statusText || "") : "終わっていない")], ["種類", rec.type], ["タブ", rec.tab], ["始まり", new Date(rec.startedAt).toLocaleTimeString()], ["時間", rec.durationMs !== undefined ? Math.round(rec.durationMs) + " ms" : ""], ["大きさ", bytes(rec.encodedBytes)]];
    const parts = [
      h("div", { style: "display:flex;gap:8px;align-items:center" }, [h("strong", { text: rec.id }), h("button", { class: "btn", type: "button", text: "閉じる", onclick: () => { selected = null; el.hidden = true; markSelected(); } })]),
      h("dl", {}, general.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: String(v) })])),
      h("h4", { text: "要求のヘッダ" }), headersPre(rec.requestHeaders),
      h("h4", { text: "応答のヘッダ" }), headersPre(rec.responseHeaders),
    ];
    if (rec.requestBody || r.requestBody) parts.push(h("h4", { text: "要求の本文" }), bodyPre(r.requestBody, rec.requestBody, rec.requestBody && rec.requestBody.base64));
    if (rec.kind === "http") {
      parts.push(h("h4", { text: "応答の本文" }), rec.bodyUnavailable && !r.responseBody ? h("pre", { text: "（取れませんでした：" + rec.bodyUnavailable + "）" }) : bodyPre(r.responseBody, rec.responseBody, rec.responseBody && rec.responseBody.base64));
    }
    if (rec.frames) parts.push(h("h4", { text: "フレーム" }), h("pre", { text: rec.frames.map((f) => (f.dir === "sent" ? "↑ " : "↓ ") + f.data).join("\n") || "（なし）" }));
    if (rec.messages) parts.push(h("h4", { text: "メッセージ" }), h("pre", { text: rec.messages.map((m) => (m.event || "message") + ": " + m.data).join("\n") || "（なし）" }));
    el.replaceChildren(...parts);
  }

  async function loadConsole() {
    const args = { limit: 300 };
    const lv = $("con-level").value;
    if (lv) args.level = lv;
    const r = await call("listConsoleRecords", args);
    const list = $("con-rows");
    if (r.entries.length === 0) { list.replaceChildren(h("div", { class: "blank", text: r.total === 0 ? "まだ出力はありません" : "当てはまる出力はありません" })); return; }
    list.replaceChildren(...r.entries.map((c) => h("div", { class: "con", "data-level": c.level, "data-id": c.id }, [
      h("span", { class: "at", text: new Date(c.at).toLocaleTimeString() + " " + c.tab + " " + (c.kind === "exception" ? "例外 " : "") }),
      document.createTextNode(c.text),
      c.url ? h("div", { class: "at", text: "at " + c.url + ":" + c.line }) : null,
      c.stack ? h("div", { class: "at", text: c.stack }) : null,
    ])));
  }

  async function saveHar() {
    try {
      const har = await call("exportHar", {});
      const d = new Date();
      const p = (n) => String(n).padStart(2, "0");
      const name = "browser-" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + ".har";
      const r = await request("ui/download-file", { contents: [{ type: "resource", resource: { uri: "banto-browser://har/" + name, mimeType: "application/json", text: JSON.stringify(har, null, 2) } }] });
      if (r && r.isError) throw new Error("取りやめたか、画面の外で断られました");
    } catch (err) { showError("HAR を保存できませんでした：" + err.message); }
  }

  // ---- 流れ ----
  const STATE_TEXT = { connecting: "繋いでいます…", open: "繋がっています", reconnecting: "繋ぎ直しています…", ended: "閉じています" };
  function setStreamState(state, detail) {
    const el = $("state");
    el.dataset.state = state;
    el.textContent = STATE_TEXT[state] || state;
    el.title = (detail && detail.reason) || "";
  }
  let logTimer = 0;
  function onText(msg) {
    if (msg.type === "state") {
      view = msg;
      if (!view.starting) progress = "";
      // 繋ぎ直したあとも、この画面で入れていた「画面に合わせる」を保つ
      if (view.fitByOther) wantFit = false;
      else if (wantFit && !view.fit) sendMsg({ type: "fit", on: true });
      render();
    } else if (msg.type === "progress") {
      progress = msg.message;
      renderEmpty();
    } else if (msg.type === "ai") {
      onAi(msg);
    } else if (msg.type === "error") {
      showError(msg.message);
    } else if (msg.type === "log") {
      view.log = { records: msg.records, console: msg.console };
      $("count-network").textContent = String(msg.records);
      $("count-console").textContent = String(msg.console);
      window.clearTimeout(logTimer);
      logTimer = window.setTimeout(loadPanel, 200);
    }
  }

  function openView() {
    const size = stageSize();
    stream = openStream({ request }, {
      name: STREAM,
      params: { width: size.width, height: size.height, dpr: size.dpr, visible: document.visibilityState === "visible" },
      onMessage(data) {
        if (typeof data === "string") {
          let msg;
          try { msg = JSON.parse(data); } catch { showError("Module から読めない知らせが届きました"); return; }
          onText(msg);
          return;
        }
        onFrame(data);
      },
      onState(state, detail) {
        setStreamState(state, detail);
        // 繋ぎ直したときは、いまの大きさ・見えているかを伝え直す（札の params は最初のまま）
        if (state === "open") {
          frame = null;
          sendMsg(Object.assign({ type: "size" }, stageSize()));
          sendMsg({ type: "visible", visible: document.visibilityState === "visible" });
          if (wantFit) sendMsg({ type: "fit", on: true });
        }
      },
    });
  }

  (async () => {
    try {
      const init = await request("ui/initialize", {
        protocolVersion: "2026-01-26",
        appInfo: { name: "banto-browser", version: "0.1.0" },
        appCapabilities: { availableDisplayModes: ["fullscreen"] },
      });
      applyAppearance((init && init.hostContext) || {});
      send({ method: "ui/notifications/initialized", params: {} });
    } catch (e) {
      $("app").textContent = "画面を始められませんでした：" + e.message;
      return;
    }
    render();
    openView();
  })();
})();
`;

export function browserViewHtml(): string {
  // 関数で渡す——中身の `$` を置き換えの記号として読ませない
  const script = SCRIPT.replace("/*STREAM_CLIENT*/", () => STREAM_CLIENT_SCRIPT);
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>${PAGE_CSS}</style>
</head>
<body>
<div id="app">
  <div class="bar">
    <button class="btn" id="back" type="button" title="戻る" aria-label="戻る">←</button>
    <button class="btn" id="forward" type="button" title="進む" aria-label="進む">→</button>
    <button class="btn" id="reload" type="button" title="読み直す" aria-label="読み直す">⟳</button>
    <form class="url" id="url-form"><input id="url" type="text" inputmode="url" autocomplete="off" spellcheck="false" aria-label="URL" placeholder="URL（例 localhost:3000）" /></form>
    <span class="state" id="state" data-state="connecting" data-testid="browser-state">繋いでいます…</span>
  </div>
  <div class="bar">
    <label class="toggle block" title="AI の操作の道具（開く・操作・評価・タブの切り替えと閉じる）を断る"><input type="checkbox" id="ai-blocked" data-testid="ai-blocked" />AI に触らせない</label>
    <label class="toggle" title="ページの大きさをこの画面に合わせる（携帯で見るとき）"><input type="checkbox" id="fit" data-testid="fit" />画面に合わせる</label>
    <span class="dim" id="viewport" data-testid="viewport"></span>
    <span style="flex:1"></span>
    <button class="btn" id="clear-data" type="button" title="Cookie・localStorage 等のログイン状態と、通信の記録を消す">ブラウザの記録を消す</button>
  </div>
  <div class="tabs" id="tabs" role="tablist" aria-label="タブ"></div>
  <div class="notice" id="block-note" data-testid="block-note" hidden>
    <p>AI の操作（開く・操作・評価・タブの切り替えと閉じる）を断っています。読む道具（ツリー・写し・通信・コンソール）は断りません。<strong>これは境界ではありません</strong>——コンテナの中の AI は Shell からこのブラウザに直接繋げ、ログイン状態のファイルも読めます。</p>
  </div>
  <div class="error" id="error" role="status" hidden><span id="error-text"></span><button class="tab-act" id="error-close" type="button" aria-label="閉じる">×</button></div>
  <div class="stage" id="stage">
    <canvas id="screen" data-testid="browser-screen" tabindex="-1" hidden></canvas>
    <div class="empty" id="empty" data-testid="browser-empty"><p id="empty-text" style="white-space:pre-line">繋いでいます…</p><button class="btn" id="start" type="button" hidden>ブラウザを起こす</button></div>
    <div class="ai-banner" id="ai-banner" data-testid="ai-banner" role="status" hidden></div>
    <textarea class="ime" id="ime" data-testid="browser-input" aria-label="ページに文字を送る" autocapitalize="off" autocomplete="off" spellcheck="false"></textarea>
  </div>
  <div class="panel" id="panel-network" data-testid="network-panel" hidden>
    <div class="panel-bar">
      <input type="search" id="net-filter" placeholder="URL で絞る" aria-label="URL で絞る" />
      <select id="net-status" aria-label="状態で絞る"><option value="">すべて</option><option value="error">エラー（失敗・4xx・5xx）</option><option value="failed">届かなかった</option></select>
      <span style="flex:1"></span>
      <button class="btn" id="har" type="button" data-testid="save-har">HAR で保存</button>
      <button class="btn" id="net-clear" type="button">記録を消す</button>
    </div>
    <div class="panel-body">
      <div class="list"><table><thead><tr><th>状態</th><th>メソッド</th><th>種類</th><th>URL</th><th>大きさ</th><th>時間</th></tr></thead><tbody id="net-rows"></tbody></table></div>
      <div class="detail" id="net-detail" data-testid="network-detail" hidden></div>
    </div>
  </div>
  <div class="panel" id="panel-console" data-testid="console-panel" hidden>
    <div class="panel-bar">
      <select id="con-level" aria-label="段で絞る"><option value="">すべて</option><option value="error">エラー</option><option value="warning">警告</option><option value="info">info</option><option value="log">log</option><option value="debug">debug</option></select>
      <span style="flex:1"></span>
      <button class="btn" id="con-clear" type="button">記録を消す</button>
    </div>
    <div class="panel-body"><div class="list" id="con-rows"></div></div>
  </div>
  <div class="foot">
    <button class="btn" id="show-network" type="button" aria-pressed="false">通信<span class="count" id="count-network">0</span></button>
    <button class="btn" id="show-console" type="button" aria-pressed="false">コンソール<span class="count" id="count-console">0</span></button>
    <span style="flex:1"></span>
    <button class="btn" id="keyboard" type="button" hidden>キーボード</button>
  </div>
</div>
<script>${script}</script>
</body>
</html>
`;
}
