// vault-directory が描く画面（MCP Apps、§6.2）。モックで形を決めてから本実装に移した
// （`mock/components/banto/canvas/vault-manage-view.tsx`、決定・2026-09-02／
// CLAUDE.md「モックを飛ばして実装しない」）。
//
// **banto を一切知らない。** 使うのは MCP Apps の約束（postMessage の JSON-RPC）
// と、自分の Module の tool だけ。依存も足さない（規則10）——ここでやることは
// 「initialize して、tools/call して、並べて、フォームから呼び返す」だけで、
// そのために組み立てツールを持ち込む理由が無い。
//
// **値は一度も画面に出てこない。** 出るのは alias の存在・種別・対象・用途・
// 使用状況だけ（§2.1 A/C）。新規登録の入力欄だけが値に触れ、その値は
// `tools/call` の引数として出ていったあと、この画面のどこにも残らない。

export const UI_APP_MIME = "text/html;profile=mcp-app";
export const MANAGE_APP_URI = "ui://banto-vault-directory/manage";

import { ALIAS_KIND_RULES_JS } from "@banto/vault-kit";

export const MANAGE_APP_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0;
    font: 13px/1.6 system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif;
    color: var(--mcp-ui-color-text, inherit);
    background: transparent;
  }
  .section { padding: 12px 16px; border-bottom: 1px solid var(--mcp-ui-color-border, rgba(128,128,128,.25)); }
  h1 { font-size: 13px; font-weight: 600; margin: 0; }
  .lead { margin: 4px 0 0; opacity: .65; font-size: 12px; }
  .label { font-size: 12px; font-weight: 500; opacity: .65; margin: 0 0 6px; }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .spread { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .chip {
    display: inline-flex; align-items: center; gap: 8px;
    border: 1px solid var(--mcp-ui-color-border, rgba(128,128,128,.35));
    border-radius: 6px; padding: 5px 9px; font-size: 12px;
  }
  .muted { opacity: .6; }
  .badge {
    display: inline-block; border: 1px solid var(--mcp-ui-color-border, rgba(128,128,128,.35));
    border-radius: 999px; padding: 0 8px; font-size: 11px; line-height: 18px; white-space: nowrap;
  }
  button {
    font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 6px; cursor: pointer;
    border: 1px solid var(--mcp-ui-color-border, currentColor); background: transparent; color: inherit;
  }
  button:hover { opacity: .75; }
  button.icon { padding: 2px 6px; border-color: transparent; opacity: .6; }
  button.icon:hover { opacity: 1; }
  button.danger { color: var(--mcp-ui-color-danger, #c0392b); }
  input, select, textarea {
    font: inherit; font-size: 12px; padding: 5px 8px; width: 100%;
    border-radius: 6px; background: transparent; color: inherit;
    border: 1px solid var(--mcp-ui-color-border, rgba(128,128,128,.35));
  }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-weight: 500; font-size: 11px; opacity: .55; padding: 0 8px 6px 0; }
  td { padding: 6px 8px 6px 0; border-top: 1px solid var(--mcp-ui-color-border, rgba(128,128,128,.18)); vertical-align: top; }
  td.name { font-weight: 500; word-break: break-all; }
  td.actions { text-align: right; white-space: nowrap; }
  .note-cell { max-width: 22em; opacity: .7; }
  dialog {
    border: 1px solid var(--mcp-ui-color-border, rgba(128,128,128,.35));
    border-radius: 10px; padding: 0; color: inherit;
    background: var(--mcp-ui-color-surface, Canvas);
    min-width: min(440px, 92vw);
  }
  dialog::backdrop { background: rgba(0,0,0,.35); }
  .dialog-body { padding: 16px; display: grid; gap: 10px; }
  .dialog-title { font-size: 13px; font-weight: 600; margin: 0; }
  .dialog-desc { font-size: 12px; opacity: .65; margin: 0; }
  /* **hidden を効かせる**（訂正・2026-09-13、ユーザー指摘）。[hidden] の
     display:none はブラウザ既定なので、.field { display: grid } のほうが強い
     ——JS で hidden を立てても何も隠れず、鍵ペアなのに「作る強さ」が出ていた。
     会話の中の入力欄でも同じことが起きていた（同じ形の画面が2枚ある） */
  [hidden] { display: none !important; }
  .field { display: grid; gap: 4px; }
  .field > span { font-size: 11px; opacity: .65; }
  .dialog-footer { display: flex; justify-content: flex-end; gap: 8px; padding-top: 4px; }
  .problem {
    border: 1px solid var(--mcp-ui-color-danger, #c0392b); border-radius: 6px;
    padding: 8px 10px; font-size: 12px; color: var(--mcp-ui-color-danger, #c0392b);
  }
  .empty { padding: 24px 0; text-align: center; font-size: 12px; opacity: .6; }
</style>
</head>
<body>

<div class="section">
  <h1>Vault を管理</h1>
  <p class="lead">
    複数の Vault 実装を横断して確認・編集する。ここに出るのは alias の存在・種別・
    用途・使用状況だけ——値はどの実装にも表示せず、banto にも残らない
  </p>
</div>

<div class="section">
  <p class="label">接続している実装</p>
  <div class="row" id="impls"></div>
</div>

<div class="section" id="problems-section" hidden>
  <div class="problem" id="problems"></div>
</div>

<div class="section">
  <div class="spread" style="margin-bottom:8px">
    <p class="label" style="margin:0" id="count">alias 一覧</p>
    <button id="open-placement">秘密の置き場…</button>
    <button id="new-alias">＋ alias を新規登録</button>
  </div>

  <div class="row" style="margin-bottom:8px">
    <input id="query" placeholder="名前・種別・範囲・backend・note を横断して検索" style="flex:1 1 14em; min-width:12em" />
    <select id="kind-filter" style="width:auto"></select>
    <select id="target-filter" style="width:auto"></select>
    <select id="backend-filter" style="width:auto"></select>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:8em">種別</th>
        <th>名前</th>
        <th style="width:12em">使える範囲</th>
        <th style="width:9em">backend</th>
        <th>用途（note）</th>
        <th style="width:9em">最終使用</th>
        <th style="width:6em"></th>
      </tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>
  <div class="empty" id="empty" hidden></div>
</div>

<dialog id="dlg-new">
  <form method="dialog" class="dialog-body">
    <p class="dialog-title">alias を新規登録</p>
    <p class="dialog-desc">
      値はこの画面から backend へ渡るだけで、banto のどのストアにも残らない。
      登録したあとは、名前でしか参照できない
    </p>
    <label class="field"><span>backend</span><select id="new-impl"></select></label>
    <label class="field"><span>名前</span><input id="new-name" placeholder="github-token" required /></label>
    <label class="field"><span>種別</span><select id="new-kind"></select></label>
    <label class="field"><span>どこから使えるようにするか</span><select id="new-scope"></select></label>
    <label class="field"><span>値の決め方</span><select id="new-source">
      <option value="typed">自分で入力する</option>
      <option value="generated">Vault の中でランダムに作る（値は誰も見ない）</option>
    </select></label>
    <label class="field" id="new-value-field"><span id="new-value-label">値</span>
      <input id="new-value" type="password" autocomplete="off" />
      <!-- **秘密鍵とファイルは1行に入らない**（訂正・2026-09-13） -->
      <textarea id="new-value-multiline" rows="4" autocomplete="off" spellcheck="false" hidden
        placeholder="-----BEGIN OPENSSH PRIVATE KEY----- から -----END ... ----- まで"></textarea>
    </label>
    <div class="field" id="new-generate-field" hidden>
      <span>作る強さ</span>
      <div class="row">
        <select id="new-format" style="width:auto">
          <option value="base64url">base64url（URL・シェルで安全）</option>
          <option value="hex">hex（16進）</option>
        </select>
        <input id="new-bytes" type="number" min="16" max="256" value="32" style="width:6em" />
        <span class="muted">バイト</span>
      </div>
    </div>
    <p class="dialog-desc" id="new-ssh-note" hidden>
      SSH の鍵ペアを Vault の中で作ります。<strong>秘密鍵は誰も見ません。</strong>
      作ったあとに出る公開鍵を、GitHub などに登録してください
    </p>
    <label class="field"><span>用途（任意）</span><textarea id="new-note" rows="2"></textarea></label>
    <div class="problem" id="new-error" hidden></div>
    <div class="dialog-footer">
      <button value="cancel">やめる</button>
      <button id="new-submit" value="ok">登録する</button>
    </div>
  </form>
</dialog>

<dialog id="dlg-pubkey">
  <form method="dialog" class="dialog-body">
    <p class="dialog-title" id="pubkey-title">公開鍵ができました</p>
    <p class="dialog-desc">
      これは<strong>秘密ではありません</strong>。GitHub などの相手方に登録してください。
      対になる秘密鍵は Vault の中にあり、誰も見られません
    </p>
    <textarea id="pubkey-text" rows="3" readonly></textarea>
    <p class="problem" id="pubkey-error" hidden></p>
    <div class="dialog-footer">
      <button id="pubkey-copy" type="button">コピーする</button>
      <button value="ok">閉じる</button>
    </div>
  </form>
</dialog>

<dialog id="dlg-note">
  <form method="dialog" class="dialog-body">
    <p class="dialog-title">用途を書き直す</p>
    <p class="dialog-desc" id="note-target"></p>
    <label class="field"><span>用途（note）</span><textarea id="note-text" rows="3"></textarea></label>
    <div class="problem" id="note-error" hidden></div>
    <div class="dialog-footer">
      <button value="cancel">やめる</button>
      <button id="note-submit" value="ok">保存する</button>
    </div>
  </form>
</dialog>

<dialog id="dlg-delete">
  <form method="dialog" class="dialog-body">
    <p class="dialog-title">この alias を削除する</p>
    <p class="dialog-desc" id="delete-target"></p>
    <p class="dialog-desc">
      値も一緒に消える。これを使っている Module は、次の呼び出しから解決できなくなる
    </p>
    <div class="problem" id="delete-error" hidden></div>
    <div class="dialog-footer">
      <button value="cancel">やめる</button>
      <button class="danger" id="delete-submit" value="ok">削除する</button>
    </div>
  </form>
</dialog>

<dialog id="dlg-groups">
  <form method="dialog" class="dialog-body">
    <!-- **置き場は「Vault とグループの組」で1つ**（改訂・2026-09-14、ユーザー指摘
         「まだバックエンドごとに選ぶ仕様になっている」）。以前はこの画面を
         backend の chip から開いていたので、**同じ問いを backend の数だけ
         聞いていた**——「この Project の秘密は結局どこに行くのか」が読めない。
         1つの問いには1つの答えを出す -->
    <p class="dialog-title">秘密の置き場</p>
    <p class="dialog-desc">
      新しく作る秘密がどこに入るかを決めます。<strong>Vault とグループを一緒に選ぶ</strong>
      ——「この Project の秘密は結局どこに行くのか」が1つに決まるように
    </p>

    <div class="field"><span>この Project の置き場</span>
      <div class="row">
        <select id="place-project-vault" style="flex:1 1 12em"></select>
        <select id="place-project-group" style="flex:1 1 12em"></select>
      </div>
    </div>
    <p class="dialog-desc" id="place-project-note"></p>

    <div class="field"><span>共通の置き場（どの Project からでも使う）</span>
      <div class="row">
        <select id="place-shared-vault" style="flex:1 1 12em"></select>
        <select id="place-shared-group" style="flex:1 1 12em"></select>
      </div>
    </div>
    <p class="dialog-desc">
      <strong>ここが「既定」です。</strong>共通の秘密のうち、ここに居るものは素の名前で引けます
      ——別の Vault に置いた共通の秘密は <code>vault-local:名前</code> のような修飾名で引きます
    </p>

    <div class="row">
      <select id="group-new-vault" style="width:auto"></select>
      <input id="group-new" placeholder="新しいグループの名前" style="flex:1" />
      <button id="group-create" type="button">作る</button>
    </div>
    <p class="dialog-desc">
      backend によっては、グループの作成自体に事前の API 呼び出しが要る（例：Infisical の Folder）。
      事前作成が不要な backend では、ここでの「作る」は一覧に加わるだけで実質なにもしない
    </p>
    <div class="problem" id="groups-error" hidden></div>
    <div class="dialog-footer">
      <button value="cancel">閉じる</button>
      <button id="groups-submit" value="ok">置き場を保存する</button>
    </div>
  </form>
</dialog>

<script>
${ALIAS_KIND_RULES_JS}
(() => {
  // --- MCP Apps の約束ごと（postMessage の JSON-RPC）だけを使う -------------
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

  /** 自分の Module の tool を呼ぶ。**中身が読めないなら読めたふりをしない**（規則2）。 */
  async function callTool(name, args) {
    const res = await request("tools/call", { name, arguments: args || {} });
    const text = res && res.content && res.content[0] && res.content[0].text;
    if (res && res.isError) throw new Error(text || (name + " が失敗しました"));
    if (typeof text !== "string") throw new Error(name + " が中身を返しませんでした");
    try { return JSON.parse(text); } catch { throw new Error(name + " の答えを読み取れませんでした: " + text); }
  }

  /** JSON ではない答え（公開鍵など）をそのまま受け取る。 */
  async function callToolText(name, args) {
    const res = await request("tools/call", { name, arguments: args || {} });
    const text = res && res.content && res.content[0] && res.content[0].text;
    if (res && res.isError) throw new Error(text || (name + " が失敗しました"));
    if (typeof text !== "string" || !text) throw new Error(name + " が中身を返しませんでした");
    return text;
  }

  const $ = (id) => document.getElementById(id);
  const KIND_LABEL = { secret: "汎用シークレット", "ssh-identity": "SSH 身元", file: "ファイル" };

  // --- 状態（導出できるものは持たない、規則3）-------------------------------
  let project = null;          // いまこの画面が開かれている Project（host が渡す）
  let implementations = [];    // vault を名乗っている Module の名前
  let aliases = [];            // 横断した alias（implementation つき）
  let failures = [];           // 読めなかった backend

  function targetOf(a) {
    // **使える範囲は backend が置き場から導いて返す**（改訂・2026-09-13）
    // ——画面で計算し直さない（規則3）
    if (a.scope === "shared") return { key: "shared", label: "どこからでも" };
    if (a.scope === "unbound") return { key: "unbound", label: "どこにも紐付いていない" };
    const ids = a.projects || [];
    if (project && ids.indexOf(project.id) >= 0) {
      return { key: project.id, label: ids.length > 1 ? project.name + " ほか" : project.name };
    }
    if (ids.length === 0) return { key: "unbound", label: "どこにも紐付いていない" };
    return { key: ids[0], label: "別の Project（" + String(ids[0]).slice(0, 8) + "）" };
  }

  function matchesFilters(a) {
    const q = $("query").value.trim().toLowerCase();
    if ($("kind-filter").value !== "all" && a.kind !== $("kind-filter").value) return false;
    if ($("backend-filter").value !== "all" && a.implementation !== $("backend-filter").value) return false;
    if ($("target-filter").value !== "all" && targetOf(a).key !== $("target-filter").value) return false;
    if (!q) return true;
    return [a.name, KIND_LABEL[a.kind] || a.kind, targetOf(a).label, a.implementation, a.note || ""]
      .join(" ").toLowerCase().includes(q);
  }

  function option(value, label) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    return o;
  }

  /** 選択肢は**いま実際にあるものから導く**——存在しない絞り込みを出さない。 */
  function fillFilters() {
    const keep = (sel) => sel.value;
    const kind = $("kind-filter"), target = $("target-filter"), backend = $("backend-filter");
    const kindWas = keep(kind), targetWas = keep(target), backendWas = keep(backend);

    kind.replaceChildren(option("all", "種別：すべて"),
      ...Object.keys(KIND_LABEL).map((k) => option(k, KIND_LABEL[k])));
    const targets = new Map();
    for (const a of aliases) { const t = targetOf(a); targets.set(t.key, t.label); }
    target.replaceChildren(option("all", "使える範囲：すべて"),
      ...Array.from(targets, ([k, l]) => option(k, l)));
    backend.replaceChildren(option("all", "backend：すべて"),
      ...implementations.map((i) => option(i, i)));

    for (const [sel, was] of [[kind, kindWas], [target, targetWas], [backend, backendWas]]) {
      if (was && Array.from(sel.options).some((o) => o.value === was)) sel.value = was;
    }
  }

  function renderImplementations() {
    $("impls").replaceChildren(...implementations.map((name) => {
      const chip = document.createElement("div");
      chip.className = "chip";
      const label = document.createElement("span");
      label.textContent = name;
      const count = document.createElement("span");
      count.className = "muted";
      count.textContent = aliases.filter((a) => a.implementation === name).length + " alias";
      // **置き場は backend ごとに聞かない**（改訂・2026-09-14）。ここに
      // 「グループ」を置くと、同じ問いを backend の数だけ聞くことになる
      chip.append(label, count);
      return chip;
    }));
    if (implementations.length === 0) {
      const none = document.createElement("span");
      none.className = "muted";
      none.textContent = "vault を名乗っている Module が繋がっていません";
      $("impls").replaceChildren(none);
    }
  }

  function renderProblems() {
    // **読めなかった backend を黙って消さない**——一覧が短く見えた理由を出す
    $("problems-section").hidden = failures.length === 0;
    $("problems").textContent = failures
      .map((f) => f.implementation + " の alias を読めませんでした：" + f.error)
      .join(" / ");
  }

  function renderRows() {
    const shown = aliases.filter(matchesFilters);
    $("count").textContent = shown.length === aliases.length
      ? "alias 一覧（" + aliases.length + "）"
      : "alias 一覧（" + shown.length + " / " + aliases.length + "）";

    $("rows").replaceChildren(...shown.map((a) => {
      const tr = document.createElement("tr");
      const cell = (text, cls) => {
        const td = document.createElement("td");
        if (cls) td.className = cls;
        td.textContent = text;
        return td;
      };
      const kindTd = document.createElement("td");
      const kindBadge = document.createElement("span");
      kindBadge.className = "badge";
      kindBadge.textContent = KIND_LABEL[a.kind] || a.kind;
      kindTd.append(kindBadge);

      const targetTd = document.createElement("td");
      const targetBadge = document.createElement("span");
      targetBadge.className = "badge";
      targetBadge.textContent = targetOf(a).label;
      targetTd.append(targetBadge);

      const actions = document.createElement("td");
      actions.className = "actions";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "icon";
      edit.textContent = "用途";
      edit.title = "用途（note）を書き直す";
      edit.addEventListener("click", () => openNote(a));
      const del = document.createElement("button");
      del.type = "button";
      del.className = "icon danger";
      del.textContent = "削除";
      del.addEventListener("click", () => openDelete(a));
      // **公開鍵はいつでも見られる**（追加・2026-09-13、ユーザー指摘）。
      // 作った直後の1回しか出していなかったので、画面を閉じたら二度と
      // 見られなかった——相手方に登録するためのものなのに
      if (a.kind === "ssh-identity") {
        const pub = document.createElement("button");
        pub.type = "button";
        pub.className = "icon";
        pub.textContent = "公開鍵";
        pub.title = "公開鍵を表示してコピーする（秘密鍵は出ません）";
        pub.addEventListener("click", () => openPublicKey(a));
        actions.append(edit, pub, del);
      } else {
        actions.append(edit, del);
      }

      tr.append(
        kindTd,
        cell(a.name, "name"),
        targetTd,
        cell(a.implementation),
        cell(a.note || "", "note-cell"),
        cell(a.lastUsedAt ? new Date(a.lastUsedAt).toLocaleDateString("ja-JP") : "—", "muted"),
        actions,
      );
      return tr;
    }));

    $("empty").hidden = shown.length > 0;
    $("empty").textContent = aliases.length === 0
      ? "登録されている alias はまだありません。"
      : "絞り込みに合う alias がありません。";
  }

  function render() {
    renderImplementations();
    renderProblems();
    fillFilters();
    renderRows();
    send({ jsonrpc: "2.0", method: "ui/notifications/size-changed",
           params: { height: document.documentElement.scrollHeight } });
  }

  async function reload() {
    implementations = await callTool("listVaults");
    const result = await callTool("listAliases");
    aliases = result.aliases || [];
    failures = result.failures || [];
    render();
  }

  // --- 人の操作 --------------------------------------------------------------

  function showError(el, err) {
    el.hidden = false;
    el.textContent = err instanceof Error ? err.message : String(err);
  }

  /** ダイアログの中の「実行」を受ける。**失敗したら閉じない**（やり直せる）。 */
  function onSubmit(dialog, submitButton, errorBox, run) {
    submitButton.addEventListener("click", async (event) => {
      event.preventDefault();
      errorBox.hidden = true;
      submitButton.disabled = true;
      try {
        await run();
        dialog.close();
        await reload();
      } catch (err) {
        showError(errorBox, err);
      } finally {
        submitButton.disabled = false;
      }
    });
  }

  // 新規登録
  $("new-alias").addEventListener("click", () => {
    $("new-error").hidden = true;
    $("new-impl").replaceChildren(...implementations.map((i) => option(i, i)));
    $("new-kind").replaceChildren(...Object.keys(KIND_LABEL).map((k) => option(k, KIND_LABEL[k])));
    const scopes = [option("instance", "どの Project からでも")];
    // **この Project を指せるのは、host がどこで開かれたか渡してくれたときだけ**
    // ——人に UUID を打たせない
    if (project) scopes.unshift(option("project", "この Project（" + project.name + "）だけ"));
    $("new-scope").replaceChildren(...scopes);
    $("new-name").value = "";
    $("new-value").value = "";
    $("new-note").value = "";
    $("new-source").value = "typed";
    applySource();
    $("dlg-new").showModal();
  });
  /**
   * 「自分で入力する」か「作らせる」か、そして種別で、出す欄を入れ替える。
   *
   * **作れる種別は限られる**（汎用シークレットと SSH 鍵。ファイルの中身を
   * ランダムに作ることに意味は無い）——選べない選択肢は**選択肢から消す**。
   * 選べるふりをしない（規則13）。
   */
  function applySource() {
    const generated = $("new-source").value === "generated";
    // 作れる種別だけに絞る（選べない道を選択肢に残さない——規則13）
    const kinds = generated ? generatableKinds() : Object.keys(KIND_LABEL);
    const was = $("new-kind").value;
    $("new-kind").replaceChildren(...kinds.map((k) => option(k, KIND_LABEL[k])));
    $("new-kind").value = kinds.includes(was) ? was : kinds[0];

    // **何を聞くかは種別が決める**——規則は kind-rules.ts の1枚だけ（規則3）
    const rule = kindRule($("new-kind").value);
    $("new-value-label").textContent = rule.valueLabel;
    $("new-value-field").hidden = generated;
    $("new-value").hidden = rule.multiline;
    $("new-value-multiline").hidden = !rule.multiline;
    $("new-generate-field").hidden = !generated || !rule.strength;
    $("new-ssh-note").textContent = rule.note || "";
    $("new-ssh-note").hidden = !generated || !rule.note;
  }
  /** いま使っている値の入力欄（種別で1行か複数行かが変わる）。 */
  function newValueInput() {
    return kindRule($("new-kind").value).multiline ? $("new-value-multiline") : $("new-value");
  }
  $("new-source").addEventListener("change", applySource);
  $("new-kind").addEventListener("change", applySource);

  /** 公開鍵は**秘密ではない**——むしろ出さないと使えない。 */
  function showPublicKey(publicKey, title) {
    $("pubkey-title").textContent = title || "公開鍵ができました";
    $("pubkey-text").value = publicKey;
    $("pubkey-error").hidden = true;
    $("dlg-pubkey").showModal();
  }

  /**
   * 既にある鍵の公開鍵を読む。**保存していない**ので backend に聞く
   * （秘密鍵から導かれる。規則3——導出できる値を持たない）。
   */
  async function openPublicKey(a) {
    showPublicKey("", "公開鍵：" + a.name);
    $("pubkey-text").value = "読み込んでいます…";
    try {
      // **返ってこなかったら、そう言う**（規則2——空の箱を出さない）
      // **名前は instance 全体で一意**なので、どの金庫かは窓口が引く
      $("pubkey-text").value = await callToolText("getPublicKey", { name: a.name });
    } catch (err) {
      $("pubkey-text").value = "";
      showError($("pubkey-error"), err);
    }
  }
  $("pubkey-copy").addEventListener("click", () => {
    $("pubkey-text").select();
    void navigator.clipboard?.writeText($("pubkey-text").value);
  });

  onSubmit($("dlg-new"), $("new-submit"), $("new-error"), async () => {
    const placement = $("new-scope").value;
    const common = {
      implementation: $("new-impl").value,
      name: $("new-name").value.trim(),
      forProject: placement === "project" && project ? project.id : undefined,
      note: $("new-note").value.trim() || undefined,
    };
    if ($("new-source").value === "generated") {
      const kind = $("new-kind").value;
      // **値はこの画面を一度も通らない**——Vault の中で作られて、そこに残る
      const result = await callTool("generateSecret", {
        ...common,
        kind,
        // 鍵の強さは鍵の種類が決まる（SSH では渡してはいけない）
        ...(kind === "ssh-identity"
          ? {}
          : { format: $("new-format").value, bytes: Number($("new-bytes").value) }),
      });
      if (kindRule(kind).returnsPublicKey) {
        // **返らなかったら、そう言う**（規則2——黙ると「作れたのか壊れたのか」
        // が分からない。会話の中の入力欄では空の箱が出ていた）
        if (!result || !result.publicKey) throw new Error("鍵は登録できましたが、公開鍵が返ってきませんでした");
        showPublicKey(result.publicKey);
      }
      return;
    }
    const input = newValueInput();
    if (!input.value) throw new Error(kindRule($("new-kind").value).valueLabel + "を入力してください");
    await callTool("createAlias", { ...common, kind: $("new-kind").value, value: input.value });
    // **値を画面に残さない**——閉じたあとの DOM にも置かない
    $("new-value").value = "";
    $("new-value-multiline").value = "";
  });

  // 用途を書き直す
  let noteTarget = null;
  function openNote(a) {
    noteTarget = a;
    $("note-error").hidden = true;
    $("note-target").textContent = a.implementation + " / " + a.name;
    $("note-text").value = a.note || "";
    $("dlg-note").showModal();
  }
  onSubmit($("dlg-note"), $("note-submit"), $("note-error"), async () => {
    await callTool("updateAlias", {
      implementation: noteTarget.implementation,
      name: noteTarget.name,
      note: $("note-text").value.trim(),
    });
  });

  // 削除
  let deleteTarget = null;
  function openDelete(a) {
    deleteTarget = a;
    $("delete-error").hidden = true;
    $("delete-target").textContent = a.implementation + " / " + a.name;
    $("dlg-delete").showModal();
  }
  onSubmit($("dlg-delete"), $("delete-submit"), $("delete-error"), async () => {
    await callTool("deleteAlias", { implementation: deleteTarget.implementation, name: deleteTarget.name });
  });

  // **置き場**（Vault とグループの組）。backend ごとに聞かない
  let placements = null;

  async function openGroups() {
    $("groups-error").hidden = true;
    $("dlg-groups").showModal();
    await refreshPlacements();
  }

  function fillGroupChoices(vaultSelect, groupSelect, chosenVault, chosenGroup) {
    const vaults = (placements && placements.vaults) || [];
    vaultSelect.replaceChildren(...vaults.map((v) => option(v.implementation, v.implementation)));
    if (chosenVault) vaultSelect.value = chosenVault;
    const groups = (vaults.find((v) => v.implementation === vaultSelect.value) || {}).groups || [];
    groupSelect.replaceChildren(...groups.map((g) => option(g, g)));
    if (chosenGroup && groups.includes(chosenGroup)) groupSelect.value = chosenGroup;
    groupSelect.disabled = groups.length === 0;
  }

  async function refreshPlacements() {
    try {
      placements = await callTool("getPlacements", project ? { projectId: project.id } : {});
      fillGroupChoices(
        $("place-project-vault"),
        $("place-project-group"),
        placements.project ? placements.project.implementation : placements.shared.implementation,
        placements.project ? placements.project.group : undefined,
      );
      fillGroupChoices(
        $("place-shared-vault"),
        $("place-shared-group"),
        placements.shared.implementation,
        placements.shared.group,
      );
      $("group-new-vault").replaceChildren(
        ...((placements.vaults || []).map((v) => option(v.implementation, v.implementation))),
      );
      // **この画面がどの Project で開かれたか**を言う——人に UUID を選ばせない
      $("place-project-note").textContent = project
        ? (placements.project ? "" : "まだ決まっていません（保存すると、この Project 用のグループに紐付きます）")
        : "この画面は Project の上で開かれていないので、Project の置き場は決められません";
      for (const id of ["place-project-vault", "place-project-group"]) $(id).disabled = !project;
    } catch (err) {
      showError($("groups-error"), err);
    }
  }
  $("place-project-vault").addEventListener("change", () =>
    fillGroupChoices($("place-project-vault"), $("place-project-group")),
  );
  $("place-shared-vault").addEventListener("change", () =>
    fillGroupChoices($("place-shared-vault"), $("place-shared-group")),
  );

  // **絞り込みは打つそばから効く**（消してしまっていた・2026-09-14）
  for (const id of ["query", "kind-filter", "target-filter", "backend-filter"]) {
    $(id).addEventListener("input", renderRows);
  }

  $("open-placement").addEventListener("click", () => void openGroups());

  $("group-create").addEventListener("click", async () => {
    $("groups-error").hidden = true;
    try {
      await callTool("createGroup", {
        implementation: $("group-new-vault").value,
        name: $("group-new").value.trim(),
      });
      $("group-new").value = "";
      await refreshPlacements();
    } catch (err) {
      showError($("groups-error"), err);
    }
  });

  onSubmit($("dlg-groups"), $("groups-submit"), $("groups-error"), async () => {
    // **共通が先**——Project の置き場は「既定と同じでよい」ことが多いので、
    // 先に既定を決めてから Project を決めるほうが、画面の流れと合う
    await callTool("setSharedPlacement", {
      implementation: $("place-shared-vault").value,
      group: $("place-shared-group").value,
    });
    if (project && $("place-project-group").value) {
      await callTool("setProjectPlacement", {
        projectId: project.id,
        implementation: $("place-project-vault").value,
        group: $("place-project-group").value,
      });
    }
    await refresh();
  });

  // --- 立ち上がり ------------------------------------------------------------
  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "banto-vault-directory", version: "0.1.0" },
    appCapabilities: { availableDisplayModes: ["fullscreen", "inline"] },
  }).then(async (result) => {
    const host = (result && result.hostContext) || {};
    const vars = ((host.styles || {}).variables) || {};
    for (const [k, v] of Object.entries(vars)) {
      document.documentElement.style.setProperty("--mcp-ui-" + k, String(v));
    }
    // **どこで開かれたか**（banto が渡す。無ければ instance 全体の面として動く）
    const ctx = host["dev.banto/project"];
    project = ctx && typeof ctx.id === "string" ? { id: ctx.id, name: String(ctx.name || ctx.id) } : null;

    send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    await reload();
  }).catch((err) => {
    // **開けなかったことを、空の一覧として見せない**（規則2・規則13）
    document.body.replaceChildren(Object.assign(document.createElement("div"), {
      className: "section",
      textContent: "Vault の管理画面を開けませんでした：" + (err && err.message ? err.message : String(err)),
    }));
  });
})();
</script>
</body>
</html>
`;
