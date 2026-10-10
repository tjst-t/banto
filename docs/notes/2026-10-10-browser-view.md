# Browser の人の画面（Backlog #242）——作りながら測ったことと、選ばなかった形

2026-10-10。決まったことは `docs/specs/v4-modules.md` §4.1「人の画面で決めたこと」。ここは経緯。

## 測ったこと（この Project のコンテナ、chromium-headless-shell 1234・Playwright 1.62.1）

小さなスクリプトで CDP を直接叩いた（30秒で答える観測、規則15）。

| 問い | 結果 | どう効いたか |
|---|---|---|
| `Page.startScreencast` を張ると最初の1枚は来るか | **来ない**。動かないページは 1 秒待って 0 枚。DOM を1回変えると1枚、16ms ごとに変えると毎秒30枚（`everyNthFrame: 2`） | 張って 150ms 来なければ `Page.captureScreenshot` で1枚撮って送る。開いた画面には最後の1枚を先に出す |
| ページの大きさを変えると、張ったままの screencast はどうなるか | 1枚来るが、頭（`deviceWidth`）は前の 1280 のまま。張り直すと 390 で来る | 大きさが変わったら張り直す（絵の頭の大きさと `viewportSize()` が違えば張り直す・AI の `resize` と「画面に合わせる」でも張り直す） |
| `Input.dispatchTouchEvent` はタッチのエミュレーション無しで押せるか | **押せる**（`pointerdown`→`touchstart`→`mousedown`→`click`）。上へなぞると `scrollY` が 462 進んだ | `Emulation.setTouchEmulationEnabled` は入れない（入れるとページから見える `maxTouchPoints`・`pointer: coarse` が変わり、AI が見るページまで変わる） |
| `Input.insertText` と `dispatchKeyEvent` で入力欄に入るか | 入る（`insertText("あいう")`＋ keyDown `a`＋ rawKeyDown `Backspace`＋ keyDown `b` → `あいうb`） | 変換を終えた文字は insertText、それ以外はキー |

## レビューで直したこと（2026-10-10）

- **1 MiB の保証が無かった**。§4.1 は「1枚が 1MiB を越えないよう Module が抑える」と決めていたのに、上限は画面とページの大きさ
  だけで、AI が `resize` で 2560×1440 にすると越えた。さらに静かなページ向けの最初の1枚（`captureScreenshot`）は上限を見ずに
  ページ全体の大きさで撮っていた。越えると host が 1009 で閉じ、stream-client は 4404 以外は繋ぎ直すので、画面は
  「繋ぎ直しています…」のまま理由が人に届かなかった（規則2）。測り直した（chromium-headless-shell、画質70）：

  | ページの大きさ | 文字の多いページ | 雑音 |
  |---|---|---|
  | 1280×800（1.02 メガ画素） | 335KiB | 464KiB |
  | 1600×1000（1.60） | 530KiB | 725KiB |
  | 1920×1080（2.07） | 684KiB | 940KiB |
  | 2560×1440（3.69） | 1227KiB | 1668KiB |

  雑音でも 3 割の余りが残る 1.6 メガ画素を上限にし、最初の1枚も同じ倍率で撮り、それでも越えた絵は送らずに理由を出す。
  `clip` は `{x:0,y:0}` だとスクロールした位置ではなくページの先頭を写した（実測）ので、visual viewport の `pageX`・`pageY` から切る
- **「画面に合わせる」がタブの無いうちは効かなかった**。携帯で開くと最初はタブが無く、人は先に切り替えを入れてから URL を打つ。
  切り替えは入ったまま新しいタブは 1280×800 で開いていた（見えている切り替えが効いていない、規則13）。タブができた・切り替わった
  ときにも効かせ、切ったら合わせたタブを全部戻す
- **画面の操作の列を E2E で通していなかった**（URL 欄・戻る/進む/読み直し・タブの ＋/切り替え/×・「ブラウザの記録を消す」）。
  単体試験は流れのメッセージから先しか見ていない。成功したときにだけ現れるもの（タブの題・URL 欄・絵の data-tab・通信の件数）で待つ

## 選ばなかった形

- **画面ごとに CDP の screencast を張る**：画面の数だけブラウザが JPEG を作る（動くページで1本 CPU 約70%、§4.1「実測」）。
  1本を張り、画面ごとの流量は画面の `ack` で絞る形にした
- **CDP への受け取りの印を、画面が描き終えるまで遅らせる**：画面が複数あると誰に合わせるかが決まらず、§4.1「実測」のとおり
  遅らせても枚数は下がりきらない。CDP にはすぐ返し、間引きは `everyNthFrame` に任せた
