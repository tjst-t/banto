// FileSystem Module が描く画面（MCP Apps、決定・2026-09-06）。
//
// **banto は「どこに出すか」しか決めない。中身は Module 発**（§6.2）。
// だからこの HTML は banto を一切知らない——MCP Apps の約束
// （postMessage の JSON-RPC）だけを使って親と話す。
//
// 依存を足さない（規則10）。ここでやることは
// 「initialize して、tools/call して、結果を並べる」だけで、
// そのために組み立てツールを持ち込む理由が無い。

/** 仕様で決まっている画面資源の MIME。 */
export const UI_APP_MIME = "text/html;profile=mcp-app";

export const DIRECTORY_APP_URI = "ui://banto-filesystem/directory";

export const DIRECTORY_APP_HTML = `<!doctype html>
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
  h1 { font-size: 13px; font-weight: 600; margin: 0 0 8px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; gap: 8px; padding: 2px 0; }
  .kind { opacity: .6; min-width: 3.5em; }
  button {
    font: inherit; padding: 4px 10px; border-radius: 6px; cursor: pointer;
    border: 1px solid currentColor; background: transparent; color: inherit; opacity: .85;
  }
  .note { opacity: .7; margin-top: 8px; }
</style>
</head>
<body>
<h1 id="title">ディレクトリ</h1>
<ul id="entries"></ul>
<p><button id="reload">この場所を読み直す</button> <button id="expand">大きく表示</button></p>
<p class="note" id="note"></p>
<script>
(() => {
  // --- MCP Apps の約束ごと（postMessage の JSON-RPC）だけを使う -------------
  let nextId = 1;
  const waiting = new Map();

  function send(message) { window.parent.postMessage(message, "*"); }

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
      return;
    }
    if (msg.method === "ui/notifications/tool-input") {
      const args = (msg.params && msg.params.arguments) || {};
      currentPath = args.path || currentPath;
      title.textContent = "ディレクトリ: " + currentPath;
      // **呼んだ人が fullscreen を頼んでいたら、開いた直後にそう頼む**
      // （仕様には「最初からこの mode」を宣言する場所が無い、決定・2026-09-07）
      if (args.displayMode === "fullscreen") requestFullscreen();
    }
    if (msg.method === "ui/notifications/tool-result") {
      // この通知の params は **CallToolResult そのもの**（仕様 McpUiToolResultNotification）
      render(msg.params);
    }
  });

  // --- 画面 -----------------------------------------------------------------
  const title = document.getElementById("title");
  const list = document.getElementById("entries");
  const note = document.getElementById("note");
  let currentPath = ".";

  function reportHeight() {
    send({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { height: document.documentElement.scrollHeight },
    });
  }

  function render(result) {
    const text = result && result.content && result.content[0] && result.content[0].text;
    let entries;
    try { entries = JSON.parse(text); } catch { entries = null; }
    if (!Array.isArray(entries)) {
      // **中身が読めないなら、読めたふりをしない**
      note.textContent = "一覧を読み取れませんでした";
      reportHeight();
      return;
    }
    list.replaceChildren(...entries.map((e) => {
      const li = document.createElement("li");
      const kind = document.createElement("span");
      kind.className = "kind";
      kind.textContent = e.type === "directory" ? "ディレクトリ" : "ファイル";
      const name = document.createElement("span");
      name.textContent = e.name;
      li.append(kind, name);
      return li;
    }));
    note.textContent = entries.length + " 件";
    reportHeight();
  }

  document.getElementById("reload").addEventListener("click", async () => {
    note.textContent = "承認を待っています…";
    reportHeight();
    try {
      const result = await request("tools/call", {
        name: "listDirectory",
        arguments: { path: currentPath },
      });
      render(result);
    } catch (err) {
      note.textContent = String(err && err.message ? err.message : err);
      reportHeight();
    }
  });

  // **大きく出してほしいと頼む**（決めるのは host、§6.2 の交渉モデル）。
  // 断られたら、断られたと表示する——通ったふりをしない
  let askedFullscreen = false;
  async function requestFullscreen() {
    if (askedFullscreen) return; // 何度も頼まない
    askedFullscreen = true;
    try {
      const result = await request("ui/request-display-mode", { mode: "fullscreen" });
      if (!result || result.mode !== "fullscreen") {
        note.textContent = "大きく表示できませんでした（いまは " + ((result && result.mode) || "不明") + "）";
        reportHeight();
      }
    } catch (err) {
      note.textContent = String(err && err.message ? err.message : err);
      reportHeight();
    }
  }

  document.getElementById("expand").addEventListener("click", () => void requestFullscreen());

  // --- 立ち上がり -----------------------------------------------------------
  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "banto-filesystem-directory", version: "0.1.0" },
    appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
  }).then((result) => {
    const ctx = (result && result.hostContext) || {};
    // fullscreen で開かれているときは、そこから更に大きくは要らない
    if (ctx.displayMode === "fullscreen") document.getElementById("expand").remove();
    const vars = (ctx.styles && ctx.styles.variables) || {};
    for (const [k, v] of Object.entries(vars)) {
      document.documentElement.style.setProperty("--mcp-ui-" + k, String(v));
    }
    send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    reportHeight();
    // **人が入口から直接開いたとき**は、起こした tool 呼び出しが無い
    // （host は toolInfo を渡さない）。渡されるのを待たず、自分で取りに行く
    // ——§6.2「launcher も同じ形。Canvas が自分で必要なものを取りに行く」
    if (!ctx.toolInfo) {
      request("tools/call", { name: "listDirectory", arguments: { path: currentPath } })
        .then(render)
        .catch((err) => {
          note.textContent = String(err && err.message ? err.message : err);
          reportHeight();
        });
    }
  }).catch((err) => {
    note.textContent = "画面を初期化できませんでした: " + err.message;
  });
})();
</script>
</body>
</html>
`;
