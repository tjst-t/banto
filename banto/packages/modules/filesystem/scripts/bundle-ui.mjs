// 画面の JS を1本にまとめる（`src/ui-app.ts` が HTML に埋める）。
//
// tsc が CommonJS で出した `dist/.ui-cjs/` を `ui/app.js` から辿り、各ファイルを関数に
// 包んで、小さな require で繋ぐ（browserify と同じ形）。**相対パスの require しか
// 許さない**——npm のパッケージを画面に持ち込むなら、この仕組みではなく組み立ての
// 道具ごと入れる（そのときは規則10 の理由を書く）。
//
// 依存を足さないためにこうした（esbuild 等はこのリポジトリに無い）。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { posix } from "node:path";

const base = new URL("../dist/.ui-cjs/", import.meta.url);
const entry = "ui/app";
const modules = new Map();

function resolveFrom(from, spec) {
  if (!spec.startsWith(".")) {
    throw new Error(`画面の JS から相対でない require があります（${from} → ${spec}）。まとめられません`);
  }
  return posix.normalize(posix.join(posix.dirname(from), spec.replace(/\.js$/, "")));
}

function load(id) {
  if (modules.has(id)) return;
  const source = readFileSync(new URL(`${id}.js`, base), "utf8");
  modules.set(id, source);
  for (const match of source.matchAll(/\brequire\("([^"]+)"\)/g)) load(resolveFrom(id, match[1]));
}

load(entry);

const defs = [...modules]
  .map(([id, source]) => `${JSON.stringify(id)}: function (require, module, exports) {\n${source}\n}`)
  .join(",\n");

const out = `// 自動生成（scripts/bundle-ui.mjs）。手で直さない——src/ui/ を直して build する
(function () {
"use strict";
var defs = {
${defs}
};
var cache = {};
function resolve(from, spec) {
  var parts = from.split("/");
  parts.pop();
  spec.replace(/\\.js$/, "").split("/").forEach(function (p) {
    if (p === "..") parts.pop();
    else if (p !== ".") parts.push(p);
  });
  return parts.join("/");
}
function load(id) {
  if (cache[id]) return cache[id].exports;
  if (!defs[id]) throw new Error("画面の JS に " + id + " がありません");
  var module = { exports: {} };
  cache[id] = module;
  defs[id](function (spec) { return load(resolve(id, spec)); }, module, module.exports);
  return module.exports;
}
load(${JSON.stringify(entry)});
})();
`;

const outDir = new URL("../dist/ui/", import.meta.url);
mkdirSync(outDir, { recursive: true });
writeFileSync(new URL("app.bundle.js", outDir), out);
console.log(`bundle-ui: ${modules.size} files → dist/ui/app.bundle.js (${out.length} bytes)`);
