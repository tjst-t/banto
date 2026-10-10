// **ブラウザの名乗りと言語**（v4-modules.md §4.1「名乗りと言語」、決定・2026-10-10、ユーザー）。
//
// 名乗り（User-Agent・Client Hints）は**変えない**——普通のブラウザを画面ありで起こしているので、本物の値が人のブラウザと
// 同じになる（chrome.ts）。ここで決めるのは言語の並びだけ：設定の locale（既定 ja-JP）に、その言語と英語を後ろに足す。
// 効かせるのは起動の引数（`--accept-lang`）と環境（LANG・LANGUAGE・TZ）——chrome.ts。

import { execFileSync } from "node:child_process";

/** ブラウザに版を聞く（`--version` は「Google Chrome 155.0.8059.39」の形で答える） */
export function readBrowserVersion(executable: string): string {
  const out = execFileSync(executable, ["--version"], { encoding: "utf8", timeout: 10_000 });
  return parseBrowserVersion(out);
}

export function parseBrowserVersion(out: string): string {
  const m = /(\d+\.\d+\.\d+\.\d+)/.exec(out);
  if (!m) throw new Error(`ブラウザの版が読めませんでした（--version の答え：${JSON.stringify(out.trim().slice(0, 200))}）`);
  return m[1]!;
}

/** `ja-JP` → `ja-JP, ja, en-US, en`。英語を後ろに足す（英語のロケールならそれだけ） */
export function acceptLanguages(locale: string): string[] {
  const lang = locale.split("-")[0]!;
  return [...new Set([locale, lang, "en-US", "en"])];
}