- **キーを canvas で受ける**（パソコン）：canvas は変換（IME）を受けないので日本語が打てない。パソコンも携帯と同じ隠した入力欄で
  受け、変換を伴わないキーだけをキーとして送る
- **人の操作（URL・戻る・タブ）を admin の道具で**：画面からは流れがすでに開いているので、流れのメッセージにした（道具を増やさない）。
  通信とコンソールの欄・HAR・記録を消す・「AI に触らせない」は、結果を読む・確かめる操作なので道具のまま
- **帯に Thread の名前を出す**：host の刻印（`dev.banto/thread`）は id だけで、Module も画面も名前を引く口を持たない。
  id の頭8字と「その会話を開く」（`dev.banto/open-surface`）にした。名前を出すかは §4.1「まだ決めていない」に置いた

## 閉じても screencast が止まらなかった1回（原因は絞れていない）

E2E の4回目までのうち1回、画面を閉じた（流れが 1001 で閉じ、Module も「いま 0 本」と書いた）のに、20 秒たっても
`getBrowserStatus` の `view.screencasting` が true のままだった。張り直しは1つずつ流す（`reconcile` の鎖）ので、鎖の中の
CDP の呼び出しが1つ返らないと、後ろの「止める」が永久に走らない形になっていた。直前は AI の `reload` と、画面の大きさの
変化（「AI に触らせない」の注意書きが出て消えた）による張り直しが重なっていた。同じ重なりを 30 秒のプローブで10回作っても
0/10 で、どの呼び出しが返らなかったかは分からなかった（規則6・規則1——測る前に犯人を決めない）。

入れたもの：鎖の中の CDP の呼び出し（口を開く・`startScreencast`・`captureScreenshot`・`stopScreencast`・口を閉じる）を
1つ 5 秒で打ち切り、何が返らなかったかを Module のログに書く。張りかけで失敗したら張りかけを止めて捨てる（残すと「同じ形で
張ってある」と見て直らない）。入れたあとの E2E では 5 回流して 5 回通り、「返りませんでした」は1度も出ていない。起きたら
Module のログの「…が 5000ms 返りませんでした」で、どの呼び出しかが分かる。

## E2E で踏んだもの

- 会話のカードは、カードそのものではなく「開く」のボタンで開く
- 新しいブラウザの文脈（携帯）は `openApp` で繋ぐ先（core）を先に渡す——無いと既定のポートへ繋ぎに行き、Canvas が出ない
- 携帯のエミュレーションでは、見えている範囲（visual viewport）が Page の座標から 19px ずれていて、`boundingBox` から
  `touchscreen.tap` した点が絵の上の入力欄から外れた（画面の不具合ではない——人は見えている所を押す）。絵の要素からの位置
  （`locator.tap({ position })`）で押す
- `--repeat-each` で繰り返すと、同じ worker が spec を読み直さずに回るので、決まった Project の名前で id を引くと前の回の
  Project を引いた（前の回のコンテナにページを立てようとしてポートが塞がり、タブが `chrome-error://`）。名前に回の番号を入れた

## 確かめたこと

- 単体（`packages/modules/browser/src/view.test.ts`）：本物のブラウザと偽の流れの相手で、印が返るまで次を送らない・返すと
  最新の1枚（番号が飛ぶ）・入力（マウス・insertText・キー・タッチ）がページに届く・AI の click が『送る』と枠と Thread を知らせる・
  2つ目の画面の「画面に合わせる」と閉じたときに戻る・裏に回ると止めて前に戻ると映す・閉じると止める。5回流して5回通った
- E2E（`banto/e2e/specs/browser-view.spec.ts`）：カードから開く・人の入力・通信とコンソールの欄・AI の帯と枠・HAR・
  「AI に触らせない」・閉じると止まる・入口から開く・携帯。`--repeat-each=3` で 3/3、単独で 1/1、`browser.spec.ts` と一緒に流して両方とも通った
  （フル E2E は流していない——ユーザー指示）
- レビューのあと：単体 26/26（足した4件——画素数の上限・2560×1440 で screencast の絵も最初の1枚も上限と 1 MiB に収まる・
  越えた絵は送らず理由を1度だけ・タブの無いうちに入れた「画面に合わせる」が URL 欄と ＋ のタブに効き、切ると全部戻る——は
  5回流して5回通った）。E2E は画面の操作の列を足して browser-view 4/4（単独・browser.spec.ts と一緒・`--repeat-each=2`）、
  browser.spec.ts 1/1

## 追記（2026-10-10、Backlog #257）：reCAPTCHA の枠が人の画面に映らない／名乗りと言語

