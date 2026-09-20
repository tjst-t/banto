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
  /* 添え物のボタン。主役（新規登録）と競らせない */
  button.quiet { padding: 2px 8px; font-size: 11px; }
  input, select, textarea {
    font: inherit; font-size: 12px; padding: 5px 8px; width: 100%;
    border-radius: 6px; background: transparent; color: inherit;
    border: 1px solid var(--mcp-ui-color-border, rgba(128,128,128,.35));
  }
  /* **列幅を固定する**（改訂・2026-09-20、ユーザー指摘）。自動幅だと、名前の
     長い秘密（CLOUDFLARE_ACCOUNT_ID など）が入った列が潰れ、word-break で
     **1文字ずつ縦に流れて**表が読めなくなっていた */
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th { text-align: left; font-weight: 500; font-size: 11px; opacity: .55; padding: 0 8px 6px 0; }
  td { padding: 6px 8px 6px 0; border-top: 1px solid var(--mcp-ui-color-border, rgba(128,128,128,.18)); vertical-align: middle; }
  /* **はみ出したら … で畳む。折り返さない。**
     **JS で文字列を切らない**——切ると、選んでコピーしたときに切れたものが
     取れてしまう。CSS の省略なら DOM には全文が在るので、コピーは全文 */
  td.clip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  td.name { font-weight: 500; }
  td.actions { text-align: right; white-space: nowrap; }
  .note-cell { opacity: .7; }
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
  <!-- **初見の人に向けて書く**（改訂・2026-09-15）。以前は仕様書の文
       （「複数の Vault 実装を横断して確認・編集する」）がそのまま出ていた -->
  <p class="lead">
    API トークンや SSH 鍵を預けておく場所。<strong>AI には名前しか見えません</strong>
    ——値を見せないまま、コマンドの中で使わせられます。
    この画面に出るのも名前・種別・用途・使用状況だけで、値はどこにも出ません
  </p>
</div>

<div class="section">
  <p class="label">接続している実装</p>
  <div class="row" id="impls"></div>
  <!-- **置き場は「どこに在るか」の段に置く**（改訂・2026-09-14、ユーザー指摘
       「一覧の見出しの真ん中にあるのは変」）。一覧の見出しに混ぜると、
       list の操作に見えるうえ、3つ並びの真ん中が中央寄せになって浮く。
       ここなら **いまどこに保存しているかを先に出せる**——ボタンだけ置くより、
       画面が答えられる問いが1つ増える -->
  <div class="row" id="place-line" style="margin-top:8px" hidden>
    <span class="muted" id="place-summary"></span>
    <button id="open-place" class="quiet">変更…</button>
  </div>
  <!-- **道標は両方向に要る**（追加・2026-09-15）。設定画面には「Project ごとは
       管理画面から」と書いてあるのに、こちらには共通の変え方が書いていなかった。
       「共通＝設定、Project＝ここ」は**値が動くかどうか**という作り手の軸で、
       人の軸（「保存先を変えたい」）では同じ問い -->
  <p class="muted" id="shared-hint" style="margin:6px 0 0; font-size:11px"></p>
</div>

<div class="section" id="problems-section" hidden>
  <div class="problem" id="problems"></div>
</div>

<div class="section">
  <div class="spread" style="margin-bottom:8px">
    <p class="label" style="margin:0" id="count">預けている秘密</p>
    <button id="new-alias">＋ 秘密を登録</button>
  </div>

  <div class="row" style="margin-bottom:8px">
    <input id="query" placeholder="名前・種別・使える範囲・グループ・Vault・用途を横断して検索" style="flex:1 1 14em; min-width:12em" />
    <select id="kind-filter" style="width:auto"></select>
    <select id="target-filter" style="width:auto"></select>
    <select id="backend-filter" style="width:auto"></select>
  </div>

  <table>
    <thead>
      <!-- **見出しも中身も端的に**（改訂・2026-09-20、ユーザー指示）。
           名前と用途だけを伸び縮みさせ、他は固定幅で畳む -->
      <tr>
        <th style="width:7.5em">種別</th>
        <th>名前</th>
        <th style="width:8em">使える範囲</th>
        <th style="width:9em" data-vault-col>Vault</th>
        <!-- **backend での本当の名前を出す**（改訂・2026-09-20、ユーザー指示）。
             Infisical ならフォルダ名そのもの。使える範囲は置き場から導いた値なので、
             元を隠すと「どのフォルダに在るのか」が画面から分からない -->
        <th style="width:9em">グループ</th>
        <th>用途</th>
        <th style="width:6.5em">最終使用</th>
        <th style="width:11em"></th>
      </tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>
  <div class="empty" id="empty" hidden></div>
</div>

