// FileSystem Module の**設定 Canvas**（決定・2026-09-07）。
//
// MCP Apps の仕様に「設定画面」は無い（UI のライフサイクルは tool 起点だけ）。
// **これは banto が足した拡張**——資源に `dev.banto/canvas: "config"` と名乗り、
// banto の設定画面がそれを埋め込む（iOS でアプリの設定が OS の設定に出るのと同じ形）。
//
// **値は Module が持つ。** 読み書きはこの Module 自身の tool を呼ぶ
// ——banto は値を預からない（v4-frontend.md §6.2）。

export const CONFIG_APP_URI = "ui://banto-filesystem/config";

export const CONFIG_APP_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 12px;
    font: 13px/1.6 system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif;
    color: var(--mcp-ui-color-text, inherit);
    background: transparent;
  }
  label { display: flex; align-items: center; gap: 8px; }
  .note { opacity: .7; margin-top: 8px; }
  button {
    font: inherit; padding: 4px 10px; border-radius: 6px; cursor: pointer;
    border: 1px solid currentColor; background: transparent; color: inherit; opacity: .85;
  }
</style>
</head>
<body>
<p><label><input type="checkbox" id="showHidden" /> 隠しファイル（<code>.</code> で始まるもの）も一覧に出す</label></p>
<p><button id="save">保存する</button></p>
<p class="note" id="note">読み込んでいます…</p>
<script>
(() => {
  let nextId = 1;
  const waiting = new Map();
  function send(m) { window.parent.postMessage(m, "*"); }
  function request(method, params) {
    const id = nextId++;
    send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
  }
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;
    if (msg.id !== undefined && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || "呼び出しに失敗しました"));
      else resolve(msg.result);
    }
  });

  const box = document.getElementById("showHidden");
  const note = document.getElementById("note");
  function reportHeight() {
    send({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: document.documentElement.scrollHeight } });
  }
  function parse(result) {
    const text = result && result.content && result.content[0] && result.content[0].text;
    try { return JSON.parse(text); } catch { return null; }
  }

  document.getElementById("save").addEventListener("click", async () => {
    note.textContent = "承認を待っています…";
    reportHeight();
    try {
      const saved = parse(await request("tools/call", {
        name: "setSettings",
        arguments: { showHidden: box.checked },
      }));
      if (!saved) throw new Error("保存の結果を読み取れませんでした");
      box.checked = saved.showHidden;
      note.textContent = "保存しました（隠しファイル: " + (saved.showHidden ? "出す" : "出さない") + "）";
    } catch (err) {
      // **保存できたふりをしない**
      note.textContent = "保存できませんでした：" + (err && err.message ? err.message : err);
    }
    reportHeight();
  });

  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "banto-filesystem-config", version: "0.1.0" },
    appCapabilities: { availableDisplayModes: ["inline"] },
  }).then(async (result) => {
    const vars = ((result && result.hostContext && result.hostContext.styles) || {}).variables || {};
    for (const [k, v] of Object.entries(vars)) {
      document.documentElement.style.setProperty("--mcp-ui-" + k, String(v));
    }
    send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    const current = parse(await request("tools/call", { name: "getSettings", arguments: {} }));
    if (!current) {
      note.textContent = "いまの設定を読み取れませんでした";
    } else {
      box.checked = current.showHidden;
      note.textContent = "";
    }
    reportHeight();
  }).catch((err) => {
    note.textContent = "設定を開けませんでした：" + err.message;
  });
})();
</script>
</body>
</html>
`;
