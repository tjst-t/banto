// **サブエージェントの入口**（launcher、決定・2026-09-24、ユーザー「launcher から一覧や状態を見られる UI」）。
// Command Palette の「Module の入口」から開く。FileSystem のファイルブラウザと同じ型
// （`dev.banto/canvas: "launcher"`、Module 自身の admin tool を呼ぶ）。
//
// 出すもの：使えるエージェントと資格情報の状態／この Project で頼んだ仕事の一覧（走っているものは
// 経過と最後の様子、「止める」）／選んだ仕事の中身（頼んだ文・返答・呼んだ tool・断った確認・注記・使用量）。
// **走っている間は2秒ごとに取り直す**（通知の口は無い——一覧は Module のメモリにあり、取り直しは軽い）。

export const RUNS_APP_URI = "ui://banto-subagent/runs";

export const RUNS_APP_HTML = `<!doctype html>
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
  h3 { font-size: 14px; margin: 14px 0 6px; }
  h3:first-child { margin-top: 0; }
  .note { opacity: .7; }
  ul.agents { margin: 0; padding-left: 1.2em; }
  .run { display: grid; grid-template-columns: 5.5em 1fr auto; gap: 2px 10px; align-items: baseline;
         padding: 6px 8px; border-radius: 6px; cursor: pointer; border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent); }
  .run:hover, .run[aria-selected="true"] { background: color-mix(in srgb, currentColor 8%, transparent); }
  .status { font-weight: 600; }
  .status[data-status="running"] { color: #2563eb; }
  .status[data-status="error"] { color: #dc2626; }
  .status[data-status="cancelled"] { opacity: .7; }
  .meta { opacity: .7; font-size: 12px; }
  .progress { grid-column: 2 / 4; opacity: .8; font-size: 12px; }
  .prompt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  pre { white-space: pre-wrap; word-break: break-word; margin: 4px 0 10px; padding: 8px;
        border-radius: 6px; background: color-mix(in srgb, currentColor 6%, transparent); font: 12px/1.5 ui-monospace, monospace; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; margin: 0 0 8px; }
  dt { opacity: .7; }
  dd { margin: 0; word-break: break-all; }
  button {
    font: inherit; padding: 2px 10px; border-radius: 6px; cursor: pointer;
    border: 1px solid currentColor; background: transparent; color: inherit; opacity: .85;
  }
</style>
</head>
<body>
<h3>エージェント</h3>
<ul class="agents" id="agents"></ul>
<h3>頼んだ仕事</h3>
<div id="runs"></div>
<div id="detail"></div>
<p class="note" id="note">読み込んでいます…</p>
<script>
(() => {
  let nextId = 1;
  const waiting = new Map();
  let selected = null;
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
  const note = document.getElementById("note");
  function reportHeight() {
    send({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: document.documentElement.scrollHeight } });
  }
  async function call(name, args) {
    const result = await request("tools/call", { name, arguments: args });
    const text = result && result.content && result.content[0] && result.content[0].text;
    if (result && result.isError) throw new Error(text || name + " が失敗しました");
    return JSON.parse(text);
  }
  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "text") e.textContent = v; else e.setAttribute(k, v);
    }
    for (const c of children || []) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    return e;
  }
  const STATUS = { running: "実行中", done: "完了", cancelled: "取り消し", error: "失敗" };
  const time = (ms) => new Date(ms).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const seconds = (from, to) => Math.max(0, Math.round(((to || Date.now()) - from) / 1000)) + "秒";
  const money = (c) => (c ? c.amount.toFixed(3) + " " + c.currency : "");

  function renderRuns(runs) {
    const box = document.getElementById("runs");
    box.textContent = "";
    if (runs.length === 0) {
      box.appendChild(el("p", { class: "note", "data-role": "empty", text: "この Project ではまだ頼んでいません。会話で「サブエージェントに〜を頼んで」と頼むと、ここに出ます。" }));
      return;
    }
    for (const r of runs) {
      const row = el("div", { class: "run", "data-role": "run", "data-run": r.id, "data-status": r.status, "aria-selected": String(r.id === selected) }, [
        el("span", { class: "status", "data-status": r.status, "data-role": "status", text: STATUS[r.status] || r.status }),
        el("span", { class: "prompt", "data-role": "prompt", text: r.promptHead }),
        el("span", { class: "meta", text: time(r.startedAt) + "・" + seconds(r.startedAt, r.finishedAt) }),
        el("span", { class: "meta", text: r.agentTitle }),
        el("span", { class: "meta", text: (r.model ? r.model + "・" : "") + "ツール " + r.toolCount + "回" + (r.cost ? "・" + money(r.cost) : "") }),
      ]);
      if (r.status === "running") {
        const stop = el("button", { text: "止める" });
        stop.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          try { await call("cancelRun", { id: r.id }); await refresh(); }
          catch (err) { note.textContent = "止められませんでした：" + err.message; }
        });
        row.appendChild(el("span", { class: "progress", "data-role": "progress", text: r.lastProgress || "起こしています…" }));
        row.appendChild(stop);
      }
      row.addEventListener("click", () => { selected = r.id; refresh(); });
      box.appendChild(row);
    }
  }

  function field(label, value) {
    return [el("dt", { text: label }), el("dd", { text: value })];
  }
  function renderDetail(r) {
    const box = document.getElementById("detail");
    box.textContent = "";
    if (!r) return;
    const dl = el("dl", {}, [
      ...field("状態", STATUS[r.status] || r.status),
      ...field("エージェント", r.agentTitle + (r.model ? "（" + r.model + "）" : "")),
      ...field("始めた", new Date(r.startedAt).toLocaleString("ja-JP") + "（" + seconds(r.startedAt, r.finishedAt) + "）"),
      ...(r.sessionId ? field("session id", r.sessionId) : []),
      ...(r.resumedFrom ? field("続きの元", r.resumedFrom) : []),
      ...(r.usage ? field("使用量", "入力 " + r.usage.inputTokens + "・出力 " + r.usage.outputTokens + "・キャッシュ読み " + (r.usage.cachedReadTokens || 0)) : []),
      ...(r.cost ? field("費用", money(r.cost)) : []),
    ]);
    box.appendChild(el("h3", { text: "仕事の中身" }));
    box.appendChild(el("div", { "data-role": "detail", "data-run": r.id }, [
      dl,
      el("div", { class: "note", text: "頼んだ内容" }),
      el("pre", { "data-role": "detail-prompt", text: r.prompt }),
      ...(r.status === "running" ? [el("div", { class: "note", "data-role": "detail-progress", text: "いま：" + (r.lastProgress || "起こしています…") })] : []),
      ...(r.text !== undefined ? [el("div", { class: "note", text: "返答" }), el("pre", { "data-role": "detail-reply", text: r.text || "（返答なし）" })] : []),
      ...(r.error ? [el("div", { class: "note", text: "失敗の理由" }), el("pre", { "data-role": "detail-error", text: r.error })] : []),
      ...(r.toolCalls.length ? [el("div", { class: "note", text: "呼んだツール" }), el("pre", { "data-role": "detail-tools", text: r.toolCalls.join("\\n") })] : []),
      ...(r.permissions && r.permissions.length ? [el("div", { class: "note", text: "断った確認（人に聞く口がまだ無いため）" }), el("pre", { text: r.permissions.map((p) => p.title + " → " + p.answer).join("\\n") })] : []),
      ...(r.notes && r.notes.length ? [el("div", { class: "note", text: "注記" }), el("pre", { "data-role": "detail-notes", text: r.notes.join("\\n") })] : []),
    ]));
  }

  let timer = null;
  async function refresh() {
    try {
      const data = await call("listRuns", {});
      const agents = document.getElementById("agents");
      agents.textContent = "";
      for (const a of data.agents) agents.appendChild(el("li", { "data-role": "agent", "data-agent": a.id }, [el("b", { text: a.title }), "——" + a.credentials]));
      renderRuns(data.runs);
      renderDetail(selected ? await call("getRun", { id: selected }) : null);
      note.textContent = "";
      clearTimeout(timer);
      timer = null;
      if (data.runs.some((r) => r.status === "running")) timer = setTimeout(refresh, 2000);
    } catch (err) {
      note.textContent = "読み込めませんでした：" + (err && err.message ? err.message : err);
    }
    reportHeight();
  }
  // 開いている間に会話で頼まれた仕事も拾う——走っていなくても、ときどき取り直す
  setInterval(() => { if (!timer) refresh(); }, 5000);

  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "banto-subagent-runs", version: "0.1.0" },
    appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
  }).then(async (result) => {
    const vars = ((result && result.hostContext && result.hostContext.styles) || {}).variables || {};
    for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty("--mcp-ui-" + k, String(v));
    send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    await refresh();
  }).catch((err) => {
    note.textContent = "開けませんでした：" + (err && err.message ? err.message : err);
    reportHeight();
  });
})();
</script>
</body>
</html>
`;
