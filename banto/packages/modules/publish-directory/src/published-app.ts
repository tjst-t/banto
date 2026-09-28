// **公開の入口の画面**（launcher、追加・2026-09-28、ユーザー「Launcher で Publish の状況を見たい」）。
//
// この画面の芯は「どこまで届くか」。公開1件ごとに、入れ子の3つの輪（この機械／LAN／インターネット）を置き、
// 届く範囲まで塗る——承認の画面で人が一番気にした問いを、公開してからも同じ形で見せ続ける。
// 輪の色は「いま届いているか」だけを言う（届いている＝ok、サーバに届かない＝warn、止まっている＝ink-3）。
// ほかは静かにする：URL は名前の構造どおり（公開ごとに違う部分を濃く、共通の基のドメインを薄く）、
// サービスとポートは文で言う。
//
// **色と段は banto が MCP Apps の標準の名前で渡す**（v4-frontend.md §6.27）。この画面は banto の値を持たない
// ——下の土台は subagent の `ui/theme.ts` と同じ読み替えの表（パッケージをまたいで共有する口がまだ無いので写した。
// filesystem の `ui/styles.ts` と同じ事情）。
// MCP Apps の約束（postMessage の JSON-RPC）だけで親と話す。

export const PUBLISHED_APP_URI = "ui://banto-publish-directory/published";

export const THEME_CSS = `
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
  --ok: var(--color-text-success, green);
  --ok-soft: var(--color-background-success, color-mix(in srgb, green 12%, Canvas));
  --warn: var(--color-text-warning, darkgoldenrod);
  --warn-soft: var(--color-background-warning, color-mix(in srgb, darkgoldenrod 14%, Canvas));
  --danger: var(--color-text-danger, crimson);
  --danger-soft: var(--color-background-danger, color-mix(in srgb, crimson 12%, Canvas));
  --sans: var(--font-sans, system-ui, sans-serif);
  --t-xs: var(--font-text-xs-size, x-small);
  --t-sm: var(--font-text-sm-size, small);
  --t-md: var(--font-text-md-size, small);
  --t-lg: var(--font-text-lg-size, medium);
  --r-sm: var(--border-radius-sm, 0.25rem);
  --r-md: var(--border-radius-md, 0.5rem);
}
:root[data-theme="dark"] { color-scheme: dark; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; }
body { font: var(--t-sm)/1.7 var(--sans); color: var(--ink); background: transparent; }
body[data-mode="fullscreen"] { background: var(--bg); }
button { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
`;

