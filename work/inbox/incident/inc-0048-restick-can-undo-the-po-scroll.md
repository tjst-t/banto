---
id: inc-0048
type: incident
kind: incident
origin: agent
class: ui-behavior
status: open
refs: [spec-chat-ui, inc-0045, inc-0041, adr-0017]
---

## 内容

**POが読み返そうと上へ動かしたのに、しばらくすると下へ引き戻されることがある。**

`tests/chat-ux.spec.ts`「わずかに上げただけでも追従は止まる（70px の内側でも）」が
負荷のかかった全体実行で落ちた。試験は「60px 上げてから20件届いても `scrollTop` は
変わらない」を見ており、落ちたということは**貼り直しがPOの操作を潰した**ということ。

## 実測（2026-08-10）

| 走らせ方 | 結果 |
|---|---|
| 全体（`npx playwright test`、128件・並列） | **1 / 4 で失敗** |
| `tests/chat-ux.spec.ts` だけ（36件） | 0 / 3 |
| この1件だけ | 0 / 5 |

**単体では通る。** 並列で他のファイルと一緒に走っている——つまり CPU が競っている
ときだけ出る。P6 の言う「単体では通るは無罪の証拠にならない」がそのまま当てはまる。

## 疑っている機構

inc-0045 で入れた猶予（`packages/banto-web/src/Room.tsx`）：

```ts
const USER_SCROLL_GRACE_MS = 400;
useEffect(() => {
  if (stick.isAtBottom) return;
  if (Date.now() - lastGestureAt.current < USER_SCROLL_GRACE_MS) return;
  void scrollToBottom({ animation: "instant" });
}, [stick.isAtBottom, scrollToBottom]);
```

猶予は**最後の仕草からの経過**で測っているが、**判定が走る時刻は制御できない**。
この effect は `stick.isAtBottom` が変わるたびに走るので、POが上げてそのまま読んでいる
最中に `isAtBottom` が一度でも揺れると、そのときには 400ms を過ぎていて**貼り直す**。
負荷が高いほど描画と `isAtBottom` の更新が遅れるので、揺れが猶予の外へずれ込む。

つまり inc-0045 が防いだ「追従が勝手に切れる」の裏返しが残っている
——**「切れたままでいてほしいのに繋ぎ直される」**。同じ穴の3つ目の面（inc-0041・0045 に続く）。

## 直し方の見当（未着手）

時刻ではなく**状態**で持つのが筋に見える。「POが自分で上げた」を掛け金（latch）にして、
最下部へ戻る・↓ボタンを押すまで下ろさない。そうすれば判定がいつ走っても答えが変わらず、
負荷で結論が変わることも無くなる。

**この起票時点では直していない。** 記憶の区画を幹へ移す作業（ADR-0003 追補）の
スコープ外で、inc-0045 のトレードオフを引き直す変更になるため（P1）。

## 影響

pre-release。POには「読み返していたら下へ飛ばされた」として現れる。
頻度は上の実測どおり、機械が忙しいときに限られる。