<dialog id="dlg-new">
  <form method="dialog" class="dialog-body">
    <p class="dialog-title">秘密を登録</p>
    <p class="dialog-desc">
      値はこの画面から Vault へ渡るだけで、banto のどのストアにも残らない。
      登録したあとは、名前でしか参照できない
    </p>
    <!-- **backend は聞かない**（改訂・2026-09-14、ユーザー指摘）。保存先を
         選べば Vault は決まるので、**同じことを2回聞いていた** -->
    <label class="field"><span>名前</span><input id="new-name" placeholder="github-token" required /></label>
    <label class="field"><span>種別</span><select id="new-kind"></select></label>
    <!-- **聞くのは置き場、出すのは範囲**（改訂・2026-09-14、ユーザー指摘）。
         設計は「グループが唯一の真実で、使える範囲は導出値」なのに、以前は
         **導出値のほうを人に入力させていた**（「どこから使えるようにするか」）
         ——順序が逆だった -->
    <label class="field"><span>保存先</span><select id="new-scope"></select></label>
    <p class="dialog-desc" id="new-scope-effect"></p>
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
      <!-- **やめるは、検証を通さない**（訂正・2026-09-15、試験を書いていて発覚）。
           method="dialog" の送信でも required の検証は走るので、名前が空のまま
           「やめる」を押すと**ダイアログが閉じない**（検証の吹き出しが出るだけ）
           ——入力をやめたい人ほど、やめられなかった -->
      <button value="cancel" formnovalidate>やめる</button>
      <button id="new-submit" value="ok">登録する</button>
    </div>
  </form>
</dialog>

<dialog id="dlg-place">
  <form method="dialog" class="dialog-body">
    <!-- **置き場を変えるのは設定ではなく操作**（決定・2026-09-14、ユーザー指示）
         ——値が動くので、設定画面ではなくここ（操作の面）に置く -->
    <p class="dialog-title">この Project の秘密の置き場を変える</p>
    <p class="dialog-desc" id="place-now"></p>
    <div class="field"><span>新しい置き場</span>
      <div class="row">
        <select id="place-vault" style="flex:1 1 12em"></select>
        <select id="place-group" style="flex:1 1 12em"></select>
      </div>
    </div>
    <label class="field"><span>いまある秘密をどうするか</span>
      <select id="place-migrate">
        <option value="yes">一緒に移す</option>
        <option value="no">移さない（古い置き場に残す）</option>
      </select>
    </label>
    <p class="dialog-desc" id="place-effect"></p>
    <div class="problem" id="place-error" hidden></div>
    <div class="dialog-footer">
      <!-- **やめるは、検証を通さない**（訂正・2026-09-15、試験を書いていて発覚）。
           method="dialog" の送信でも required の検証は走るので、名前が空のまま
           「やめる」を押すと**ダイアログが閉じない**（検証の吹き出しが出るだけ）
           ——入力をやめたい人ほど、やめられなかった -->
      <button value="cancel" formnovalidate>やめる</button>
      <button id="place-submit" value="ok">変える</button>
    </div>
  </form>
</dialog>

<dialog id="dlg-move">
  <form method="dialog" class="dialog-body">
    <!-- **1件だけ移す**（追加・2026-09-15）。置き場の変更（dlg-place）は
         Project 全体の話で、こちらは行単位。どこにも紐付いていない秘密を
         直す道がここしか無いので、削除以外の出口として要る -->
    <p class="dialog-title">この秘密を別の置き場へ移す</p>
    <p class="dialog-desc" id="move-now"></p>
    <div class="field"><span>移す先</span>
      <div class="row">
        <select id="move-vault" style="flex:1 1 12em"></select>
        <select id="move-group" style="flex:1 1 12em"></select>
      </div>
    </div>
    <p class="dialog-desc" id="move-effect"></p>
    <div class="problem" id="move-error" hidden></div>
    <div class="dialog-footer">
      <!-- **やめるは、検証を通さない**（訂正・2026-09-15、試験を書いていて発覚）。
           method="dialog" の送信でも required の検証は走るので、名前が空のまま
           「やめる」を押すと**ダイアログが閉じない**（検証の吹き出しが出るだけ）
           ——入力をやめたい人ほど、やめられなかった -->
      <button value="cancel" formnovalidate>やめる</button>
      <button id="move-submit" value="ok">移す</button>
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
      <!-- **押した結果を必ず言う**（追加・2026-09-15）——黙って失敗しない -->
      <span class="muted" id="pubkey-copied" style="margin-right:auto"></span>
      <button id="pubkey-copy" type="button">コピーする</button>
      <button value="ok">閉じる</button>
    </div>
  </form>
</dialog>

