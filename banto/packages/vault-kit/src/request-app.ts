// `requestAlias` が**会話の中に出す入力欄**（MCP Apps、inline。決定・2026-09-12、
// ユーザー提案）。
//
// **なぜ Elicitation ではなくこれか。** 元は Elicitation で「設定画面の Vault から
// 登録してください」と頼んでいたが、
//
//   1. **人を会話の外へ追い出していた**——秘密が要ると分かったその場で入れられない
//   2. **答えが Module に届かない**。banto は Elicitation の応答を解決しない設計
//      （アーキ仕様 §2.4.1 の帰結1、`runner/adapter.ts`）なので、人が答えても
//      呼び出し側は60秒のタイムアウトを待つだけだった。画面にもそう出ていた
//      ——**繋がっていないことを正直に出してはいたが、繋がってはいなかった**
//
// **値は AI を通らない。** 人がこの iframe に打った値は、host の画面 API
// （`/api/threads/:id/ui-tool-call`）から **Vault 自身の `admin` tool** へ直接渡る。
// Runner（AI）はこの経路に一切登場しない——§2.1 A の「AI は値を見ない」はそのまま。
//
// **自分の Module を呼ぶだけ**なので中継も承認も要らない（決定・2026-09-07）。

/** 会話の中の入力欄の URI。**Module ごとに分ける**——2本並んだとき、
 *  どちらの画面かが URI から分かる。 */
export function requestAppUri(moduleName: string): string {
  return `ui://banto-${moduleName.replace(/^banto-/, "")}/request`;
}