const PAGE_CSS = `
#app { max-width: 760px; padding: 20px 20px 28px; }

/* ---- 上：題と、いまどこまで届いているかの一文 ---- */
.head { margin-bottom: 20px; }
.title { margin: 0; font-size: var(--t-lg); font-weight: 600; line-height: 1.4; }
.summary { margin: 4px 0 0; color: var(--ink-2); max-width: 60ch; }

/* ---- 公開1件 ---- */
.doors { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.door {
  display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; gap: 4px 16px; align-items: center;
  padding: 14px 0; border-top: 1px solid var(--line);
}
.door:last-child { border-bottom: 1px solid var(--line); }
.gauge { width: 40px; height: 40px; display: block; }
.gauge circle { fill: none; stroke-width: 2; }
.gauge .off { stroke: var(--ink-3); stroke-opacity: .35; stroke-dasharray: 1.5 3; }
.gauge .core { stroke: none; }
.door[data-tone="ok"] .on { stroke: var(--ok); }
.door[data-tone="ok"] .core.on { fill: var(--ok); }
.door[data-tone="warn"] .on { stroke: var(--warn); }
.door[data-tone="warn"] .core.on { fill: var(--warn); }
.door[data-tone="idle"] .on { stroke: var(--ink-3); }
.door[data-tone="idle"] .core.on { fill: var(--ink-3); }
.door[data-tone="danger"] .on { stroke: var(--danger); }
.door[data-tone="danger"] .core.on { fill: var(--danger); }

.where { min-width: 0; }
/* URL は名前の構造どおりに：公開ごとに違う部分を濃く、共通の基のドメインを薄く。選んで写せる */
.host { margin: 0; font-size: var(--t-md); font-weight: 600; line-height: 1.4; overflow-wrap: anywhere; user-select: all; }
.host .base { font-weight: 400; color: var(--ink-3); }
.what { margin: 2px 0 0; color: var(--ink-2); font-size: var(--t-sm); }
.state { margin: 2px 0 0; font-size: var(--t-sm); color: var(--ink-2); }
.door[data-tone="warn"] .state { color: var(--warn); }
.door[data-tone="danger"] .state { color: var(--danger); }

.acts { display: flex; gap: 6px; }
.btn {
  display: inline-flex; align-items: center; justify-content: center; height: 28px; padding: 0 12px;
  border-radius: var(--r-sm); cursor: pointer; border: 1px solid var(--line); background: var(--bg); color: var(--ink);
  font-size: var(--t-sm); white-space: nowrap;
}
.btn:hover:not(:disabled) { background: var(--bg-3); }
.btn:disabled { opacity: .5; cursor: default; }
.btn-quiet { border-color: transparent; background: transparent; color: var(--ink-2); }
.btn-quiet:hover:not(:disabled) { color: var(--danger); background: var(--danger-soft); }
.btn-quiet[data-armed] { color: var(--danger); background: var(--danger-soft); }

/* ---- 承認待ち・まだ公開していないサーバ：同じ並びで、もっと静かに ---- */
.section { margin-top: 28px; }
.section-title { margin: 0 0 4px; font-size: var(--t-sm); font-weight: 600; }
.section-lead { margin: 0 0 8px; color: var(--ink-3); font-size: var(--t-xs); max-width: 60ch; }
.door.quiet { padding: 10px 0; }
.door.quiet .host { font-size: var(--t-sm); }
.rest { list-style: none; margin: 0; padding: 0; }
.rest li { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; border-top: 1px solid var(--line); }
.rest li:last-child { border-bottom: 1px solid var(--line); }
.rest .name { color: var(--ink); }
.rest .note { color: var(--ink-3); font-size: var(--t-xs); }
.rest .note[data-on] { color: var(--ok); }

/* ---- 空・読めない・出し方の不調 ---- */
.empty { padding: 24px 0 8px; max-width: 52ch; }
.empty p { margin: 0 0 6px; }
.empty .hint { color: var(--ink-3); }
.callout { margin: 0 0 16px; padding: 8px 12px; border-radius: var(--r-md); background: var(--warn-soft); color: var(--ink); font-size: var(--t-sm); }
.callout strong { color: var(--warn); font-weight: 600; }
.error { margin: 0 0 16px; padding: 8px 12px; border-radius: var(--r-md); background: var(--danger-soft); color: var(--danger); }
.flash { margin: 12px 0 0; color: var(--ink-2); font-size: var(--t-xs); min-height: 1.7em; }

@media (max-width: 520px) {
  #app { padding: 16px 14px 24px; }
  .door { grid-template-columns: 32px minmax(0, 1fr); }
  .gauge { width: 32px; height: 32px; }
  .acts { grid-column: 2; }
}
`;

