// Subagent Module の**設定 Canvas**（決定・2026-09-24、ユーザー「OpenCode の Secret は設定から入れられるといい」）。
// FileSystem の設定 Canvas と同じ形（`dev.banto/canvas: "config"`、Module 自身の admin tool を呼ぶ）。
//
// - **本体のログインを共有するエージェント**（Claude Code）：何も入れなくてよい。いまの状態だけを出す
// - **鍵を受け取るエージェント**（OpenCode）：未設定の変数に「この機械の設定から取り込む」「貼り付けて保存」。
//   設定済みのものは**ここでは変えない**——Vault は書き換え・削除を Vault の管理画面からだけ受け付ける
//   （秘密を守る線）。変え方を案内する
//
// **鍵は Module が持たない**——Vault（banto 全体）の決まった名前に置き、どの Project でも使う。
// 画面は値を表示しない（入力欄は password、保存したら空にする）。

export const CONFIG_APP_URI = "ui://banto-subagent/config";

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
  h3 { font-size: 14px; margin: 16px 0 4px; }
  h3:first-child { margin-top: 0; }
  .note { opacity: .7; }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 6px 0; border-top: 1px solid color-mix(in srgb, currentColor 15%, transparent); }
  .row code { min-width: 11em; }
  .state { min-width: 4.5em; }
  input { font: inherit; padding: 3px 6px; border-radius: 6px; border: 1px solid color-mix(in srgb, currentColor 35%, transparent); background: transparent; color: inherit; min-width: 12em; }
  button {
    font: inherit; padding: 3px 10px; border-radius: 6px; cursor: pointer;
    border: 1px solid currentColor; background: transparent; color: inherit; opacity: .85;
  }
  button:disabled { opacity: .4; cursor: default; }
</style>
</head>
<body>
<div id="agents"></div>
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
  const note = document.getElementById("note");
  const root = document.getElementById("agents");
  function reportHeight() {
    send({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: document.documentElement.scrollHeight } });
  }
  async function call(name, args) {
    const result = await request("tools/call", { name, arguments: args });
    const text = result && result.content && result.content[0] && result.content[0].text;
    // **失敗を成功に見せない**——isError はそのまま投げる
    if (result && result.isError) throw new Error(text || name + " が失敗しました");
    return JSON.parse(text);
  }
  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "text") e.textContent = v; else e.setAttribute(k, v);
    }
    for (const c of children || []) e.appendChild(c);
    return e;
  }
  // words = [しているとき, できたとき, できなかったとき]
  async function act(words, fn) {
    note.textContent = words[0] + "…";
    reportHeight();
    try {
      await fn();
      await load(words[1]);
    } catch (err) {
      note.textContent = words[2] + "：" + (err && err.message ? err.message : err);
      reportHeight();
    }
  }
  function render(data) {
    root.textContent = "";
    for (const agent of data.agents) {
      root.appendChild(el("h3", { text: agent.title }));
      if (agent.hostLogin) {
        const h = agent.hostLogin;
        root.appendChild(el("p", {
          "data-role": "host-login",
          "data-agent": agent.id,
          text: h.loggedIn
            ? "banto 本体の Claude ログインを使います（契約：" + (h.subscriptionType || "不明") + "）。入れるものはありません。"
            : "banto 本体が Claude にログインしていません：" + h.reason,
        }));
        continue;
      }
      root.appendChild(el("p", { class: "note", text: "鍵は banto 全体の Vault に置き、どの Project でも使います。サブエージェントのシェルから読めるので、渡してよいものだけを入れてください。" }));
      for (const key of agent.keys) {
        const cells = [];
        if (key.set) {
          // 設定済みは、ここでは変えない（Vault の管理画面だけが書き換え・削除できる）
          cells.push(el("span", { class: "note", "data-role": "how-to-change", text: "変える・消すときは、banto 全体の設定の Vault で「" + key.alias + "」を消してから入れ直す" }));
        } else {
          if (key.importable) {
            const b = el("button", { text: agent.importLabel + "から取り込む" });
            b.addEventListener("click", () => act(
              [key.env + " を取り込んでいます", key.env + " を取り込みました", key.env + " を取り込めませんでした"],
              () => call("importCredential", { agent: agent.id, env: key.env }),
            ));
            cells.push(b);
          }
          const input = el("input", { type: "password", placeholder: "鍵を貼り付け", "aria-label": key.env + " の鍵", autocomplete: "off" });
          const save = el("button", { text: "貼り付けて保存" });
          save.addEventListener("click", () => {
            const value = input.value;
            input.value = "";
            act(
              [key.env + " を保存しています", key.env + " を保存しました", key.env + " を保存できませんでした"],
              () => call("setCredential", { agent: agent.id, env: key.env, value }),
            );
          });
          cells.push(input, save);
        }
        root.appendChild(el("div", { class: "row", "data-role": "credential", "data-agent": agent.id, "data-env": key.env }, [
          el("code", { text: key.env }),
          el("span", { class: "state", "data-role": "state", text: key.set ? "設定済み" : "未設定" }),
          ...cells,
        ]));
      }
    }
  }
  async function load(message) {
    const data = await call("getCredentials", {});
    render(data);
    note.textContent = message || "";
    reportHeight();
  }
  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "banto-subagent-config", version: "0.1.0" },
    appCapabilities: { availableDisplayModes: ["inline"] },
  }).then(async (result) => {
    const vars = ((result && result.hostContext && result.hostContext.styles) || {}).variables || {};
    for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty("--mcp-ui-" + k, String(v));
    send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    await load("");
  }).catch((err) => {
    note.textContent = "設定を開けませんでした：" + (err && err.message ? err.message : err);
    reportHeight();
  });
})();
</script>
</body>
</html>
`;
