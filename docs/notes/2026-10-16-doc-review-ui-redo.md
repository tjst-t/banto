# PDF・Office の画面の作り直し（2026-10-16、Backlog #340）

仕様 v4-modules.md §2.2「画面の形（改訂・2026-10-16）」の実装。見本はモック fork/doc-review-mock ae1db51c。

## 仕様と食い違ったところ（規則8——人に上げる）

- **印の色**：仕様は「文は蛍光ペン（`--banto-chart-4` を薄く）」。Canvas に渡る色は MCP Apps の標準の名前だけで
  （`apps/frontend/lib/backend/canvas-host-styles.ts`、SDK が知らない名前を断る）、`--banto-chart-4` は渡らない。画面は banto の値を
  持たない（要件E9）ので、**注意の色（`--color-text-warning`←`--banto-warn`）を薄くして使った**（`ui/styles.ts` の `--mark`）。
  chart-4 にしたいなら、標準の名前のどれに対応させるかを決める必要がある
- **表と docx-preview の面の「探す」**：仕様のツールバーの一覧には「探す」があるが、表と Word の面には前の版から無い。今回は
  作っていない（見せて繋がっていないボタンは置かない、規則13）。要るなら別のタスクに

## 決めたこと・却下した案

- 文の位置（矩形）をコメントに保存する案（モックはそうしている）は採らなかった：コメントの口（`getComments`・`saveComments`・
  指す場所の形）は変えない決まり。描いた文字の中から引用を探し直す（`ui/quote-range.ts`）。同じ文がページに2回あれば最初の所
- 印は押せる要素にしない（`pointer-events: none`）：印の上から文字を選べなくなるため。押しただけ（ドラッグしていない）のときに
  その点にある印を探して強調する
- 範囲は「文字の無い所の pointerdown」で始める。pointerdown を止めると mousedown も来ないので、文字の選択は始まらず
  `text-selection.ts` の「選んでいる」も立たない（文字の選び方は変えていない）
- E2E は範囲も文もマウスのドラッグで作る。PDF の1行は文字の層で複数の span に分かれる（「第1章」「 」「受信箱の見直し」）
  ので、行の右端は同じ高さの span をつないで測る

## 試験（流した結果）

`BANTO_E2E_WORKERS=2 npx playwright test specs/filesystem-{pdf,pdf-select,comments,docx,xlsx,office-pdf}.spec.ts`
——**8 件すべて通った（4.0 分、2026-10-16）**。足した試験：文字の無い所のドラッグで範囲（「コメント」を押すまで残る・ページの
別の所を押すと消える）・ページの上の行からページへのコメント・コメントモードのオフで「コメント」・印・余白が出ない・広いときに
余白のコメントが指した所の高さに並ぶ（重なれば下へ）・スライドの範囲とスライドへのコメントを「AI に返す」まで・docx の文へのコメント。

単体試験の注意：この作業の環境では `$TMPDIR` が深く、`@banto/core` の `runtime/socket-dir.test.js` の2件が Unix socket の
パスの長さで落ちる（変更と関係ない。`TMPDIR=/tmp` では全部通る）。