<dialog id="dlg-note">
  <form method="dialog" class="dialog-body">
    <p class="dialog-title">用途を書き直す</p>
    <p class="dialog-desc" id="note-target"></p>
    <label class="field"><span>用途（この秘密が何のためのものか）</span><textarea id="note-text" rows="3"></textarea></label>
    <div class="problem" id="note-error" hidden></div>
    <div class="dialog-footer">
      <!-- **やめるは、検証を通さない**（訂正・2026-09-15、試験を書いていて発覚）。
           method="dialog" の送信でも required の検証は走るので、名前が空のまま
           「やめる」を押すと**ダイアログが閉じない**（検証の吹き出しが出るだけ）
           ——入力をやめたい人ほど、やめられなかった -->
      <button value="cancel" formnovalidate>やめる</button>
      <button id="note-submit" value="ok">保存する</button>
    </div>
  </form>
</dialog>

<dialog id="dlg-delete">
  <form method="dialog" class="dialog-body">
    <p class="dialog-title">この秘密を削除する</p>
    <p class="dialog-desc" id="delete-target"></p>
    <p class="dialog-desc">
      値も一緒に消える。これを使っているコマンドは、次から動かなくなる
    </p>
    <div class="problem" id="delete-error" hidden></div>
    <div class="dialog-footer">
      <!-- **やめるは、検証を通さない**（訂正・2026-09-15、試験を書いていて発覚）。
           method="dialog" の送信でも required の検証は走るので、名前が空のまま
           「やめる」を押すと**ダイアログが閉じない**（検証の吹き出しが出るだけ）
           ——入力をやめたい人ほど、やめられなかった -->
      <button value="cancel" formnovalidate>やめる</button>
      <button class="danger" id="delete-submit" value="ok">削除する</button>
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
  // **一覧の見出し。作れる種別とは別**（oauth-token は banto が置くもので、
  // 人は作らないが**見えて消せる**べき——規則13）
  // **短く言う**（改訂・2026-09-20、ユーザー指示）。badge は1行に収める語で、
  // 説明は書かない——「ログイン情報（OAuth）」のような説明つきの語は、
  // 列を押し広げて名前の列を潰していた
  const KIND_LABEL = {
    secret: "シークレット",
    "ssh-identity": "SSH 鍵",
    file: "ファイル",
    "oauth-token": "OAuth",
  };

  // --- 状態（導出できるものは持たない、規則3）-------------------------------
  let project = null;          // いまこの画面が開かれている Project（host が渡す）
  let implementations = [];    // vault を名乗っている Module の名前
  let aliases = [];            // 横断した alias（implementation つき）
  let failures = [];           // 読めなかった Vault
  let placements = null;       // 置き場（共通・この Project）と Vault ごとのグループ
  let movePlaces = null;       // 「移す」ダイアログが見ている置き場

  function targetOf(a) {
    // **使える範囲は backend が置き場から導いて返す**（改訂・2026-09-13）
    // ——画面で計算し直さない（規則3）
    // **保存先の言葉とそろえる**（改訂・2026-09-15）。保存先で「共通」を選んだ
    // ものが一覧で「どこからでも」と出ると、人が対応を暗記することになる
    // **「共通」ではなく Global**（改訂・2026-09-20、ユーザー指示）——banto の他所
    // （instance 全体の設定）が既に Global と呼んでいるので、そちらに寄せる。
    // **説明は付けない**（改訂・2026-09-20）——badge は1語。意味は「使える範囲」
    // という見出しが言っている
    if (a.scope === "shared") return { key: "shared", label: "Global" };
    if (a.scope === "unbound") return { key: "unbound", label: "未割当" };
    const ids = a.projects || [];
    if (project && ids.indexOf(project.id) >= 0) {
      return { key: project.id, label: ids.length > 1 ? project.name + " ほか" : project.name };
    }
    if (ids.length === 0) return { key: "unbound", label: "未割当" };
    // **他の Project は1つにまとめる**（改訂・2026-09-20）。以前は id の頭8桁を
    // label に混ぜて見分けていたが、短くすると**同じ文字列の選択肢が絞り込みに
    // 並ぶ**ことになる——key も1つにして、まとめて絞れる形にする
    return { key: "other", label: "別の Project" };
  }

  /**
   * **いまこの Project から使えるか**（追加・2026-09-20、ユーザー指示）。
   *
   * この Project 専用のものと Global。**素の名前で引ける範囲と同じ**
   * （窓口の解決順「Project ＞ Global の既定」）——画面の既定の絞り込みが
   * 「いまここで名前を書けば通るもの」と一致する。判定はここだけ（規則3）。
   */
  function usableHere(a) {
    if (a.scope === "shared") return true;
    return !!project && (a.projects || []).indexOf(project.id) >= 0;
  }

  function matchesFilters(a) {
    const q = $("query").value.trim().toLowerCase();
    if ($("kind-filter").value !== "all" && a.kind !== $("kind-filter").value) return false;
    if ($("backend-filter").value !== "all" && a.implementation !== $("backend-filter").value) return false;
    const target = $("target-filter").value;
    if (target === "usable") {
      if (!usableHere(a)) return false;
    } else if (target !== "all" && targetOf(a).key !== target) {
      return false;
    }
    if (!q) return true;
    // **グループも検索に入れる**——列に出したものが引けないと、見えているのに探せない。
    // 引けるのは**列に出ている文字列**（backend での本当の名前）
    return [a.name, KIND_LABEL[a.kind] || a.kind, targetOf(a).label,
            a.group || "", a.implementation, a.note || ""]
      .join(" ").toLowerCase().includes(q);
  }

  /**
   * **グループの見える名前**（追加・2026-09-15、レビューで発覚）。
   *
   * Project の既定グループ名は projectId（UUID）そのもの——衝突しない値を
   * 選んだ結果だが、**人は UUID からどの Project のものか判別できない**。
   * 「1つのグループに複数の Project を向けるのが共有の意思表示」という設計が、
   * 画面の上では実質できない状態になっていた。
   *
   * **識別子は変えず、見せ方だけ変える**——既に在る秘密の置き場を動かさずに済む。
   */
  function groupLabel(impl, group) {
    const p = placements && placements.project;
    const sh = placements && placements.shared;
    if (p && p.implementation === impl && p.group === group) {
      return project ? "この Project 専用（" + project.name + "）" : "この Project 専用";
    }
    if (sh && sh.implementation === impl && sh.group === group) return "Global";
    // UUID そのままの名前は、人にとって意味が無い——せめて何であるかを言う
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(group)) return "別の Project 専用（" + group.slice(0, 8) + "…）";
    return group;
  }

  /** **その置き場に入れると、どう引けるようになるか**（1箇所で決める・規則3）。 */
  function placementEffect(impl, group) {
    const p = placements && placements.project;
    const sh = placements && placements.shared;
    if (p && p.implementation === impl && p.group === group) {
      return "→ この Project からだけ使えます（素の名前で引けます）";
    }
    if (sh && sh.implementation === impl && sh.group === group) {
      return "→ どの Project からでも使えます（素の名前で引けます）";
    }
    return "→ 既定の置き場ではないので、" + impl + ":名前 のように " + impl + " を頭に付けて引きます";
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

    // **種別も、いま実際にあるものだけ**（訂正・2026-09-15）。この関数の
    // 見出しは「いま実際にあるものから導く」なのに、種別だけ全部出していた
    // ——選んでも必ず0件になる絞り込みが並ぶ
    const kinds = Object.keys(KIND_LABEL).filter((k) => aliases.some((a) => a.kind === k));
    kind.replaceChildren(option("all", "種別：すべて"), ...kinds.map((k) => option(k, KIND_LABEL[k])));
    const targets = new Map();
    for (const a of aliases) { const t = targetOf(a); targets.set(t.key, t.label); }
    // **「この Project から使える」を先頭に置く**（追加・2026-09-20、ユーザー指示）。
    // 専用のものと Global をまとめた1つの選択肢——この2つは別々の key なので、
    // 導出した一覧（targets）からは作れない。Project の上でだけ出す（規則13）
    target.replaceChildren(option("all", "使える範囲：すべて"),
      ...(project ? [option("usable", "この Project から使える")] : []),
      ...Array.from(targets, ([k, l]) => option(k, l)));
    backend.replaceChildren(option("all", "Vault：すべて"), ...implementations.map((i) => option(i, i)));
    // **Vault が1本なら、選ばせない**（追加・2026-09-15）。選択肢が1つしかない
    // 絞り込みは、画面の情報量を増やすだけで何も決められない。
    // 同じ理由で表の Vault 列も畳む（どれも同じ値しか出ない）
    const manyVaults = implementations.length > 1;
    backend.hidden = !manyVaults;
    for (const el of document.querySelectorAll("[data-vault-col]")) el.hidden = !manyVaults;

    for (const [sel, was] of [[kind, kindWas], [target, targetWas], [backend, backendWas]]) {
      if (was && Array.from(sel.options).some((o) => o.value === was)) sel.value = was;
    }
    // **既定は「この Project から使える」**（決定・2026-09-20、ユーザー指示）。
    // Vault は banto 全体に1本なので、何も絞らないと**他の Project の秘密が
    // 全部並ぶ**——Project の上で開いているのに、関係の無いものが大半になる。
    // **当てるのは初回だけ**（前の選択が空のとき）——人が「すべて」に
    // 変えたあと、再読み込みのたびに巻き戻さない
    if (!targetWas && project) target.value = "usable";
  }

  function renderImplementations() {
    $("impls").replaceChildren(...implementations.map((name) => {
      const chip = document.createElement("div");
      chip.className = "chip";
      const label = document.createElement("span");
      label.textContent = name;
      const count = document.createElement("span");
      count.className = "muted";
      count.textContent = aliases.filter((a) => a.implementation === name).length + " 件";
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
      .map((f) => f.implementation + " の秘密を読めませんでした：" + f.error)
      .join(" / ");
  }

  function renderRows() {
    const shown = aliases.filter(matchesFilters);
    $("count").textContent = shown.length === aliases.length
      ? "預けている秘密（" + aliases.length + "）"
      : "預けている秘密（" + shown.length + " / " + aliases.length + "）";

    $("rows").replaceChildren(...shown.map((a) => {
      const tr = document.createElement("tr");
      const cell = (text, cls, attr) => {
        const td = document.createElement("td");
        if (cls) td.className = cls;
        if (attr) td.setAttribute(attr, "");
        td.textContent = text;
        return td;
      };
      /**
       * **はみ出す列は … で畳み、全文は指を乗せれば読める**
       * （追加・2026-09-20、ユーザー指示）。
       *
       * **切るのは CSS で、文字列ではない**——textContent には全文を入れる。
       * JS で切ってしまうと、選んでコピーしたときに**切れたものが取れる**。
       */
      const clipped = (text, cls) => {
        const td = cell(text, cls ? "clip " + cls : "clip");
        if (text) td.title = text;
        return td;
      };
      const kindTd = document.createElement("td");
      const kindBadge = document.createElement("span");
      kindBadge.className = "badge";
      kindBadge.textContent = KIND_LABEL[a.kind] || a.kind;
      kindTd.append(kindBadge);

      const targetTd = document.createElement("td");
      targetTd.className = "clip";
      const targetBadge = document.createElement("span");
      targetBadge.className = "badge";
      targetBadge.textContent = targetOf(a).label;
      // Project 名が長いことはある——badge は縮めずに、畳んだうえで指で読ませる
      targetBadge.title = targetOf(a).label;
      targetTd.append(targetBadge);

      // **backend での本当の名前をそのまま出す**（改訂・2026-09-20、ユーザー指示）。
      // Infisical ならフォルダ名。言い換え（「この Project 専用（…）」）は
      // **長いうえに、実際に見に行く先の名前と一致しない**——人が Infisical を
      // 開いたときに突き合わせられる名前を出す
      const groupTd = clipped(a.group || "", "muted");

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
      // **どこにも紐付いていないものを、行き止まりにしない**（追加・2026-09-15）。
      // 置き場の変更で「移さない」を選ぶと秘密は unbound になり、画面は
      // そう出すのに**直す操作がどこにも無かった**——できるのは削除だけ。
      // 「使えなくなります」と警告した先が行き止まりでは、警告の意味が半分になる
      const move = document.createElement("button");
      move.type = "button";
      move.className = "icon";
      move.textContent = "移す";
      move.title = "この秘密を別の置き場へ移す";
      move.addEventListener("click", () => openMove(a));
      if (a.kind === "ssh-identity") {
        const pub = document.createElement("button");
        pub.type = "button";
        pub.className = "icon";
        pub.textContent = "公開鍵";
        pub.title = "公開鍵を表示してコピーする（秘密鍵は出ません）";
        pub.addEventListener("click", () => openPublicKey(a));
        actions.append(edit, pub, move, del);
      } else {
        actions.append(edit, move, del);
      }

      // Vault が1本しかないときは畳む（fillFilters が hidden を立てる）
      const vaultTd = clipped(a.implementation);
      vaultTd.setAttribute("data-vault-col", "");

      tr.append(
        kindTd,
        clipped(a.name, "name"),
        targetTd,
        vaultTd,
        groupTd,
        clipped(a.note || "", "note-cell"),
        cell(a.lastUsedAt ? new Date(a.lastUsedAt).toLocaleDateString("ja-JP") : "—", "muted"),
        actions,
      );
      return tr;
    }));

    $("empty").hidden = shown.length > 0;
    $("empty").textContent = aliases.length === 0
      // **この場所が何のためにあるかを言う**（追加・2026-09-15）。
      // 「まだありません」だけだと、初見の人は何をする場所か分からない
      ? "まだ何も預けていません。API トークンや SSH 鍵をここに預けると、"
        + "AI に値を見せないまま、コマンドの中で使えるようになります。"
      // **既定で隠していることを言う**（追加・2026-09-20）。既定の絞り込みを
      // 入れた以上、「0 件」が「預けていない」に見えてはいけない
      : $("target-filter").value === "usable"
        ? "この Project から使える秘密はまだありません。"
          + "「使える範囲：すべて」にすると、他の Project のものや未割当のものも出ます。"
        : "絞り込みに合う秘密がありません。";
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
    await reloadPlacement();
    render();
  }

  /**
   * この Project の秘密がどこに保存されるか。**Project の上で開かれたときだけ出す**
   * ——instance 全体の面には Project の置き場が無いので、押せないボタンを置かない
   * （規則13——繋がっていないものを画面に残さない）。
   */
  async function reloadPlacement() {
    // **置き場は Project が無くても読む**——グループの見える名前（groupLabel）と
    // 保存先の重複排除が、共通の置き場を知っている必要があるため
    try {
      placements = await callTool("getPlacements", project ? { projectId: project.id } : {});
    } catch (err) {
      placements = null;
      if (project) {
        // **読めなかったことを、無いことにしない**（規則2）
        $("place-summary").textContent =
          "置き場を読めませんでした：" + (err && err.message ? err.message : String(err));
        $("place-line").hidden = false;
      }
      return;
    }
    if (!project) {
      // Project の上で開かれていないなら、Project の置き場の行は出さない（規則13）
      $("place-line").hidden = true;
      return;
    }
    // **1行に収める**（改訂・2026-09-20、ユーザー指示）。括弧の言い換えは
    // 「使える範囲」の列がもう言っているので、ここで繰り返さない
    $("shared-hint").textContent =
      "Global の置き場" +
      (placements.shared
        ? "は " + placements.shared.implementation + " / " + placements.shared.group
        : "") +
      "（変えるのは 設定 → Vault の窓口）";
    $("place-summary").textContent = placements.project
      ? "この Project の保存先は " +
        placements.project.implementation +
        " / " +
        placements.project.group
      : "この Project の保存先はまだ決まっていません（最初に保存したときに決まります）";
    $("place-line").hidden = false;
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
    $("new-kind").replaceChildren(...Object.keys(KIND_LABEL).map((k) => option(k, KIND_LABEL[k])));
    void fillPlacementChoices();
    $("new-name").value = "";
    $("new-value").value = "";
    // **複数行の欄も消す**（訂正・2026-09-15）。消していなかったので、
    // 秘密鍵を貼って「やめる」を押すと DOM に残り、**次に開くと前回の
    // 秘密鍵が見えていた**——このファイルの冒頭の宣言（値はどこにも残らない）と
    // 食い違っていた
    $("new-value-multiline").value = "";
    $("new-note").value = "";
    $("new-source").value = "typed";
    applySource();
    $("dlg-new").showModal();
  });
  /**
   * **保存先の選択肢**（改訂・2026-09-14）。Vault とグループの組を1つ選ぶ
   * ——backend を別に聞かない。選んだ結果の「どこから使えるか」はその場に出す。
   */
  async function fillPlacementChoices() {
    let places = placements;
    try {
      places = placements = await callTool("getPlacements", project ? { projectId: project.id } : {});
    } catch {
      // 置き場が読めなくても登録の道は塞がない——既定に入る
      places = placements;
    }
    const opts = [];
    // **この Project を指せるのは、host がどこで開かれたか渡してくれたときだけ**
    // ——人に UUID を打たせない
    const where = places && places.project;
    if (project) {
      opts.push(
        option(
          "project",
          "この Project（" + project.name + "）" + (where ? "——" + where.implementation + " / " + where.group : ""),
        ),
      );
    }
    const shared = places && places.shared;
    opts.push(option("shared", "Global" + (shared ? "——" + shared.implementation + " / " + shared.group : "")));
    // 既定の外に置きたい人向け（**修飾名でしか引けなくなる**ので、そう言う）。
    // **既定と同じ置き場は出さない**（訂正・2026-09-15、レビューで発覚）
    // ——同じ場所が2回並ぶうえ、下の重複を選ぶと「既定ではないので修飾名で」と
    // **画面が嘘をつく**（実際は素の名前で引ける）
    const isDefault = (impl, g) =>
      (!!where && where.implementation === impl && where.group === g) ||
      (!!shared && shared.implementation === impl && shared.group === g);
    for (const v of (places && places.vaults) || []) {
      for (const g of v.groups) {
        if (isDefault(v.implementation, g)) continue;
        opts.push(
          option("at:" + v.implementation + ":" + g, v.implementation + " / " + groupLabel(v.implementation, g)),
        );
      }
    }
    $("new-scope").replaceChildren(...opts);
    applyPlacementEffect();
  }

  /** **選んだ結果がどうなるか**を、その場に出す（導出値は見せるもの）。 */
  function applyPlacementEffect() {
    const v = $("new-scope").value;
    const note = $("new-scope-effect");
    if (v === "project") note.textContent = "→ この Project からだけ使えます（素の名前で引けます）";
    else if (v === "shared") note.textContent = "→ どの Project からでも使えます（素の名前で引けます）";
    else {
      const at = v.slice(3);
      const impl = at.slice(0, at.indexOf(":"));
      note.textContent = placementEffect(impl, at.slice(at.indexOf(":") + 1));
    }
  }
  $("new-scope").addEventListener("change", applyPlacementEffect);

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
    // **人が作れる種別だけ**（選べない道を選択肢に残さない——規則13）
    const kinds = generated ? generatableKinds() : humanCreatableKinds();
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
  /**
   * **コピーの結果を、人に必ず言う**（訂正・2026-09-15、実測で発覚）。
   *
   * 以前は navigator.clipboard.writeText を投げっぱなし で投げっぱなしだった。
   * sandbox iframe には Permissions Policy でクリップボードが渡っていなかったので
   * **常に NotAllowedError で失敗し、しかも画面は何も言わなかった**
   * ——人は押して、何も起きず、コピーされたと思い込む（規則2・規則13）。
   *
   * 権限は通るようにしたが、**通らない環境でも人の手が残るようにする**：
   * 選択して execCommand("copy") に落とし、それも駄目なら
   * 「選んであるので Ctrl+C」と言う。**黙って失敗しない。**
   */
  async function copyFrom(field, say) {
    field.select();
    try {
      await navigator.clipboard.writeText(field.value);
      say("コピーしました");
      return;
    } catch {
      // 権限が通っていない環境——古い経路に落ちる（選択済みなので実際に効く）
    }
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    say(ok ? "コピーしました" : "コピーできませんでした——選んであるので Ctrl+C（Mac は Cmd+C）で");
  }

  $("pubkey-copy").addEventListener("click", () => {
    void copyFrom($("pubkey-text"), (note) => {
      $("pubkey-copied").textContent = note;
    });
  });

  onSubmit($("dlg-new"), $("new-submit"), $("new-error"), async () => {
    // **保存先が置き場を決める**——backend は別に聞かない（改訂・2026-09-14）
    const placement = $("new-scope").value;
    const at = placement.startsWith("at:") ? placement.slice(3) : null;
    const common = {
      name: $("new-name").value.trim(),
      note: $("new-note").value.trim() || undefined,
      ...(placement === "project" && project ? { forProject: project.id } : {}),
      ...(at ? { implementation: at.slice(0, at.indexOf(":")), group: at.slice(at.indexOf(":") + 1) } : {}),
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
    // **どの置き場のものを消すのかまで見せる**——同じ名前が複数の置き場に
    // 在るのは普通のことなので、名前だけでは「どれを消すか」が決まらない
    $("delete-target").textContent = a.implementation + " / " + a.group + " / " + a.name;
    $("dlg-delete").showModal();
  }
  onSubmit($("dlg-delete"), $("delete-submit"), $("delete-error"), async () => {
    // **置き場まで渡す**（訂正・2026-09-15）——渡さないと backend の既定解決に
    // 落ちて、一覧で選んだ行と別の秘密が消える
    await callTool("deleteAlias", {
      implementation: deleteTarget.implementation,
      name: deleteTarget.name,
      group: deleteTarget.group,
    });
  });

  // 1件だけ移す（**どこにも紐付いていない秘密の、削除以外の出口**）
  let moveTarget = null;
  async function openMove(a) {
    moveTarget = a;
    $("move-error").hidden = true;
    $("move-now").textContent = "いまは " + a.implementation + " / " + groupLabel(a.implementation, a.group);
    const places = await callTool("getPlacements", project ? { projectId: project.id } : {});
    movePlaces = places;
    const fill = () => {
      const v = (places.vaults || []).find((x) => x.implementation === $("move-vault").value);
      const groups = (v && v.groups) || [];
      $("move-group").replaceChildren(
        ...groups.map((g) => option(g, groupLabel($("move-vault").value, g))),
      );
      $("move-group").disabled = groups.length === 0;
      applyMoveEffect();
    };
    $("move-vault").replaceChildren(...(places.vaults || []).map((v) => option(v.implementation, v.implementation)));
    $("move-vault").value = a.implementation;
    fill();
    $("move-vault").onchange = fill;
    $("move-group").onchange = applyMoveEffect;
    $("dlg-move").showModal();
  }

  /** **移した先からどう引けるようになるか**を、押す前に出す。 */
  function applyMoveEffect() {
    const impl = $("move-vault").value, group = $("move-group").value;
    const same = moveTarget && impl === moveTarget.implementation && group === moveTarget.group;
    $("move-submit").disabled = !!same || !group;
    $("move-effect").textContent = same
      ? "もう その置き場に在ります"
      : placementEffect(impl, group);
  }

  onSubmit($("dlg-move"), $("move-submit"), $("move-error"), async () => {
    await callTool("migrateAlias", {
      name: moveTarget.name,
      implementation: moveTarget.implementation,
      group: moveTarget.group,
      toImplementation: $("move-vault").value,
      toGroup: $("move-group").value,
    });
  });

  // 置き場を変える（**移行あり／なしを選ぶ**）
  async function openPlace() {
    $("place-error").hidden = true;
    if (!project) {
      showError($("place-error"), new Error("この画面は Project の上で開かれていないので、置き場を決められません"));
      $("dlg-place").showModal();
      return;
    }
    const places = await callTool("getPlacements", { projectId: project.id });
    $("place-now").textContent = places.project
      ? "いまは " + places.project.implementation + " / " + places.project.group
      : "まだ決まっていません（最初に保存したときに決まります）";
    const fill = () => {
      const v = (places.vaults || []).find((x) => x.implementation === $("place-vault").value);
      const groups = (v && v.groups) || [];
      $("place-group").replaceChildren(...groups.map((g) => option(g, g)));
      $("place-group").disabled = groups.length === 0;
    };
    $("place-vault").replaceChildren(...(places.vaults || []).map((v) => option(v.implementation, v.implementation)));
    if (places.project) $("place-vault").value = places.project.implementation;
    fill();
    $("place-vault").onchange = () => { fill(); void preview(); };
    $("place-group").onchange = () => void preview();
    $("place-migrate").onchange = () => void preview();
    await preview();
    $("dlg-place").showModal();
  }

  /** **変える前に、何が起きるかを出す**（規則2——黙って使えなくしない）。 */
  async function preview() {
    if (!project) return;
    try {
      const plan = await callTool("planProjectPlacement", {
        projectId: project.id,
        implementation: $("place-vault").value,
        group: $("place-group").value,
      });
      const migrate = $("place-migrate").value === "yes";
      const parts = [];
      // **できないと分かっているなら、押させない**（追加・2026-09-15）。
      // 以前は「このままでは変えられません」と出しながらボタンは有効で、
      // 押してからエラーになっていた
      let blocked = false;
      if (plan.moving.length === 0) parts.push("移すものはありません");
      else if (migrate) {
        parts.push(plan.moving.length + " 件を一緒に移します");
        if (plan.conflicts.length) {
          parts.push(
            "ただし移す先に同じ名前があります（" + plan.conflicts.join(", ") +
              "）——1つでもぶつかると何も移しません。先に名前を変えるか、移す先を変えてください",
          );
          blocked = true;
        }
        if (plan.sharedWith.length) {
          // **押すとどうなるかまで書く**——「移せません」で止めない
          parts.push(
            "いまの置き場は他の Project も使っているので、一緒には移せません" +
              "（他所のものまで動かすことになるため）。移さずに変えるなら「移さない」を選んでください",
          );
          blocked = true;
        }
      } else {
        parts.push(
          plan.strandedIfNotMigrated.length + " 件（" + plan.strandedIfNotMigrated.join(", ") +
            "）は、どこにも紐付かなくなり、この Project から使えなくなります" +
            "（あとで一覧の「移す」から戻せます）",
        );
      }
      $("place-submit").disabled = blocked;
      $("place-effect").textContent = parts.join("。");
    } catch (err) {
      showError($("place-error"), err);
    }
  }
  $("open-place").addEventListener("click", () => void openPlace());
  onSubmit($("dlg-place"), $("place-submit"), $("place-error"), async () => {
    if (!project) throw new Error("この画面は Project の上で開かれていません");
    await callTool("setProjectPlacement", {
      projectId: project.id,
      implementation: $("place-vault").value,
      group: $("place-group").value,
      migrate: $("place-migrate").value === "yes",
    });
    await reload();
  });

  // **絞り込みは打つそばから効く**（2度消してしまっている・2026-09-14）
  for (const id of ["query", "kind-filter", "target-filter", "backend-filter"]) {
    $(id).addEventListener("input", renderRows);
  }

  // **共通の置き場はこの画面に無い**（改訂・2026-09-14、ユーザー指摘）
  // ——設定画面（ui://banto-vault-directory/config）。値が動かないので「設定」。
  //
  // **Project の置き場だけはここに在る**。変えると秘密が実際に移るので、
  // これは設定ではなく**操作**（仕様 §2.1「画面はどこで何を聞くか」）。
  // 置き場所は「接続している実装」の段——いまどこに在るかと並べて出す。

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
