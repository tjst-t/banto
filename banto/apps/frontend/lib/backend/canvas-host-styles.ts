// Module の画面（Canvas）に渡す banto の色と段（決定・2026-09-25、v4-frontend.md §6.27）。
//
// **元は `app/globals.css` の層A（`--banto-*`）の1箇所**。ここが持つのは「MCP Apps の標準の名前 ←
// banto の名前」の対応だけで、値は持たない（規則3）——画面を開くときと明暗が変わったときに、
// banto の画面から今の値を読んで `hostContext.styles.variables` で渡す。
//
// **名前は標準のものだけ**。SDK の検査は決まった名前の外を `unrecognized_keys` で断る
// （確認・2026-09-25）——banto 独自の名前を足すと、SDK を使う Module の画面が初期化で落ちる。
// **banto に無い段は渡さない**（`heading-xl` 以上・`radius-xs` など）——無い値を作らない。

import type { McpUiStyleVariableKey, McpUiStyles } from "@modelcontextprotocol/ext-apps/app-bridge";

export const CANVAS_STYLE_SOURCES = {
  "--color-background-primary": "--banto-surface",
  "--color-background-secondary": "--banto-surface-2",
  "--color-background-tertiary": "--banto-surface-3",
  "--color-background-inverse": "--banto-text",
  "--color-background-info": "--banto-accent-soft",
  // danger は stop——banto は失敗・エラー・差分の削除を stop で出す（turn は「会話の番・注意」の色）
  "--color-background-danger": "--banto-stop-soft",
  "--color-background-success": "--banto-ok-soft",
  "--color-background-warning": "--banto-warn-soft",
  "--color-text-primary": "--banto-text",
  "--color-text-secondary": "--banto-text-2",
  "--color-text-tertiary": "--banto-text-3",
  // 色の上の字（例：塗ったボタンの字）。inverse の地（本文の字の色）の上でも読める
  "--color-text-inverse": "--banto-on-color",
  "--color-text-info": "--banto-accent",
  "--color-text-danger": "--banto-stop",
  "--color-text-success": "--banto-ok",
  "--color-text-warning": "--banto-warn",
  "--color-border-primary": "--banto-line",
  "--color-border-secondary": "--banto-line-2",
  "--color-border-info": "--banto-accent",
  "--color-border-danger": "--banto-stop",
  "--color-border-success": "--banto-ok",
  "--color-border-warning": "--banto-warn",
  "--color-ring-primary": "--banto-accent",
  "--font-sans": "--banto-font-sans",
  "--font-mono": "--banto-font-mono",
  // 字の7段を小さい順に：本文 xs〜lg ＝ 11・12・13・15、見出し xs〜lg ＝ 15・17・22・28
  "--font-text-xs-size": "--banto-text-xs",
  "--font-text-sm-size": "--banto-text-sm",
  "--font-text-md-size": "--banto-text-md",
  "--font-text-lg-size": "--banto-text-lg",
  "--font-text-xs-line-height": "--banto-text-xs-leading",
  "--font-text-sm-line-height": "--banto-text-sm-leading",
  "--font-text-md-line-height": "--banto-text-md-leading",
  "--font-text-lg-line-height": "--banto-text-lg-leading",
  "--font-heading-xs-size": "--banto-text-lg",
  "--font-heading-sm-size": "--banto-text-xl",
  "--font-heading-md-size": "--banto-text-2xl",
  "--font-heading-lg-size": "--banto-text-3xl",
  "--font-heading-xs-line-height": "--banto-text-lg-leading",
  "--font-heading-sm-line-height": "--banto-text-xl-leading",
  "--font-heading-md-line-height": "--banto-text-2xl-leading",
  "--font-heading-lg-line-height": "--banto-text-3xl-leading",
  "--border-radius-sm": "--banto-radius-sm",
  "--border-radius-md": "--banto-radius-md",
  "--border-radius-lg": "--banto-radius-lg",
  "--shadow-sm": "--banto-sh-1",
  "--shadow-md": "--banto-sh-2",
  "--shadow-lg": "--banto-sh-3",
} as const satisfies Partial<Record<McpUiStyleVariableKey, `--banto-${string}`>>;

type CanvasStyleKey = keyof typeof CANVAS_STYLE_SOURCES;

/**
 * banto の今の値を、標準の名前で並べる。`read` は CSS の変数を読む口（`getComputedStyle(…).getPropertyValue`）。
 * **読めなかった banto の名前は `missing` で返す**——黙って欠かさない（規則2）。欠けても画面は
 * 出せる（Module は渡されない変数を既定で描く）ので止めはしないが、呼ぶ側が言う
 */
export function readCanvasStyles(read: (name: string) => string): {
  variables: Partial<Record<CanvasStyleKey, string>> & Partial<McpUiStyles>;
  missing: string[];
} {
  const variables: Partial<Record<CanvasStyleKey, string>> = {};
  const missing: string[] = [];
  for (const [key, source] of Object.entries(CANVAS_STYLE_SOURCES) as [CanvasStyleKey, string][]) {
    const value = read(source).trim();
    if (value) variables[key] = value;
    else missing.push(source);
  }
  return { variables, missing };
}

/** 今の banto の画面から読む（ブラウザでだけ呼ぶ）。明暗は `<html>` の `dark` クラス（next-themes） */
export function currentCanvasAppearance(): { theme: "light" | "dark"; styles: { variables: McpUiStyles } } {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const { variables, missing } = readCanvasStyles((name) => style.getPropertyValue(name));
  if (missing.length) console.error(`Canvas に渡す banto の値が読めません：${missing.join("、")}（globals.css の層A）`);
  return {
    theme: root.classList.contains("dark") ? "dark" : "light",
    // 型は全部の名前を要るように見えるが、値は string | undefined——渡すのは banto に在る段だけ
    styles: { variables: variables as McpUiStyles },
  };
}
