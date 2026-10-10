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
