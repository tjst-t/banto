// skills Module が描く画面（MCP Apps）。**1つの HTML を2か所で使う**：
//
// - **会話の中**（`import_skill` の画面）——AI が取ってきて仮置きしたものを、人が見て
//   「取り込む／取り込まない」を決める（アーキ仕様 §5.7「取り込むかどうかは人が決める」）
// - **設定の中**（Skill の置き場）——人が直接 GitHub・ZIP から取り込み、入っているものを
//   出所つきで見て、消す
//
// 承認の前に出すもの（§5.7）：出所・`SKILL.md` の中身・`scripts/` の有無・`Read`/`Bash`
// を前提にした記述。**書き換えはしない**——届かない部分は、ここで示すだけ。
//
// banto を知らない。MCP Apps の約束（postMessage の JSON-RPC）だけで親と話す
// （filesystem・vault の画面と同じ作り。依存を足さない、規則10）。

export const UI_APP_MIME = "text/html;profile=mcp-app";
/** `import_skill` の画面（AI に見える tool の画面なので、資源も `agent`）。 */
export const IMPORT_APP_URI = "ui://banto-skills/import";
/** 設定の中の面（人だけ）。 */
export const MANAGE_APP_URI = "ui://banto-skills/manage";

export function skillsAppHtml(mode: "tool" | "manage"): string {
  return APP_HTML.replace("__MODE__", mode);
}

