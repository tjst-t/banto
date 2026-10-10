// **入口「ターミナル」の画面**（launcher、v4-modules.md §4.6「画面」）。
//
// 上にセッションの切り替え（足す・名前を変える・閉じる）、下に端末（xterm.js）。打鍵と出力は共通の流れの口
// （アーキ仕様 §5.8、`@banto/stream-client` を埋め込む）に乗る。流れの名前は `terminal`、params は
// `{ session, cols, rows }`。画面のキーボードが出る端末（`(hover: none) and (pointer: coarse)`——banto の画面の
// `useTouchKeyboard` と同じ見分け）では、端末の下（＝画面のキーボードのすぐ上）にキーの帯を出す。
//
// xterm.js はこの HTML に埋め込む（Canvas の iframe は外から読み込めない。数百 KB あるので Shell には足さず、
// 任意の Terminal にだけ載せる——§4.6「Shell に足さず、別の Module にする」）。
// 色と段は banto が MCP Apps の標準の名前で渡す（v4-frontend.md §6.27）。

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { STREAM_CLIENT_SCRIPT } from "@banto/stream-client";

export const TERMINAL_APP_URI = "ui://banto-terminal/terminal";

const require = createRequire(import.meta.url);
const asset = (id: string) => readFileSync(require.resolve(id), "utf8");

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
body { font: var(--t-sm)/1.6 var(--sans); color: var(--ink); background: var(--bg); overflow: hidden; }
button, input { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

#app { display: flex; flex-direction: column; height: 100%; }

/* ---- 上：セッションの切り替え ---- */
.bar { display: flex; align-items: center; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.tabs { display: flex; gap: 2px; flex-wrap: wrap; min-width: 0; }
.tab { display: inline-flex; align-items: center; height: 28px; border-radius: var(--r-sm); border: 1px solid transparent; }
.tab[aria-selected="true"] { background: var(--bg-3); border-color: var(--line); }
.tab-name { height: 100%; padding: 0 10px; border: 0; background: transparent; cursor: pointer; font-family: var(--mono); }
.tab-act { height: 100%; width: 24px; border: 0; background: transparent; color: var(--ink-3); cursor: pointer; border-radius: var(--r-sm); }
.tab-act:hover { color: var(--ink); background: var(--bg-2); }
.tab-act[data-armed] { color: var(--danger); background: var(--danger-soft); }
.tab input { height: 24px; width: 12ch; margin: 0 4px; padding: 0 6px; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--bg); font-family: var(--mono); }
.btn { height: 28px; padding: 0 10px; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--bg); cursor: pointer; white-space: nowrap; }
.btn:hover { background: var(--bg-3); }
.btn.icon { width: 28px; padding: 0; font-size: 16px; line-height: 1; }
.spacer { flex: 1; }
.state { color: var(--ink-3); font-size: var(--t-xs); white-space: nowrap; }
.state[data-state="open"] { color: var(--ink-2); }
.state[data-state="reconnecting"] { color: var(--warn); }

