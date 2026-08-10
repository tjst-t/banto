---
id: inc-0048
type: incident
kind: incident
origin: agent
class: ui-behavior
status: resolved
refs: [spec-chat-ui, inc-0045, inc-0041, adr-0017]
---

## 内容

**POが読み返そうと上へ動かしたのに、しばらくすると下へ引き戻されることがある。**

`tests/chat-ux.spec.ts`「わずかに上げただけでも追従は止まる（70px の内側でも）」が
負荷のかかった全体実行で落ちた。試験は「60px 上げてから20件届いても `scrollTop` は
変わらない」を見ており、落ちたということは**貼り直しがPOの操作を潰した**ということ。

## 実測

見つけたときの姿（全体実行・128件）：**4回中1回**。単体では 0/5、ファイル単独でも 0/3
——**単体では通る**ので、P6 の「単体で通るのは無罪の証拠にならない」がそのまま当てはまる。

原因を掴んでからは、並列度を上げて**確実に再現する形**に落とせた
（`npx playwright test tests/chat-ux.spec.ts -g 追従 --repeat-each=12 --workers=8`、計84件）：

| | 落ちた数 |
|---|---|
| 直す前（猶予 400ms） | **5 / 84** |
| 直した後（掛け金） | **0 / 84** |

落ちるのは常に「70px の内側」の1件だけだった。これが手がかりになった（下記）。

## 原因

inc-0045 で入れた猶予（`packages/banto-web/src/Room.tsx`）：

```ts
const USER_SCROLL_GRACE_MS = 400;
useEffect(() => {
  if (stick.isAtBottom) return;
  if (Date.now() - lastGestureAt.current < USER_SCROLL_GRACE_MS) return;
  void scrollToBottom({ animation: "instant" });
}, [stick.isAtBottom, scrollToBottom]);
```

**猶予は「最後の仕草からの経過」で測るのに、判定が走る時刻は選べない。**
この effect は `stick.isAtBottom` が変わるたびに走る。

そして**60px 上げた状態が、ちょうど揺れる位置**だった。`use-stick-to-bottom` の
「最下部にいる」判定は 70px の遊びを持つので、60px 上げた状態は**遊びの内側**——
中身が伸びるたびに `isAtBottom` が true と false を行き来する。行き来のたびに effect が
走り、400ms を過ぎた1回で貼り直す。負荷が高いほど揺れが遅れて出るので、混んでいるときだけ
下へ引き戻された。300px 上げる試験が落ちなかったのは、遊びの外だから揺れなかっただけ。

**inc-0045 が防いだものの裏返し。** あちらは「追従が勝手に切れる」、こちらは
「切れたままでいてほしいのに繋ぎ直される」。同じ穴の3つ目の面（inc-0041・0045 に続く）。

## 直したこと

**時間ではなく掛け金（latch）で持つ。** いつ判定が走っても答えが変わらないようにした。

- 掛かる条件：**器が実際に上へ動いたとき**（`scrollTop` が下がったとき）。
  inc-0045 の誤読では `scrollTop` が一度も下がらない——追従は代入するだけなので値は
  増える方向にしか動かない。POが上げたときだけ下がる。これで2つの「切れた」が見分く
- 外れる条件：**本当に最下端まで戻ったとき**（`scrollHeight - scrollTop - clientHeight <= 1`）。
  **ライブラリの `isAtBottom` では外さない**——70px の遊びがあるので、60px 上げて
  読んでいる最中に「最下部にいる」と読んで掛け金がその場で外れる。
  最初この条件で書いて 6回中1回まだ落ち、そこで気づいた
- 仕草のハンドラ（`onWheel` / `onPointerDown` / `onTouchStart` / `onKeyDown`）は要らなく
  なったので外した。見ているのは器が動いたかどうかだけ

`USER_SCROLL_GRACE_MS` は消えた。

## 確かめたこと

- 上の実測表（84件 × 2）
- 掛け金の意味を固定する試験を3つ足した（`tests/chat-ux.spec.ts`）：
  **何度届いても戻らない**（時間で緩まないこと）・**触っただけでは止まらない**
  （押す・選ぶで掛からないこと）・**自分で最下端まで戻すとまた追いかける**（外れること）。
  ただしこの3件は**直す前でも通る**——時間で緩む不具合は `isAtBottom` が揺れないと出ない
  ので、意味を書き留める役で、再現の役はしていない。再現の役は「70px の内側」が担う

## 余談：この件を追う途中で気づいたこと

`npm run build:web` が**失敗しても気づけない形で失敗していた**。
`packages/banto-web/node_modules/.vite` と `.vite-temp` が root 所有で作られており
（2026-08-10 09:08、meta/environments.yaml の dev プロファイルが root で走った跡）、
vite が設定ファイルを書けず EACCES で落ちていた。**古い束をそのまま試験していた**ので、
直したはずのものが直っていないように見えた。`sudo rm -rf` で消して復旧。

dev プロファイルがリポジトリを root で汚す件は inc-0049 に分けた。
