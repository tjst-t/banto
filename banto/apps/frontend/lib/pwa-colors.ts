/**
 * **CSS の外で色を値で書くしかない所の色**（追加・2026-10-10、`docs/specs/v4-frontend.md` §6.37）。
 *
 * manifest の地の色と `viewport.themeColor` はブラウザが CSS より先に読むので、変数（`var(--banto-bg)`）を使えない。
 * 値の出どころは今も `app/globals.css` だけ——ここはその写しで、`scripts/check-tokens.mjs` が食い違いを落とす
 */
export const PWA_COLORS = {
  /** `:root` の `--banto-bg` */
  lightBackground: "#f5f6f8",
  /** `.dark` の `--banto-bg` */
  darkBackground: "#0e1014",
} as const;
