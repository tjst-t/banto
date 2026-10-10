// banto のアイコン（PWA・ホーム画面・タブ）を1つの形から組み立てる（追加・2026-10-10、ユーザー報告
// 「Windows では PWA にできたが Android ではできない」、docs/specs/v4-frontend.md §6.37）。
//
// 形はこのファイルの SVG だけが持つ。PNG は sharp で書き出して public/icons/ に置き、リポジトリに入れる
// （組み立てのたびに作らない——画面の組み立てに sharp を要らせないため）。形を変えたら打ち直す：
//
//   node apps/frontend/scripts/pwa-icons.mjs
//
// - any（192・512）：角を丸めた青の板。外側は透明
// - maskable（512）：端まで青。Android が丸や角丸に切り抜いても字が欠けないよう、字は真ん中の安全域（直径の80%）に収める
// - apple-icon（180）：端まで青。iOS が自分で角を丸める（public/icons/apple-icon.png、metadata.icons.apple が指す）
// - icon.svg：タブの favicon（public/icons/icon.svg、layout の metadata.icons が指す）
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");

// 青は globals.css の :root の --banto-accent から読む（色の出どころは globals.css の1箇所だけ、E9）
const rootBlock = readFileSync(join(app, "app", "globals.css"), "utf8").match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";
const ACCENT = rootBlock.match(/--banto-accent:\s*([^;]+);/)?.[1]?.trim();
if (!ACCENT) throw new Error("globals.css に --banto-accent が見つからない");
const INK = "white";

/** 小文字の b を線で組む：縦の柱と輪。scale は 512 四方での大きさに対する倍率（maskable は小さめ） */
function glyph(scale) {
  const c = 256;
  const s = (v) => c + (v - c) * scale;
  const stroke = 46 * scale;
  // 輪：中心 (256, 296)、半径 88
  const cx = s(256);
  const cy = s(296);
  const r = 88 * scale;
  // 柱：輪の左端に沿って上へ伸ばす
  const x = cx - r;
  const top = s(112);
  const bottom = cy;
  return [
    `<line x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" stroke="${INK}" stroke-width="${stroke}" stroke-linecap="round"/>`,
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${INK}" stroke-width="${stroke}"/>`,
  ].join("");
}

function svg({ rounded, scale }) {
  const plate = rounded
    ? `<rect x="16" y="16" width="480" height="480" rx="112" fill="${ACCENT}"/>`
    : `<rect width="512" height="512" fill="${ACCENT}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${plate}${glyph(scale)}</svg>`;
}

const outDir = join(app, "public", "icons");
mkdirSync(outDir, { recursive: true });

async function png(source, size, file) {
  await sharp(Buffer.from(source)).resize(size, size).png({ compressionLevel: 9 }).toFile(join(outDir, file));
}

const any = svg({ rounded: true, scale: 1 });
const full = svg({ rounded: false, scale: 0.9 });
await png(any, 192, "icon-192.png");
await png(any, 512, "icon-512.png");
await png(full, 512, "icon-maskable-512.png");
await png(full, 180, "apple-icon.png");
writeFileSync(join(outDir, "icon.svg"), any + "\n");
console.log("書き出しました:", outDir);
