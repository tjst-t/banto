/* ══════════════════════════════════════════════════════════════════════════
   3案が描く**同じ場面**。案どうしを比べられるのは、中身が同じときだけ。

   模型（3案で動かさないもの）:
   ・会話が中心
   ・プロジェクトごとに幹となる会話は永続。枝が分岐し、終われば幹に回収される
   ・プロジェクト横断の通知（取次）がある
   ══════════════════════════════════════════════════════════════════════════ */

window.SCENE = (() => {
  const PROJECTS = {
    banto:  { name: "banto",     note: "番頭そのもの" },
    home:   { name: "自宅サーバ", note: "Caddy・systemd・証明書" },
    hermes: { name: "記憶の検証", note: "Hermes を試す置き場" },
  };

  /* 面（キャンバスに開くGUI）。番頭が差し出すか、POが自分で開く（決定16・25） */
  const FACES = {
    diff: {
      title: "views.css の差分", meta: "+42 −18", icon: "diff",
      html: `<pre class="code"><span class="c">@@ 器と部品を分ける @@</span>
<span class="d">- .cv-bar   { display: flex; }</span>
<span class="d">- .cv-split { display: flex; }</span>
<span class="a">+ .bar   { display: flex; }</span>
<span class="a">+ .split { display: flex; }</span>
<span class="c">  /* 外向け：語彙表と3つの面が .cv-* を名指ししている */</span></pre>`,
    },
    workers: {
      title: "職人の手元", meta: "6人 · 生きています", icon: "workers",
      html: `<div class="rows">
        <div class="r"><span class="dot turn"></span><b>views.css の分割</b><span class="sp"></span><em>w-30 · 判断待ち</em></div>
        <div class="r"><span class="dot run"></span><b>canvas_state の到着順を追う</b><span class="sp"></span><em>w-31 · 04:12</em></div>
        <div class="r"><span class="dot done"></span><b>再現手順の切り出し</b><span class="sp"></span><em>w-29 · 終わりました</em></div>
        <div class="r"><span class="dot stop"></span><b>WS 再接続の取りこぼし</b><span class="sp"></span><em>w-28 · 止まりました</em></div>
      </div>`,
    },
    memory: {
      title: "記憶", meta: "89件 · 直近7日で +12", icon: "memory",
      html: `<div class="rows">
        <div class="r"><span class="dot done"></span><b>POは「まれに落ちる」で先へ進むのを嫌う</b><span class="sp"></span><em>P6</em></div>
        <div class="r"><span class="dot done"></span><b>朱は「あなたの判断待ち」専用</b><span class="sp"></span><em>裁定</em></div>
        <div class="r"><span class="dot done"></span><b>ドロップダウンは使わない</b><span class="sp"></span><em>報告</em></div>
        <div class="r"><span class="dot run"></span><b>会話とキャンバスの主従は未決</b><span class="sp"></span><em>保留</em></div>
      </div>`,
    },
    env: {
      title: "検証環境", meta: "3件 · 畳み忘れ", icon: "env",
      html: `<div class="rows">
        <div class="r"><span class="dot warn"></span><b>env-31 · task-0086 の検証</b><span class="sp"></span><em>6日 · 1,400円/月</em></div>
        <div class="r"><span class="dot warn"></span><b>env-29 · inc-0041 の再現</b><span class="sp"></span><em>6日 · 1,400円/月</em></div>
        <div class="r"><span class="dot warn"></span><b>env-27 · 意匠の見本</b><span class="sp"></span><em>7日 · 1,400円/月</em></div>
      </div>`,
    },
  };

  /* 枝。**還す条件を持って生まれる**のが枝の定義 */
  const BRANCHES = {
    ui: {
      proj: "banto", title: "会話UIを一から見直す", by: "あなたが開きました",
      cond: "方針が決まり、ADR の草案ができたら",
      state: "turn", meta: "12分", faces: ["diff"],
      result: "会話が中心・幹1本＋枝・横断の通知の3点は動かさない。枝は番頭の判断でもPOの指示でも開く。ADR-0017 の草案を置きました",
      /* 枝を開くのは誰か（2026-08-09）と器の4件（同）が決着し、**還す条件を満たした**。
         残る判断は「畳んでよいか」だけ——枝の一生の終わりが見本になる */
      ask: {
        text: "還す条件（方針が決まり、ADR の草案ができたら）を<strong>満たしました</strong>。畳んで幹に還してよいですか。",
        opts: ["畳んで還す", "もう少し置いておく", "くわしく聞く"],
      },
      log: [
        ["seam", "この枝は幹から生まれました"],
        ["po", "会話とキャンバスの横並び、本当にこれでいいのか悩んでいる"],
        ["tool", "memory.search", "会話 UI 主従 案3", "5件"],
        ["ba", "<p>案3「座敷」が<strong>未決のまま</strong>残っています（2026-08-05 の裁定⑤「主従は後で」）。</p><p>会話を中心に据えたまま、枝と面の置き場だけを変えた案を3つ組みました。</p>"],
        ["po", "Slack のスレッドだと枝が埋没するけど、そこはどうする？"],
        ["ba", "<p>埋没の原因は4つあって、うち2つはこの店では起きません。</p><ul><li><strong>枝の持ち主が人間</strong>——ここでは私が持ちます（D10）</li><li><strong>未処理を集める口が無い</strong>——横断の通知が1本あります（ADR-0015）</li></ul><p>残る2つは、<strong>還す条件</strong>を必須にし、畳んだら幹へ1行積むことで閉じます。</p>"],
        ["face", "diff"],
      ],
    },
    tab: {
      proj: "banto", title: "開いたタブに中身が出ない", by: "番頭が開きました",
      cond: "原因が特定でき、incident と task が積まれたら",
      state: "run", meta: "職人 2人 · 04:12", faces: ["workers"],
      result: "canvas_state が history より先に届くと落ちる。inc-0048 起票・task-0089 を積みました",
      log: [
        ["seam", "この枝は幹から生まれました"],
        ["ba", "<p>手元で 30 回試して 11 回落ちました。間欠なので、機構が壊れている合図として扱います（P6・ADR-0016）。</p>"],
        ["tool", "worker.spawn", "再現手順の切り出し", "w-29"],
        ["tool", "worker.spawn", "canvas_state の到着順を追う", "w-31"],
        ["face", "workers"],
        ["note", "職人 w-29", "390×780 と 1440×900 の両方で再現。幅は関係ありません"],
        ["ba", "<p>見当は2つ。<code>canvas_state</code> が <code>history</code> より先に着いたときと、タブの活性を画面側が先に切り替えているときです。w-31 が実測しています。</p>"],
      ],
    },
    gate: {
      proj: "banto", title: "依存ゲートの再実装", by: "番頭が開きました",
      cond: "台帳の持ち主が Pool に一本化され、inc-0027 が閉じたら",
      state: "stop", meta: "6日 動いていません", faces: [],
      result: "保留：Pool の台帳一本化を待つ",
      log: [
        ["stop", "職人 w-28 が 6日前に落ちてから、誰も引き取っていません。<br>黙って止まっている枝は、機構が壊れている合図として扱います（P6）。"],
        ["po", "いったん置いておいて"],
        ["ba", "<p>置いておくなら<strong>畳みます</strong>。「保留：Pool の台帳一本化を待つ」として還し、動かせるようになったら開き直します。開いたままにすると、開いている枝の一覧が信用できなくなります。</p>"],
      ],
    },
    catalog: {
      proj: "banto", title: "起動時のモデル台帳", by: "番頭が開きました",
      cond: "原因が分かり、起票まで済んだら",
      state: "merged", meta: "畳みました", faces: [],
      result: "起動時に台帳を取りに行かない。inc-0047 起票・task-0088 を積みました",
      log: [["ba", "<p>畳んだ枝です。中身は残っていて、いつでも読み返せます。</p>"]],
    },
    cert: {
      proj: "home", title: "証明書の自動更新が落ちる", by: "番頭が開きました",
      cond: "落ちる条件が特定でき、監視が入ったら",
      state: "turn", meta: "2日", faces: [],
      result: "更新前に Caddy を止める運用へ。監視を入れました",
      ask: { text: "更新のたびに Caddy を止めてよいか。<strong>18〜25 秒</strong>だけ公開URLが落ちます。",
             opts: ["止めてよい", "止めずに直す道を探す", "くわしく聞く"] },
      log: [
        ["seam", "この枝は幹から生まれました"],
        ["po", "また証明書切れてた"],
        ["ba", "<p>3回目です。<strong>月に一度しか起きない</strong>ので、当てずっぽうで直すと直ったかどうかが分かりません。枝にして条件から詰めます。</p>"],
        ["tool", "file.read", "/etc/caddy/Caddyfile", "84 行"],
      ],
    },
    mem: {
      proj: "hermes", title: "記憶の取り出しが遅い", by: "番頭が開きました",
      cond: "500ms を切れたら", state: "run", meta: "職人 1人 · 12:30", faces: [],
      result: "索引を張って 180ms へ",
      log: [["ba", "<p>実測 1.2 秒でした。職人が索引の張り方を試しています。</p>"]],
    },
  };

  /* 幹。**追記のみ**。枝は「開いた1行」と「還った1行」だけが載る */
  const TRUNKS = {
    banto: [
      ["seam", "文脈が一杯になったので、ここまでを畳んで引き継ぎました（意匠の決定と取次の一本化）"],
      ["po", "起動に5分かかるの、そろそろ気になる"],
      ["branch", "catalog"],
      ["po", "ファイル面、開くとタブは増えるのに中身が出ないことがある"],
      ["tool", "file.search", "canvas_state", "12件"],
      ["ba", "<p>手元で再現しました。<strong>30 回中 11 回</strong>です。間欠なので機構が壊れている合図として扱います（P6）。</p><p>ここから先は往復が続くので、<strong>枝にします</strong>。</p>"],
      ["branch", "tab"],
      ["back", "catalog"],
      ["po", "会話とキャンバスの横並び、本当にこれでいいのか悩んでいる"],
      ["ba", "<p>案3「座敷」が未決のまま残っています。あなたが明示したので<strong>枝にします</strong>——ここは私が勝手に決めるところではありません。</p>"],
      ["branch", "ui"],
      ["po", "番頭の記憶、いまどこまで効いてる？"],
      ["ba", "<p>89 件です。直近7日で 12 件足しました。<strong>これは枝にしません</strong>——見れば済む話なので、面を出しておきます。</p>"],
      ["face", "memory"],
    ],
    home: [
      ["po", "また証明書切れてた"],
      ["ba", "<p>3回目です。月に一度しか起きないので、当てずっぽうで直すと直ったかどうかが分かりません。枝にして条件から詰めます。</p>"],
      ["branch", "cert"],
    ],
    hermes: [
      ["po", "記憶の検索、体感で遅い"],
      ["ba", "<p>実測で 1.2 秒でした。<strong>体感は当たっています</strong>。枝にして 500ms を目標にします。</p>"],
      ["branch", "mem"],
    ],
  };

  /* 横断の通知（取次）。**出所とプロジェクトを問わず、ここ1本** */
  const LETTERS = [
    { to: "ui", from: "番頭", kind: "判断待ち", age: "12分",
      h: "枝「会話UIを一から見直す」を畳んでよいか",
      why: "会話とキャンバスの横並び、本当にこれでいいのか悩んでいる",
      what: "還す条件を満たした。方針が決まり（幹1本＋枝・器と面）、器の4件も決着し、ADR-0017 の草案ができた",
      opts: ["畳んで還す", "もう少し置いておく"] },
    { to: "cert", from: "番頭", kind: "判断待ち", age: "2日",
      h: "更新のたびに Caddy を止めてよいか",
      why: "また証明書切れてた",
      what: "3回目。止めれば確実だが 18〜25 秒だけ公開URLが落ちる",
      opts: ["止めてよい", "止めずに直す道を探す"] },
    { to: "gate", from: "番頭（滞留の検出）", kind: "止まっています", age: "6日", tone: "stop",
      h: "枝「依存ゲートの再実装」が 6日 動いていません",
      why: "Kobo の tick が番頭の立てた職人を見ていない",
      what: "職人 w-28 が 6日前に落ちたまま、誰も引き取っていない",
      opts: ["畳んで保留にする", "私が引き取る"] },
  ];

  const ICON = {
    diff:    '<path d="M12 4v16M4 8h4M4 16h4M16 12h4"/><circle cx="12" cy="8" r="0"/>',
    workers: '<path d="M4 20v-2a4 4 0 014-4h8a4 4 0 014 4v2"/><circle cx="12" cy="8" r="4"/>',
    memory:  '<path d="M12 4a4 4 0 00-4 4 3 3 0 000 6 4 4 0 008 0 3 3 0 000-6 4 4 0 00-4-4z"/>',
    env:     '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    branch:  '<path d="M6 4v9a4 4 0 004 4h5"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="17" r="2.2"/><circle cx="6" cy="4" r="1.6"/>',
    inbox:   '<path d="M3 13h4l2 3h6l2-3h4"/><path d="M5 5h14l2 8v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4z"/>',
    back:    '<path d="M15 6l-6 6 6 6"/>',
    close:   '<path d="M6 6l12 12M18 6L6 18"/>',
    plus:    '<path d="M12 5v14M5 12h14"/>',
    down:    '<path d="M7 10l5 5 5-5"/>',
    check:   '<path d="M5 12l5 5 9-10"/>',
  };
  const svg = (k, extra = "") => `<svg viewBox="0 0 24 24" ${extra}>${ICON[k] || ""}</svg>`;

  /* 会話の1行を描く。**3案で共通**——同じものが2通りに見えないように */
  function row(e, opts = {}) {
    const [kind, a, b, c] = e;
    if (kind === "po")   return `<div class="msg-po">${a}</div>`;
    if (kind === "ba")   return `<div class="msg-ba">${a}</div>`;
    if (kind === "tool") return `<div class="msg-tool"><b>${a}</b> ${b}<span class="sp"></span>${c}</div>`;
    if (kind === "note") return `<div class="msg-note"><em>${a}</em>${b}</div>`;
    if (kind === "seam") return `<div class="msg-seam">${a}</div>`;
    if (kind === "stop") return `<div class="ask" style="background:var(--stop-soft);border-left-color:var(--stop)">
        <div class="ask-h" style="color:var(--stop)">止まっています</div><p>${a}</p></div>`;
    if (kind === "face") return opts.face ? opts.face(a) : "";
    if (kind === "branch") return opts.branch ? opts.branch(a) : "";
    if (kind === "back") return opts.back ? opts.back(a) : "";
    return "";
  }

  return { PROJECTS, FACES, BRANCHES, TRUNKS, LETTERS, ICON, svg, row };
})();
