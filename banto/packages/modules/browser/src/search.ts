// **人が使う検索の入口**（v4-modules.md §4.1「新しいタブと URL 欄の検索」、決定・2026-10-15、Backlog #326）。
// 新しいタブ（人の画面の＋・AI が URL 無しで開いたタブ）は検索エンジンのトップで開き、URL 欄に URL でない言葉を打ったら
// 検索エンジンで調べる。AI の Web の検索は WebSearch のまま——ここは人のためのもの。

/** 選べる検索エンジン。`custom` は人が書いた URL の型（`%s` を言葉に替える） */
export const SEARCH_ENGINES = {
  duckduckgo: { name: "DuckDuckGo", home: "https://duckduckgo.com/", template: "https://duckduckgo.com/?q=%s" },
  startpage: { name: "Startpage", home: "https://www.startpage.com/", template: "https://www.startpage.com/do/search?q=%s" },
  brave: { name: "Brave Search", home: "https://search.brave.com/", template: "https://search.brave.com/search?q=%s" },
} as const;

export type SearchEngineId = keyof typeof SEARCH_ENGINES | "custom";
export const SEARCH_ENGINE_IDS: readonly SearchEngineId[] = [...(Object.keys(SEARCH_ENGINES) as (keyof typeof SEARCH_ENGINES)[]), "custom"];

/**
 * 既定は DuckDuckGo——この banto の接続元から3つを開いて日本語で検索し、確かめのページが出なかったもの（実測・2026-10-15。
 * Startpage は「リクエストを確認しています」の計算の確かめが出た。v4-modules.md §4.1）
 */
export const DEFAULT_SEARCH_ENGINE: SearchEngineId = "duckduckgo";

export interface SearchSettings {
  searchEngine: SearchEngineId;
  /** `custom` の URL の型。ほかのエンジンを選んでいる間も残す（選び直したとき書き直さずに済む） */
  searchTemplate: string;
}

export function checkSearchEngine(v: unknown): string | undefined {
  return typeof v === "string" && (SEARCH_ENGINE_IDS as readonly string[]).includes(v)
    ? undefined
    : `searchEngine は ${SEARCH_ENGINE_IDS.join("・")} のどれかです（${JSON.stringify(v)} が来ました）`;
}

/** 任意の URL の型として使えるか（空はまだ書いていない——custom を選ぶときだけ要る）。使えなければ理由 */
export function checkSearchTemplate(v: unknown): string | undefined {
  if (typeof v !== "string") return `searchTemplate は文字列です（${JSON.stringify(v)} が来ました）`;
  if (v === "") return undefined;
  if (!v.includes("%s")) return `searchTemplate には言葉を入れる場所 %s が要ります（例 https://example.com/search?q=%s）: ${JSON.stringify(v)}`;
  let url: URL;
  try {
    url = new URL(v.replaceAll("%s", "x"));
  } catch {
    return `searchTemplate が URL として読めません（例 https://example.com/search?q=%s）: ${JSON.stringify(v)}`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return `searchTemplate は http か https で始めます: ${JSON.stringify(v)}`;
  return undefined;
}

/** 選び方が揃っているか（custom なのに型が無い、を置かない）。揃っていなければ理由 */
export function checkSearchSettings(s: SearchSettings): string | undefined {
  if (s.searchEngine === "custom" && s.searchTemplate === "") return "任意の URL の型（searchTemplate）を書いてから custom を選びます";
  return undefined;
}

function templateOf(s: SearchSettings): string {
  return s.searchEngine === "custom" ? s.searchTemplate : SEARCH_ENGINES[s.searchEngine].template;
}

/** 新しいタブで開くトップ。任意の型は言葉を空にした URL（多くの検索エンジンは空の言葉でトップを返す） */
export function searchHome(s: SearchSettings): string {
  return s.searchEngine === "custom" ? s.searchTemplate.replaceAll("%s", "") : SEARCH_ENGINES[s.searchEngine].home;
}

/** その言葉を検索エンジンで調べる URL */
export function searchUrl(s: SearchSettings, words: string): string {
  return templateOf(s).replaceAll("%s", encodeURIComponent(words.trim()));
}

/**
 * URL 欄に打ったものが URL らしいか。**らしくなければ検索する**——空白を含む・scheme が無くホストとして読めない（ドットの
 * 無い1語・最後の区切りが英字でない等）。らしいもの：scheme つき（`http://`・`about:` 等）・`localhost`・IPv4・`[IPv6]`・
 * 英字の TLD で終わるホスト（`example.com`）・番号つきの1語（`web:8080`——コンテナの中のサービス）
 */
export function looksLikeUrl(input: string): boolean {
  const s = input.trim();
  if (s === "" || /\s/.test(s)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(about|data|blob|file):/i.test(s)) return true;
  // ホスト[:番号] を取り出す（その後ろの / ? # は道）
  const m = /^([^/?#]+)(.*)$/.exec(s);
  if (!m) return false;
  const authority = m[1]!;
  const hp = /^(\[[0-9a-f:.]+\]|[^:]+)(?::(\d{1,5}))?$/i.exec(authority);
  if (!hp) return false;
  const host = hp[1]!.toLowerCase();
  const port = hp[2];
  let ok: boolean;
  if (host === "localhost" || host.startsWith("[")) ok = true;
  else if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) ok = host.split(".").every((n) => Number(n) <= 255);
  else {
    const labels = host.split(".");
    const valid = labels.every((l) => /^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u.test(l));
    // 1語は番号つきだけ（web:8080）。2語以上は最後が英字の TLD（日本語の「東京.天気」は検索）
    ok = valid && (labels.length === 1 ? port !== undefined : /^(?:[a-z]{2,63}|xn--[a-z0-9-]+)$/.test(labels[labels.length - 1]!));
  }
  if (!ok) return false;
  try {
    new URL(`http://${s}`);
    return true;
  } catch {
    return false;
  }
}

/** URL 欄に打ったもの：URL らしければ scheme が無いとき http:// を足して開き、らしくなければ検索エンジンで調べる */
export function urlBarTarget(input: string, s: SearchSettings): string {
  const url = input.trim();
  if (!looksLikeUrl(url)) return searchUrl(s, url);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^(about|data|blob|file):/i.test(url)) return url;
  return `http://${url}`;
}
