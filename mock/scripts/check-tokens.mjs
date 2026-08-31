#!/usr/bin/env node
// 要件E9「色・字の大きさ・余白・角は、決めた段だけを使う。面が独自の値を持たない」の
// 機械的検査。値の出どころは app/globals.css の1箇所だけ（規則3）——それ以外の場所で
// 任意値・生の色・Tailwind標準パレット・段の外のフォントサイズを書いたら落とす。
//
// 対象は banto 自身のコード（app/**、components/banto/**）だけ。
// components/ui/** と components/assistant-ui/** は vendored（shadcn/assistant-ui の
// レジストリからコピーしたもの）で、段への置換は別途まとめて行う対象。

import { readdirSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";

const TARGET_DIRS = ["app", "components/banto", "lib/mock"];
const EXTS = new Set([".ts", ".tsx", ".css"]);

const RULES = [
  {
    name: "任意値のフォントサイズ（text-[...]）",
    pattern: /text-\[[^\]]+\]/g,
    severity: "error",
  },
  {
    name: "任意値の角丸（rounded-[...]）",
    pattern: /rounded-\[[^\]]+\]/g,
    severity: "error",
  },
  {
    name: "生の16進カラー",
    pattern: /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3}(?:[0-9a-fA-F]{2})?)?\b/g,
    severity: "error",
  },
  {
    name: "Tailwind 標準パレット直書き（役色に置換すること：turn/stop/ok/warn/primary）",
    pattern:
      /\b(?:bg|text|border|ring|from|via|to)-(?:red|green|blue|amber|emerald|yellow|orange|purple|violet|slate|gray|zinc|neutral|stone|cyan|sky|indigo|fuchsia|pink|rose|lime|teal)-\d{2,3}\b/g,
    severity: "error",
  },
  {
    name: "段の外のフォントサイズ（text-base/4xl/5xl 等。7段＝xs/sm/md/lg/xl/2xl/3xl のみ）",
    pattern: /\btext-(?:base|4xl|5xl|6xl|7xl|8xl|9xl)\b/g,
    severity: "error",
  },
  {
    name: "h-screen（iOS Safari の 100vh 問題。h-dvh を使う）",
    pattern: /\bh-screen\b/g,
    severity: "error",
  },
  {
    name: "turn 以外の役色を塗りに使っている（soft でない bg-stop/ok/warn/primary）。" +
      "「塗ってよいのは turn だけ」——ボタン等の意図した用途なら許可リストへ追加を検討",
    pattern: /\bbg-(?:stop|ok|warn|primary)\b(?!-soft)/g,
    severity: "warn",
  },
];

/** @type {string[]} */
const files = [];
function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      walk(path);
    } else if (EXTS.has(extname(entry.name))) {
      files.push(path);
    }
  }
}

for (const dir of TARGET_DIRS) walk(dir);

let errorCount = 0;
let warnCount = 0;

for (const file of files) {
  // globals.css はトークンの出どころそのものなので対象外
  if (file.endsWith("globals.css")) continue;

  const content = readFileSync(file, "utf8");
  const lines = content.split("\n");

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let match;
    while ((match = rule.pattern.exec(content)) !== null) {
      const upToMatch = content.slice(0, match.index);
      const lineNo = upToMatch.split("\n").length;
      const line = lines[lineNo - 1]?.trim() ?? "";
      const tag = rule.severity === "error" ? "✖" : "⚠";
      console.log(`${tag} ${file}:${lineNo}  ${rule.name}`);
      console.log(`   ${line}`);
      if (rule.severity === "error") errorCount++;
      else warnCount++;
    }
  }
}

console.log("");
console.log(`check-tokens: ${errorCount} error(s), ${warnCount} warning(s) across ${files.length} file(s)`);

if (errorCount > 0) {
  process.exit(1);
}
