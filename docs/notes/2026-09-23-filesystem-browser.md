# FileSystem のファイルブラウザを本実装にした——モックと同じ機能まで（2026-09-23）

## 何を頼まれたか

「FileSystem は AI 向けの読み書きの tool だけでなく、利用者向けのリッチな
FileBrowser・Viewer を期待している。Viewer は別 Module のほうがいいのか」。
続けて「モックでかなり作り込んでいるので、まずはそれと同等の機能を」。

モックの該当部分は `mock/components/banto/canvas/file-explorer-view.tsx`
（2ペインのブラウザ）と `file-preview.tsx`（プレビュー・編集）、
`canvas-content.tsx` の `FsEditDiffView`（editFile の差分カード）。

## Viewer を別 Module にするか（別にしない、と答えた）

ユーザーと確認して「いまは FileSystem の中」に決めた。理由は MCP Apps の形そのもの：

1. **tool の画面は、その tool を持つサーバの `ui://` に限られる。** `editFile` の差分カードや
   `listDirectory` の画面は FileSystem の画面でしか出せない
2. **別 Module がファイルを読むには、中継（初回承認・依存の宣言）か、同じ根への二重の閉じ込めが要る**
3. **画面は自分のサーバの tool しか呼べない。** ブラウザから別 Module の Viewer へ渡すには
   「別の Module の画面でこれを開く」口を core に新しく作ることになる（名前はあるが——
   OS の「プログラムから開く」——いま作る理由が無い）
4. 描画は sandbox の iframe の中で行われる。リッチにしても閉じ込めの面（Landlock された
   プロセス）は広がらない——「セキュリティ上大事な Module が重くなる」は当たらない

**見直すのは2つ目の Module が同じ中身を見せたくなったとき**。候補はもうある——skills は
`SKILL.md` を `<pre>` のまま出している。本命は C14（AI が任意の Module の資源を
`resource_link` で指し、人が開く、Phase 2.5）。そのときの第一候補は「描画の部品をライブラリに
切り出し、各 Module が同梱する」（2本目の Vault のときに `@banto/vault-kit` を切り出したのと同じ形）。
そのために、描画の部品（`src/view/`）は FileSystem の tool を知らない形にしてある。

## 画面の作り方——依存を足さずに、TypeScript で書く

いままでの Module の画面は、HTML の文字列の中に JS を直接書いていた（依存なし）。
ファイルブラウザ＋プレビュー＋編集の量では、型も試験も効かない。

- **esbuild 等はこのリポジトリに無い**（確認した）。足すと共有の `node_modules` と
  lockfile に手が入り、他の作業とぶつかる
- **採った形**：`src/ui/` を tsc で CommonJS に出し、`scripts/bundle-ui.mjs`（小さな require の
  繋ぎ、browserify と同じ形）で1本にまとめ、`ui-app.ts` が HTML に埋める。**相対の require しか
  許さない**——npm のパッケージを画面に持ち込みたくなったら、この仕組みではなく道具ごと入れる
- 純粋な部品（`src/view/`・`src/unified-diff.ts`）は DOM に触らないので、node の試験から直接読める
- 却下：`outFile` ＋ AMD（TypeScript 6 で廃止予定の道）、1ファイルに全部書く（量的に無理）

**Markdown はライブラリを使わず、よく使う書き方だけを自前で描く。** ライブラリ（marked 等）は
上の組み立てでは持ち込めない。**生の HTML は必ずエスケープする**——この画面は自分の Module の
書き込み・削除を呼べるので、中身に紛れた `<img onerror>` が走れば人の操作なしにファイルが消せる。
書き方が増えて手に余ったら、組み立ての道具とライブラリを一緒に入れる。

## 踏んだもの

### readFile のバイナリが規格外の形だった

`{type:"resource", data, mimeType}` を返していた。MCP の embedded resource は
`{type:"resource", resource:{uri, mimeType, blob}}` で、SDK の検査を通らない形だった
（PDF をプレビューしようとして発覚）。直した。

### `.csv` が base64 で返っていた

拡張子の表（TEXT_EXT）に無いものは一律にバイナリ扱いだった。表に無いものは中身で決める形に
した（NUL を含むか、UTF-8 として壊れていればバイナリ）。

### editFile が前後の全文を返していた

