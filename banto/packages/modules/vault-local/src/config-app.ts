// Vault Module の**設定 Canvas**（決定・2026-09-07、ユーザー指摘）。
//
// Vault は **banto 全体に1本**（`scope: "instance"`）なので、その設定は
// Project ごとではなく**全体の設定画面**に出る——置き場はその Module の
// scope が決める（v4-frontend.md §6.2）。
//
// いまは**見るだけ**。alias の削除のような取り返しのつかない操作は、
// 承認の扱いを決めてから足す（画面からの呼び出しは承認を求めない、という
// 決定と合わせて考える必要があるため）。

export const CONFIG_APP_URI = "ui://banto-vault-local/config";

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
  }
  :root[data-theme="light"] { color-scheme: light; }
  :root[data-theme="dark"] { color-scheme: dark; }
  body {
    margin: 0; padding: 12px;
    font: 13px/1.6 system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif;
    color: var(--ink);
    background: transparent;
  }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; gap: 8px; padding: 2px 0; }
  .kind { opacity: .6; min-width: 5em; }
  .note { opacity: .7; margin-top: 8px; }
</style>
</head>
<body>
<ul id="aliases"></ul>
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

  const list = document.getElementById("aliases");
  const note = document.getElementById("note");
  function reportHeight() {
    send({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: document.documentElement.scrollHeight } });
  }

  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "banto-vault-config", version: "0.1.0" },
    appCapabilities: { availableDisplayModes: ["inline"] },
  }).then(async (result) => {
    applyAppearance(result && result.hostContext);
    send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });

    const res = await request("tools/call", { name: "listAliases", arguments: {} });
    const text = res && res.content && res.content[0] && res.content[0].text;
    let aliases;
    try { aliases = JSON.parse(text); } catch { aliases = null; }
    if (!Array.isArray(aliases)) {
      // **読めないなら、読めたふりをしない**
      note.textContent = "一覧を読み取れませんでした";
    } else if (aliases.length === 0) {
      note.textContent = "登録されている alias はまだありません。";
    } else {
      list.replaceChildren(...aliases.map((a) => {
        const li = document.createElement("li");
        const kind = document.createElement("span");
        kind.className = "kind";
        kind.textContent = a.kind || "";
        const name = document.createElement("span");
        name.textContent = a.name;
        li.append(kind, name);
        return li;
      }));
      note.textContent = aliases.length + " 件";
    }
    reportHeight();
  }).catch((err) => {
    note.textContent = "設定を開けませんでした：" + err.message;
    reportHeight();
  });
})();
</script>
</body>
</html>
`;