const SCRIPT = String.raw`
(() => {
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
  const reportSize = () => send({ method: "ui/notifications/size-changed", params: { height: document.documentElement.scrollHeight } });

  // ---- 部品 ----
  function h(tag, attrs, children) {
    const e = document.createElement(tag);
    for (const k of Object.keys(attrs || {})) {
      const v = attrs[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === "text") e.textContent = v; else e.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children || []) if (c) e.append(c);
    return e;
  }
  const SVG = "http://www.w3.org/2000/svg";
  const LEVEL = { machine: 1, lan: 2, internet: 3 };
  /** 入れ子の3つの輪（内から：この機械・LAN・インターネット）。届く範囲まで塗る */
  function gauge(reach, label) {
    const level = LEVEL[reach] || 0;
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 40 40");
    svg.setAttribute("class", "gauge");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "届く範囲：" + label);
    const ring = (r, i, cls) => {
      const c = document.createElementNS(SVG, "circle");
      c.setAttribute("cx", "20"); c.setAttribute("cy", "20"); c.setAttribute("r", String(r));
      c.setAttribute("class", cls + " " + (i <= level ? "on" : "off"));
      svg.append(c);
    };
    ring(18, 3, "ring"); ring(12, 2, "ring"); ring(5, 1, "core");
    const title = document.createElementNS(SVG, "title"); title.textContent = "届く範囲：" + label; svg.append(title);
    return svg;
  }
  /** URL を名前の構造で割る：公開ごとに違う最初の名前と、共通の残り */
  function hostParts(url) {
    let host = url;
    try { host = new URL(url).host; } catch (e) {}
    const i = host.indexOf(".");
    return i < 0 ? [host, ""] : [host.slice(0, i), host.slice(i)];
  }
  const STATE = {
    active: { tone: "ok", text: "届いています" },
    "not-listening": { tone: "warn", text: "サーバが待ち受けていません。Service のログを確かめてください" },
    "project-stopped": { tone: "idle", text: "コンテナが止まっています。Project を開くと戻ります" },
    "caddy-unreachable": { tone: "danger", text: "Caddy に繋がりません" },
  };
  function stateOf(p) { return STATE[p.state] || { tone: "danger", text: p.problem || p.state }; }
  const authText = (p) => p.auth === "basic" ? "Basic 認証（" + (p.username || "") + "）をはさんで" : "認証なしで";
  /** 文の中で使う短い言い方（承認の画面の長い言い方は、輪の説明に使う） */
  const REACH_SHORT = { machine: "この機械", lan: "LAN の中", internet: "インターネット" };

  // ---- 状態と描画 ----
  const app = document.getElementById("app");
  let projectId = null;
  let data = null;
  let loadError = null;
  let flash = "";
  const armed = new Map();

  function render() {
    const kids = [];
    const pub = data ? data.published : [];
    kids.push(h("header", { class: "head" }, [
      h("h1", { class: "title", text: "公開" }),
      h("p", { class: "summary", text: summary(pub) }),
    ]));
    if (loadError) kids.push(h("p", { class: "error", role: "alert", text: loadError }));
    if (data) {
      for (const m of data.methods) if (m.problem) kids.push(h("p", { class: "callout" }, [h("strong", { text: (m.title || m.name) + "：" }), m.problem]));
      if (pub.length === 0) kids.push(emptyState());
      else kids.push(h("ul", { class: "doors", "aria-label": "公開しているもの" }, pub.map(door)));
      if (data.pending.length) kids.push(pendingSection(data.pending));
      if (data.unpublished.length || data.servicesProblem) kids.push(restSection(data.unpublished, data.servicesProblem));
    }
    kids.push(h("p", { class: "flash", role: "status", "aria-live": "polite", text: flash }));
    app.replaceChildren(...kids);
    reportSize();
  }

  function summary(pub) {
    if (!data) return loadError ? "" : "確かめています…";
    if (pub.length === 0) return "外から届くようにしたものはありません。";
    const widest = pub.reduce((a, p) => (LEVEL[p.reach] || 0) > (LEVEL[a.reach] || 0) ? p : a, pub[0]);
    const down = pub.filter((p) => p.state !== "active").length;
    return pub.length + " 件を公開していて、いちばん広いものは" + (REACH_SHORT[widest.reach] || widest.reachLabel) + "から届きます。" +
      (down ? "そのうち " + down + " 件は、いま届いていません。" : "");
  }

  function door(p) {
    const st = stateOf(p);
    const [sub, base] = hostParts(p.url);
    const key = p.method + " " + p.service + " " + p.port;
    const stop = h("button", { class: "btn btn-quiet", type: "button", "data-armed": armed.has(key), text: armed.has(key) ? "もう一度押すとやめます" : "やめる" });
    stop.addEventListener("click", () => unpublish(p, key));
    const open = h("button", { class: "btn", type: "button", text: "開く", disabled: p.state !== "active" });
    open.addEventListener("click", () => openUrl(p.url));
    return h("li", { class: "door", "data-tone": st.tone }, [
      gauge(p.reach, p.reachLabel + "。" + st.text),
      h("div", { class: "where" }, [
        h("p", { class: "host" }, [sub, h("span", { class: "base", text: base })]),
        h("p", { class: "what", text: p.service + " の " + p.port + " 番へ、" + (REACH_SHORT[p.reach] || p.reachLabel) + "から" + authText(p) + "届きます。" }),
        // 届いているときは輪の色が言うので黙る。届いていないときだけ、理由と次の手を言う
        p.state === "active" ? null : h("p", { class: "state", text: st.text }),
      ]),
      h("div", { class: "acts" }, [open, stop]),
    ]);
  }

  function pendingSection(list) {
    return h("section", { class: "section" }, [
      h("h2", { class: "section-title", text: "承認を待っているもの" }),
      h("p", { class: "section-lead", text: "会話に出ている承認の画面で、公開するかを決めてください。" }),
      h("ul", { class: "doors" }, list.map((r) => {
        const [sub, base] = hostParts(r.plannedUrl);
        return h("li", { class: "door quiet", "data-tone": "pending" }, [
          gauge("", r.reachLabel),
          h("div", { class: "where" }, [
            h("p", { class: "host" }, [sub, h("span", { class: "base", text: base })]),
            h("p", { class: "what", text: r.service + " の " + r.port + " 番を、" + (REACH_SHORT[r.reach] || r.reachLabel) + "から届くようにする頼み" }),
          ]),
        ]);
      })),
    ]);
  }

  function restSection(list, problem) {
    return h("section", { class: "section" }, [
      h("h2", { class: "section-title", text: "まだ公開していないサーバ" }),
      h("p", { class: "section-lead", text: problem ? "Service の登録を読めませんでした：" + problem : "公開するには、会話で「" + (list[0] ? list[0].name : "web") + " を公開して」と頼んでください。" }),
      list.length ? h("ul", { class: "rest" }, list.map((s) => h("li", {}, [
        h("span", { class: "name", text: s.name + " の " + s.port + " 番" }),
        h("span", { class: "note", "data-on": s.listening, text: s.listening ? "待ち受けています" : "待ち受けていません" }),
      ]))) : null,
    ]);
  }

  function emptyState() {
    return h("div", { class: "empty" }, [
      h("p", { text: "コンテナの中で動かしたサーバは、そのままでは外から届きません。" }),
      h("p", { class: "hint", text: "Service で動かしているサーバを、会話で「公開して」と頼むと、承認のあとにここへ URL が並びます。" }),
    ]);
  }

  // ---- 操作 ----
  async function openUrl(url) {
    try {
      const r = await request("ui/open-link", { url });
      if (r && r.isError) throw new Error("banto が開きませんでした");
    } catch (e) {
      flash = "開けませんでした。URL を選んで写してください：" + url;
      render();
    }
  }
  async function unpublish(p, key) {
    if (!armed.has(key)) {
      armed.set(key, window.setTimeout(() => { armed.delete(key); render(); }, 4000));
      render();
      return;
    }
    window.clearTimeout(armed.get(key)); armed.delete(key);
    try {
      await call("unpublish_route", { projectId, method: p.method, service: p.service, port: p.port });
      flash = p.service + " の " + p.port + " 番の公開をやめました。";
    } catch (e) {
      flash = "やめられませんでした：" + e.message;
    }
    await refresh();
  }

  let timer = 0;
  async function refresh() {
    window.clearTimeout(timer);
    if (!projectId) { loadError = "どの Project の画面か分かりません（Project の中から開いてください）。"; render(); return; }
    try {
      data = await call("get_publish_overview", { projectId });
      loadError = null;
    } catch (e) {
      loadError = "読み込めませんでした：" + e.message;
    }
    render();
    // 承認待ちがあるときは細かく、そうでなければゆっくり取り直す
    timer = window.setTimeout(refresh, data && data.pending.length ? 2000 : 6000);
  }

  (async () => {
    try {
      const init = await request("ui/initialize", {
        protocolVersion: "2026-01-26",
        appInfo: { name: "banto-publish-published", version: "0.1.0" },
        appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
      });
      const ctx = (init && init.hostContext) || {};
      applyAppearance(ctx);
      document.body.dataset.mode = ctx.displayMode === "fullscreen" ? "fullscreen" : "inline";
      const project = ctx["dev.banto/project"];
      projectId = project && typeof project.id === "string" ? project.id : null;
      send({ method: "ui/notifications/initialized", params: {} });
    } catch (e) {
      app.textContent = "画面を始められませんでした：" + e.message;
      return;
    }
    render();
    await refresh();
  })();
})();
`;

export function publishedAppHtml(): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>${THEME_CSS}${PAGE_CSS}</style>
</head>
<body>
<main id="app"></main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