`{before, after}` を JSON で返していて、AI の文脈に同じファイルが2回載っていた。MCP 公式の
filesystem リファレンス実装と同じく unified diff を返すようにした。差分は Myers 法
（`diff`・git の既定と同じ）で、依存は足していない——画面側にも同じコードを持ち込むため。

### ダウンロードの確かめ方と、試験が「一時的な操作の印」を立て続けていたこと

画面は sandbox の中で保存させられないので、MCP Apps の `ui/download-file` を host（banto）に
受けさせた（`allow-downloads` をサンドボックスに足すと、どの Module も黙って保存させられる）。
仕様は「host は確かめるべき（SHOULD）」と言うので、**人が画面の中を押した直後
（transient user activation）なら確かめず、そうでなければ banto の画面で確かめる**形にした。

実測（2026-09-23、Chromium・Playwright 1.62）：

- 印の寿命は約5秒。**入れ子の別オリジンの iframe の中の生のクリックでも、親（banto の画面）に
  印が立つ**（単独のプローブで、生のマウス入力だけを使って確認）
- **Playwright の操作・検査はそれ自体が印を立てる**（`boundingBox()` ですら）
- さらに、前の spec（`error-surfacing`）の後に走らせると、**何も操作していない17秒の間ずっと
  印が立ったまま**だった（単独なら5秒で切れる）。原因は Playwright／Chromium の側で、特定していない

最初の E2E は「印が切れるまで待ってから頼ませる」形で、単独では通り、フルでは落ちた
（2回中2回）。**待ちを延ばす形では直らない**（規則6）ので、試験の中だけ
`UserActivation.prototype.isActive` を差し替えて「切れている」を作る形にした。本物のクリックが
印を立てることは上のプローブで別に確かめてある。

## モックと違うところ（意図して、または持ち越し）

| モック | 本実装 | 理由 |
|---|---|---|
| AI の readFile が fullscreen でプレビューを開く | **開かない** | AI は FileSystem の `readFile` でしか読めない（組み込みの Read は無い）。画面を付けると読むたびにカードが出る。AI が人にファイルを見せる口は**未決**（新しい tool か、C14 の `resource_link` か——人に上げた） |
| PDF・画像はプレースホルダ | 画像は本物を描く。PDF は名前と大きさ | PDF は Canvas の CSP が frame/object を塞いでいて埋め込めない（仕様は「埋め込みビューア」——食い違いとして記録し、人に上げた） |
| 開いたファイル・フォルダが URL に残る（戻る／進む） | 画面の中だけ | 画面は sandbox の中で banto の URL に触れない。要るなら host の口が要る |
| Command Palette から名前で探して開く | 無い | host 側の `completion/complete` が未実装（どの Module にも無い）。開く先を画面に渡す口も無い |
| フォルダを押すと右の中身が空になる | 開いているファイルはそのまま | URL にファイルとフォルダを片方ずつ持つモックの作りの副作用で、意図ではないと判断 |
| 設定「バイナリファイルの扱い」 | 無い | モックの固定値だけで、何を変える設定かが決まっていない |
| 足したもの | 保存していない編集があるうちは別のファイルへ移らない・同じ名前は作らない・アップロードで上書きになるものを先に示す・大きすぎるファイルは中身を取りに行かない | 黙って失う・壊すを作らない（規則2） |

## 追記：人が決めた2つ（2026-09-23）

上で人に上げた2つに答えが出た。

- **AI が人にファイルを見せる口 → `showFile` を足す。** `readFile` には画面を付けない
  （読むたびにカードが出る）。中身は返さない——読むなら `readFile`。既定は会話の中の
  カードで、大きく開くのは頼まれたときだけ（`listDirectory` の `displayMode` と同じ形）。
  モックの `banto.fs:preview:<path>`（ツリーを畳んだブラウザでそのファイルが開く）を、
  大きく開いたときの見せ方にそのまま使った。会話の中のカードは、モックに無かったので新しく作った
  （ファイルブラウザと同じ Viewer を、見出しと「大きく表示」つきで入れただけ）
- **PDF → 当面このまま**（名前と大きさ＋ダウンロード）。

