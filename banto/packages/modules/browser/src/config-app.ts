// Browser の設定画面（Project の設定に出る。MCP Apps の約束——postMessage の JSON-RPC——だけで親と話す。
// publish-caddy の画面と同じ作り。依存を足さない、規則10）。
//
// 決めるもの：人の新しいタブ（＋）と URL 欄の検索に使う検索エンジン（v4-modules.md §4.1「新しいタブと URL 欄の検索」）。
// 中身は getSettings・setSettings（search.ts が確かめる）。

export const CONFIG_APP_URI = "ui://banto-browser/config";

export const CONFIG_APP_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<style>
  :root {
    color-scheme: light dark;
    --ink: var(--color-text-primary, var(--mcp-ui-color-text, CanvasText));
    --line: var(--color-border-primary, var(--mcp-ui-color-border, rgba(128,128,128,.35)));
    --danger: var(--color-text-danger, var(--mcp-ui-color-danger, #c0392b));
  }
  :root[data-theme="light"] { color-scheme: light; }
  :root[data-theme="dark"] { color-scheme: dark; }
  option, optgroup { background-color: var(--color-background-primary, var(--mcp-ui-color-surface, Canvas)); color: var(--ink); }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body { margin: 0; padding: 12px; font: 13px/1.6 system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif;
    color: var(--ink); background: transparent; }
  .lead { margin: 0 0 10px; opacity: .65; font-size: 12px; }
  .field { display: grid; gap: 4px; margin-bottom: 10px; }
  .field > span { font-size: 11px; opacity: .65; }
  input, select { font: inherit; font-size: 12px; padding: 5px 8px; width: 100%; border-radius: 6px; background: transparent; color: inherit;
    border: 1px solid var(--line); }
  button { font: inherit; font-size: 12px; padding: 5px 12px; border-radius: 6px; cursor: pointer;
    border: 1px solid var(--line); background: transparent; color: inherit; }
  button[disabled] { opacity: .45; cursor: default; }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .muted { opacity: .6; font-size: 12px; }
  .problem { border: 1px solid var(--danger); color: var(--danger);
    border-radius: 6px; padding: 8px 10px; font-size: 12px; margin: 8px 0; }
</style>
</head>
<body>
<p class="lead">ブラウザの新しいタブ（＋）は検索エンジンのトップで開き、URL 欄に URL でない言葉を打つとその検索エンジンで調べます。
  AI が URL を省いてタブを開いたときも、ここで選んだ検索エンジンのトップが開きます。</p>
<label class="field"><span>検索エンジン</span>
  <select id="engine" data-testid="browser-config-engine"></select></label>
<label class="field" id="template-field" hidden><span>URL の型（%s を言葉に替えます。例 https://example.com/search?q=%s）</span>
  <input id="template" data-testid="browser-config-template" type="text" autocomplete="off" spellcheck="false" /></label>
<div class="row"><button id="save" type="button" data-testid="browser-config-save">保存</button><span class="muted" id="status" data-testid="browser-config-note"></span></div>
<p class="problem" id="error" data-testid="browser-config-error" hidden></p>
<script>
(() => {
  let nextId = 1;
  const waiting = new Map();
  function send(m) { window.parent.postMessage(m, "*"); }
  function request(method, params) {
    const id = nextId++;
    send({ jsonrpc: "2.0", id: id, method: method, params: params });
    return new Promise((resolve, reject) => waiting.set(id, { resolve: resolve, reject: reject }));
  }
  function $(id) { return document.getElementById(id); }
  function reportHeight() { send({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: document.documentElement.scrollHeight } }); }
  function problem(text) { $("error").textContent = text; $("error").hidden = !text; reportHeight(); }
  async function call(name, args) {
    const r = await request("tools/call", { name: name, arguments: args || {} });
    const t = r && r.content && r.content[0] && r.content[0].text;
    if (!r || r.isError) throw new Error(t || "失敗しました");
    return JSON.parse(t);
  }
  function showTemplate() { $("template-field").hidden = $("engine").value !== "custom"; reportHeight(); }
  function fill(s) {
    const engines = s.searchEngines || {};
    const sel = $("engine");
    sel.textContent = "";
    for (const id of Object.keys(engines)) {
      const o = document.createElement("option");
      o.value = id; o.textContent = engines[id].name + "（" + engines[id].home + "）";
      sel.appendChild(o);
    }
    const custom = document.createElement("option");
    custom.value = "custom"; custom.textContent = "任意の URL の型";
    sel.appendChild(custom);
    sel.value = s.searchEngine;
    $("template").value = s.searchTemplate || "";
    showTemplate();
  }
  $("engine").addEventListener("change", showTemplate);
  $("save").addEventListener("click", async () => {
    problem("");
    $("status").textContent = "";
    $("save").disabled = true;
    try {
      const engine = $("engine").value;
      const args = { searchEngine: engine };
      if (engine === "custom") args.searchTemplate = $("template").value.trim();
      await call("setSettings", args);
      const s = await call("getSettings", {});
      fill(s);
      $("status").textContent = "保存しました（" + (s.searchEngine === "custom" ? s.searchTemplate : s.searchEngines[s.searchEngine].name) + "）";
    } catch (err) { problem(String(err && err.message ? err.message : err)); }
    finally { $("save").disabled = false; }
  });
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
  /** host の明暗と色を当てる（publish-caddy の画面と同じ） */
  function applyAppearance(ctx) {
    if (!ctx) return;
    if (ctx.theme === "light" || ctx.theme === "dark") document.documentElement.dataset.theme = ctx.theme;
    const vars = (ctx.styles && ctx.styles.variables) || {};
    for (const [k, v] of Object.entries(vars)) {
      if (typeof v !== "string") continue;
      document.documentElement.style.setProperty(k.startsWith("--") ? k : "--mcp-ui-" + k, v);
    }
  }
  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "banto-browser-config", version: "0.1.0" },
    appCapabilities: { availableDisplayModes: ["inline"] },
  }).then(async (result) => {
    applyAppearance(result && result.hostContext);
    send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    try { fill(await call("getSettings", {})); } catch (err) { problem(String(err && err.message ? err.message : err)); }
    reportHeight();
  }).catch((err) => { document.body.textContent = "画面を初期化できませんでした: " + String(err && err.message ? err.message : err); });
})();
</script>
</body>
</html>
`;