const APP_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body {
    margin: 0; padding: 12px;
    font: 13px/1.6 system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif;
    color: var(--mcp-ui-color-text, inherit);
    background: transparent;
  }
  h1 { font-size: 13px; font-weight: 600; margin: 0 0 2px; }
  h2 { font-size: 12px; font-weight: 600; margin: 14px 0 6px; }
  .lead { margin: 0 0 10px; opacity: .65; font-size: 12px; }
  .muted { opacity: .6; font-size: 12px; }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .field { display: grid; gap: 4px; margin-bottom: 10px; }
  .field > span { font-size: 11px; opacity: .65; }
  input[type=text] {
    font: inherit; font-size: 12px; padding: 5px 8px; width: 100%;
    border-radius: 6px; background: transparent; color: inherit;
    border: 1px solid var(--mcp-ui-color-border, rgba(128,128,128,.35));
  }
  button {
    font: inherit; font-size: 12px; padding: 5px 12px; border-radius: 6px; cursor: pointer;
    border: 1px solid var(--mcp-ui-color-border, currentColor); background: transparent; color: inherit;
  }
  button:hover { opacity: .75; }
  button[disabled] { opacity: .45; cursor: default; }
  .problem, .warn {
    border-radius: 6px; padding: 8px 10px; font-size: 12px; margin: 8px 0;
  }
  .problem { border: 1px solid var(--mcp-ui-color-danger, #c0392b); color: var(--mcp-ui-color-danger, #c0392b); }
  .warn { border: 1px solid var(--mcp-ui-color-border, rgba(128,128,128,.45)); }
  .warn strong { font-weight: 600; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; margin: 0 0 8px; font-size: 12px; }
  dt { opacity: .6; }
  dd { margin: 0; word-break: break-all; }
  pre {
    margin: 0; padding: 8px; max-height: 260px; overflow: auto; white-space: pre-wrap; word-break: break-word;
    font-size: 11px; line-height: 1.5; border-radius: 6px;
    border: 1px solid var(--mcp-ui-color-border, rgba(128,128,128,.35));
  }
  ul { margin: 0; padding-left: 18px; font-size: 12px; }
  .skill { border-top: 1px solid var(--mcp-ui-color-border, rgba(128,128,128,.25)); padding: 8px 0; }
  .skill:first-child { border-top: 0; }
  .tabs { display: flex; gap: 6px; margin-bottom: 8px; }
  .tabs button[aria-pressed=true] { font-weight: 600; }
  code { font-size: 11px; opacity: .85; }
</style>
</head>
<body>
<div id="manage-top" hidden>
  <!-- 見出しは置き場（設定画面）が出すので、ここでは繰り返さない -->
  <p class="lead">GitHub のフォルダか ZIP から Skill を取り込みます。取り込む前に中身を見せます。
    効かせるかどうかは、設定の「Skill」で選びます（次の新しい会話から効きます）。</p>
  <div class="tabs" role="group" aria-label="取り込み元">
    <button id="tab-github" type="button" aria-pressed="true">GitHub</button>
    <button id="tab-zip" type="button" aria-pressed="false">ZIP</button>
  </div>
  <label class="field" id="github-field"><span>Skill のフォルダの URL（例：https://github.com/anthropics/skills/tree/main/skills/pdf）</span>
    <input id="github-source" type="text" autocomplete="off" spellcheck="false" />
  </label>
  <label class="field" id="zip-field" hidden><span>SKILL.md の入った ZIP</span>
    <input id="zip-file" type="file" accept=".zip,application/zip" />
  </label>
  <div class="row"><button id="prepare" type="button">中身を見る</button><span class="muted" id="prepare-status"></span></div>
  <p class="problem" id="prepare-error" hidden></p>
</div>

<div id="tool-top" hidden>
  <h1>Skill の取り込み——取り込む前の確認</h1>
  <p class="lead">AI が取り込みを提案しています。中身を見て、取り込むかを決めてください。</p>
  <p class="muted" id="waiting">取ってきています…</p>
  <p class="problem" id="tool-error" hidden></p>
</div>

<div id="preview" hidden>
  <h2 id="preview-title"></h2>
  <dl id="preview-meta"></dl>
  <div id="preview-warnings"></div>
  <h2>SKILL.md</h2>
  <pre id="preview-skillmd"></pre>
  <h2 id="preview-files-title"></h2>
  <ul id="preview-files"></ul>
  <div class="row" style="margin-top:10px">
    <button id="confirm" type="button">取り込む</button>
    <button id="discard" type="button">取り込まない</button>
    <span class="muted" id="confirm-status"></span>
  </div>
  <p class="problem" id="confirm-error" hidden></p>
</div>

<p id="result" hidden></p>

<div id="installed-view" hidden>
  <h2>入っている Skill</h2>
  <div id="installed"></div>
  <p class="problem" id="installed-error" hidden></p>
</div>

<script>
(() => {
  const MODE = "__MODE__";
  let nextId = 1;
  const waiting = new Map();
  function send(m) { window.parent.postMessage(m, "*"); }
  function request(method, params) {
    const id = nextId++;
    send({ jsonrpc: "2.0", id: id, method: method, params: params });
    return new Promise((resolve, reject) => waiting.set(id, { resolve: resolve, reject: reject }));
  }
  function reportHeight() {
    send({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: document.documentElement.scrollHeight } });
  }
  function $(id) { return document.getElementById(id); }
  function show(id, on) { $(id).hidden = !on; reportHeight(); }
  function errText(err) { return String(err && err.message ? err.message : err); }
  function problem(id, text) { $(id).textContent = text; show(id, !!text); }

  /** tools/call の結果から、Module が返した JSON を読む（structuredContent が先、無ければ本文）。 */
  function payloadOf(result) {
    if (!result) return null;
    if (result.isError) {
      const t = result.content && result.content[0] && result.content[0].text;
      throw new Error(t || "失敗しました");
    }
    if (result.structuredContent) return result.structuredContent;
    const text = result.content && result.content[0] && result.content[0].text;
    try { return JSON.parse(text); } catch (e) { return null; }
  }
  async function call(name, args) { return payloadOf(await request("tools/call", { name: name, arguments: args || {} })); }

  function when(iso) { const d = new Date(iso); return isNaN(d.getTime()) ? String(iso) : d.toLocaleString("ja-JP"); }
  function kb(n) { return n < 1024 ? n + " B" : (n / 1024).toFixed(1) + " KB"; }
  function sourceLines(src) {
    if (!src) return [["出所", "（直接置かれたもの——出所の記録なし）"]];
    if (src.kind === "github") {
      return [
        ["出所", "GitHub " + src.repo + (src.path ? " / " + src.path : "")],
        ["ref", src.ref ? src.ref : "（指定なし——既定のブランチ）"],
        ["commit", src.commit],
      ].concat(src.importedAt ? [["取り込んだ日", when(src.importedAt)]] : []);
    }
    return [["出所", "ZIP " + src.fileName], ["sha256", src.sha256]].concat(src.importedAt ? [["取り込んだ日", when(src.importedAt)]] : []);
  }
  function fillDl(dl, rows) {
    dl.replaceChildren();
    for (const r of rows) {
      const dt = document.createElement("dt"); dt.textContent = r[0];
      const dd = document.createElement("dd"); dd.textContent = r[1];
      dl.append(dt, dd);
    }
  }
  function warn(html) {
    const p = document.createElement("div"); p.className = "warn"; p.append(...html); return p;
  }
  function strong(t) { const s = document.createElement("strong"); s.textContent = t; return s; }
  function text(t) { return document.createTextNode(t); }

  let current = null;
  function renderPreview(p) {
    current = p;
    $("preview-title").textContent = "Skill「" + p.name + "」";
    fillDl($("preview-meta"), [["説明", p.description]].concat(sourceLines(p.source)));
    const warnings = [];
    if (p.replaces) {
      warnings.push(warn([strong("同じ名前の Skill がもう入っています。"), text("取り込むと入れ替わります（前の出所：" + (p.replaces.source ? (p.replaces.source.repo || p.replaces.source.fileName) : "記録なし") + "）。")]));
    }
    if (p.hasScripts) {
      warnings.push(warn([strong("scripts/ が同梱されています。"), text("banto では実行されません（AI にシェルが無いため）。中身は資料として読めます。")]));
    }
    if (p.unreachable && p.unreachable.length > 0) {
      const ul = document.createElement("ul");
      for (const u of p.unreachable) { const li = document.createElement("li"); li.textContent = u.line + " 行目：" + u.text; ul.append(li); }
      warnings.push(warn([strong("banto では届かないかもしれない記述があります"), text("（コマンドの実行・ファイルの直接の読み込み）。取り込んでも書き換えません。"), ul]));
    }
    $("preview-warnings").replaceChildren(...warnings);
    $("preview-skillmd").textContent = p.skillMd;
    $("preview-files-title").textContent = "同梱のファイル（SKILL.md のほかに " + (p.files.length - 1) + " 個）";
    const files = p.files.filter((f) => f.path !== "SKILL.md");
    $("preview-files").replaceChildren(...files.slice(0, 40).map((f) => { const li = document.createElement("li"); li.textContent = f.path + "（" + kb(f.bytes) + "）"; return li; }).concat(files.length > 40 ? [Object.assign(document.createElement("li"), { textContent: "ほか " + (files.length - 40) + " 個" })] : []));
    $("confirm").disabled = false; $("discard").disabled = false;
    $("confirm-status").textContent = "";
    problem("confirm-error", "");
    show("preview", true);
  }

  function finish(message) {
    show("preview", false);
    $("result").textContent = message;
    show("result", true);
    if (MODE === "manage") void loadInstalled();
  }

  $("confirm").addEventListener("click", async () => {
    if (!current) return;
    $("confirm").disabled = true; $("discard").disabled = true;
    $("confirm-status").textContent = "取り込んでいます…";
    try {
      const r = await call("confirm_skill_import", { stagingId: current.stagingId });
      finish("取り込みました：Skill「" + r.name + "」。効かせるかは設定の「Skill」で選びます（次の新しい会話から効きます）。いまの会話でも、資源として読めます。");
    } catch (err) {
      $("confirm").disabled = false; $("discard").disabled = false;
      $("confirm-status").textContent = "";
      problem("confirm-error", errText(err));
    }
  });
  $("discard").addEventListener("click", async () => {
    if (!current) return;
    $("confirm").disabled = true; $("discard").disabled = true;
    try {
      await call("discard_skill_import", { stagingId: current.stagingId });
      finish("取り込みませんでした。");
    } catch (err) {
      $("confirm").disabled = false; $("discard").disabled = false;
      problem("confirm-error", errText(err));
    }
  });

  // --- 設定の中：人が直接取り込む ---------------------------------------------
  let from = "github";
  function setFrom(next) {
    from = next;
    $("tab-github").setAttribute("aria-pressed", String(next === "github"));
    $("tab-zip").setAttribute("aria-pressed", String(next === "zip"));
    show("github-field", next === "github");
    show("zip-field", next === "zip");
  }
  $("tab-github").addEventListener("click", () => setFrom("github"));
  $("tab-zip").addEventListener("click", () => setFrom("zip"));

  function readAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => { const s = String(reader.result); resolve(s.slice(s.indexOf(",") + 1)); };
      reader.onerror = () => reject(reader.error || new Error("ファイルを読めません"));
      reader.readAsDataURL(file);
    });
  }

  $("prepare").addEventListener("click", async () => {
    problem("prepare-error", "");
    show("result", false);
    show("preview", false);
    const args = {};
    if (from === "github") {
      const source = $("github-source").value.trim();
      if (!source) return problem("prepare-error", "URL を入れてください");
      args.source = source;
    } else {
      const file = $("zip-file").files && $("zip-file").files[0];
      if (!file) return problem("prepare-error", "ZIP を選んでください");
      args.fileName = file.name;
      args.zipBase64 = await readAsBase64(file);
    }
    $("prepare").disabled = true;
    $("prepare-status").textContent = "取ってきています…";
    try {
      renderPreview(await call("prepare_skill_import", args));
      $("prepare-status").textContent = "";
    } catch (err) {
      $("prepare-status").textContent = "";
      problem("prepare-error", errText(err));
    } finally {
      $("prepare").disabled = false;
    }
  });

  async function loadInstalled() {
    try {
      const r = await call("list_installed_skills", {});
      const box = $("installed");
      if (!r.skills.length) {
        box.replaceChildren(Object.assign(document.createElement("p"), { className: "muted", textContent: "まだありません" }));
      } else {
        box.replaceChildren(...r.skills.map((s) => {
          const div = document.createElement("div"); div.className = "skill"; div.setAttribute("data-skill", s.name);
          const title = document.createElement("div"); title.className = "row";
          const name = document.createElement("strong"); name.textContent = s.name;
          const del = document.createElement("button"); del.type = "button"; del.textContent = "消す";
          const status = document.createElement("span"); status.className = "muted";
          del.addEventListener("click", async () => {
            // 押し間違いで消さない——2度目で消す（確認のダイアログは枠の中では出せない）
            if (del.dataset.armed !== "1") { del.dataset.armed = "1"; del.textContent = "本当に消す"; return; }
            del.disabled = true;
            try { await call("remove_skill", { name: s.name }); status.textContent = "消しました"; void loadInstalled(); }
            catch (err) { del.disabled = false; status.textContent = errText(err); }
          });
          title.append(name, del, status);
          const desc = document.createElement("div"); desc.className = "muted"; desc.textContent = s.description;
          const dl = document.createElement("dl"); fillDl(dl, sourceLines(s.source));
          div.append(title, desc, dl);
          return div;
        }));
      }
      problem("installed-error", r.problems.length ? "読めないフォルダ：" + r.problems.map((p) => p.dir + "（" + p.problem + "）").join("、") : "");
      show("installed-view", true);
    } catch (err) {
      problem("installed-error", errText(err));
      show("installed-view", true);
    }
  }

  // --- 会話の中：AI の tool 呼び出しの結果から、仮置きの id を読んで中身を引く -----
  // 結果の本文は会話の記録を通って届く（structuredContent はその道で落ちる）。
  // 中身は人の操作の口（get_skill_import）で引く——AI の文脈には載せない
  async function showToolResult(result) {
    try {
      const t = result && result.content && result.content[0] && result.content[0].text;
      if (result && result.isError) throw new Error(t || "失敗しました");
      const m = String(t || "").match(/取り込みの id：([0-9a-f-]{36})/);
      if (!m) throw new Error("取り込む前の確認を読み取れませんでした");
      const r = await call("get_skill_import", { stagingId: m[1] });
      show("waiting", false);
      if (r.state === "pending") renderPreview(r.preview);
      else finish(r.state === "confirmed" ? "取り込み済みです：Skill「" + r.name + "」" : "取り込みませんでした（Skill「" + r.name + "」）");
    } catch (err) {
      show("waiting", false);
      problem("tool-error", "取り込めません：" + errText(err));
    }
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;
    if (msg.id !== undefined && waiting.has(msg.id)) {
      const w = waiting.get(msg.id); waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error.message || "呼び出しに失敗しました")); else w.resolve(msg.result);
      return;
    }
    if (msg.method === "ui/notifications/tool-input" && MODE === "tool") {
      const args = (msg.params && msg.params.arguments) || {};
      if (args.source) $("waiting").textContent = "取ってきています：" + args.source;
    }
    if (msg.method === "ui/notifications/tool-result" && MODE === "tool") {
      void showToolResult(msg.params);
    }
  });

  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "banto-skills", version: "0.1.0" },
    appCapabilities: { availableDisplayModes: ["inline"] },
  }).then((result) => {
    const ctx = (result && result.hostContext) || {};
    const vars = (ctx.styles && ctx.styles.variables) || {};
    for (const k of Object.keys(vars)) document.documentElement.style.setProperty("--mcp-ui-" + k, String(vars[k]));
    send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    if (MODE === "manage") { show("manage-top", true); void loadInstalled(); }
    else show("tool-top", true);
    reportHeight();
  }).catch((err) => {
    document.body.textContent = "画面を初期化できませんでした: " + errText(err);
  });
})();
</script>
</body>
</html>
`;
