// **日本語を日本の字形で描く**（v4-modules.md §4.1「字体」、Backlog #271）。
//
// Playwright の install-deps chromium が入れる fonts-wqy-zenhei（中国の字形）の fontconfig の設定（25-・64-wqy-zenhei.conf）が
// 強く、`fc-match "sans-serif:lang=ja"` も素の `sans-serif` も WenQuanYi Zen Hei を返す（実測・2026-10-12、まっさらのコンテナ。
// 一緒に入る IPA ゴシックも、fonts-noto-cjk を足しただけでも負ける）。そこで：
//
// - **Noto CJK（fonts-noto-cjk）を入れる**（ensureCjkFont——install.ts と同じく、入れられるのはコンテナの中だけ）
// - **Module が起こすブラウザにだけ効く fontconfig の設定**を置く（`FONTCONFIG_FILE`——chrome.ts）。システムの設定
//   （/etc/fonts/fonts.conf）を読み込んだ後に、言語ごとに Noto CJK の字形を先に選ぶ規則と、言語の指定の無い文字を
//   設定の locale の字形にする規則を足す。/etc/fonts は書かない——sudo が要らず、別のサーバでも同じに効き、ほかの
//   プログラムの字体を変えない

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** 入れる字体の包み（Ubuntu・Debian）。Sans・Serif・Sans Mono の CJK の JP・KR・SC・TC・HK を含む */
export const CJK_FONT_PACKAGE = "fonts-noto-cjk";

/** Noto CJK の地域の名前（JP・KR・SC・TC・HK） */
type Region = "JP" | "KR" | "SC" | "TC" | "HK";

/** 言語の印（fontconfig の lang）ごとの字形。ko を書かないと、下の言語の指定の無い文字の規則で JP になる（実測） */
const LANG_REGIONS: [lang: string, region: Region][] = [
  ["ja", "JP"],
  ["ko", "KR"],
  ["zh-cn", "SC"],
  ["zh-sg", "SC"],
  ["zh-tw", "TC"],
  ["zh-hk", "HK"],
  ["zh-mo", "HK"],
];

/** 総称（CSS の sans-serif 等）ごとの Noto CJK の名前 */
const GENERICS: [generic: string, family: (r: Region) => string][] = [
  ["sans-serif", (r) => `Noto Sans CJK ${r}`],
  ["serif", (r) => `Noto Serif CJK ${r}`],
  ["monospace", (r) => `Noto Sans Mono CJK ${r}`],
];

/**
 * 言語の指定の無い文字を描く字形。設定の locale（ブラウザの言語）から決める：ja→JP・ko→KR・zh は地域か文字（Hant）で
 * SC・TC・HK。**CJK でない言語は JP**——どれかに決めないと wqy-zenhei の中国の字形になり、banto の使い手は日本語で書く
 */
export function defaultRegion(locale: string): Region {
  const parts = locale.toLowerCase().split("-");
  if (parts[0] === "ko") return "KR";
  if (parts[0] === "zh") {
    if (parts.includes("hk") || parts.includes("mo")) return "HK";
    if (parts.includes("tw") || parts.includes("hant")) return "TC";
    return "SC";
  }
  return "JP";
}

/** Module が起こすブラウザの fontconfig の設定（`FONTCONFIG_FILE` に置く） */
export function fontconfigXml(locale: string): string {
  const lines = [
    `<?xml version="1.0"?>`,
    `<!DOCTYPE fontconfig SYSTEM "fonts.dtd">`,
    `<!-- banto Browser が書く（起こすたびに書き直す）。v4-modules.md §4.1「字体」 -->`,
    `<fontconfig>`,
    `  <include>/etc/fonts/fonts.conf</include>`,
  ];
  for (const [lang, region] of LANG_REGIONS) {
    for (const [generic, family] of GENERICS) {
      lines.push(
        `  <match target="pattern">`,
        `    <test name="lang" compare="contains"><string>${lang}</string></test>`,
        `    <test name="family"><string>${generic}</string></test>`,
        `    <edit name="family" mode="prepend" binding="strong"><string>${family(region)}</string></edit>`,
        `  </match>`,
      );
    }
  }
  const region = defaultRegion(locale);
  for (const [generic, family] of GENERICS) {
    lines.push(`  <alias binding="strong"><family>${generic}</family><prefer><family>${family(region)}</family></prefer></alias>`);
  }
  lines.push(`</fontconfig>`, ``);
  return lines.join("\n");
}

/** 設定を書く（起こすたびに——locale は次に起こしたときから効く） */
export function writeFontconfig(file: string, locale: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, fontconfigXml(locale));
}

/** Noto Sans CJK JP が入っているか（fontconfig に聞く。fc-list が無ければ入っていないと見る——fontconfig ごと入れる） */
export function hasCjkFont(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("fc-list", ["-q", "Noto Sans CJK JP"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

const MANUAL = `\`sudo apt install ${CJK_FONT_PACKAGE}\``;

/**
 * 字体が無ければ入れる。**入れられなくてもブラウザは断らない**（字形が違うだけで、ページは開ける）——代わりに理由と入れ方を
 * 返す（呼ぶ側が Module のログと状態に出す）。sudo しない箱（別のサーバ——`BANTO_NO_SUDO=1`、v4-security.md §1「前提の
 * 確かめ」）では入れようとしない
 */
export async function ensureCjkFont(install: (onProgress?: (message: string) => void) => Promise<void>, onProgress?: (message: string) => void): Promise<string | undefined> {
  if (await hasCjkFont()) return undefined;
  if (process.env.BANTO_NO_SUDO === "1") {
    return `この実行場所には日本語の字体（Noto Sans CJK JP）がありません。日本語が中国の字形や別の字体で描かれます（banto はこの実行場所で sudo しないので、自動では入れません）。向こうで ${MANUAL} を打ってから、ブラウザを起こし直してください`;
  }
  try {
    await install(onProgress);
  } catch (err) {
    return `日本語の字体（Noto Sans CJK JP）を入れられませんでした（${(err as Error).message}）。日本語が中国の字形や別の字体で描かれます。${MANUAL} を打ってから、ブラウザを起こし直してください`;
  }
  if (await hasCjkFont()) return undefined;
  return `${CJK_FONT_PACKAGE} を入れましたが、fontconfig に Noto Sans CJK JP が見つかりません。日本語が中国の字形や別の字体で描かれます`;
}
