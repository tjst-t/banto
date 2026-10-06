// **画面の HTML はテンプレート文字列の中**にある。そこに ` を書くと
// 文字列が途中で閉じてビルドが壊れる——**3回踏んだ**（2026-09-12・13・14）。
// コメントのつもりの ` も同じなので、機械で止める。
//
// あわせて、MCP Apps の初期化で **host が検査する名前**も押さえる
// （`capabilities` と書いて弾かれ、画面が出ないまま終わった・2026-09-14）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { REQUEST_APP_HTML } from "./index.js";

test("画面の HTML にバッククォートを混ぜない（テンプレート文字列が閉じる）", () => {
  assert.equal(REQUEST_APP_HTML.includes("`"), false, "バッククォートが混ざっている");
});

test("初期化は appCapabilities で名乗る（capabilities では弾かれる）", () => {
  assert.ok(REQUEST_APP_HTML.includes("appCapabilities:"), "appCapabilities を送っていない");
  assert.equal(
    /[^p]capabilities:\s*\{/.test(REQUEST_APP_HTML.replace("appCapabilities:", "")),
    false,
    "capabilities という名前で送っている（host に弾かれる）",
  );
});

// **画面の色は host が渡す標準の名前で受ける**（訂正・2026-10-06）。banto は hostContext.styles.variables に
// `--color-text-primary` などを入れて渡す（apps/frontend の canvas-host-styles.ts）。以前は受けた名前の前に
// "--mcp-ui-" を足して置き、CSS は `--mcp-ui-color-text` を読んでいた——いつも既定の色で、明暗も OS 任せだった
test("入力欄は banto が渡す色の名前を読み、受けた名前をそのまま置き、明暗の渡し直しに追随する", () => {
  const html = REQUEST_APP_HTML;
  assert.match(html, /var\(--color-text-primary,/, "字の色を標準の名前で読んでいない");
  assert.match(html, /var\(--color-border-primary,/, "枠の色を標準の名前で読んでいない");
  // 受けた名前の前に "--mcp-ui-" を足すのは、頭に -- の無い名前だけ
  assert.doesNotMatch(html, /setProperty\("--mcp-ui-" \+ k/, "受けた名前の前に --mcp-ui- を無条件に足している");
  assert.match(html, /k\.startsWith\("--"\) \? k :/);
  // 明暗は host に合わせる（OS 任せにしない）——初期化の答えでも、渡し直しでも
  assert.match(html, /dataset\.theme = ctx\.theme/);
  assert.match(html, /:root\[data-theme="light"\] \{ color-scheme: light; \}/);
  assert.match(html, /:root\[data-theme="dark"\] \{ color-scheme: dark; \}/);
  assert.match(html, /applyAppearance\(result && result\.hostContext\)|applyAppearance\(host\)/, "初期化の答えの hostContext を当てていない");
  assert.match(html, /ui\/notifications\/host-context-changed"\) applyAppearance\(msg\.params\)/);
  // CSS が読む色は、どれも標準の名前を先に見る（--mcp-ui-color-* は既定の手前に残すだけ）
  for (const m of html.matchAll(/var\(--mcp-ui-color-[\w-]+/g)) {
    const before = html.slice(Math.max(0, m.index - 40), m.index);
    assert.match(before, /var\(--color-[\w-]+, $/, `古い名前を直接読んでいる: …${before}${m[0]}`);
  }
});
