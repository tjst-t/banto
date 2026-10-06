// **Infisical への繋ぎ方を人が入れる画面**（追加・2026-09-13、ユーザー要望
// 「接続先と API Token を Global の Module 設定でできるように」）。
//
// banto 全体（instance）の設定画面に出る（`ui://<id>/config`、
// docs/specs/v4-frontend.md §6.2）。**Project ごとではない**——Infisical への
// 繋ぎ方は banto インストール全体で1つだから。
//
// **Client Secret は画面に返さない。** 入っているかどうかだけを出す
// （`hasClientSecret`）——出すと、画面を開いただけで秘密が DOM に載る。

export const CONFIG_APP_URI = "ui://banto-vault-infisical/config";

export const CONFIG_APP_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<style>
  /* **色は host が渡す標準の名前（--color-*）で受け、明暗も host に合わせる**（訂正・2026-10-06）。
     以前は渡されない --mcp-ui-color-* を読み、そもそも ui/initialize を送らず host の色を受けていなかった
     ——いつも既定の色で、明暗も OS 任せだった。古い名前は既定の手前に残す */
  :root {
    color-scheme: light dark;
    --ink: var(--color-text-primary, var(--mcp-ui-color-text, CanvasText));
    --line: var(--color-border-primary, var(--mcp-ui-color-border, rgba(128,128,128,.35)));
    --danger: var(--color-text-danger, var(--mcp-ui-color-danger, #c0392b));
    --ok-line: var(--color-border-success, rgba(120,180,120,.5));
    --todo-line: var(--color-border-warning, rgba(200,160,80,.6));
  }
  :root[data-theme="light"] { color-scheme: light; }
  :root[data-theme="dark"] { color-scheme: dark; }
  /* **開いた選択肢の一覧は、地と字を自分で決める**（直し・2026-10-06、ユーザー指摘）。選択欄は地が透明で字を
     受け継ぐので、一覧の項目も明るい字のまま、ブラウザが白い地で描くと読めなかった（暗い画面・Windows の Chrome） */
  option, optgroup { background-color: var(--color-background-primary, var(--mcp-ui-color-surface, Canvas)); color: var(--ink); }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body {
    margin: 0; padding: 14px;
    font: 13px/1.6 system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif;
    color: var(--ink);
    background: transparent;
  }
  h1 { font-size: 14px; font-weight: 600; margin: 0 0 2px; }
  .lead { margin: 0 0 12px; opacity: .65; font-size: 12px; }
  .field { display: grid; gap: 4px; margin-bottom: 10px; }
  .field > span { font-size: 11px; opacity: .65; }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .muted { opacity: .6; font-size: 12px; }
  input, select {
    font: inherit; font-size: 12px; padding: 6px 8px; width: 100%;
    border-radius: 6px; background: transparent; color: inherit;
    border: 1px solid var(--line);
  }
  button {
    font: inherit; font-size: 12px; padding: 6px 14px; border-radius: 6px; cursor: pointer;
    border: 1px solid var(--line); background: transparent; color: inherit;
  }
  button:hover { opacity: .75; }
  button[disabled] { opacity: .45; cursor: default; }
  .state { border-radius: 6px; padding: 8px 10px; font-size: 12px; margin-bottom: 12px; }
  .ok { border: 1px solid var(--ok-line); }
  .todo { border: 1px solid var(--todo-line); }
  .problem {
    border: 1px solid var(--danger); border-radius: 6px;
    padding: 8px 10px; font-size: 12px; color: var(--danger);
  }
</style>
</head>
<body>

<h1>Infisical への繋ぎ方</h1>
<p class="lead">
  ここで入れた資格情報は <strong>この Module の中だけ</strong>に 0600 で保存され、
  banto の記録（Event Store）には残りません。AI にも渡りません
</p>

<div class="state" id="state">読み込んでいます…</div>

<label class="field"><span>接続先</span>
  <select id="target">
    <option value="us">Infisical Cloud（US・app.infisical.com）</option>
    <option value="eu">Infisical Cloud（EU・eu.infisical.com）</option>
    <option value="self">自前で立てたもの（URL を入れる）</option>
  </select>
</label>

<label class="field" id="site-field" hidden><span>接続先の URL</span>
  <input id="siteUrl" placeholder="http://127.0.0.1:8088" autocomplete="off" />
</label>

<label class="field"><span>Infisical の Client ID（Machine Identity）</span>
  <input id="clientId" autocomplete="off" spellcheck="false" />
</label>

<label class="field"><span>Infisical の Client Secret</span>
  <input id="clientSecret" type="password" autocomplete="off" placeholder="ここに貼り付ける" />
</label>

<label class="field"><span>Infisical の Project ID（banto の Project とは別のものです）</span>
  <input id="projectId" autocomplete="off" spellcheck="false" />
</label>

<label class="field"><span>Infisical の環境（environment）</span>
  <input id="environment" placeholder="dev" autocomplete="off" spellcheck="false" />
</label>

<div class="row">
  <button id="save">繋いで保存する</button>
  <span class="muted">実際に繋がったときだけ保存します</span>
</div>
<p class="problem" id="error" hidden></p>

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
  const $ = (id) => document.getElementById(id);

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

  async function callTool(name, args) {
    const res = await request("tools/call", { name, arguments: args || {} });
    const text = res && res.content && res.content[0] && res.content[0].text;
    if (res && res.isError) throw new Error(text || (name + " が失敗しました"));
    if (typeof text !== "string") throw new Error(name + " が中身を返しませんでした");
    try { return JSON.parse(text); } catch { throw new Error(name + " の答えを読み取れませんでした: " + text); }
  }

  function reportHeight() {
    send({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { height: document.documentElement.scrollHeight },
    });
  }

  function applyTarget() {
    $("site-field").hidden = $("target").value !== "self";
    reportHeight();
  }
  $("target").addEventListener("change", applyTarget);

  /** いまの状態を、**推測せずに Module から聞いて**出す（規則3）。 */
  function show(view) {
    const state = $("state");
    if (view.configured) {
      state.className = "state ok";
      state.textContent =
        "繋がっています（" + view.siteUrl + " / Project " + view.projectId + " / " + view.environment + "）" +
        (view.source === "env"
          ? "——いまは環境変数から読んでいます。ここで保存すると、保存した値のほうが優先されます"
          : "");
    } else {
      state.className = "state todo";
      state.textContent = "まだ繋がっていません" + (view.lastError ? "：" + view.lastError : "");
    }
    $("target").value = view.target || "us";
    $("siteUrl").value = view.target === "self" ? view.siteUrl || "" : "";
    $("clientId").value = view.clientId || "";
    $("projectId").value = view.projectId || "";
    $("environment").value = view.environment || "dev";
    // **秘密は返ってこない**ので、入っていることだけを示す
    $("clientSecret").placeholder = view.hasClientSecret
      ? "保存済み（変えるときだけ入れ直す）"
      : "ここに貼り付ける";
    applyTarget();
  }

  $("save").addEventListener("click", async () => {
    $("error").hidden = true;
    $("save").disabled = true;
    try {
      // **空なら「変えない」**（訂正・2026-09-15）。placeholder が
      // 「変えるときだけ入れ直す」と言っているのに、空だと必ず弾いていた
      const secret = $("clientSecret").value;
      show(
        await callTool("setConnectionSettings", {
          target: $("target").value,
          siteUrl: $("siteUrl").value.trim(),
          clientId: $("clientId").value.trim(),
          ...(secret ? { clientSecret: secret } : {}),
          projectId: $("projectId").value.trim(),
          environment: $("environment").value.trim() || "dev",
        }),
      );
      // **打った秘密を画面に残さない**——閉じたあとの DOM にも置かない
      $("clientSecret").value = "";
    } catch (err) {
      $("error").hidden = false;
      $("error").textContent = err && err.message ? err.message : String(err);
    } finally {
      $("save").disabled = false;
      reportHeight();
    }
  });

  async function load() {
    try {
      show(await callTool("getConnectionSettings", {}));
    } catch (err) {
      $("state").className = "state todo";
      $("state").textContent = "いまの設定を読めませんでした：" + (err && err.message ? err.message : String(err));
    }
    reportHeight();
  }

  // **初期化して host の色と明暗を受ける**（追加・2026-10-06）。以前は ui/initialize を送っておらず、
  // host の色を一度も受けていなかった（いつも既定の色、明暗も OS 任せ）
  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "banto-vault-infisical-config", version: "0.1.0" },
    // **appCapabilities**——host が検査する名前はこちら（capabilities では弾かれる・2026-09-14）
    appCapabilities: { availableDisplayModes: ["inline"] },
  })
    .then((result) => {
      applyAppearance(result && result.hostContext);
      send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    })
    .catch(() => {
      // **初期化に失敗しても、画面ごと消さない**（規則13——出せるものは出す）。
      // ここで得るのは見た目の変数だけなので、無くても設定はできる——vault-directory の設定画面と同じ
    })
    .then(load);
})();
</script>
</body>
</html>
`;
