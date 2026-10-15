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

## docx（Backlog #303 office-docx-preview、2026-10-15）

- **同じ `document` の画面に入れた**。docx 用に別の `ui://` を作ると、`readFileRange`・大きく表示・後で入るコメントの一覧を
  2つの画面で持つことになる。docx-preview＋JSZip は min で約 0.17MB で、PDF を見るときに背負っても pdf.js（約 1.7MB）に比べて小さい。
  どちらで描くかは画面が拡張子で選ぶ（host が `ui-by-extension` で選んだのと同じ物差し）。画面はパスが分かるまで面を作らない
  ——tool の引数で先に届くが、届かないとき（記録から開き直したとき等）は結果のパスで決める
- 却下：docx-preview を画面の束（`bundle-ui.mjs`）に入れる——束は相対の require しか辿らず、`require("jszip")` を解けない。
  pdf.js と同じく HTML に別の script で置く。どちらも UMD なので普通の script（module ではない）で `globalThis` に置かせる
- JSZip の min に `new Function` が1か所あるが、`setImmediate` に文字列を渡されたときだけ通る（docx-preview は渡さない）。
  Canvas と同じ CSP の Chromium で描けることを、試験用の docx（見出し・表・箇条書き）で確かめた
- **「元に近い見た目で見る」と、描けなかったときの PDF への切り替えはまだ無い**——変換役（LibreOffice）が入っていない。
  規則13 によりボタンは出さず、描けなかったら理由（壊れた zip は「docx として読めませんでした」）を出して止まる。変換役の
  タスクで、この画面に切り替えを足す
- 狭いカードでは紙の幅のページが横にはみ出すので、`.docx-wrapper` に CSS の `zoom` を掛けて幅に合わせる（縮めるだけ）。
  `transform: scale` は元の大きさで場所を取るのでスクロールの長さが合わない
- 依存は docx-preview 0.4.1 と、その peer の JSZip 3.10.1（規則10：docx を HTML にする既存資産は無く、fflate では zip は開けても
  WordprocessingML を描けない）。JSZip が引く readable-stream・pako 等は Node 向けの `lib/` 用で、画面は自己完結の `dist/jszip.min.js` だけを使う
- **訂正（2026-10-15、レビュー）**：幅合わせの「元の幅」を `.docx-wrapper` の `scrollWidth` で測っていた。wrapper は flex の
  中央寄せなので、ページがカードより広いと左右両側にはみ出し、`scrollWidth` には右側しか載らない——縮め足りず、左端が切れて
  横にもはみ出した（レビューの実測：カード 420px で 65px）。一番広い `section.docx` の幅＋wrapper の左右の余白で測るように直した。
  本物の `appHtml("document")` を偽の host に入れたプローブで、カード 360〜1000px のどれでもはみ出し 0・左右の余白が対称なのを確かめた
