// publishService の画面（会話の中の承認）。**banto 本体で動く窓口が出す**——中の AI はこの画面を偽れない。
//
// **この画面の芯は「どこまで届くか」**（ユーザー決定：承認の画面に届く範囲を banto が出す）。入口の画面
// （`published-app.ts`）と同じ入れ子の3つの輪（内から：この機械・LAN・インターネット）を大きく置き、輪ごとに
// 名前を添えて、届く範囲まで塗る——言葉より先に絵で読める。色は段階で変わる：承認前は accent（届くようになる）、
// 公開したら ok（届いている）、断ったら塗らない。ほかは静かにする（作り直し・2026-09-28、frontend-design）。
//
// 設定項目は実装が名乗った JSON Schema から組む。窓口は中身を解釈しない：
//   選択肢が少ない enum → 並べて選ぶ（enumNames があれば見せ方に使う）／ writeOnly の文字列 → 伏せ字（送ったら消す）／
//   文字列 → 文字の欄／ boolean → チェック／ number・integer → 数の欄
//   **最初の enum 以外は「詳しい設定」に畳む**。enum を既定から変えたとき・実装が設定を断ったときは開く
// 色と段は banto が MCP Apps の標準の名前で渡すものだけを使う（`THEME_CSS`、入口の画面と同じ読み替え）。
// MCP Apps の約束（postMessage の JSON-RPC）だけで親と話す（依存を足さない、規則10）。

import { THEME_CSS } from "./published-app.js";

export const UI_APP_MIME = "text/html;profile=mcp-app";
export const APPROVAL_APP_URI = "ui://banto-publish-directory/approve";

const PAGE_CSS = `
body { padding: 16px 16px 14px; }
.title { margin: 0; font-size: var(--t-sm); font-weight: 600; color: var(--ink-2); }
.muted { color: var(--ink-3); font-size: var(--t-sm); margin: 6px 0 0; }

/* ---- 芯：どこまで届くか ---- */
.door { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 16px; align-items: center; margin: 12px 0 4px; }
.gauge { width: 76px; height: 76px; display: block; }
.gauge circle { fill: none; stroke-width: 2.25; transition: stroke .2s, fill .2s; }
.gauge .off { stroke: var(--ink-3); stroke-opacity: .35; stroke-dasharray: 1.5 3.5; }
.gauge .core.off { fill: none; }
[data-phase="pending"] .gauge .on { stroke: var(--accent); }
[data-phase="pending"] .gauge .core.on { fill: var(--accent); }
[data-phase="published"] .gauge .on { stroke: var(--ok); }
[data-phase="published"] .gauge .core.on { fill: var(--ok); }
@media (prefers-reduced-motion: reduce) { .gauge circle { transition: none; } }

.host { margin: 0; font-size: var(--t-lg); font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; }
.host .base { font-weight: 400; color: var(--ink-3); }
a.host-link { color: inherit; text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 3px; cursor: pointer; }
a.host-link:hover { text-decoration-color: currentColor; }
.reach { margin: 4px 0 0; font-size: var(--t-md); color: var(--ink); }
.detail { margin: 2px 0 0; font-size: var(--t-sm); color: var(--ink-2); }

/* 輪の名前：塗った輪だけ濃く。塗っていない輪は「そこまでは届かない」と読める */
.legend { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: var(--t-xs); color: var(--ink-3); }
.legend li { display: inline-flex; align-items: center; gap: 6px; }
.legend i { width: 8px; height: 8px; border-radius: 50%; border: 1.5px dotted var(--ink-3); opacity: .6; }
.legend li[data-on] { color: var(--ink); }
[data-phase="pending"] .legend li[data-on] i { border: 0; background: var(--accent); opacity: 1; }
[data-phase="published"] .legend li[data-on] i { border: 0; background: var(--ok); opacity: 1; }
.wide-warn { margin: 10px 0 0; padding: 8px 12px; border-radius: var(--r-md); background: var(--warn-soft); color: var(--ink); font-size: var(--t-sm); }

/* ---- 設定 ---- */
.settings { margin: 16px 0 0; padding: 14px 0 0; border-top: 1px solid var(--line); display: grid; gap: 12px; }
.field { display: grid; gap: 4px; min-width: 0; }
.field > .label { font-size: var(--t-xs); color: var(--ink-2); }
.field > small { font-size: var(--t-xs); color: var(--ink-3); line-height: 1.6; }
.choice { display: inline-flex; flex-wrap: wrap; border: 1px solid var(--line); border-radius: var(--r-sm); overflow: hidden; width: fit-content; max-width: 100%; }
.choice label { position: relative; }
.choice input { position: absolute; opacity: 0; inset: 0; margin: 0; cursor: pointer; }
.choice span { display: block; padding: 5px 12px; font-size: var(--t-sm); color: var(--ink-2); border-right: 1px solid var(--line); }
.choice label:last-child span { border-right: 0; }
.choice input:checked + span { background: var(--accent-soft); color: var(--accent); font-weight: 500; }
.choice input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: -2px; }
input[type=text], input[type=password], input[type=number], select {
  font: inherit; font-size: var(--t-sm); height: 30px; padding: 0 8px; width: 100%; max-width: 360px; border-radius: var(--r-sm);
  background: var(--bg); color: var(--ink); border: 1px solid var(--line);
}
input:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 0; border-color: transparent; }
details.more > summary { cursor: pointer; font-size: var(--t-xs); color: var(--ink-2); width: fit-content; list-style: none; }
details.more > summary::-webkit-details-marker { display: none; }
details.more > summary::before { content: "＋ "; }
details.more[open] > summary::before { content: "− "; }
details.more > div { display: grid; gap: 12px; margin-top: 10px; }

/* ---- 決める ---- */
.acts { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 16px 0 0; }
.btn { display: inline-flex; align-items: center; height: 30px; padding: 0 14px; border-radius: var(--r-sm); cursor: pointer;
  font-size: var(--t-sm); border: 1px solid var(--line); background: var(--bg); color: var(--ink); }
.btn:hover:not(:disabled) { background: var(--bg-3); }
.btn:disabled { opacity: .5; cursor: default; }
.btn-primary { background: var(--accent); border-color: transparent; color: var(--color-text-inverse, Canvas); font-weight: 500; }
.btn-primary:hover:not(:disabled) { background: var(--accent); filter: brightness(1.08); }
.btn-quiet { border-color: transparent; background: transparent; color: var(--ink-2); }
.status { font-size: var(--t-xs); color: var(--ink-3); }
.problem { margin: 12px 0 0; padding: 8px 12px; border-radius: var(--r-md); background: var(--danger-soft); color: var(--danger); font-size: var(--t-sm); overflow-wrap: anywhere; }
.facts { margin: 14px 0 0; font-size: var(--t-xs); color: var(--ink-3); overflow-wrap: anywhere; }

@media (max-width: 420px) {
  .door { grid-template-columns: 1fr; gap: 10px; }
  .gauge { width: 60px; height: 60px; }
  /* 選択肢が折り返すときは縦に並べる（横の区切りが途中で切れないように） */
  .choice { display: grid; width: 100%; }
  .choice span { border-right: 0; border-bottom: 1px solid var(--line); }
  .choice label:last-child span { border-bottom: 0; }
}
`;

