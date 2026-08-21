/**
 * コードに色を付ける（要件 E4）。
 *
 * **前の実装から機構ごと引いた**（規則10・規則12：名前のあるものは既知の答えで通る）。
 * そこで測られていたことをそのまま持ってくる：
 *
 * - **言語は1つずつ引く。** 全部まとめて読むと、コードブロックが1つ現れただけで
 *   **生 2.1MB（圧縮後 178KB）**降ってきた。ruby は単体で 30 文法、php は 10 文法を
 *   抱えている——TypeScript を1つ描くために ruby の文法を配る理由はない
 * - **エンジンは WASM ではなく JavaScript 実装。** ビルドと配信が単純になる
 *   （文法は同じなので、色の質は変わらない）
 * - **知らない言語は素のまま出す。** 当てずっぽうで別の文法に当てない（規則2）
 *
 * 明暗は `data-theme` に合わせる——地が暗いのにコードだけ明るいと、そこだけ穴が開く。
 */

import type { HighlighterCore } from 'shiki/core';

/** 会話に出てくる言語。**足すのは出てきたときでよい**（出ない言語を配らない）。 */
const LANGS: Record<string, () => Promise<unknown>> = {
  typescript: () => import('@shikijs/langs/typescript'),
  javascript: () => import('@shikijs/langs/javascript'),
  tsx: () => import('@shikijs/langs/tsx'),
  jsx: () => import('@shikijs/langs/jsx'),
  json: () => import('@shikijs/langs/json'),
  python: () => import('@shikijs/langs/python'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  yaml: () => import('@shikijs/langs/yaml'),
  markdown: () => import('@shikijs/langs/markdown'),
  css: () => import('@shikijs/langs/css'),
  html: () => import('@shikijs/langs/html'),
  sql: () => import('@shikijs/langs/sql'),
  diff: () => import('@shikijs/langs/diff'),
  rust: () => import('@shikijs/langs/rust'),
  go: () => import('@shikijs/langs/go'),
};

/** よくある別名。**知らない綴りは素のまま出す**ので、ここは当たるものだけ書く。 */
const ALIASES: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  py: 'python',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  console: 'shellscript',
  yml: 'yaml',
  md: 'markdown',
  rs: 'rust',
  golang: 'go',
};

export function canonicalLang(raw: string): string | null {
  const lower = raw.toLowerCase();
  const name = ALIASES[lower] ?? lower;
  return name in LANGS ? name : null;
}

let core: Promise<HighlighterCore> | null = null;
const loaded = new Set<string>();

async function highlighter(): Promise<HighlighterCore> {
  if (core === null) {
    core = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] =
        await Promise.all([
          import('shiki/core'),
          import('shiki/engine/javascript'),
          import('@shikijs/themes/github-light'),
          import('@shikijs/themes/github-dark'),
        ]);
      return createHighlighterCore({
        themes: [light.default, dark.default],
        langs: [],
        engine: createJavaScriptRegexEngine(),
      });
    })();
  }
  return core;
}

/**
 * コードを色付きの HTML にする。**引けない言語は `null`** を返す
 * ——呼び手が素のまま出せるように、ここで「それらしい何か」を作らない（規則2）。
 */
export async function highlightToHtml(
  code: string,
  lang: string,
  theme: 'light' | 'dark',
): Promise<string | null> {
  const name = canonicalLang(lang);
  if (name === null) return null;

  const hl = await highlighter();
  if (!loaded.has(name)) {
    const mod = (await LANGS[name]!()) as { default: unknown };
    await hl.loadLanguage(mod.default as Parameters<typeof hl.loadLanguage>[0]);
    loaded.add(name);
  }
  return hl.codeToHtml(code, {
    lang: name,
    theme: theme === 'dark' ? 'github-dark' : 'github-light',
  });
}
