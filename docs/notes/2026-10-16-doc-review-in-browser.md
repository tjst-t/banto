# ファイルブラウザの右側で PDF・Office を読む（2026-10-16、Backlog #341）

仕様 v4-modules.md §2.2「画面の形（改訂・2026-10-16）」の最初の項「ファイルブラウザの右側で読む」の実装。

## 決めたこと：描く道具は要るときに読み込む（最初からは入れない）

仕様は「pdf.js 等をファイルブラウザの束に最初から入れるか、要るときに Module の tool で受けて inline の `<script>` で読み込むかは
重さを測って決める」としていた。両方を作って測った。

道具の大きさ（min）：pdf.js の worker 1.26MB・本体 0.46MB・SheetJS mini 0.28MB・JSZip 0.10MB・docx-preview 0.08MB——計 2.18MB。
ファイルブラウザの画面の JS（`app.bundle.js`）は 0.14MB → 0.28MB（document の描き方の部品を足した分。道具は入れていない）。

**測り方**：E2E の core・画面を起こし（`BANTO_E2E_WORKERS=1`）、入口（Command Palette の「ファイル」）からファイルブラウザを開いて
ツリーの行が見えるまで（「開く」）、ツリーのテキストのファイル（約 30KB）を押して中身が出るまで（「テキスト」）を測った。開くのは
1回目は入口から、2〜4回目はリロードから（どちらもファイルブラウザの HTML を読み直す）。テキストは1回につき 8 回。計測の spec は
使い捨て（コミットしていない）。

| | 開く（ms、4回） | テキスト（ms、中央値・32回） |
|---|---|---|
| 変える前（main の 575e27c5） | 286・484・374・409 | 83 |
| 案 A：道具を全部ファイルブラウザの HTML に入れる | 638・820・608・609／639・721・614・604（2回流した） | 83 |
| **案 B：要るときに読み込む（採った）** | 287・425・423・421 | 83 |

案 A は**テキストしか見ないときも開くのが約 0.3 秒遅い**（HTML が 2.2MB 増え、ホストを通って運ばれ、読み込みのたびに解釈される）。
テキストを押してから出るまでは変わらない。案 B はテキストのときの重さを変えず、PDF・Office を初めて選んだときだけ道具を運ぶ。

案 B の行は、filesystem の他の spec と2本並べて流した回（`BANTO_E2E_WORKERS=2`）。変える前・案 A は1本で流した。

- PDF（1ページ、日本語の CMap つき）を押してから1ページ目の文字の層が出るまで：**初めて 469ms**（pdf.js を tool で受けて読み込む分を
  含む）、2回目から 92〜200ms（道具は読み込み済み）

## 仕組み

- Module の tool `readViewerScript`（admin）が道具の JS を名前で返す（`pdfjs-worker`・`pdfjs`・`jszip`・`docx-preview`・`xlsx`）。
  画面（`ui/libraries.ts`）が inline の `<script>` にして足す。Canvas の CSP は `script-src 'self' 'unsafe-inline'` のまま
  （外の script・blob の URL・data の URL は許していないので、それらで読む案は使えない）
- **inline の module の script には load が来ない**（Chromium で確かめた——素の Chromium に同じ CSP の頁を作り、足した inline の
  module の script に load も error も来ないことを見た）。最初は load を待って描くのが止まった（「読み込んでいます…」のまま）。
  script の末尾に「走り終えた」を知らせる1行を足して待つ。中で投げたものは window の error で拾う
- `document` の画面（showFile）とファイルブラウザは同じ面（`ui/document-screen.ts`）を使う。ファイルブラウザ側は `ui/document-pane.ts`
  がテキストのビューアと同じ口（`el`・`path`・`isDirty`・`reload`）で包む。docx を PDF にした面へ切り替えるときは、その前に pdf.js を
  読み込む
- ファイルブラウザで別のファイルを選ぶと前の面を捨てる（`destroy`）。document・window に付けた聞き手（keydown・selectionchange・
  focus）と ResizeObserver を外し、PDF は読み込みを捨てる。showFile の画面は1つのファイルしか開かないので、これまで要らなかった
- ファイルブラウザは描き直すたびに画面全体を作り直していた。中身の欄を外して付け直すと PDF のスクロールが頭に戻るので、枠
  （ツリー・中身の欄）は作り直さず、中身は同じファイルなら付け直さない
- 「AI に返す」は host が `ui/message` を受けると名乗ったときだけ。入口から開いたファイルブラウザ（会話の外）では「コピー」
- 中身の欄では document の描き方のツールバー（ファイル名・ページ・コメント）がそのまま見出しになるので、テキストのときの
  パスの見出し（`content-head`）は出さない

## 直した不具合（同じ変更の中で踏んだ）

- **pdf.js 6 の文書（`PDFDocumentProxy`）には `destroy` が無い**。PDF の面は閉じるときに `doc.destroy()` を呼んでいて、別のファイルへ
  移って初めて通り、例外（`doc.destroy is not a function`）になった。showFile の画面は1つのファイルしか開かないので今まで通らなかった。
  捨てるのは読み込みの仕事（`loadingTask.destroy()`）にした

## 試験

`BANTO_E2E_WORKERS=2 npx playwright test specs/filesystem-{browser,pdf,pdf-select,comments,docx,xlsx,office-pdf}.spec.ts`——
**15 件すべて通った（4.2 分、2026-10-16）**。ファイルブラウザ・Canvas に触る他の spec（module-launcher・module-canvas-inline・
canvas-host-styles・wide-root・module-settings-canvas）も 12 件すべて通った。

フル E2E（288 件、worker 2 本、50.3 分）：282 件通過・3 件落ち・3 件流れず。落ちた3件はこの変更と関わらない——
`browser-tabs`（タブの選ばれ方 t1/t3）・`browser-video`（動画の返事が来ない）はブラウザの Module の試験（同じ時刻に別の作業ツリー
factory-browser-video-tab-switch-no-frame がその辺りを直している）、`subagent-from-module` はこの作業の環境の HOME が深く、
Incus のデバイスのパスが長すぎて Module の置き場をマウントできなかった（`file name too long`。#340 のノートの Unix socket の件と同じ根）。
直していない（規則7）。

- `filesystem-browser.spec.ts` に「ファイルブラウザで PDF・pptx・xlsx を選ぶと、右側でそのまま読めてコメントを付けられる」を足した：
  開く前は道具が読み込まれていない／PDF のファイル名・パス・ページ数・文字・中身の欄いっぱい・コメントモードが既定でオン・余白／
  ページへのコメントと「コピー」でクリップボードに入った文／テキストに移ると PDF の面が外れる／pptx をスライドとして読みスライドに
  コメント／xlsx の値とセルへのコメント／PDF に戻るとコメントが残り、リロードしても同じファイルが開いている
- 前からある「入口から開いたファイルブラウザで…」の壊れた PDF は、名前と大きさではなく「PDF として読めませんでした」になった