export const APPROVAL_APP_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>${THEME_CSS}${PAGE_CSS}</style>
</head>
<body>
<main id="app" data-phase="loading">
  <h1 class="title">公開の承認</h1>
  <p class="muted" id="waiting">確かめています…</p>
  <p class="problem" id="load-error" role="alert" hidden></p>

  <section id="door-box" hidden>
    <div class="door">
      <span id="gauge"></span>
      <div>
        <p class="host" id="host"></p>
        <p class="reach" id="reach"></p>
        <p class="detail" id="detail"></p>
      </div>
    </div>
    <ul class="legend" id="legend" aria-hidden="true"></ul>
    <p class="wide-warn" id="wide-warn" hidden>URL を知っていれば、この機械の外の誰からでも届きます。前に認証を置くかを確かめてから公開してください。</p>
  </section>

  <div id="request" hidden>
    <form class="settings" id="form" autocomplete="off"></form>
    <div class="acts">
      <button class="btn btn-primary" id="approve" type="button">公開する</button>
      <button class="btn btn-quiet" id="decline" type="button">公開しない</button>
      <span class="status" id="status" role="status" aria-live="polite"></span>
    </div>
    <p class="problem" id="error" role="alert" hidden></p>
  </div>

  <p class="detail" id="result" role="status" hidden></p>
  <p class="problem" id="open-error" hidden></p>
  <p class="facts" id="facts" hidden></p>
</main>

