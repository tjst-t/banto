# Browser のタブを会話ごとに——測ったこと・選ばなかった案（2026-10-14、Backlog #297）

仕様は `docs/specs/v4-modules.md` §4.1「タブは会話ごと」。ここは経緯だけ。

## 裏のタブで AI の道具が効くか（実装の最初に測った）

Google Chrome 155・Xvfb（窓の管理役なし）・キオスク形の全画面の窓。人のタブを前に、AI のタブを同じ窓の裏に置いて測った。

| 見たもの | Playwright を繋いだタブ（Module の形） | 素の Chrome（CDP を直に） |
|---|---|---|
| `document.visibilityState` | `visible` | `hidden` |
| `setInterval(…, 10)` | 毎秒約100回 | 毎秒1回 |
| `requestAnimationFrame` | 毎秒60回（`background` で開いたタブは30回のことも） | 0回 |
| `<video>`（canvas の captureStream） | 2秒で2秒進む | — |
| click・type・press・scroll・hover・ツリー・評価 | 効く | — |
| `Page.captureScreenshot` | **1回目は返らない（15秒で時間切れ）、2回目からは古い絵** | 返らない |

- 差は Playwright が繋いだページ全部に入れる `Emulation.setFocusEmulationEnabled`。素の Chrome に同じものを送ると
  `visible`・毎秒100回・60回になった
- 写しは `fromSurface: false`・`captureBeyondViewport: true` でも同じ（2回目からは返るが、500ms ごとに色を替えるページで
  4回撮って4回とも裏に回った時点の色）。`Page.startScreencast` も1秒に1枚しか来ない。Chrome が窓の裏のタブを描いていない
- 別の窓（全画面で (0,0) に重なる）にした AI のタブは、隠れていても描き続け、写しは毎回いまの色・タイマーと rAF も同じ。
  `--disable-backgrounding-occluded-windows` の有る無しで変わらなかった

## 選ばなかった案

- **起動の設定だけで済ませる**（`--disable-background-timer-throttling`・`--disable-renderer-backgrounding`・
  `--disable-backgrounding-occluded-windows`）：タイマーと描画の間引きは focus emulation で既に起きていない。写しが撮れない
  原因（窓の裏のタブを描かない）には効かない
- **AI のタブを1つの「AI の窓」に集める**：2つの会話が同時に作業すると、その窓の中でまた一方が裏になる
- **写す前に毎回、人の画面のタブを裏に回す**：人の画面が替わる（決定に反する）
- **`_blank` のタブを別の窓へ移す**：CDP にタブを窓から窓へ移す口が無い。裏に回ったときだけ表に出してから写す形にした

## 仕様と違えたところ（人に上げた）

- 決定は「持ち主はプロファイルと同じく覚え、起こし直しても残す」。実際はブラウザを起こすと about:blank の1枚から起き、前の
  タブは残らない（Module ごと起こし直すときもブラウザを止めてから起こす）ので、残す相手が無い。持ち主はブラウザを止めるときに
  捨てる形にし、仕様にそう書いた。タブを残して起こす（セッションの復元）ようにするなら、そのときに持ち主も残す
