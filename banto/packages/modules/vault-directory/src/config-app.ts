// **共通の秘密をどこに置くかは、設定画面で決める**（決定・2026-09-14、ユーザー指摘
// 「こういうのは Canvas よりも設定画面でやったほうがいい」）。
//
// banto 全体（instance）の設定に出る（`ui://<id>/config`、v4-frontend.md §6.2）。
// 窓口は `scope: "instance"` なので、ちょうどここに出る。
//
// **Project の置き場はここで決めない**（仕様 §2.1「画面はどこで何を聞くか」）。
// 事前に決める設定にせず、**最初にその Project へ保存したときに決まる**
// ——`instance` の Module は Project の設定面に出ないので、例外を作るより
// 「そもそも事前設定が要らない」形にした。

export const CONFIG_APP_URI = "ui://banto-vault-directory/config";

export const CONFIG_APP_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<style>
  /* 色は host が渡す標準の名前（--color-*）で受け、明暗も host に合わせる——管理画面（manage-app.ts）と同じ
     （訂正・2026-10-06。以前は渡されない --mcp-ui-color-* を読み、初期化で受けた色も捨てていた） */
  :root {
    color-scheme: light dark;
    --ink: var(--color-text-primary, var(--mcp-ui-color-text, CanvasText));
    --line: var(--color-border-primary, var(--mcp-ui-color-border, rgba(128,128,128,.35)));
    --danger: var(--color-text-danger, var(--mcp-ui-color-danger, #c0392b));
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
  .problem {
    border: 1px solid var(--danger); border-radius: 6px;
    padding: 8px 10px; font-size: 12px; color: var(--danger);
  }
  .done { font-size: 12px; }
</style>
</head>
<body>

<h1>Global の秘密の置き場</h1>
<p class="lead">
  どの Project からでも使う秘密を、新しく作るときの保存先です。
  <strong>ここが「既定」</strong>——ここに居る秘密は素の名前で引けます
</p>

<div class="field"><span>置き場（Vault とグループ）</span>
  <div class="row">
    <select id="vault" style="flex:1 1 12em"></select>
    <select id="group" style="flex:1 1 12em"></select>
  </div>
</div>

<div class="row">
  <input id="new-group" placeholder="新しいグループの名前" style="flex:1" />
  <button id="create" type="button">作る</button>
</div>
<p class="muted">作ると、上の選択肢に加わります</p>

<div class="row">
  <button id="save">置き場を保存する</button>
  <span class="muted" id="state"></span>
</div>
<p class="problem" id="error" hidden></p>

<p class="muted" style="margin-top:14px">
  <strong>Project ごとの秘密は、ここでは決めません。</strong>
  最初にその Project へ保存したときに置き場が決まります
  ——「Vault を管理」の画面から、いまどこに在るかを確かめられます
</p>

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
   * （CSS の古い名前が既定の手前で受ける）——管理画面と同じ
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

  let places = null;
  function fillGroups() {
    const v = (places.vaults || []).find((x) => x.implementation === $("vault").value);
    const groups = (v && v.groups) || [];
    $("group").replaceChildren(...groups.map((g) => new Option(g, g)));
    $("group").disabled = groups.length === 0;
    if (places.shared && $("vault").value === places.shared.implementation && groups.includes(places.shared.group)) {
      $("group").value = places.shared.group;
    }
  }
  $("vault").addEventListener("change", fillGroups);

  async function refresh() {
    places = await callTool("getPlacements", {});
    $("vault").replaceChildren(...(places.vaults || []).map((v) => new Option(v.implementation, v.implementation)));
    if (places.shared) $("vault").value = places.shared.implementation;
    fillGroups();
    $("state").textContent = places.shared
      ? "いまは " + places.shared.implementation + " / " + places.shared.group
      : "まだ決まっていません";
    reportHeight();
  }

  $("create").addEventListener("click", async () => {
    $("error").hidden = true;
    try {
      const made = $("new-group").value.trim();
      await callTool("createGroup", { implementation: $("vault").value, name: made });
      $("new-group").value = "";
      await refresh();
      // **作った直後に選ぶのは、明らかな意図**（追加・2026-09-15）。
      // 作ってから自分でもう一度選び直させない
      if (Array.from($("group").options).some((o) => o.value === made)) $("group").value = made;
    } catch (err) {
      $("error").hidden = false;
      $("error").textContent = err && err.message ? err.message : String(err);
      reportHeight();
    }
  });

  $("save").addEventListener("click", async () => {
    $("error").hidden = true;
    $("save").disabled = true;
    try {
      await callTool("setSharedPlacement", { implementation: $("vault").value, group: $("group").value });
      await refresh();
    } catch (err) {
      $("error").hidden = false;
      $("error").textContent = err && err.message ? err.message : String(err);
    } finally {
      $("save").disabled = false;
      reportHeight();
    }
  });

  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "banto-vault-directory-config", version: "0.1.0" },
    // **appCapabilities**——host が検査する名前はこちら（capabilities では
    // 弾かれ、画面が出ないまま終わる。実測で踏んだ・2026-09-14）
    appCapabilities: { availableDisplayModes: ["fullscreen", "inline"] },
  })
    .then((result) => {
      applyAppearance(result && result.hostContext);
      send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    })
    .catch(() => {
      // **初期化に失敗しても、画面ごと消さない**（規則13——出せるものは出す）。
      // ここで得るのは見た目の変数だけなので、無くても設定はできる
    })
    .then(refresh)
    .catch((err) => {
      $("error").hidden = false;
      $("error").textContent = "設定を読めませんでした：" + (err && err.message ? err.message : String(err));
      reportHeight();
    });
})();
</script>
</body>
</html>
`;
