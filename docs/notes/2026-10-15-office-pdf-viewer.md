# PDF の画面（Backlog #302 office-pdf-viewer）を実装して決めたこと（2026-10-15）

仕様は `docs/specs/v4-modules.md` §2.2「PDF・Office のファイルを読んでコメントを返す」と
`docs/specs/v4-frontend.md` §6.2「引数のファイルの拡張子で画面を選び替える tool」。ここは経緯と却下した案。

## showFile が拡張子で画面を選ぶ口

仕様は「`showFile` が拡張子で画面を選ぶ」とだけ書いていたが、MCP Apps の tool の画面（`_meta.ui.resourceUri`）は
tool に1つで、host（core の `ReplyRecorder`・画面の `rememberInlineView`）は **tool の名前だけで**画面を引いていた。
呼び出しごとに選ぶ口は無かった。

- **採った案**：tool が `_meta["dev.banto/ui-by-extension"]` で「この引数のパスの拡張子なら、この画面」と名乗り、host が
  呼び出しの引数で選ぶ。記録にも選んだ URI を残す（大きく開く・リロード・バックグラウンドの一覧は記録の URI を開く）
- 却下：テキストの画面（`file`）に PDF も描かせる——テキストを見るたびに pdf.js（約 1.7MB）を読み込む。仕様の「テキストの画面の重さは変えない」に反する
- 却下：`file` の画面が PDF を見たら自分で `document` に移る——Canvas の CSP で外の script は読めず、画面から別の画面を開く口も無い
  （`dev.banto/open-surface` は launcher・設定・Thread だけ）
- 却下：PDF 用に別の tool（`showDocument` 等）を足す——AI が「見せる」に2つの tool を使い分けることになり、間違える

## pdf.js の版と組み立て

- pdfjs-dist 6.4.299 の `build/`（新しいブラウザ向け）の min を使う。2026-10-15 の実測（Canvas と同じ CSP の Chromium）がこの形だったため。
  `build/` は `Uint8Array.prototype.toHex`・`Map.prototype.getOrInsertComputed` などの新しい組み込みを使う
  （Node 24 では `toHex` が無くて落ちた）。**古いブラウザでは開けない**。`legacy/build/` は約 0.1MB 大きいだけだが、
  worker の min に `eval(` が1か所あり、CSP の下で動くかを測っていない。要るようになったら測って切り替える
- 依存は pdfjs-dist だけ（規則10：Canvas の CSP の下でブラウザの PDF ビューアは使えず、PDF を描く既存資産が無い）。
  `@napi-rs/canvas` は pdfjs-dist の optionalDependencies（Node で描くとき用）で、画面では使わない
- 画面の束（`scripts/bundle-ui.mjs`）は相対の require しか辿らないので、pdf.js は束に入れず HTML に別の
  `<script type="module">` で置く（worker → 本体 → 画面）。どちらも自分で `globalThis.pdfjsWorker`／`pdfjsLib` に置く

## CMap・標準フォント

pdf.js は日本語の CMap（`cmaps/*.bcmap`）と標準フォントを URL から fetch する。Canvas の `connect-src` は塞いだまま
（緩めない）なので、`BinaryDataFactory` を差し替えて画面向けの `readPdfAsset`（`admin`）から受ける。
埋め込みのある PDF（LibreOffice・Word の書き出し）では呼ばれない。E2E は埋め込まない日本語フォント
（`UniJIS-UCS2-H`）の PDF で、この道を通している。

## 大きな PDF

4MiB を超えるものは `PDFDataRangeTransport`（`rangeChunkSize` 512KiB、`disableAutoFetch`・`disableStream`）。
先読みをすると見ないページのために 50MB を中継で運ぶので止めた。探すときは全ページの文字を読むので、そのときは要る範囲を運ぶ。
