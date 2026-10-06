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
