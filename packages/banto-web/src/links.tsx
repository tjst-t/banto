/**
 * 外に出るリンクは別のタブで開く（PO要望 2026-08-06）。
 *
 * Banto は**開きっぱなしで使う面**（会話・キャンバス・下書き・スクロール位置）を持っている。
 * 番頭の応答や読んでいるファイルの中のリンクを同じタブで開くと、それが丸ごと消える——
 * 戻ってきても、送っていた会話も書きかけも元には戻らない。
 *
 * **外に出るものだけ**を別タブにする。同じ面の中の行き先（`#見出し` のような刷りの中の
 * 参照）まで別タブにすると、押すたびに同じ画面が増える。
 *
 * `rel="noreferrer"`: 別タブへ `window.opener` を渡さない（開いた先からこちらを触らせない）。
 */

import type React from "react";

/**
 * 外に出る行き先か。
 *
 * 判断は**自分のオリジンかどうか**の1点。相対パスも `#…` もこの面の中なので、そのまま。
 * 読めない href（`javascript:` 等の壊れたもの）は外扱いにしない——別タブにしても
 * 何も良くならない。
 */
export function isExternalHref(href: string | undefined): boolean {
  if (!href) return false;
  // スキームの無いもの（`./a.md` `#top` `/env/1`）は必ず自分のオリジンに解決される
  try {
    return new URL(href, location.href).origin !== location.origin;
  } catch {
    return false;
  }
}

/**
 * Markdown の中のリンク（react-markdown の `a` を差し替える）。
 *
 * どの Markdown（番頭の応答・知らせ・思考・SKILL.md・読んでいる `.md`）でも同じ振る舞いに
 * なるよう、置き場をここ1つにする。
 */
export function MarkdownLink({
  href,
  children,
  ...rest
}: React.AnchorHTMLAttributes<HTMLAnchorElement>): React.ReactElement {
  const external = isExternalHref(href);
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
      {...rest}
    >
      {children}
    </a>
  );
}
