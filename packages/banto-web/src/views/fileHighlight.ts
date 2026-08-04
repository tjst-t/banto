/**
 * shiki によるシンタックスハイライト（task-0052）。
 *
 * **shiki 本体・言語文法・テーマはすべて動的インポートで遅延読み込みする**（a3）——
 * 初回ロードの JS に載せない。約700KB の mermaid と同じく、初めてコードを表示する
 * ときにはじめて該当チャンクが読み込まれる。
 *
 * - エンジンは WASM（oniguruma）ではなく JavaScript 実装（createJavaScriptRegexEngine）。
 *   WASM を避けて Vite でのビルド・配信を単純にする（ハイライト品質は同一文法）。
 * - 言語は提案の表（.ts/.js/.py/...）＋ Markdown のコードブロックでよく出るもの
 *   （markdown/html/sql）を明示的に読み込む。足りない言語は表示時に素のまま出す
 *   （fallback）。ハイライト対象の拡充は「都度の追加とする」（task-0052 スコープ外）。
 * - テーマは github-light / github-dark。どちらを使うかは呼び出し側が
 *   prefers-color-scheme（ライト／ダーク）で決める（task-0052 a4）。
 */

import { useEffect, useState } from "react";
import type { HighlighterCore, ThemedToken } from "shiki/core";

export type Scheme = "light" | "dark";

/** システムのライト／ダーク設定（prefers-color-scheme）。shiki のテーマ切替に使う（task-0052 a4）。 */
export function useColorScheme(): Scheme {
  const [scheme, setScheme] = useState<Scheme>(() =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light"
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent): void => setScheme(e.matches ? "dark" : "light");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return scheme;
}

export interface HighlightedLine {
  content: string;
  color?: string;
  fontStyle?: number;
}

/** ハイライト結果の行（CodeBody が行番号つきで描くための、トークン列）。 */
export interface HighlightResult {
  lines: HighlightedLine[][];
  bg?: string;
  fg?: string;
}

const THEME_DARK = "github-dark";
const THEME_LIGHT = "github-light";

let highlighterPromise: Promise<HighlighterCore> | undefined;

/** 言語を1つずつ明示的に動的インポートする（Vite が静的に分割できる形）。 */
async function loadLangs(): Promise<HighlighterCore> {
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
  ]);
  const [themeLight, themeDark, ...langModules] = await Promise.all([
    import("@shikijs/themes/github-light"),
    import("@shikijs/themes/github-dark"),
    // 提案の表のコード種別
    import("@shikijs/langs/typescript"),
    import("@shikijs/langs/javascript"),
    import("@shikijs/langs/python"),
    import("@shikijs/langs/rust"),
    import("@shikijs/langs/go"),
    import("@shikijs/langs/java"),
    import("@shikijs/langs/c"),
    import("@shikijs/langs/cpp"),
    import("@shikijs/langs/css"),
    import("@shikijs/langs/scss"),
    import("@shikijs/langs/json"),
    import("@shikijs/langs/yaml"),
    import("@shikijs/langs/xml"),
    import("@shikijs/langs/shell"),
    import("@shikijs/langs/toml"),
    import("@shikijs/langs/ruby"),
    import("@shikijs/langs/php"),
    import("@shikijs/langs/swift"),
    import("@shikijs/langs/kotlin"),
    import("@shikijs/langs/dart"),
    // Markdown 内のコードブロックでよく出るもの（```markdown / ```html / ```sql 等）
    import("@shikijs/langs/markdown"),
    import("@shikijs/langs/html"),
    import("@shikijs/langs/sql"),
  ]);
  return createHighlighterCore({
    themes: [themeLight.default, themeDark.default],
    langs: langModules.map((m) => m.default).flat(),
    engine: createJavaScriptRegexEngine(),
  });
}

/** シングルトン。初回に一度だけ読み込み、以後は同じインスタンスを返す。 */
export function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= loadLangs();
  return highlighterPromise;
}

export function themeOf(scheme: Scheme): string {
  return scheme === "dark" ? THEME_DARK : THEME_LIGHT;
}

/**
 * コードをトークン列に分解する（行番号つき表示用・task-0052 a1）。
 * 言語が読み込まれていない等で失敗したら undefined（呼び出し側は素のまま表示）。
 */
export async function highlightCode(
  code: string,
  lang: string,
  scheme: Scheme
): Promise<HighlightResult | undefined> {
  try {
    const highlighter = await getHighlighter();
    if (!highlighter.getLoadedLanguages().includes(lang)) return undefined;
    const res = await highlighter.codeToTokens(code, {
      lang,
      theme: themeOf(scheme),
    });
    return {
      lines: res.tokens.map((line) =>
        line.map((t: ThemedToken) => ({
          content: t.content,
          color: t.color,
          fontStyle: t.fontStyle,
        }))
      ),
      bg: res.bg,
      fg: res.fg,
    };
  } catch {
    // I2 の範囲ではない（表示専用の装飾）。素のまま見せれば読めるので握りつぶす
    return undefined;
  }
}

/**
 * コードを HTML に変換する（Markdown 内コードブロック・preview の行番号なし表示用）。
 * 失敗時は undefined（呼び出し側は素のまま表示）。
 */
export async function highlightToHtml(
  code: string,
  lang: string,
  scheme: Scheme
): Promise<string | undefined> {
  try {
    const highlighter = await getHighlighter();
    if (!highlighter.getLoadedLanguages().includes(lang)) return undefined;
    return highlighter.codeToHtml(code, { lang, theme: themeOf(scheme) });
  } catch {
    return undefined;
  }
}
