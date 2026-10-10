# Browser を画面ありの普通のブラウザにする（Backlog #259、2026-10-10）

決めたことは `docs/specs/v4-modules.md` §4.1（「形」「起こし方」「名乗りと言語」「実測」）。ここは経緯・測ったこと・却下した案。

## なぜ

#257 で headless-shell の名乗りを Chrome に揃え言語を日本語にしたが、稼働中の Google の検索はまだ reCAPTCHA の画像選びを
求めた。ユーザー：「普通に人が使っている Chromium に AI も触れるだけ。Chrome の Claude Plugin と同じ。完全に人が使っている
のと同じように動作するようにして」。

## どのブラウザか（測って選んだ）

この機械（x86_64）で、Xvfb の上で画面ありで起こして、ページから見える値を比べた。

| | Google Chrome 155（安定版） | Playwright の `chromium`（x86_64 は Chrome for Testing 151） | Playwright の `chromium-tip-of-tree` |
|---|---|---|---|
| 何か | 人が使っているもの | Chrome for Testing（自動試験向けの Chrome） | Chrome **Canary** for Testing |
| brands | `Google Chrome`・`Chromium`・GREASE | `Chromium`・GREASE だけ | （CfT と同じ系統） |
| 窓の枠 | 87px | 143px（「Chrome for Testing」の帯が常に出る） | — |
| 入れ方 | Google の apt（`playwright install chrome`、sudo） | 置き場に展開 | 置き場に展開 |

- **Google Chrome を選んだ**：brands に `Google Chrome` が入るのはこれだけで、人のブラウザと同じになる。arm64 には Linux の
  Google Chrome が無いので、arm64 は Playwright の `chromium`（arm64 では Playwright が組んだ Chromium で、CfT ではない）
- **却下**：Chrome for Testing（自動試験向けと名乗る帯が出て、brands も Chromium だけ）・tip-of-tree（Canary の CfT で不安定）・
  Ubuntu の `chromium`（snap。コンテナで使えない）

## navigator.webdriver が true になる

自分で起こして `connectOverCDP` で繋いでも、最初は `navigator.webdriver` が true だった。Playwright の仕業ではなかった——
**Chrome は CDP の口を開いて起こすと、それだけで true にする**。CDP を使わず、ページが自分の値をサーバに送る形で測った：

| 引数 | webdriver |
|---|---|
| なし | false |
| `--remote-debugging-port=0` | **true** |
| `--remote-debugging-pipe` | **true** |
| `--remote-debugging-pipe --disable-blink-features=AutomationControlled` | false |

ブラウザの機能の切り替え（`AutomationControlled`）を起動の引数で切ることにした。ページの JS を上書きする細工ではない。

## 却下した案・踏んだもの

- **窓の自然な大きさをページの大きさにする**（`setViewportSize` を使わず、`--window-size` と窓の枠を測って中身をちょうど
  1280×800 にする）：起こしてすぐ測ると、Google Chrome は窓の枠が 143px（あとで 87px に縮む）。中身が 800 から 856 に変わり、
  人の画面の絵と入力の座標がずれた（view.test の「画面に合わせる」で落ちた）。時間を置いて測る形は待ちの延長なのでとらず、
  今までどおりタブごとに `setViewportSize` でそろえる。そのため `screen` はページの大きさ（1280×800）に見える
  （Playwright の大きさ合わせが `screen` も合わせる）——ここは人のブラウザと違うまま
- **戻る・進むが時間切れ**：Playwright の launch は既定で `--disable-back-forward-cache` を付けていた。人の Chrome では
  キャッシュから戻り、`load` が来ず、`goBack` が応答を返さない（null——戻る先が無いときと同じ）。待ちを commit にし、戻る先が
  あるかは履歴で見る形にした（キャッシュは切らない）
- **最後のタブを閉じるとブラウザが終わる**：headless では残った。終わりかけのブラウザに次の操作が当たって、起こし直しと
  競った（view.test で、全部のタブを閉じた直後に開いた画面が映らなかった）。最後のタブを閉じるときは Module から止める
- **起きずに落ちる**：画面ありの Chrome は TMPDIR の下に UNIX ソケットを作る。banto が Module に渡す TMPDIR は長く、108 バイトを
  越えて落ちた。TMPDIR が長いときはブラウザに `/tmp` を渡す
- **中のサンドボックス**：この機械では AppArmor が名前空間を縛り「No usable sandbox」で落ちる。今までどおり `--no-sandbox`
  （Playwright の launch も既定で付けていた）
- **WebGL**：仮想の画面に GPU が無く、Chrome は既定でソフトウェアの WebGL を出さない（`null`）。`--enable-unsafe-swiftshader`
  で出せるが入れない（名前の通り安全でないとされる。名前の文字列も `SwiftShader` でかえって目立つ）
- **Module が SIGKILL で消えるとブラウザが残る**：パイプで繋がないので道連れにならない。`--remote-debugging-pipe` なら道連れに
  できるが、Playwright の `connectOverCDP` は WebSocket しか受けない。次に起こすときに残りを止める形にした（実測：SIGKILL の
  後に Chrome と Xvfb が残り、次の起動で両方止めてから起きた）

## Google の検索

この機械から、Module の起こし方そのまま（展開した Google Chrome 155）で https://www.google.com/?hl=ja を開いて1回検索した：
確認のページ（google.com/sorry・reCAPTCHA）にならず、検索結果が出た（2026-10-10）。IP の評判にもよるので、ほかの所で
出ないとは言えない。

## 確かめの記録（2026-10-10、引き継いだ回）

- `browser-view.spec.ts` を4回流して **3回通り、1回落ちた**。落ちたのは「9. 携帯」の、指で入力欄を押してキーボードの欄から
  「けいたい」を打つところ（送った本文が `{"name":""}`）。落ちた回は、別の作業ツリーの E2E と、止めかけの同じ spec の E2E が
  同時に走っていた。痕跡（trace）は次の回で上書きされ、原因は突き止めていない
- 同じ並び（携帯の幅に合わせる→入力欄を指で押す→insertText→「送る」を指で押す）を、Module の口（BrowserView）に直接、画面ありの
  Google Chrome 155 で8回流して **8回とも届いた**（押すと focus・click が入力欄に来る）。Module とブラウザの間では再現しない
- 直さずに残す（規則6）。また落ちたら、その回の trace で、入力欄を押した指が届いたか・キーボードの欄が focus を持っていたかを見る
