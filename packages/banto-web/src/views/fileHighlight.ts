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
 *   （markdown/html/sql）。**出てきた言語だけを1つずつ引く**（→ `LANG_LOADERS`）——
 *   以前は全部まとめて読み込んでいたので、コードブロックが1つ現れただけで 2.1MB 降ってきた。
 *   足りない言語は表示時に素のまま出す（fallback）。ハイライト対象の拡充は
 *   「都度の追加とする」（task-0052 スコープ外）。
 * - テーマは github-light / github-dark。どちらを使うかは呼び出し側が
 *   prefers-color-scheme（ライト／ダーク）で決める（task-0052 a4）。
 */

import { useEffect, useState } from "react";
import type { HighlighterCore, LanguageRegistration, ThemedToken } from "shiki/core";

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

/**
 * 言語ごとの読み込み口（Vite が静的に分割できるよう、リテラルの `import()` で書く）。
 *
 * **1つずつ引く。** 以前はここを丸ごと `Promise.all` していたので、コードブロックが
 * 1つ現れただけで**全言語**が降ってきた（生 2.1MB・**圧縮後 178KB**）。よくある
 * 組み合わせ（ts/shell/json/yaml/markdown）なら 24KB、TypeScript だけなら 11KB で済む。
 *
 * 中身は言語ごとに大きく偏っている——ruby は単体で30文法、php は10文法、cpp は8文法を
 * 抱えており（それぞれ他言語を埋め込むため）、圧縮後でもこの3つで全体の4割を占める。
 * TypeScript のコードを1つ描くために ruby の文法を配る理由はない。
 *
 * **効くのは転送量だけではない。** 24個の文法を組み立てる CPU も要らなくなる——
 * 遅い端末ではこちらのほうが体感に響く。
 */
const LANG_LOADERS: Record<string, () => Promise<{ default: LanguageRegistration[] }>> = {
  typescript: () => import("@shikijs/langs/typescript"),
  javascript: () => import("@shikijs/langs/javascript"),
  python: () => import("@shikijs/langs/python"),
  rust: () => import("@shikijs/langs/rust"),
  go: () => import("@shikijs/langs/go"),
  java: () => import("@shikijs/langs/java"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  css: () => import("@shikijs/langs/css"),
  scss: () => import("@shikijs/langs/scss"),
  json: () => import("@shikijs/langs/json"),
  yaml: () => import("@shikijs/langs/yaml"),
  xml: () => import("@shikijs/langs/xml"),
  shell: () => import("@shikijs/langs/shell"),
  toml: () => import("@shikijs/langs/toml"),
  ruby: () => import("@shikijs/langs/ruby"),
  php: () => import("@shikijs/langs/php"),
  swift: () => import("@shikijs/langs/swift"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  dart: () => import("@shikijs/langs/dart"),
  // Markdown 内のコードブロックでよく出るもの（```markdown / ```html / ```sql 等）
  markdown: () => import("@shikijs/langs/markdown"),
  html: () => import("@shikijs/langs/html"),
  sql: () => import("@shikijs/langs/sql"),
};

/**
 * 別名から本体の名前へ。
 *
 * **全部載せをやめた代償**——以前は文法を読み込んだ shiki が別名も登録してくれたので
 * ```ts や ```bash がそのまま通った。1つずつ引くいまは、**何を引くかを決める前に**
 * 別名を解かないと「知らない言語」として素のまま出てしまう。
 * 中身は各文法が `aliases` に持っている値（2026-08-08 に実測して写した）。
 */
const LANG_ALIASES: Record<string, string> = {
  ts: "typescript", cts: "typescript", mts: "typescript",
  js: "javascript", cjs: "javascript", mjs: "javascript",
  py: "python",
  rs: "rust",
  yml: "yaml",
  bash: "shell", sh: "shell", zsh: "shell",
  rb: "ruby",
  kt: "kotlin", kts: "kotlin",
  md: "markdown",
  "c++": "cpp",
};

let highlighterPromise: Promise<HighlighterCore> | undefined;
/** 読み込み済み（または読み込み中）の言語。同じ文法を二重に引かない。 */
const loadedLangs = new Map<string, Promise<void>>();

/** テーマとエンジンだけで作る。文法は使うものだけ後から足す（→ `ensureLang`）。 */
async function createCore(): Promise<HighlighterCore> {
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
  ]);
  const [themeLight, themeDark] = await Promise.all([
    import("@shikijs/themes/github-light"),
    import("@shikijs/themes/github-dark"),
  ]);
  return createHighlighterCore({
    themes: [themeLight.default, themeDark.default],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  });
}

/** シングルトン。初回に一度だけ読み込み、以後は同じインスタンスを返す。 */
export function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createCore();
  return highlighterPromise;
}

/**
 * その言語の文法を用意する。解決できた本体の名前を返す（扱えない言語は undefined）。
 * 呼び出し側は undefined を素のまま表示として扱う——これは今までと同じ約束。
 */
async function ensureLang(
  highlighter: HighlighterCore,
  lang: string
): Promise<string | undefined> {
  // Markdown のフェンス（```TS）は書き手の打ったままなので、ここで揃える。
  // ファイルビューア側は拡張子から正規名に直して渡してくる（`CODE_LANG_BY_EXT`）
  const key = lang.toLowerCase();
  const name = LANG_ALIASES[key] ?? key;
  const load = LANG_LOADERS[name];
  if (!load) return undefined;
  if (!loadedLangs.has(name)) {
    loadedLangs.set(
      name,
      load().then((m) => highlighter.loadLanguage(m.default))
    );
  }
  try {
    await loadedLangs.get(name);
  } catch {
    // 落ちた読み込みを覚え込まない（次に同じ言語が出たらもう一度試す）
    loadedLangs.delete(name);
    return undefined;
  }
  return name;
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
    const name = await ensureLang(highlighter, lang);
    if (!name) return undefined;
    const res = await highlighter.codeToTokens(code, {
      lang: name,
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
    const name = await ensureLang(highlighter, lang);
    if (!name) return undefined;
    return highlighter.codeToHtml(code, { lang: name, theme: themeOf(scheme) });
  } catch {
    return undefined;
  }
}
