// **ブラウザの名乗りと言語**（v4-modules.md §4.1「名乗りと言語」、決定・2026-10-10、ユーザー）。
//
// chromium-headless-shell はそのままだと `HeadlessChrome/<版>` と名乗り（User-Agent と Client Hints の brands の両方）、
// 言語は en-US だけ・時刻は UTC。Google はこれでロボットと判定した（実測・2026-10-10）。ここでは
//   - 名乗りを**同じ版の普通の Chrome**（`Chrome/<版>`）に揃え、Client Hints の brands から `HeadlessChrome` を除く
//   - 言語を設定の locale（既定 ja-JP）にし、Accept-Language と navigator.languages を `ja-JP, ja, en-US, en` にする
// **それ以上は変えない**（ユーザー決定）：navigator.webdriver・プラグイン・WebGL・指紋の類はそのまま。ボット判定を
// すり抜ける細工はしない。
//
// 効かせる場所は2つ（実測・2026-10-10）：起こすときの引数（`--user-agent`・`--accept-lang`——ブラウザ全体に効き、
// Worker とポップアップの最初の要求にも届く）と、タブごとの CDP（`Emulation.setUserAgentOverride` の brands と
// `setLocaleOverride`——brands と Intl のロケールは引数では変えられない）。

import { execFileSync } from "node:child_process";

export interface BrowserIdentity {
  /** ブラウザの版（`151.0.7922.34`）。ブラウザ自身に聞いたもの */
  version: string;
  userAgent: string;
  /** 言語の並び（先頭が一番好む言語） */
  languages: string[];
  locale: string;
  timezone: string;
}

/** ブラウザに版を聞く（`--version` は「Google Chrome for Testing 151.0.7922.34」の形で答える） */
export function readBrowserVersion(executable: string): string {
  const out = execFileSync(executable, ["--version"], { encoding: "utf8", timeout: 10_000 });
  return parseBrowserVersion(out);
}

export function parseBrowserVersion(out: string): string {
  const m = /(\d+\.\d+\.\d+\.\d+)/.exec(out);
  if (!m) throw new Error(`ブラウザの版が読めませんでした（--version の答え：${JSON.stringify(out.trim().slice(0, 200))}）`);
  return m[1]!;
}

/**
 * Linux の Chrome の名乗り。headless-shell が名乗る形から `Headless` を除いたものと同じ（Chrome は Linux では
 * CPU の種類によらず `X11; Linux x86_64` と名乗る）
 */
export function chromeUserAgent(version: string): string {
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

/** `ja-JP` → `ja-JP, ja, en-US, en`。英語を後ろに足す（英語のロケールならそれだけ） */
export function acceptLanguages(locale: string): string[] {
  const lang = locale.split("-")[0]!;
  return [...new Set([locale, lang, "en-US", "en"])];
}

export function browserIdentity(version: string, locale: string, timezone: string): BrowserIdentity {
  return { version, userAgent: chromeUserAgent(version), languages: acceptLanguages(locale), locale, timezone };
}

/** 起こすときの引数 */
export function identityArgs(id: BrowserIdentity): string[] {
  return [`--user-agent=${id.userAgent}`, `--accept-lang=${id.languages.join(",")}`, `--lang=${id.locale}`];
}

/** CDP の口（Playwright の CDPSession のうち、ここで使う形） */
export interface CdpSender {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/** タブ1つに名乗り・言語・Client Hints を効かせる。ページの最初の要求より前に呼ぶ */
export async function applyIdentity(cdp: CdpSender, id: BrowserIdentity): Promise<void> {
  const major = id.version.split(".")[0]!;
  // brands は headless-shell が出す並びから `HeadlessChrome` を除いたもの（GREASE の1つと Chromium）
  const grease = { brand: "Not=A?Brand", version: "99" };
  await cdp.send("Emulation.setUserAgentOverride", {
    userAgent: id.userAgent,
    acceptLanguage: id.languages.join(","),
    userAgentMetadata: {
      brands: [grease, { brand: "Chromium", version: major }],
      fullVersionList: [
        { brand: grease.brand, version: "99.0.0.0" },
        { brand: "Chromium", version: id.version },
      ],
      fullVersion: id.version,
      platform: "Linux",
      platformVersion: "",
      architecture: "x86",
      bitness: "64",
      model: "",
      mobile: false,
      wow64: false,
    },
  });
  await cdp.send("Emulation.setLocaleOverride", { locale: id.locale });
}
