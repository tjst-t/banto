# 承認するたびに画面が落ちた——`Duplicate key toolCallId-… in useResources` の真因

2026-09-06、ユーザー報告。実 banto（4175/4737）で承認カードに答えると、
Fork Thread の画面が Next.js のランタイムエラーで落ちた。

```
Duplicate key toolCallId-toolu_01BUTfeFx6Rhi3rFzVb9kWNd in useResources
components/banto/thread/thread-panel.tsx (149:23) @ ThreadRuntime
```

**前日に「5秒ポーリングが原因」と診断して間隔を消したが、それは誤りだった**
（`2026-09-05-phase0-real-wiring-progress.md` に訂正を追記した）。
ポーリングを消した状態で再現している。「間隔を10分に延ばしたら再現しなくなった」
は、再現しにくくなっただけで犯人の証明ではなかった（規則1）。

## 真因

assistant-ui のローカルランタイムは、**run が yield した parts を、そのメッセージに
既にある parts へ連結する**。`node_modules/@assistant-ui/core/dist/runtimes/local/
local-thread-runtime-core.js` の `performRoundtrip`：

```js
const initialContent = message.content;          // run 開始時点の中身
const updateMessage = (m) => {
  message = { ...message,
    ...m.content ? { content: [...initialContent, ...m.content ?? []] } : void 0,
    status: m.status ?? message.status, ... };
```

最初の run では `initialContent` が空なので、「毎回いままでの全 parts を yield する」
累積方式（`PartsAccumulator`）が成り立つ。**ところが承認で run を終わらせて
`addResult` で呼び直すと、2回目の run の `initialContent` は1回目の全 parts になる。**
そこへ累積 parts をもう一度 yield するので、同じ `toolCallId` が2つ並ぶ
——React の key 衝突で画面が落ちる。

**この罠は `lib/mock/adapter.ts`（モック側）に実測コメントとして既に書いてあった**
（「ここで手前の parts を作り直して二重に返してはいけない」）。実データ側の
`lib/backend/adapter.ts` は逆に「accが真実だから付け直す必要は無い」と書いて
返してしまっていた。**モックで一度踏んだ穴に、本実装で作り直して落ちた。**

## 直し方——待ちの機構を host 側の1つに保つ（規則3）

判断待ちで **run を終わらせないことにした**。host は `canUseTool` を
hold-the-line で止めているだけで、答えれば**同じ SSE 接続がそのまま続く**
——止まっているのは host であって UI ではない。UI 側にもう一つ「待ち」を
作っていたのが歪みの元。

- `lib/backend/adapter.ts`：judgment で `return` していたのを `continue` に。
  以後の yield には明示的に `status: {type:"running"}` を付ける
  （ランタイムが最後に complete へ寄せるのは `status === "running"` のときだけ
  ——同ファイル `performRoundtrip` の末尾。付けないと requires-action のまま
  固まり、ターンが終わってもカードが答えを待ち続ける）
- `human-tool-card.tsx`：**実 Thread では `addResult` を呼ばない**
  （呼ぶとランタイムが run を起こし直し、上の連結が起きる）。
  答えは `sendRealAnswer` が host へ送り、走行中の parts へ書き戻す。
  台本（モック）の Thread は従来どおり `addResult` だけで完結する
- 答えた直後はまだ host から何も届かないので、カード側でも畳む
  （二重に答えられないように）

## E2E がこれを素通りしていた（規則14）

`inbox.spec.ts` は承認後の決着を **host の API** で見ていた。
`page.request` は画面の描画と無関係なので、**React が落ちてもテストは緑**だった。

足した検証：

- `page.on("pageerror")` を集め、最後に**1つも無い**ことを検査する
- 承認後に**カードが「回答：許可する」に変わる**ところまで見る

旧挙動（`return` + `addResult`）に2箇所だけ戻して測ると、この spec は
実際に落ち、`error-context.md` に `Duplicate key toolCallId-` が出る
——**捕まえられることを確かめてから**直した方を通した（7 spec 全通過・41秒）。
