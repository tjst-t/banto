# Ctrl-K の表示が遅い・スクロールがもたつく（2026-09-30）

ユーザー指摘「Ctrl-K のメニュー表示がちょっと遅いのとスクロールももたつく」。測り方は `banto/e2e/palette-probe.mjs`
（Banto開発 を開き、Ctrl-K を 3 回開閉、1 回目はホイールで 30 回スクロールして rAF の間隔を取る。
`PROBE_CPU=4` で CPU を 4 倍遅く、`PROBE_PROFILE=1` で CPU プロファイル）。項目は 16 件——数の問題ではなかった。

## 原因（3つ、独立）

1. **背景のぼかし**（`backdrop-blur-xs`）：スクロール中は JS がほぼ動かないのに 5% のコマが 50ms。
   ぼかしを CSS で消すと p95 50→17ms（毎コマ間に合う）
2. **Radix のモーダル**：開いた瞬間の変化を MutationObserver で取ると、スクロール止めの `<style>` を `<head>` に
   追加・`<body>` に `data-scroll-locked` と `pointer-events:none`。トレースでは文書全体（約 900 要素）の
   スタイル計算が 2 回で 0.16 s（CPU ×4）——`focus` と cmdk の `scrollIntoView` が強制している
3. **URL を変えるたびの RSC 取得**：パレットの開閉（`?overlay=palette`）ごとに `GET /p/<id>?…`（`RSC: 1`）が
   1 往復。Fork・Canvas の開閉、設定の歯車・Escape、サイドバーの Fork の行も同じ

## 直した後（直した画面を 4197 で起こし、API は稼働中の host）

| | 前 CPU ×1 | 後 CPU ×1 | 前 CPU ×4 | 後 CPU ×4 |
|---|---|---|---|---|
| Ctrl-K で最初の項目が出るまで | 97〜195 ms | 50〜63 ms | 389〜472 ms | 207〜238 ms |
| そのときの long task | 50〜97 ms | なし | 190〜258 ms | 128〜164 ms |
| スクロール p95／最大 | 50〜67 ms | 17／17 ms | 50／67 ms | 17／33 ms |
| 開閉・Fork・設定での RSC 取得 | 毎回 1 回 | 0 回 | | |

残り（CPU ×4 で約 0.15 s の long task）は、URL が変わったことで `useSearchParams` を読む部品（外枠・パネル・
会話）が描き直される分。パレットの開閉を URL から外せば消えるが、「開いているものは URL が持つ」（規則3）を
崩すので、今回はやらない。

却下：パレットの項目の仮想スクロール（16 件なので効かない）。
