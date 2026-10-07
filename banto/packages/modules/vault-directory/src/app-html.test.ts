// **画面の色は host が渡す標準の名前で受ける**（訂正・2026-10-06）。
//
// banto は hostContext.styles.variables に `--color-text-primary` などを入れて渡す
// （apps/frontend の canvas-host-styles.ts）。以前のこの Module の画面は、受けた名前の前に
// "--mcp-ui-" を足して置き（"--mcp-ui---color-…"）、CSS は `--mcp-ui-color-text` を読んでいた
// ——どちらも誰も渡さない名前なので、**いつも既定の色**で描かれ、明暗も OS 任せだった。
import { test } from "node:test";
import assert from "node:assert/strict";
import { MANAGE_APP_HTML } from "./manage-app.js";
import { CONFIG_APP_HTML } from "./config-app.js";

for (const [name, html] of [
  ["管理画面", MANAGE_APP_HTML],
  ["設定画面", CONFIG_APP_HTML],
] as const) {
  test(`${name}は banto が渡す色の名前を読み、受けた名前をそのまま置き、明暗の渡し直しに追随する`, () => {
    assert.match(html, /var\(--color-text-primary,/, "字の色を標準の名前で読んでいない");
    assert.match(html, /var\(--color-border-primary,/, "枠の色を標準の名前で読んでいない");
    // 受けた名前の前に "--mcp-ui-" を足すのは、頭に -- の無い名前だけ
    assert.doesNotMatch(html, /setProperty\("--mcp-ui-" \+ k,/, "受けた名前の前に --mcp-ui- を無条件に足している");
    assert.match(html, /k\.startsWith\("--"\) \? k :/);
    // 明暗は host に合わせる（OS 任せにしない）
    assert.match(html, /dataset\.theme = ctx\.theme/);
    assert.match(html, /:root\[data-theme="dark"\] \{ color-scheme: dark; \}/);
    assert.match(html, /ui\/notifications\/host-context-changed/);
    // CSS が読む色は、どれも標準の名前を先に見る（--mcp-ui-color-* は既定の手前に残すだけ）
    for (const m of html.matchAll(/var\(--mcp-ui-color-[\w-]+/g)) {
      const before = html.slice(Math.max(0, m.index - 40), m.index);
      assert.match(before, /var\(--color-[\w-]+, $/, `古い名前を直接読んでいる: …${before}${m[0]}`);
    }
  });
}

// **選択欄は customizable select で整え、対応しないブラウザでは素の select のまま**（2026-10-07、ユーザー）。
// 開いた一覧の見た目は行の「…」メニューと同じ色の変数で描く。素の select の option の地と字（2026-10-06 の直し）は
// @supports の外に残す——Firefox・Safari では今までどおりそれが効く
test("管理画面の選択欄：base-select は @supports の中だけ、開いた一覧は host の色、素の option の地と字は残す", () => {
  const html = MANAGE_APP_HTML;
  const at = html.indexOf("@supports (appearance: base-select) {");
  assert.ok(at > 0, "base-select を @supports で囲んでいない");
  const before = html.slice(0, at);
  assert.doesNotMatch(before, /appearance:\s*base-select;/, "@supports の外で base-select を当てている（対応しないブラウザで崩れる）");
  assert.match(before, /option, optgroup \{ background-color: var\(--color-background-primary,/, "素の select の option の地を消した");
  const block = html.slice(at, html.indexOf("</style>"));
  assert.match(block, /select, ::picker\(select\) \{ appearance: base-select; \}/);
  assert.match(block, /::picker\(select\) \{[^}]*background: var\(--surface\)[^}]*color: var\(--ink\)/, "開いた一覧が host の色で描かれていない");
  assert.match(block, /::picker\(select\) \{[^}]*border: 1px solid var\(--line\)/);
  assert.match(block, /option::checkmark/);
  assert.match(block, /select::picker-icon/);
});

// **グループの選択肢は Vault での本当の名前**（2026-10-07、ユーザー）。言い換え（「この Project 専用（…）」
// 「別の Project 専用（2ced47c4…）」）を出さない。この Project・Global は添えで言う
test("管理画面：グループの言い換えを出さず、「移す」「参照を作る」は版の欄から g@版 を作って渡す", () => {
  const html = MANAGE_APP_HTML;
  assert.doesNotMatch(html, /"[^"\n]*Project 専用（/, "グループを Project 名で言い換えている");
  assert.doesNotMatch(html, /base\.slice\(0, 8\)/, "UUID を省いている");
  assert.match(html, /t\.textContent = " — " \+ tag;/, "置き場の添えが無い");
  for (const prefix of ["move", "link"]) {
    assert.match(html, new RegExp(`<select id="${prefix}-variant"[^>]*hidden></select>`), `${prefix} の小窓に版の欄が無い`);
    assert.match(html, new RegExp(`toGroup: chosenDestination\\("${prefix}",`), `${prefix} が選んだ版を toGroup に渡していない`);
  }
  assert.match(html, /variant === axis\.default \? group : group \+ "@" \+ variant/, "既定の版に @ を付けている");
  assert.doesNotMatch(html, /variantGroups \|\| \[\]\)\]\)\]/, "版付きの置き場をグループ欄に混ぜている（前の形）");
});
