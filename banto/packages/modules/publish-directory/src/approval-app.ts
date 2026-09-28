// publishService の画面（会話の中の承認）。**banto 本体で動く窓口が出す**——中の AI はこの画面を偽れない。
//
// 出すもの（docs/specs/v4-modules.md §4.3）：何を（サービス・ポート）・どの出し方で・どの URL に・**どこまで届くか**。
// 設定項目は実装が名乗った JSON Schema から組む。窓口は中身を解釈しない：
//   enum → 選ぶ欄（enumNames があれば見せ方に使う）／ writeOnly の文字列 → 伏せ字（送ったら消す）／
//   文字列 → 文字の欄／ boolean → チェック／ number・integer → 数の欄
// MCP Apps の約束（postMessage の JSON-RPC）だけで親と話す（skills の画面と同じ作り。依存を足さない、規則10）。

export const UI_APP_MIME = "text/html;profile=mcp-app";
export const APPROVAL_APP_URI = "ui://banto-publish-directory/approve";

export const APPROVAL_APP_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body { margin: 0; padding: 12px; font: 13px/1.6 system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif;
    color: var(--mcp-ui-color-text, inherit); background: transparent; }
  h1 { font-size: 13px; font-weight: 600; margin: 0 0 2px; }
  .lead { margin: 0 0 10px; opacity: .65; font-size: 12px; }
  .muted { opacity: .6; font-size: 12px; }
  .reach { border-radius: 6px; padding: 8px 10px; margin: 8px 0; font-size: 13px;
    border: 1px solid var(--mcp-ui-color-border, rgba(128,128,128,.45)); }
  .reach[data-reach=internet] { border-color: var(--mcp-ui-color-danger, #c0392b); }
  .reach strong { font-weight: 600; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; margin: 0 0 8px; font-size: 12px; }
  dt { opacity: .6; }
  dd { margin: 0; word-break: break-all; }
  .field { display: grid; gap: 4px; margin-bottom: 10px; }
  .field > span { font-size: 11px; opacity: .65; }
  .field > small { font-size: 11px; opacity: .55; }
  input[type=text], input[type=password], input[type=number], select {
    font: inherit; font-size: 12px; padding: 5px 8px; width: 100%; border-radius: 6px; background: transparent; color: inherit;
    border: 1px solid var(--mcp-ui-color-border, rgba(128,128,128,.35)); }
  button { font: inherit; font-size: 12px; padding: 5px 12px; border-radius: 6px; cursor: pointer;
    border: 1px solid var(--mcp-ui-color-border, currentColor); background: transparent; color: inherit; }
  button[disabled] { opacity: .45; cursor: default; }
  .url { color: var(--color-text-info, LinkText); text-decoration: underline; text-underline-offset: 2px; word-break: break-all; cursor: pointer; }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .problem { border: 1px solid var(--mcp-ui-color-danger, #c0392b); color: var(--mcp-ui-color-danger, #c0392b);
    border-radius: 6px; padding: 8px 10px; font-size: 12px; margin: 8px 0; }
</style>
</head>
<body>
<h1>公開の承認</h1>
<p class="lead" id="lead">AI が、Project のコンテナで動いているサーバの公開を頼んでいます。</p>
<p class="muted" id="waiting">読み込んでいます…</p>
<p class="problem" id="load-error" hidden></p>

<div id="request" hidden>
  <div class="reach" id="reach" data-reach=""></div>
  <dl id="facts"></dl>
  <form id="form" autocomplete="off"></form>
  <div class="row">
    <button id="approve" type="button">公開する</button>
    <button id="decline" type="button">公開しない</button>
    <span class="muted" id="status"></span>
  </div>
  <p class="problem" id="error" hidden></p>
</div>
<p id="result" hidden></p>
<p class="problem" id="open-error" hidden></p>

<script>
(() => {
  const ID_LABEL = "公開の承認の id：";
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
  function show(id, on) { $(id).hidden = !on; reportHeight(); }
  function errText(err) { return String(err && err.message ? err.message : err); }
  function problem(id, text) { $(id).textContent = text; show(id, !!text); }
  async function call(name, args) {
    const r = await request("tools/call", { name: name, arguments: args || {} });
    const t = r && r.content && r.content[0] && r.content[0].text;
    if (!r || r.isError) throw new Error(t || "失敗しました");
    return JSON.parse(t);
  }
  function fillDl(rows) {
    $("facts").replaceChildren();
    for (const r of rows) {
      const dt = document.createElement("dt"); dt.textContent = r[0];
      const dd = document.createElement("dd"); dd.textContent = r[1];
      $("facts").append(dt, dd);
    }
  }

  let requestId = null;
  let current = null;
  let schema = null;

  // --- 実装が名乗った JSON Schema から入力欄を組む（中身は解釈しない）--------------------
  function buildForm(s) {
    schema = s;
    const form = $("form");
    form.replaceChildren();
    const props = (s && s.properties) || {};
    for (const key of Object.keys(props)) {
      const p = props[key];
      const label = document.createElement("label"); label.className = "field";
      const title = document.createElement("span"); title.textContent = p.title || key;
      let input;
      if (Array.isArray(p.enum)) {
        input = document.createElement("select");
        p.enum.forEach((v, i) => {
          const o = document.createElement("option"); o.value = String(v);
          o.textContent = (p.enumNames && p.enumNames[i]) || String(v);
          input.append(o);
        });
        if (p.default !== undefined) input.value = String(p.default);
      } else if (p.type === "boolean") {
        input = document.createElement("input"); input.type = "checkbox"; input.checked = p.default === true;
      } else if (p.type === "number" || p.type === "integer") {
        input = document.createElement("input"); input.type = "number";
        if (p.default !== undefined) input.value = String(p.default);
      } else {
        input = document.createElement("input");
        input.type = p.writeOnly ? "password" : "text";
        if (p.writeOnly) input.autocomplete = "new-password";
        input.spellcheck = false;
        if (p.default !== undefined && !p.writeOnly) input.value = String(p.default);
      }
      input.name = key;
      input.dataset.key = key;
      input.addEventListener("input", schedulePlan);
      input.addEventListener("change", schedulePlan);
      label.append(title, input);
      if (p.description) { const d = document.createElement("small"); d.textContent = p.description; label.append(d); }
      form.append(label);
    }
  }

  /** 入れた値を集める。writeOnly は withSecrets のときだけ入れる（見積もりには送らない） */
  function collect(withSecrets) {
    const out = {};
    const props = (schema && schema.properties) || {};
    for (const el of $("form").querySelectorAll("[data-key]")) {
      const key = el.dataset.key; const p = props[key] || {};
      if (p.writeOnly && !withSecrets) continue;
      if (p.type === "boolean") { out[key] = el.checked; continue; }
      if (el.value === "") continue;
      out[key] = (p.type === "number" || p.type === "integer") ? Number(el.value) : el.value;
    }
    return out;
  }

  function clearSecrets() {
    const props = (schema && schema.properties) || {};
    for (const el of $("form").querySelectorAll("[data-key]")) if ((props[el.dataset.key] || {}).writeOnly) el.value = "";
  }

  function render(r) {
    current = r;
    const req = r.request;
    const plan = r.plan;
    const reach = plan ? plan.reach : req.reach;
    const reachLabel = plan ? plan.reachLabel : req.reachLabel;
    $("reach").dataset.reach = reach;
    $("reach").replaceChildren();
    const strong = document.createElement("strong"); strong.textContent = "届く範囲：" + reachLabel;
    $("reach").append(strong);
    fillDl([
      ["サービス", req.service + "（ポート " + req.port + "）"],
      ["URL", plan ? plan.url : (r.planProblem ? "決められません：" + r.planProblem : req.plannedUrl)],
      ["出し方", r.method ? r.method.title + "（" + req.implementation + "）" : req.implementation],
      ["Project", req.projectId],
      ["頼まれた時刻", new Date(req.createdAt).toLocaleString("ja-JP")],
    ]);
    reportHeight();
  }

  let planTimer = null;
  function schedulePlan() {
    if (planTimer) clearTimeout(planTimer);
    planTimer = setTimeout(async () => {
      try { render(await call("get_publish_request", { requestId: requestId, config: collect(false) })); }
      catch (err) { problem("error", errText(err)); }
    }, 300);
  }

  // **公開した URL は押すと別のタブで開く**（追加・2026-09-28、ユーザー要望）。画面はサンドボックスの中で自分では
  // タブを開けないので、MCP Apps の ui/open-link で banto に頼む。開けなかったら URL を選べる形で残す
  function finish(lead, url, tail) {
    clearSecrets();
    show("request", false);
    const box = $("result");
    box.replaceChildren(document.createTextNode(lead));
    if (url) {
      const a = document.createElement("a");
      a.href = url; a.textContent = url; a.className = "url"; a.rel = "noopener noreferrer"; a.target = "_blank";
      a.addEventListener("click", async (e) => {
        e.preventDefault();
        try {
          const r = await request("ui/open-link", { url: url });
          if (r && r.isError) throw new Error("開けませんでした");
          problem("open-error", "");
        } catch (err) {
          problem("open-error", "開けませんでした。URL を選んで写してください");
        }
      });
      box.append(a);
    }
    if (tail) box.append(document.createTextNode(tail));
    show("result", true);
  }
  function finishDecided(req) {
    if (req.state === "published") finish("公開しました：", req.url, "");
    else finish("公開しませんでした（" + req.service + ":" + req.port + "）", "", "");
  }

  async function load(id) {
    requestId = id;
    try {
      const r = await call("get_publish_request", { requestId: id });
      show("waiting", false);
      if (r.request.state !== "pending") { finishDecided(r.request); return; }
      if (!r.method.ready) problem("error", "この出し方はまだ使えません：" + (r.method.problem || ""));
      buildForm(r.method.configSchema);
      render(r);
      show("request", true);
    } catch (err) {
      show("waiting", false);
      problem("load-error", "承認の画面を開けません：" + errText(err));
    }
  }

  function busy(on, text) {
    $("approve").disabled = on; $("decline").disabled = on;
    $("status").textContent = text || "";
  }

  $("approve").addEventListener("click", async () => {
    problem("error", "");
    busy(true, "公開しています…");
    try {
      const r = await call("approve_publish", { requestId: requestId, config: collect(true) });
      finish("公開しました：", r.url, "（届く範囲：" + r.reachLabel + "）");
    } catch (err) {
      // 断られたら頼みは待ったまま——直してもう一度押せる
      busy(false);
      problem("error", errText(err));
    }
  });
  $("decline").addEventListener("click", async () => {
    problem("error", "");
    busy(true);
    try { await call("decline_publish", { requestId: requestId }); finish("公開しませんでした。"); }
    catch (err) { busy(false); problem("error", errText(err)); }
  });

  // --- AI の tool 呼び出しの結果から、頼みの id を読む --------------------------------------
  function onToolResult(result) {
    const t = result && result.content && result.content[0] && result.content[0].text;
    if (result && result.isError) { show("waiting", false); problem("load-error", "公開を頼めませんでした：" + (t || "")); return; }
    const i = String(t || "").indexOf(ID_LABEL);
    const m = i >= 0 ? String(t).slice(i + ID_LABEL.length).match(/^[0-9a-f-]{36}/) : null;
    if (!m) { show("waiting", false); problem("load-error", "承認の頼みを読み取れませんでした"); return; }
    void load(m[0]);
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;
    if (msg.id !== undefined && waiting.has(msg.id)) {
      const w = waiting.get(msg.id); waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error.message || "呼び出しに失敗しました")); else w.resolve(msg.result);
      return;
    }
    if (msg.method === "ui/notifications/tool-input") {
      const a = (msg.params && msg.params.arguments) || {};
      if (a.service) $("waiting").textContent = "確かめています：" + a.service + (a.port ? ":" + a.port : "");
    }
    if (msg.method === "ui/notifications/tool-result") onToolResult(msg.params);
  });

  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "banto-publish-directory", version: "0.1.0" },
    appCapabilities: { availableDisplayModes: ["inline"] },
  }).then((result) => {
    const vars = (result && result.hostContext && result.hostContext.styles && result.hostContext.styles.variables) || {};
    for (const k of Object.keys(vars)) document.documentElement.style.setProperty("--mcp-ui-" + k, String(vars[k]));
    send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    reportHeight();
  }).catch((err) => { document.body.textContent = "画面を初期化できませんでした: " + errText(err); });
})();
</script>
</body>
</html>
`;
