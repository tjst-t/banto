import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, renderInline } from "./markdown.js";
import { parseCsv, serializeCsv } from "./csv.js";
import { extOf, previewKindFor } from "./preview-kind.js";
import { diffLines, parseUnifiedDiff, unifiedDiff } from "../unified-diff.js";

// ---- Markdown：**生の HTML は通さない**（この画面は自分の Module の書き込み・削除を呼べる）----

test("Markdown：中身に紛れた HTML・スクリプトは文字として出る", () => {
  const html = renderMarkdown('# 見出し\n\n<img src=x onerror="alert(1)">\n\n<script>alert(1)</script>');
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test("Markdown：リンクは飛ばない（行き先は title に、エスケープして）", () => {
  const html = renderInline('[押す](javascript:x"onclick="y) と [banto](https://example.com)');
  assert.doesNotMatch(html, /<a\b/);
  assert.doesNotMatch(html, /href=|onclick="/);
  // 属性を閉じて別の属性を足す、ができない（引用符はエスケープされたまま title に入る）
  assert.match(html, /<span class="md-link" title="javascript:x&quot;onclick=&quot;y">押す<\/span>/);
  assert.match(html, /<span class="md-link" title="https:\/\/example.com">banto<\/span>/);
});

test("Markdown：普段使う書き方が描ける", () => {
  const html = renderMarkdown(
    [
      "# banto",
      "",
      "人に**伴走**し、`人の助け`となる。",
      "",
      "## まず読む",
      "",
      "1. docs/vision.md",
      "2. docs/requirements.md",
      "",
      "- [x] 済んだ",
      "- [ ] まだ",
      "  - 入れ子",
      "",
      "| 項目 | 予算 |",
      "|---|--:|",
      "| Vault | 120000 |",
      "",
      "```ts",
      "const a = 1 < 2;",
      "```",
      "",
      "> 引用",
      "",
      "---",
    ].join("\n"),
  );
  assert.match(html, /<h1>banto<\/h1>/);
  assert.match(html, /<strong>伴走<\/strong>/);
  assert.match(html, /<code>人の助け<\/code>/);
  assert.match(html, /<h2>まず読む<\/h2>/);
  assert.match(html, /<ol><li>docs\/vision\.md<\/li><li>docs\/requirements\.md<\/li><\/ol>/);
  assert.match(html, /<input type="checkbox" disabled checked> 済んだ/);
  assert.match(html, /<ul><li>入れ子<\/li><\/ul>/);
  assert.match(html, /<th>項目<\/th><th style="text-align:right">予算<\/th>/);
  assert.match(html, /<pre data-lang="ts"><code>const a = 1 &lt; 2;<\/code><\/pre>/);
  assert.match(html, /<blockquote><p>引用<\/p><\/blockquote>/);
  assert.match(html, /<hr>/);
});

test("Markdown：setext 見出しと、区切り線を取り違えない", () => {
  assert.match(renderMarkdown("タイトル\n===\n"), /<h1>タイトル<\/h1>/);
  assert.match(renderMarkdown("小見出し\n---\n"), /<h2>小見出し<\/h2>/);
  assert.match(renderMarkdown("段落\n\n---\n"), /<p>段落<\/p>\n<hr>/);
});

// ---- CSV：引用符・改行を含むセルを壊さずに書き戻す ----

test("CSV：引用符つきのセル（区切り・改行・二重引用符）を読んで、同じ形で書き戻す", () => {
  const source = '名前,メモ\r\n"山田, 太郎","一行目\r\n二行目"\r\n"引用""符""",x\r\n';
  const doc = parseCsv(source);
  assert.deepEqual(doc.rows, [
    ["名前", "メモ"],
    ["山田, 太郎", "一行目\r\n二行目"],
    ['引用"符"', "x"],
  ]);
  assert.equal(serializeCsv(doc), source);
});

test("CSV：末尾の改行が無いファイルは、無いまま書き戻す", () => {
  const doc = parseCsv("a,b\n1,2");
  assert.deepEqual(doc.rows, [
    ["a", "b"],
    ["1", "2"],
  ]);
  doc.rows[1]![1] = "3";
  assert.equal(serializeCsv(doc), "a,b\n1,3");
});

test("TSV：タブ区切りで読む", () => {
  assert.deepEqual(parseCsv("a\tb\n1\t2\n", "\t").rows, [
    ["a", "b"],
    ["1", "2"],
  ]);
});

// ---- 拡張子 → 描き方 ----

test("拡張子の表：大文字でも・拡張子の無い名前でも決まる", () => {
  assert.equal(previewKindFor("docs/README.MD"), "markdown");
  assert.equal(previewKindFor("public/index.html"), "html");
  assert.equal(previewKindFor("budget.csv"), "spreadsheet");
  assert.equal(previewKindFor(".gitignore"), "source");
  assert.equal(extOf(".gitignore"), "");
  assert.equal(previewKindFor("Makefile"), "source");
});

// ---- 差分 ----

test("差分：Myers で最小の差分になる", () => {
  const ops = diffLines(["a", "b", "c", "d"], ["a", "x", "c", "d", "e"]);
  assert.deepEqual(
    ops.map((o) => `${o.kind[0]}${o.line}`),
    ["ea", "db", "ix", "ec", "ed", "ie"],
  );
});

test("差分：離れた変更は別の塊になり、行番号が正しい", () => {
  const before = Array.from({ length: 20 }, (_v, i) => `line${i + 1}`).join("\n") + "\n";
  const after = before.replace("line2\n", "LINE2\n").replace("line18\n", "");
  const diff = unifiedDiff("f.txt", before, after);
  assert.equal(diff.additions, 1);
  assert.equal(diff.deletions, 2);
  const hunks = diff.text.split("\n").filter((l) => l.startsWith("@@"));
  assert.deepEqual(hunks, ["@@ -1,5 +1,5 @@", "@@ -15,6 +15,5 @@"]);
  const parsed = parseUnifiedDiff(diff.text);
  assert.equal(parsed.path, "f.txt");
  const removed = parsed.rows.find((r) => r.kind === "remove" && r.text === "line18");
  assert.equal(removed && "oldNo" in removed ? removed.oldNo : undefined, 18);
});

test("差分：新しく書いたファイル（前が空）は 0 行の側を 0 で書く", () => {
  const diff = unifiedDiff("new.txt", "", "a\nb\n");
  assert.match(diff.text, /@@ -0,0 \+1,2 @@/);
});
