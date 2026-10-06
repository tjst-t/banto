// publish-caddy の設定画面（banto 全体の設定に出る。MCP Apps の約束——postMessage の JSON-RPC——だけで親と話す。
// skills・vault の画面と同じ作り。依存を足さない、規則10）。
//
// 決めるもの：Caddy の admin の場所・公開の URL の基のドメイン・ルートを足す server・その URL がどこまで届くか。
// 「どこまで届くか」は承認の画面にそのまま出る——**分からなければ一番広い「インターネット」のまま**にしておく。

export const UI_APP_MIME = "text/html;profile=mcp-app";
export const CONFIG_APP_URI = "ui://banto-publish-caddy/config";

export const CONFIG_APP_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<style>
  /* **色は host が渡す標準の名前（--color-*）で受け、明暗も host に合わせる**（訂正・2026-10-06）。
     以前は渡されない --mcp-ui-color-* を読み、受けた名前の前に --mcp-ui- を足して置いていた
     ——いつも既定の色で、明暗も OS 任せだった。古い名前は既定の手前に残す */
  :root {
    color-scheme: light dark;
    --ink: var(--color-text-primary, var(--mcp-ui-color-text, CanvasText));
    --line: var(--color-border-primary, var(--mcp-ui-color-border, rgba(128,128,128,.35)));
    --danger: var(--color-text-danger, var(--mcp-ui-color-danger, #c0392b));
  }
  :root[data-theme="light"] { color-scheme: light; }
  :root[data-theme="dark"] { color-scheme: dark; }
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
<p class="lead">Project のコンテナで動いているサービスを、host の Caddy のサブドメイン（例 web-1a2b3c4d.&lt;基のドメイン&gt;）で公開します。
  公開のたびに、人が承認の画面で押したときだけ道を張ります。</p>
<label class="field"><span>公開の URL の基のドメイン（例 banto.example.net。ワイルドカードの DNS と証明書が要ります）</span>
  <input id="baseDomain" type="text" autocomplete="off" spellcheck="false" /></label>
<label class="field"><span>Caddy の admin API（http://127.0.0.1:2019 か unix:/path/to/admin.sock）</span>
  <input id="adminUrl" type="text" autocomplete="off" spellcheck="false" /></label>
<label class="field"><span>ルートを足す server の名前（空なら 443 で待ち受けている1つ）</span>
  <input id="serverName" type="text" autocomplete="off" spellcheck="false" /></label>
<label class="field"><span>その URL がどこまで届くか（承認の画面に出ます）</span>
  <select id="reach">
    <option value="internet">インターネット</option>
    <option value="lan">LAN</option>
    <option value="machine">この機械だけ</option>
  </select></label>
<div class="row"><button id="save" type="button">保存</button><span class="muted" id="status"></span></div>
<p class="problem" id="error" hidden></p>
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
  function fill(r) {
    const s = r.settings;
    $("baseDomain").value = s.baseDomain || "";
    $("adminUrl").value = s.adminUrl || "";
    $("serverName").value = s.serverName || "";
    $("reach").value = s.reach;
    $("status").textContent = r.method.ready ? "使えます" : (r.method.problem || "");
  }
  $("save").addEventListener("click", async () => {
    problem("");
    $("save").disabled = true;
    try {
      fill(await call("setCaddySettings", {
        baseDomain: $("baseDomain").value, adminUrl: $("adminUrl").value, serverName: $("serverName").value, reach: $("reach").value,
      }));
      $("status").textContent = "保存しました";
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
    // **明暗が変わると host が色を渡し直す**——受けないと、開いたままの画面が古い色に残る
    if (msg.method === "ui/notifications/host-context-changed") applyAppearance(msg.params);
  });

  /**
   * **host の明暗と色を当てる**（訂正・2026-10-06）。色の名前は標準のもの（--color-text-primary など、
   * 頭に -- が付いている）をそのまま置く。頭に -- の無い名前を渡す host には "--mcp-ui-" を付けて置く
   * （CSS の古い名前が既定の手前で受ける）——vault-directory の画面と同じ
   */
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
    appInfo: { name: "banto-publish-caddy", version: "0.1.0" },
    appCapabilities: { availableDisplayModes: ["inline"] },
  }).then(async (result) => {
    applyAppearance(result && result.hostContext);
    send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    try { fill(await call("getCaddySettings", {})); } catch (err) { problem(String(err && err.message ? err.message : err)); }
    reportHeight();
  }).catch((err) => { document.body.textContent = "画面を初期化できませんでした: " + String(err && err.message ? err.message : err); });
})();
</script>
</body>
</html>
`;