### 映らなかった理由——別プロセスの iframe ではなく、`everyNthFrame: 2`

見立ては「screencast が別プロセスで描かれる別サイトの iframe（OOPIF）を合成しない」だった。測ったら違った：

- 別サイトの iframe（127.0.0.1 のページの中の localhost、github.io のページの中の google.com の reCAPTCHA）は、
  headless-shell の screencast にも描かれていた（素の CDP で、screencast の1枚と `captureScreenshot` が同じ）
- google.com/sorry の reCAPTCHA の iframe（`www.google.com/recaptcha/enterprise/anchor`）は親と**同じサイト**で、そもそも別プロセスではない
- 本物の `BrowserView`（偽の画面が印を返す）で google.com/sorry を開き、7秒後に画面が受けた最後の絵と `captureScreenshot` を
  画素で比べた：最初に開いたときに、**枠はあるが中の文字（I'm not a robot）が無い絵のまま止まる**のが 9回中6回。
  `everyNthFrame: 1` にすると6回中0回。iframe の中の文字（web フォント）の描画が、ページが静かになる前の最後の1枚で、
  2枚に1枚を捨てるとそれが捨てられることがある。静かなページはそのあと絵を出さないので、古い絵のまま残る
- 試験用のページ（`/frame`、別オリジンの iframe が読み終えて少し後と押すたびに1度だけ色を変える）で単体の試験を作り、
  `everyNthFrame: 2` で5回中5回落ち、`1` で通ることを確かめた

却下した案：(a) 通常の Chromium の `--headless=new` に替える（重い——760MiB 対 400MiB。原因が OOPIF でないので効く理由も無い）、
(b) サイトの分離を切る（安全が下がる。同上）、(c) screencast をやめて `captureScreenshot` を間引いて流す（撮るたびに全面を
符号化するので重い）、(d) `everyNthFrame: 2` のまま、絵が止まってしばらくしたら1枚撮り足す（直るが、止まったかの判定と
撮った絵と screencast の絵の順序の扱いが増える。間引かないほうが単純）。

費用：動き続けるページ（回る四角）で、毎秒 30 → 60 枚、ブラウザの CPU は 120% → 140〜160%（`ps` の秒単位の粗い計測）。
画面が開いていてページが動き続けている間だけ。

### 名乗りと言語（ユーザー決定）

- Playwright の `userAgent` は User-Agent を変えるが、Client Hints の brands（`HeadlessChrome`）は変えない
  （Playwright が作る `userAgentMetadata` に brands が無い）。`locale` は Accept-Language を `ja-JP` だけにする
- 引数 `--user-agent`・`--accept-lang` はブラウザ全体に効く（Worker・ポップアップの最初の要求も）。brands と Intl のロケールは
  タブごとの CDP（`Emulation.setUserAgentOverride` の `userAgentMetadata`・`setLocaleOverride`）でしか変えられない
  （headless-shell に brands を変える引数は無い——`--product-version` も効かなかった）
- タブごとの CDP はポップアップの最初の1件の要求に間に合わず、その `Sec-CH-UA` には `HeadlessChrome` が残る。
  ブラウザ全体の自動接続（`Target.setAutoAttach` で止めて効かせてから走らせる）なら塞げるが、Playwright も同じことをしていて
  食い合うので、ここではやらない（仕様の「届かないところ」）
- 版は `--version` でブラウザに聞く（起こす前に要る——引数に入れるため）。User-Agent の形は Linux の Chrome の形で、
  headless-shell の名乗りから `Headless` を除いたものと同じ

### 間引くのをやめたら表に出た2つ（同じ日、Backlog #257）

- **絵の頭の大きさが、縮めた絵の大きさになることがある**：単体の「大きなページ」（2560×1440 を 1685×948 に縮めて流す）が
  20回中12回落ちた。screencast の絵に付く `metadata.deviceWidth`・`deviceHeight` が、ときどき 2560×1440 ではなく 1685×948 を
  返していた（素の CDP の小さな試しでは20回で出ず、`BrowserView` の経路で出た）。`everyNthFrame: 2` でも20回中2回出ていた
  ——間引いていて最初の1枚が捨てられることが多く、隠れていた。頭は張ったときのページの大きさにした（張ったままの screencast は
  その大きさの絵を出す、§4.1）。直した後 20回中0回
- 単体の「流れ」が、携帯の画面を裏に回した直後に `screencasting` を読んで、15回に2回ほど false を見た。見ている画面が変わると
  上限が変わって張り直すので、止めてから張るまでの間を読んでいた（機構の不具合ではなく試験の読み方）。張られるまで待つ形に
  直し、フルの単体を15回流して15回通った