<script>
(() => {
  const ID_LABEL = "公開の承認の id：";
  const LEVEL = { machine: 1, lan: 2, internet: 3 };
  const RINGS = [["machine", "この機械"], ["lan", "LAN"], ["internet", "インターネット"]];
  const REACH_SENTENCE = {
    machine: "この機械の中からだけ届くようになります。",
    lan: "LAN の中から届くようになります。",
    internet: "インターネットから届くようになります。",
  };
  let nextId = 1;
  const waiting = new Map();
  function send(m) { window.parent.postMessage(m, "*"); }
  function request(method, params) {
    const id = nextId++;
    send({ jsonrpc: "2.0", id: id, method: method, params: params });
    return new Promise((resolve, reject) => waiting.set(id, { resolve: resolve, reject: reject }));
  }
  function $(id) { return document.getElementById(id); }
  // **中身の高さを言う**——html の scrollHeight は枠の高さより小さくならないので、承認のあと中身が縮んでも
  // 枠が広いまま残っていた。body の実際の高さを測る
  function reportHeight() { send({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: Math.ceil(document.body.getBoundingClientRect().height) } }); }
  function show(id, on) { $(id).hidden = !on; reportHeight(); }
  function errText(err) { return String(err && err.message ? err.message : err); }
  function problem(id, text) { $(id).textContent = text; show(id, !!text); }
  function phase(p) { $("app").dataset.phase = p; }
  /** banto が渡す色と段（MCP Apps の標準の名前）を当てる——開くときと、明暗が変わって渡し直されたとき */
  function applyAppearance(ctx) {
    if (!ctx) return;
    if (ctx.theme) document.documentElement.dataset.theme = ctx.theme;
    const vars = (ctx.styles && ctx.styles.variables) || {};
    for (const k of Object.keys(vars)) if (k.startsWith("--") && typeof vars[k] === "string") document.documentElement.style.setProperty(k, vars[k]);
  }
  async function call(name, args) {
    const r = await request("tools/call", { name: name, arguments: args || {} });
    const t = r && r.content && r.content[0] && r.content[0].text;
    if (!r || r.isError) throw new Error(t || "失敗しました");
    return JSON.parse(t);
  }

  // --- 芯：輪と名前 ------------------------------------------------------------------------
  const SVG = "http://www.w3.org/2000/svg";
  function drawReach(reach, label) {
    const level = LEVEL[reach] || 0;
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 40 40"); svg.setAttribute("class", "gauge"); svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "届く範囲：" + label);
    [[18.5, 3, "ring"], [12.5, 2, "ring"], [5.5, 1, "core"]].forEach(([r, i, cls]) => {
      const c = document.createElementNS(SVG, "circle");
      c.setAttribute("cx", "20"); c.setAttribute("cy", "20"); c.setAttribute("r", String(r));
      c.setAttribute("class", cls + " " + (i <= level ? "on" : "off"));
      svg.append(c);
    });
    $("gauge").replaceChildren(svg);
    $("legend").replaceChildren(...RINGS.map(([key, name]) => {
      const li = document.createElement("li");
      if ((LEVEL[key] || 0) <= level) li.dataset.on = "";
      li.append(document.createElement("i"), document.createTextNode(name));
      return li;
    }));
  }
  function hostParts(url) {
    let host = url || "";
    try { host = new URL(url).host; } catch (e) {}
    const i = host.indexOf(".");
    return i < 0 ? [host, ""] : [host.slice(0, i), host.slice(i)];
  }
  /** 名前を置く。公開したら押すと別のタブで開く（画面は自分でタブを開けないので ui/open-link で banto に頼む） */
  function drawHost(url, asLink) {
    const [sub, base] = hostParts(url);
    const baseEl = document.createElement("span"); baseEl.className = "base"; baseEl.textContent = base;
    if (!asLink) { $("host").replaceChildren(sub, baseEl); return; }
    const a = document.createElement("a");
    a.className = "host-link"; a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer";
    a.title = url + " を別のタブで開く";
    a.append(sub, baseEl);
    a.addEventListener("click", async (e) => {
      e.preventDefault();
      try {
        const r = await request("ui/open-link", { url: url });
        if (r && r.isError) throw new Error("開けませんでした");
        problem("open-error", "");
      } catch (err) {
        problem("open-error", "開けませんでした。URL を選んで写してください：" + url);
      }
    });
    $("host").replaceChildren(a);
  }

  let requestId = null;
  let schema = null;
  let firstEnumKey = null;
  // 「詳しい設定」を画面が自分で開いたか（true）・人が summary を押して開け閉めしたか（manualMore）
  let autoOpenedMore = false;
  let manualMore = false;
  let currentReq = null;

  // --- 実装が名乗った JSON Schema から入力欄を組む（中身は解釈しない）--------------------
  function fieldFor(key, p) {
    const wrap = document.createElement("div"); wrap.className = "field";
    const title = document.createElement("span"); title.className = "label"; title.textContent = p.title || key;
    let input;
    if (Array.isArray(p.enum) && p.enum.length <= 4) {
      wrap.setAttribute("role", "radiogroup"); wrap.setAttribute("aria-label", p.title || key);
      input = document.createElement("div"); input.className = "choice";
      p.enum.forEach((v, i) => {
        const l = document.createElement("label");
        const r = document.createElement("input"); r.type = "radio"; r.name = key; r.value = String(v); r.dataset.key = key;
        if (p.default !== undefined ? String(p.default) === String(v) : i === 0) r.checked = true;
        r.addEventListener("change", onChange);
        const s = document.createElement("span"); s.textContent = (p.enumNames && p.enumNames[i]) || String(v);
        l.append(r, s); input.append(l);
      });
    } else if (Array.isArray(p.enum)) {
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
    if (input.tagName !== "DIV") {
      input.name = key; input.dataset.key = key;
      input.addEventListener("input", onChange); input.addEventListener("change", onChange);
      const label = document.createElement("label"); label.className = "field";
      label.append(title, input);
      if (p.description) { const d = document.createElement("small"); d.textContent = p.description; label.append(d); }
      return label;
    }
    wrap.append(title, input);
    if (p.description) { const d = document.createElement("small"); d.textContent = p.description; wrap.append(d); }
    return wrap;
  }
  function buildForm(s) {
    schema = s;
    const form = $("form");
    form.replaceChildren();
    autoOpenedMore = false; manualMore = false;
    const props = (s && s.properties) || {};
    const keys = Object.keys(props);
    firstEnumKey = keys.find((k) => Array.isArray(props[k].enum)) || null;
    if (firstEnumKey) form.append(fieldFor(firstEnumKey, props[firstEnumKey]));
    const rest = keys.filter((k) => k !== firstEnumKey);
    if (rest.length) {
      const more = document.createElement("details"); more.className = "more"; more.id = "more";
      const sum = document.createElement("summary"); sum.textContent = "詳しい設定（" + rest.map((k) => props[k].title || k).join("・") + "）";
      const box = document.createElement("div");
      for (const k of rest) box.append(fieldFor(k, props[k]));
      more.append(sum, box);
      // 人が自分で開け閉めしたら、以後は画面から勝手に畳まない（キーボードでの開閉も click になる）
      sum.addEventListener("click", () => { manualMore = true; autoOpenedMore = false; });
      more.addEventListener("toggle", reportHeight);
      form.append(more);
    }
    form.hidden = keys.length === 0;
  }
  /**
   * 最初の選択を既定から変えたら、畳んだ設定を開く（その選択に要る欄がそこにあるかもしれない）。
   * 自分で開いたのなら、既定に戻したら畳み直す——開いたままだと、要らなくなった欄がフォームに残って見える
   * （2026-09-29、ユーザー指摘「いちど Basic 認証にすると、無しにしてもフォームが戻らない」）。
   * 人が summary を押して開け閉めしたときは触らない。判断は最初の選択の欄が変わったときだけ
   * ——ほかの欄を打っている最中に畳まない
   */
  function syncMoreWithFirstChoice(target) {
    const more = $("more");
    if (!more || !firstEnumKey || manualMore) return;
    if (!target || !target.dataset || target.dataset.key !== firstEnumKey) return;
    const p = schema.properties[firstEnumKey];
    const v = valueOf(firstEnumKey);
    if (v === undefined || p.default === undefined) return;
    if (String(v) !== String(p.default)) {
      if (!more.open) { more.open = true; autoOpenedMore = true; }
    } else if (autoOpenedMore) {
      more.open = false; autoOpenedMore = false;
    }
  }
  function valueOf(key) {
    const els = $("form").querySelectorAll('[data-key="' + key + '"]');
    for (const el of els) {
      if (el.type === "radio") { if (el.checked) return el.value; continue; }
      if (el.type === "checkbox") return el.checked;
      return el.value;
    }
    return undefined;
  }

  /** 入れた値を集める。writeOnly は withSecrets のときだけ入れる（見積もりには送らない） */
  function collect(withSecrets) {
    const out = {};
    const props = (schema && schema.properties) || {};
    for (const key of Object.keys(props)) {
      const p = props[key];
      if (p.writeOnly && !withSecrets) continue;
      const v = valueOf(key);
      if (v === undefined) continue;
      if (p.type === "boolean") { out[key] = v; continue; }
      if (v === "") continue;
      out[key] = (p.type === "number" || p.type === "integer") ? Number(v) : v;
    }
    return out;
  }
  function clearSecrets() {
    const props = (schema && schema.properties) || {};
    for (const el of $("form").querySelectorAll("[data-key]")) if ((props[el.dataset.key] || {}).writeOnly) el.value = "";
  }

  function render(r) {
    const req = r.request;
    currentReq = req;
    const plan = r.plan;
    const reach = plan ? plan.reach : req.reach;
    const reachLabel = plan ? plan.reachLabel : req.reachLabel;
    const url = plan ? plan.url : req.plannedUrl;
    phase("pending");
    drawReach(reach, reachLabel);
    drawHost(url, false);
    $("reach").textContent = r.planProblem ? "URL を決められません：" + r.planProblem : (REACH_SENTENCE[reach] || reachLabel);
    $("detail").textContent = req.service + " の " + req.port + " 番を、" + (r.method ? r.method.title : req.implementation) + "で。";
    show("wide-warn", reach === "internet");
    $("facts").textContent = "Project " + req.projectId + "・" + new Date(req.createdAt).toLocaleString("ja-JP") + " に頼まれました";
    show("facts", true);
    show("door-box", true);
  }

  let planTimer = null;
  function onChange(e) { syncMoreWithFirstChoice(e && e.target); schedulePlan(); }
  function schedulePlan() {
    if (planTimer) clearTimeout(planTimer);
    planTimer = setTimeout(async () => {
      try { render(await call("get_publish_request", { requestId: requestId, config: collect(false) })); }
      catch (err) { problem("error", errText(err)); }
    }, 300);
  }

  function finishPublished(url, reach, reachLabel, autoApproved) {
    clearSecrets();
    show("request", false);
    phase("published");
    drawReach(reach, reachLabel);
    drawHost(url, true);
    $("reach").textContent = "公開しました。" + (REACH_SENTENCE[reach] || reachLabel).replace("ようになります", "ようになりました");
    // 人に聞かずに公開したもの（「承認をすべて自動で許可する」、追加・2026-10-05）——そうと分かるように言う
    $("detail").textContent = (autoApproved
      ? "自動で許可しました（承認をすべて自動で許可する がオン）——既定の設定で公開しています。"
      : "") + "名前を押すと別のタブで開きます。";
    show("wide-warn", false);
    show("door-box", true);
  }
  function finishDeclined(service, port) {
    clearSecrets();
    show("request", false);
    phase("declined");
    drawReach("", "無し");
    $("reach").textContent = "公開しませんでした。外からは届きません。";
    $("detail").textContent = service ? service + " の " + port + " 番は、コンテナの中だけで動いています。" : "";
    show("wide-warn", false);
    show("door-box", true);
  }

  async function load(id) {
    requestId = id;
    try {
      const r = await call("get_publish_request", { requestId: id });
      show("waiting", false);
      const req = r.request;
      if (req.state === "published") { finishPublished(req.url, req.reach, req.reachLabel, req.autoApproved === true); return; }
      if (req.state !== "pending") { drawHost(req.plannedUrl, false); finishDeclined(req.service, req.port); return; }
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
      finishPublished(r.url, r.reach, r.reachLabel);
    } catch (err) {
      // 断られたら頼みは待ったまま——直してもう一度押せる。要る欄が畳んだ中にあるかもしれないので開く
      busy(false);
      if ($("more")) $("more").open = true;
      problem("error", errText(err));
    }
  });
  $("decline").addEventListener("click", async () => {
    problem("error", "");
    busy(true);
    try {
      await call("decline_publish", { requestId: requestId });
      finishDeclined(currentReq ? currentReq.service : "", currentReq ? currentReq.port : "");
    }
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
    if (msg.method === "ui/notifications/host-context-changed") applyAppearance(msg.params);
    if (msg.method === "ui/notifications/tool-input") {
      const a = (msg.params && msg.params.arguments) || {};
      if (a.service) $("waiting").textContent = "確かめています：" + a.service + (a.port ? " の " + a.port + " 番" : "");
    }
    if (msg.method === "ui/notifications/tool-result") onToolResult(msg.params);
  });

  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "banto-publish-directory", version: "0.2.0" },
    appCapabilities: { availableDisplayModes: ["inline"] },
  }).then((result) => {
    applyAppearance(result && result.hostContext);
    send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    reportHeight();
  }).catch((err) => { document.body.textContent = "画面を始められませんでした：" + errText(err); });
})();
</script>
</body>
</html>
`;