**要件 C14 との関係**：C14 は「AI に画面を開けと言わせない。指すだけにする」。`showFile` の
既定（会話の中のカード）は「指し」にあたり、勝手に画面は飛ばない。大きく開くのは
`displayMode` を渡したときだけで、これは 2026-09-07 に `listDirectory` で決めた形と同じ
——人の「大きく見せて」に AI が応えるための口。

## 追記：見ている場所を預ける・切り替えと編集を1行に・「File」で引ける（2026-09-23、ユーザー要望）

- **ファイルを開いたまま「別タブで開く」と、別タブでは最初の画面に戻っていた。** 画面の状態は
  iframe の中にしか無く、banto の URL に出ていなかった（モックは URL に `fsFile` を持っていた）。
  MCP Apps には状態を host に預ける口が無い（OpenAI Apps SDK の widget state にあたるもの）ので、
  banto の拡張 `dev.banto/view-state` を足した——画面が通知で預け、banto は URL の `canvasView` に持ち、
  開き直したら `hostContext` で返す。リロードで最初に戻る問題（上の表の持ち越し）も同時に解けた。
  - **踏んだもの**：URL の書き換えに `history.replaceState(history.state, …)` を使ったら、
    `history.state` に入っている Next の内部の印（`__NA`）を見て Next が「自分の操作」と扱い、
    `useSearchParams` に反映しなかった。「別タブで開く」は `useSearchParams` から URL を組むので、
    古い場所を運んだ。第1引数を `null` にして直した（Next は自分の内部の状態を写し直す）
  - 却下：`ui/update-model-context` の `structuredContent` に載せる——それは AI の文脈に入れる
    ためのもので、意味が違う
- **「プレビュー／ソース」と「編集」を1行に**した。2段だと中身に使える高さが減る。
- **Command Palette で「File」と打っても入口が引ける**ようにした。入口の名前（「ファイル」）だけで
  絞っていた。名前・説明・Module の名前（`filesystem`）で引き、Module の名前は項目の下に出す
  （なぜ当たったかが画面で分かる）。


## HTML のプレビューで JS を走らせる（2026-09-25、ユーザー）

ユーザー：「`~/site/llm-explained.html` をプレビューで見ると JS が動いていない。ダウンロードして開くのと表示が変わる。
同じであってほしい」。原因は 2026-09-23 の決定そのもの——`sandbox=""`（スクリプトも同一オリジンも与えない）。

**`sandbox="allow-scripts"` に変えた。** 以前 JS を止めた理由は「画面は自分の Module の書き込み・削除を呼べるので、
中身に紛れたスクリプトを走らせない」。確かめたこと：

- 同一オリジンを与えなければ、中身は不透明なオリジンで走る——画面の DOM にも JS にも触れない
- 上へ送る postMessage は、どの層も送り手の窓を確かめて捨てる：この画面（`ui/protocol.ts`：`window.parent` だけ）・
  中継（`sandbox-server.ts`：banto の画面か内側の iframe だけ）・banto の画面（ext-apps の `PostMessageTransport` は
  `event.source` を確かめる）
- srcdoc の iframe は親の CSP を継ぐ——`connect-src 'none'` で通信は止まる（E2E で `securitypolicyviolation` を確かめた。
  CORS で落ちたのと区別するため）
- 人がダウンロードして開けば、同じ JS がもっと強い権限（`file://`）で走る。プレビューのほうが狭い

**却下した案**：`allow-same-origin` も足す——中身が画面と同じオリジンになり、画面の DOM と口（書き込み・削除）に
そのまま届く。`allow-popups`・`allow-forms`・`allow-modals` も足していない（要ると分かってから）。

**残る違い**：①外のフォント・画像・スクリプトを読む HTML は CSP で止まる（今回の HTML は1枚に閉じていて当たらない）。
②幅——プレビューは左のツリーのぶん狭いので、ページが幅で切り替えるレイアウト（今回の HTML は 900px 以下で目次が上の
帯になる）は、ダウンロードして広い窓で開いたときと変わる。これは JS ではなく幅の違い。

E2E（`filesystem-browser.spec.ts` の最後）：JS が動いて中身が出ること・親の DOM に触れないこと・通信が CSP で止まる
こと・プレビューの中から削除の呼び出しを3つの窓に送っても `ui-tool-call` が1本も出ずファイルが残ること。
`sandbox=""` に戻すと「JS が動いていない」で落ちることも確かめた。