/* ---- お知らせ・消えたセッション ---- */
.notice { display: flex; gap: 8px; align-items: flex-start; margin: 6px 8px 0; padding: 6px 10px; border-radius: var(--r-md); background: var(--accent-soft); font-size: var(--t-xs); }
.notice p { margin: 0; flex: 1; }
.lost { margin: 6px 8px 0; padding: 6px 10px; border-radius: var(--r-md); background: var(--warn-soft); font-size: var(--t-xs); }
.lost p { margin: 0 0 4px; }
.lost ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.lost li { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.lost code { font-family: var(--mono); }
.lost .where { color: var(--ink-2); overflow-wrap: anywhere; }
.error { margin: 6px 8px 0; padding: 6px 10px; border-radius: var(--r-md); background: var(--danger-soft); color: var(--danger); font-size: var(--t-xs); }

/* ---- キーの帯（画面のキーボードが出る端末だけ） ---- */
.keys { display: grid; grid-template-columns: repeat(8, 1fr); gap: 3px; padding: 4px 4px calc(4px + env(safe-area-inset-bottom)); border-top: 1px solid var(--line); background: var(--bg-2); }
.key { min-width: 0; height: 38px; padding: 0; border: 0; border-radius: var(--r-sm); background: var(--bg); font-family: var(--mono); font-size: 13px; touch-action: manipulation; user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent; }
.key:active, .key[data-down] { background: var(--bg-3); }
.key.mod { font-size: 11px; letter-spacing: .02em; }
.key[data-mod="once"] { background: var(--accent-soft); color: var(--accent); }
.key[data-mod="lock"] { background: var(--accent); color: var(--bg); }

/* ---- 端末 ---- */
.term-wrap { position: relative; flex: 1; min-height: 0; padding: 4px 0 0 6px; }
#term { position: absolute; inset: 4px 0 0 6px; }
/* 指の縦の動きは自分でスクロールに換える（下の「指でのスクロール」）。ブラウザに持っていかせない */
@media (hover: none) and (pointer: coarse) { #term { touch-action: none; } }
.empty { padding: 24px 16px; color: var(--ink-2); max-width: 52ch; }
.empty p { margin: 0 0 8px; }
`;

const SCRIPT = String.raw`
(() => {
  const STREAM = "terminal";
  const GONE = 4404;
  const VIEW_STATE = "dev.banto/view-state";
  const NOTICE_KEY = "banto-terminal-ai-notice-seen";
  const TOUCH = window.matchMedia("(hover: none) and (pointer: coarse)").matches;

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
    applyTermTheme();
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

  // ---- 端末 ----
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "monospace",
    fontSize: TOUCH ? 13 : 14,
    scrollback: 10000,
    allowProposedApi: false,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($("term"));
  function applyTermTheme() {
    const cs = getComputedStyle(document.documentElement);
    const bg = cs.getPropertyValue("--bg").trim();
    const fg = cs.getPropertyValue("--ink").trim();
    const probe = document.body;
    // 変数の中身は var(...) のままのことがあるので、実際に塗られた色を読む
    const bodyBg = getComputedStyle(probe).backgroundColor || bg;
    const bodyFg = getComputedStyle(probe).color || fg;
    term.options.theme = { background: bodyBg, foreground: bodyFg, cursor: bodyFg, selectionBackground: "rgba(128,128,128,.35)" };
  }
  applyTermTheme();

  let session = null;
  let stream = null;
  let streamState = "connecting";
  /**
   * 帯の修飾キー（Ctrl・Alt）。Termux・Blink に倣い、1回押すと次の1打にだけ効き（once）、続けて2回押すと
   * 押し続けた形で残る（lock、もう一度押すと外れる）。画面のキーボードで打った文字にも、帯のキーにも効く
   */
  const mods = { ctrl: "off", alt: "off" };

  function ctrlOf(data) {
    if (data.length !== 1) return data;
    const c = data.toUpperCase().charCodeAt(0);
    // @ A-Z [ \ ] ^ _ → 制御文字、? → DEL、空白 → NUL
    if (c >= 64 && c <= 95) return String.fromCharCode(c - 64);
    if (data === "?") return "\x7f";
    if (data === " ") return "\x00";
    return data;
  }
  /** 修飾キーを効かせる。once のものはここで外す */
  function applyMods(data) {
    if (mods.ctrl !== "off") data = ctrlOf(data);
    if (mods.alt !== "off") data = "\x1b" + data;
    for (const k of ["ctrl", "alt"]) if (mods[k] === "once") setMod(k, "off");
    return data;
  }
  function sendRaw(data) {
    if (stream) stream.send(JSON.stringify({ type: "input", data }));
  }
  function sendInput(data) {
    if (!stream) return;
    sendRaw(applyMods(data));
  }
  term.onData(sendInput);
  // 選んだ文字のコピー（Ctrl+Shift+C）・貼り付け（Ctrl+Shift+V はブラウザの貼り付けに任せる）
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown" || !e.ctrlKey || !e.shiftKey) return true;
    if (e.code === "KeyC") { copySelection(); return false; }
    if (e.code === "KeyV") return false;
    return true;
  });
  async function copySelection() {
    const text = term.getSelection();
    if (!text) return;
    try { await navigator.clipboard.writeText(text); flash("選んだ文字をコピーしました"); }
    catch (e) { flash("コピーできませんでした：" + e.message); }
  }

  function sendSize() {
    if (stream) stream.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  }
  let fitTimer = 0;
  new ResizeObserver(() => {
    window.clearTimeout(fitTimer);
    fitTimer = window.setTimeout(() => {
      try { fit.fit(); } catch {}
      sendSize();
    }, 60);
  }).observe($("term"));

  // ---- 指でのスクロール（携帯） ----
  // xterm.js は指の縦の動きで履歴を動かさない（携帯で「スワイプでスクロールできない」、2026-10-10 ユーザー報告）。
  // 指の動きを行に換えて自分で動かす。全画面の物（vim・less・man 等、alternate の画面）は履歴を持たないので、Termux と
  // 同じく ↑・↓ を送る。少し動いてから（8px）スクロールとみなし、動かさずに離した指は今までどおりタップ（キーボードを出す）
  if (TOUCH) {
    const el = $("term");
    let startY = 0, lastY = 0, lastT = 0, acc = 0, scrolling = false, velocity = 0, glide = 0;
    const cellHeight = () => Math.max(8, el.clientHeight / Math.max(1, term.rows));
    function scrollBy(lines) {
      if (!lines) return;
      if (term.buffer.active.type === "alternate") {
        const key = (term.modes.applicationCursorKeysMode ? "\x1bO" : "\x1b[") + (lines < 0 ? "A" : "B");
        sendRaw(key.repeat(Math.min(Math.abs(lines), 20)));
      } else {
        term.scrollLines(lines);
      }
    }
    function move(dy) {
      acc += dy;
      const h = cellHeight();
      const lines = Math.trunc(acc / h);
      if (lines) { acc -= lines * h; scrollBy(lines); }
    }
    el.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) return;
      window.cancelAnimationFrame(glide);
      startY = lastY = e.touches[0].clientY;
      lastT = performance.now();
      acc = 0; velocity = 0; scrolling = false;
    }, { passive: true, capture: true });
    el.addEventListener("touchmove", (e) => {
      if (e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
      if (!scrolling && Math.abs(y - startY) < 8) return;
      scrolling = true;
      e.preventDefault();
      e.stopPropagation();
      const now = performance.now();
      const dy = lastY - y; // 指を上へ＝先（下の行）へ
      // 速さは px/ms。指の速さの上限ほど（3px/ms）で抑える——続けざまの出来事で桁違いに滑らないように
      velocity = Math.max(-3, Math.min(3, dy / Math.max(1, now - lastT)));
      lastY = y; lastT = now;
      move(dy);
    }, { passive: false, capture: true });
    el.addEventListener("touchend", (e) => {
      if (!scrolling) return;
      e.preventDefault(); // スクロールした指でタップ扱いにしない
      scrolling = false;
      // 指を離したあとも少し滑らせる（携帯のスクロールと同じ手ざわり）
      let v = velocity * 16;
      const step = () => {
        if (Math.abs(v) < 0.5) return;
        move(v);
        v *= 0.92;
        glide = window.requestAnimationFrame(step);
      };
      glide = window.requestAnimationFrame(step);
    }, { passive: false, capture: true });
  }

  // ---- 流れ ----
  const STATE_TEXT = { connecting: "connecting…", open: "connected", reconnecting: "reconnecting…", ended: "closed" };
  function setStreamState(state, detail) {
    streamState = state;
    const el = $("state");
    el.dataset.state = state;
    el.textContent = STATE_TEXT[state] || state;
    el.title = (detail && detail.reason) || "";
  }
  function openSession(name) {
    if (stream) { stream.close(); stream = null; }
    session = name;
    term.reset();
    try { fit.fit(); } catch {}
    send({ method: VIEW_STATE, params: { state: { session: name } } });
    render();
    if (!name) { setStreamState("ended"); return; }
    // openStream は中で onState を同じ流れのまま呼ぶ（「繋いでいます」）ので、先に宣言しておく
    let opened = null;
    opened = openStream({ request }, {
      name: STREAM,
      params: { session: name, cols: term.cols, rows: term.rows },
      onMessage(data) {
        if (typeof data === "string") return;
        term.write(new Uint8Array(data));
      },
      onState(state, detail) {
        if (opened !== null && stream !== opened && stream !== null) return;
        setStreamState(state, detail);
        // 繋ぎ直したときは、いまの大きさを伝え直す（札の params は最初の大きさのまま）
        if (state === "open") sendSize();
        // セッションが閉じられた（シェルを exit した・別の画面で閉じた）——一覧を取り直す
        if (state === "ended" && detail && detail.code === GONE) refresh();
      },
    });
    stream = opened;
    if (!TOUCH) term.focus();
  }

  // ---- セッションの一覧 ----
  let sessions = [];
  let lost = [];
  let editing = null;
  const armed = new Map();
  let error = "";
  let flashText = "";
  let flashTimer = 0;
  function flash(text) {
    flashText = text; render();
    window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => { flashText = ""; render(); }, 3000);
  }

  async function act(fn) {
    try { error = ""; const r = await fn(); if (r) { sessions = r.sessions; lost = r.lost; } return true; }
    catch (e) { error = e.message; render(); return false; }
  }
  async function refresh() {
    await act(() => call("listSessions", {}));
    if (session && !sessions.some((s) => s.name === session)) {
      // 見ていたセッションが無くなった
      if (stream) { stream.close(); stream = null; }
      session = null;
      setStreamState("ended");
    }
    render();
  }
  function nextName() {
    for (let i = 2; ; i++) { const n = "s" + i; if (!sessions.some((s) => s.name === n) && !lost.some((s) => s.name === n)) return n; }
  }
  async function addSession() {
    const name = sessions.length === 0 && !lost.some((s) => s.name === "main") ? "main" : nextName();
    if (await act(() => call("createSession", { name, cols: term.cols, rows: term.rows }))) openSession(name);
  }
  async function recreate(k) {
    if (await act(() => call("createSession", { name: k.name, cols: term.cols, rows: term.rows }))) openSession(k.name);
  }
  async function forget(k) {
    await act(() => call("closeSession", { name: k.name }));
    render();
  }
  async function closeSession(name) {
    if (!armed.has(name)) {
      armed.set(name, window.setTimeout(() => { armed.delete(name); render(); }, 4000));
      render();
      return;
    }
    window.clearTimeout(armed.get(name)); armed.delete(name);
    const wasCurrent = session === name;
    if (wasCurrent && stream) { stream.close(); stream = null; }
    if (await act(() => call("closeSession", { name }))) {
      if (wasCurrent) openSession(sessions[0] ? sessions[0].name : null);
      else render();
    }
  }
  async function commitRename(from, to) {
    editing = null;
    to = to.trim();
    if (!to || to === from) { render(); return; }
    if (await act(() => call("renameSession", { name: from, newName: to }))) {
      // 繋ぎ直すときに古い名前で頼まないように、新しい名前で繋ぎ直す（写しが先に来るので見た目は変わらない）
      if (session === from) { openSession(to); return; }
    }
    render();
  }

  function render() {
    const tabs = $("tabs");
    tabs.replaceChildren(...sessions.map((s) => {
      const selected = s.name === session;
      const children = [];
      if (editing === s.name) {
        const input = h("input", { value: s.name, "aria-label": "新しい名前", "data-testid": "rename-input" });
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") commitRename(s.name, input.value);
          if (e.key === "Escape") { editing = null; render(); }
        });
        input.addEventListener("blur", () => { if (editing === s.name) commitRename(s.name, input.value); });
        children.push(input);
        setTimeout(() => { input.focus(); input.select(); });
      } else {
        children.push(h("button", { class: "tab-name", text: s.name, title: s.cwd, onclick: () => { if (session !== s.name) openSession(s.name); } }));
        children.push(h("button", { class: "tab-act", text: "✎", title: "名前を変える", "aria-label": s.name + " の名前を変える", onclick: () => { editing = s.name; render(); } }));
        children.push(h("button", {
          class: "tab-act", text: "×", "data-armed": armed.has(s.name),
          title: armed.has(s.name) ? "もう一度押すと閉じます（中のシェルは終わります）" : "閉じる",
          "aria-label": armed.has(s.name) ? s.name + " を本当に閉じる" : s.name + " を閉じる",
          onclick: () => closeSession(s.name),
        }));
      }
      return h("div", { class: "tab", role: "tab", "aria-selected": selected ? "true" : "false", "data-session": s.name }, children);
    }));

    const lostEl = $("lost");
    lostEl.hidden = lost.length === 0;
    if (lost.length > 0) {
      lostEl.replaceChildren(
        h("p", { text: "前にあったセッションが、いまはありません（コンテナを起こし直した・シェルを終えた）。同じ名前と作業ディレクトリで作り直せます。" }),
        h("ul", {}, lost.map((k) => h("li", { "data-lost": k.name }, [
          h("code", { text: k.name }),
          h("span", { class: "where", text: k.cwd }),
          h("button", { class: "btn", text: "作り直す", onclick: () => recreate(k) }),
          h("button", { class: "btn", text: "控えから消す", onclick: () => forget(k) }),
        ]))),
      );
    }
    const errEl = $("error");
    errEl.hidden = !error && !flashText;
    errEl.className = error ? "error" : "notice";
    errEl.textContent = error || flashText;

    const empty = !session;
    $("empty").hidden = !empty || lost.length > 0;
    $("term").style.visibility = empty ? "hidden" : "visible";
  }

  // ---- AI も読める、のお知らせ（一度だけ） ----
  function setupNotice() {
    let seen = false;
    try { seen = window.localStorage.getItem(NOTICE_KEY) === "1"; } catch {}
    const el = $("notice");
    el.hidden = seen;
    $("notice-close").addEventListener("click", () => {
      el.hidden = true;
      try { window.localStorage.setItem(NOTICE_KEY, "1"); } catch {}
    });
  }

  // ---- キーの帯 ----
  // 形は Android の Termux の既定（2段・8列、横に流さない）に倣い、修飾キーは iOS の Blink Shell・Termux に倣って
  // 1回で次の1打だけ・2回で押し続け。矢印・BS は長押しで繰り返す。置き場は端末の下——banto は画面のキーボードが
  // 出るとレイアウトを縮める（interactive-widget=resizes-content）ので、帯はキーボードのすぐ上に来る
  function setMod(k, state) {
    mods[k] = state;
    const b = $("key-" + k);
    if (!b) return;
    b.dataset.mod = state;
    b.setAttribute("aria-pressed", state === "off" ? "false" : "true");
  }
  let lastModTap = { k: null, at: 0 };
  function tapMod(k) {
    const now = Date.now();
    const twice = lastModTap.k === k && now - lastModTap.at < 350;
    lastModTap = { k, at: now };
    if (mods[k] === "lock") setMod(k, "off");
    else if (mods[k] === "once") setMod(k, twice ? "lock" : "off");
    else setMod(k, "once");
  }
  /** 矢印などの CSI。修飾があれば xterm の形（ESC [ 1 ; <m> X）にする */
  function csiKey(final, tilde) {
    return () => {
      const m = 1 + (mods.alt !== "off" ? 2 : 0) + (mods.ctrl !== "off" ? 4 : 0);
      for (const k of ["ctrl", "alt"]) if (mods[k] === "once") setMod(k, "off");
      if (tilde) return m > 1 ? "\x1b[" + tilde + ";" + m + "~" : "\x1b[" + tilde + "~";
      if (m > 1) return "\x1b[1;" + m + final;
      return (term.modes.applicationCursorKeysMode ? "\x1bO" : "\x1b[") + final;
    };
  }
  const plain = (d) => () => applyMods(d);
  function setupKeys() {
    const bar = $("keys");
    if (!TOUCH) { bar.hidden = true; return; }
    bar.hidden = false;
    // [表示, 読み上げ, 送るもの（関数）| 修飾キーの名前, 長押しで繰り返すか]
    const KEYS = [
      ["ESC", "Esc", plain("\x1b")], ["/", "/", plain("/")], ["-", "-", plain("-")], ["|", "|", plain("|")],
      ["HOME", "Home", csiKey("H")], ["↑", "↑", csiKey("A"), true], ["END", "End", csiKey("F")], ["PGUP", "Page Up", csiKey(null, "5")],
      ["TAB", "Tab", plain("\t")], ["CTRL", "Ctrl", "ctrl"], ["ALT", "Alt", "alt"], ["~", "~", plain("~")],
      ["←", "←", csiKey("D"), true], ["↓", "↓", csiKey("B"), true], ["→", "→", csiKey("C"), true], ["PGDN", "Page Down", csiKey(null, "6")],
    ];
    for (const [label, name, make, repeat] of KEYS) {
      const isMod = typeof make === "string";
      const b = h("button", { class: isMod || label.length > 2 ? "key mod" : "key", type: "button", text: label, "data-key": name, "aria-label": name });
      if (isMod) { b.id = "key-" + make; b.dataset.mod = "off"; b.setAttribute("aria-pressed", "false"); }
      let timer = 0, interval = 0, fired = false;
      const stop = () => { window.clearTimeout(timer); window.clearInterval(interval); timer = interval = 0; delete b.dataset.down; };
      // 押しても端末から焦点を外さない（画面のキーボードを閉じない）
      b.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        if (isMod || !repeat) return;
        b.dataset.down = "";
        fired = false;
        timer = window.setTimeout(() => {
          interval = window.setInterval(() => { fired = true; sendRaw(make()); }, 60);
        }, 400);
      });
      b.addEventListener("pointerup", stop);
      b.addEventListener("pointercancel", stop);
      b.addEventListener("pointerleave", stop);
      b.addEventListener("click", () => {
        if (isMod) { tapMod(make); term.focus(); return; }
        if (fired) { fired = false; term.focus(); return; } // 長押しで繰り返した分は、離したときに1回足さない
        sendRaw(make());
        term.focus();
      });
      bar.append(b);
    }
    // 選んだ文字のコピーは上の帯に置く（画面のキーボードの端末だけ）
    $("copy").hidden = false;
    $("copy").addEventListener("pointerdown", (e) => e.preventDefault());
    $("copy").addEventListener("click", () => copySelection());
  }

  (async () => {
    let initial = null;
    try {
      const init = await request("ui/initialize", {
        protocolVersion: "2026-01-26",
        appInfo: { name: "banto-terminal", version: "0.1.0" },
        appCapabilities: { availableDisplayModes: ["fullscreen"] },
      });
      const ctx = (init && init.hostContext) || {};
      applyAppearance(ctx);
      const saved = ctx[VIEW_STATE];
      if (saved && typeof saved.session === "string") initial = saved.session;
      send({ method: "ui/notifications/initialized", params: {} });
    } catch (e) {
      $("app").textContent = "画面を始められませんでした：" + e.message;
      return;
    }
    setupNotice();
    setupKeys();
    $("add").addEventListener("click", addSession);
    try { fit.fit(); } catch {}
    await refresh();
    if (error) return;
    // 何も無い（初めて）なら main を作る。消えたものがあれば、作り直すかは人が決める
    if (sessions.length === 0 && lost.length === 0) {
      if (await act(() => call("createSession", { name: "main", cols: term.cols, rows: term.rows }))) openSession("main");
      return;
    }
    const pick = sessions.find((s) => s.name === initial) || sessions.find((s) => s.name === "main") || sessions[0];
    openSession(pick ? pick.name : null);
  })();
})();
`;

export function terminalAppHtml(): string {
  // 関数で渡す——中身の `$` を置き換えの記号として読ませない
  const script = SCRIPT.replace("/*STREAM_CLIENT*/", () => STREAM_CLIENT_SCRIPT);
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>${asset("@xterm/xterm/css/xterm.css")}${PAGE_CSS}</style>
</head>
<body>
<div id="app">
  <div class="bar">
    <div class="tabs" id="tabs" role="tablist" aria-label="セッション"></div>
    <button class="btn icon" id="add" type="button" title="セッションを足す" aria-label="セッションを足す">+</button>
    <button class="btn" id="copy" type="button" title="選んだ文字をコピー" hidden>コピー</button>
    <span class="spacer"></span>
    <span class="state" id="state" data-state="connecting" data-testid="terminal-state">繋いでいます…</span>
  </div>
  <div class="notice" id="notice" data-testid="terminal-ai-notice" hidden>
    <p>この Project の AI も、このセッションを読めますし打てます（Shell から <code>tmux -L banto-terminal</code> で）。秘密を打つときは気をつけてください。</p>
    <button class="tab-act" id="notice-close" type="button" aria-label="お知らせを閉じる">×</button>
  </div>
  <div id="lost" class="lost" data-testid="terminal-lost" hidden></div>
  <div id="error" class="error" role="status" hidden></div>
  <div class="term-wrap">
    <div class="empty" id="empty" hidden><p>開いているセッションがありません。</p><p>「+」でセッションを作ります。</p></div>
    <div id="term" data-testid="terminal"></div>
  </div>
  <div class="keys" id="keys" data-testid="terminal-keys" role="toolbar" aria-label="キー" hidden></div>
</div>
<script>${asset("@xterm/xterm/lib/xterm.js")}</script>
<script>${asset("@xterm/addon-fit/lib/addon-fit.js")}</script>
<script>${script}</script>
</body>
</html>
`;
}