export const REQUEST_APP_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 12px;
    font: 13px/1.6 system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif;
    color: var(--mcp-ui-color-text, inherit);
    background: transparent;
  }
  h1 { font-size: 13px; font-weight: 600; margin: 0 0 2px; }
  .lead { margin: 0 0 10px; opacity: .65; font-size: 12px; }
  /* **hidden を効かせる**（訂正・2026-09-13、ユーザー指摘）。[hidden] の
     display:none はブラウザ既定のスタイルなので、.field { display: grid } の
     ほうが強く、**JS で hidden を立てても全部見えたまま**だった——種類を変えても
     画面が変わらない、の正体。ここは全ての hidden より先に置く */
  [hidden] { display: none !important; }
  .field { display: grid; gap: 4px; margin-bottom: 10px; }
  .field > span { font-size: 11px; opacity: .65; }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .muted { opacity: .6; font-size: 12px; }
  input, select, textarea {
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
  .problem {
    border: 1px solid var(--mcp-ui-color-danger, #c0392b); border-radius: 6px;
    padding: 8px 10px; font-size: 12px; color: var(--mcp-ui-color-danger, #c0392b);
  }
  .done { font-size: 12px; }
  code { font-size: 12px; opacity: .85; }
</style>
</head>
<body>

<div id="form-view">
  <h1 id="title">秘密の登録</h1>
  <p class="lead" id="why"></p>

  <label class="field"><span>値の決め方</span><select id="source">
    <option value="typed">自分で入力する</option>
    <option value="generated" id="generated-option">Vault の中で作る（誰も値を見ない）</option>
  </select></label>

  <label class="field" id="value-field"><span id="value-label">値</span>
    <input id="value" type="password" autocomplete="off" placeholder="ここに貼り付ける" />
    <!-- **秘密鍵とファイルは1行に入らない**（訂正・2026-09-13）。input に
         貼ると改行が落ちて、読めない鍵が登録される -->
    <textarea id="value-multiline" rows="4" autocomplete="off" spellcheck="false" hidden
      placeholder="-----BEGIN OPENSSH PRIVATE KEY----- から -----END ... ----- まで"></textarea>
  </label>

  <div class="field" id="generate-field" hidden>
    <span>作る強さ</span>
    <div class="row">
      <select id="format" style="width:auto">
        <option value="base64url">base64url（URL・シェルで安全）</option>
        <option value="hex">hex（16進）</option>
      </select>
      <input id="bytes" type="number" min="16" max="256" value="32" style="width:6em" />
      <span class="muted">バイト</span>
    </div>
  </div>

  <p class="muted" id="ssh-note" hidden>
    SSH の鍵ペアを Vault の中で作ります。<strong>秘密鍵は誰も見ません。</strong>
    作ったあとに出る公開鍵を、GitHub などに登録してください
  </p>

  <label class="field" id="impl-field" hidden><span>どの Vault に入れるか</span>
    <select id="impl"></select>
  </label>

  <!-- **「対象」では何を聞かれているか分からない**（訂正・2026-09-13、ユーザー
       指摘）。聞いているのは「どこから使えるようにするか」で、instance は
       banto の内部語（規則11）。既定はいま開いている Project -->
  <label class="field"><span>どこから使えるようにするか</span><select id="scope"></select></label>

  <div class="row">
    <button id="submit">登録する</button>
    <span class="muted" id="hint-value">打った値は AI には渡りません</span>
  </div>
  <p class="problem" id="error" hidden></p>
</div>

<div id="done-view" hidden>
  <p class="done" id="done-text"></p>
  <div class="field" id="pubkey-field" hidden>
    <span>公開鍵（これは秘密ではありません。相手方に登録してください）</span>
    <textarea id="pubkey" rows="3" readonly></textarea>
    <div class="row"><button id="pubkey-copy" type="button">コピーする</button></div>
  </div>
  <p class="problem" id="pubkey-missing" hidden>
    鍵は登録できましたが、<strong>公開鍵が返ってきませんでした。</strong>
    このままでは相手方に登録できません——Vault の管理画面から作り直してください
  </p>
</div>

<script>
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

  const $ = (id) => document.getElementById(id);

  /** 自分の Module の tool を呼び、本文を JSON として読む。 */
  async function callTool(name, args) {
    const res = await request("tools/call", { name, arguments: args || {} });
    const text = res && res.content && res.content[0] && res.content[0].text;
    if (res && res.isError) throw new Error(text || name + " が失敗しました");
    return JSON.parse(text);
  }
  /** この画面が何を頼まれているか。**tool の引数から受け取る**（作らない）。 */
  let asked = { name: "", kind: "secret", hint: "" };
  let project = null;

  function reportHeight() {
    send({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { height: document.documentElement.scrollHeight },
    });
  }

  // **種類ごとの違いは、この表1枚に集める**（整理・2026-09-13、ユーザー指摘
  // 「Secret なのか SSH 鍵ペアなのかで選べるものは変わるべきなのに変わらない」）。
  // 以前は if (kind === …) が3箇所に散っていて、増やすたびに揃わなくなっていた。
  const KINDS = {
    secret: {
      canGenerate: true,        // 乱数で作れる
      valueLabel: "値",
      multiline: false,
      strength: true,           // 長さ・形式を選ぶのは、乱数のときだけ意味がある
      note: null,
      typedHint: "打った値は AI には渡りません",
    },
    "ssh-identity": {
      canGenerate: true,
      valueLabel: "秘密鍵（-----BEGIN OPENSSH PRIVATE KEY----- から）",
      multiline: true,          // 1行に入らない
      strength: false,          // **鍵の強さは鍵の種類が決める**——選ばせない
      note: "SSH の鍵ペア（ed25519）を Vault の中で作ります。秘密鍵は誰も見ません。"
        + "作ったあとに出る公開鍵を、GitHub などに登録してください",
      typedHint: "持っている秘密鍵を貼るか、新しく作らせます（AI には渡りません）",
    },
    file: {
      canGenerate: false,       // **ファイルの中身はランダムに作れない**
      valueLabel: "ファイルの中身",
      multiline: true,
      strength: false,
      note: null,
      typedHint: "貼った中身は AI には渡りません",
    },
  };
  const spec = () => KINDS[asked.kind] || KINDS.secret;

  function applyAsked() {
    const k = spec();
    $("title").textContent = asked.name ? "秘密を登録：" + asked.name : "秘密の登録";
    $("why").textContent = asked.hint
      ? "AI がこの秘密を求めています——" + asked.hint
      : "AI がこの秘密を求めています。";
    $("value-label").textContent = k.valueLabel;
    $("hint-value").textContent = k.typedHint;
    // **選べない道を選択肢に残さない**（規則13）
    $("generated-option").hidden = !k.canGenerate;
    $("generated-option").disabled = !k.canGenerate;
    if (!k.canGenerate) $("source").value = "typed";
    $("ssh-note").textContent = k.note || "";
    applySource();
  }

  function applySource() {
    const k = spec();
    const generated = $("source").value === "generated";
    $("value-field").hidden = generated;
    $("value").hidden = k.multiline;
    $("value-multiline").hidden = !k.multiline;
    $("generate-field").hidden = !generated || !k.strength;
    $("ssh-note").hidden = !generated || !k.note;
    reportHeight();
  }
  $("source").addEventListener("change", applySource);

  /** いま使っている入力欄（種類で1行か複数行かが変わる）。 */
  const valueInput = () => (spec().multiline ? $("value-multiline") : $("value"));

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
    if (msg.method === "ui/notifications/tool-input") {
      const args = (msg.params && msg.params.arguments) || {};
      asked = {
        name: String(args.name || ""),
        kind: String(args.kind || "secret"),
        hint: String(args.hint || ""),
      };
      applyAsked();
    }
  });

  $("pubkey-copy").addEventListener("click", () => {
    $("pubkey").select();
    void navigator.clipboard?.writeText($("pubkey").value);
  });

  $("submit").addEventListener("click", async () => {
    $("error").hidden = true;
    $("submit").disabled = true;
    try {
      if (!asked.name) throw new Error("どの名前で登録するのかが渡ってきていません");
      // **置き場を直に渡す**（改訂・2026-09-13）。使える範囲は置き場から
      // 導かれるので、画面が別に scope を送ることはない（規則3）
      const forProject = $("scope").value === "project" && project ? project.id : undefined;
      const common = {
        name: asked.name,
        forProject,
        // 選ばせているときだけ添える——1本しか無いなら受け手が決める
        ...($("impl-field").hidden ? {} : { implementation: $("impl").value }),
      };
      let publicKey;
      if ($("source").value === "generated") {
        // **値はこの画面を一度も通らない**——Vault の中で作られて、そこに残る
        const res = await request("tools/call", {
          name: "generateSecret",
          arguments: {
            ...common,
            kind: asked.kind,
            ...(asked.kind === "ssh-identity"
              ? {}
              : { format: $("format").value, bytes: Number($("bytes").value) }),
          },
        });
        const text = res && res.content && res.content[0] && res.content[0].text;
        try { publicKey = JSON.parse(text).publicKey; } catch { publicKey = undefined; }
      } else {
        const input = valueInput();
        if (!input.value) throw new Error(spec().valueLabel + "を入力してください");
        await request("tools/call", {
          name: "createAlias",
          arguments: { ...common, kind: asked.kind, value: input.value },
        });
        // **打った値を画面に残さない**——閉じたあとの DOM にも置かない
        $("value").value = "";
        $("value-multiline").value = "";
      }
      $("form-view").hidden = true;
      $("done-view").hidden = false;
      $("done-text").textContent =
        "「" + asked.name + "」を登録しました。AI からは名前だけが見えます（値は見えません）。";
      // **公開鍵は秘密ではない**——出さないと相手方に登録できない。
      // 返ってこなかったときに**空の箱を見せない**（規則2——「出たが空」は
      // 「作れたのか壊れたのか」が分からない。実際そう見えていた）
      if (asked.kind === "ssh-identity" && $("source").value === "generated") {
        if (publicKey) {
          $("pubkey").value = publicKey;
          $("pubkey-field").hidden = false;
        } else {
          $("pubkey-missing").hidden = false;
        }
      }
      reportHeight();
    } catch (err) {
      $("error").hidden = false;
      $("error").textContent = err && err.message ? err.message : String(err);
      $("submit").disabled = false;
      reportHeight();
    }
  });

  /**
   * **入れ先の候補**（追加・2026-09-12、窓口の導入）。
   *
   * vault は役割で、実装は複数ありうる。窓口（vault-directory）に繋がって
   * いるときは listVaults が答えるので、**2本以上あるときだけ選ばせる**
   * ——1本しか無いのに選択肢を出さない（規則13）。
   *
   * backend 単体で他の MCP ホストに繋いだときは listVaults が無いので、
   * その場合は**何も出さない**（自分が唯一の入れ先）。
   *
   * （※ここはテンプレート文字列の中——コメントにバッククォートを書くと
   *   そこで文字列が切れる。実際に一度やった）
   */
  async function loadImplementations() {
    let impls;
    try {
      impls = await callTool("listVaults", {});
    } catch {
      return; // 窓口ではない（backend 単体）——入れ先は自分しか無い
    }
    if (!Array.isArray(impls) || impls.length < 2) return;
    $("impl").replaceChildren(...impls.map((i) => new Option(i, i)));
    $("impl-field").hidden = false;
  }

  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "banto-vault-request", version: "0.1.0" },
    appCapabilities: { availableDisplayModes: ["inline"] },
  }).then(async (result) => {
    const host = (result && result.hostContext) || {};
    const vars = ((host.styles || {}).variables) || {};
    for (const [k, v] of Object.entries(vars)) {
      document.documentElement.style.setProperty("--mcp-ui-" + k, String(v));
    }
    // **どこで開かれたか**（banto が渡す）。Project が分かるときだけ
    // 「この Project のもの」を選べる——人に UUID を打たせない
    const ctx = host["dev.banto/project"];
    project = ctx && typeof ctx.id === "string" ? { id: ctx.id, name: String(ctx.name || ctx.id) } : null;
    // **人の言葉で書く**（訂正・2026-09-13）。"instance" は banto の内部語で、
    // 画面に出す語ではない（規則11）。既定はいま開いている Project
    const scopes = [new Option("どの Project からでも", "instance")];
    if (project) scopes.unshift(new Option("この Project（" + project.name + "）だけ", "project"));
    $("scope").replaceChildren(...scopes);

    send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    applyAsked();
    await loadImplementations();
    reportHeight();
  }).catch((err) => {
    // **出せなかったことを、出せたように見せない**（規則2・規則13）
    document.body.replaceChildren(Object.assign(document.createElement("p"), {
      className: "problem",
      textContent: "登録の画面を開けませんでした：" + (err && err.message ? err.message : String(err)),
    }));
  });
})();
</script>
</body>
</html>
`;
