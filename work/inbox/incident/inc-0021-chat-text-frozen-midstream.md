---
id: inc-0021
type: incident
kind: incident
origin: po
class: bug
status: resolved
refs: [spec-chat-ui, spec-canvas-ui]
---

## 内容

会話の途中で**番頭の応答が数文字だけ出て止まる**。リロードすると全文が出る。ちょいちょい起きる。

同じことがツールの札でも起きていた——`worker.close` が終わっているのに「実行中」のまま。
こちらは次の行が積まれた瞬間に「完了」へ変わるので、気づきにくい形で出ていた。

**通信は止まっていない。** リロードで全文が出るのは、`history` から新しい行として作り直される
ため。止まっていたのは**描画の側**。

## 原因

`applyDelta`（`packages/banto-web/src/useBantoSession.ts`）が、届いた差分を**既存の行に
in-place で書き足していた**。

```ts
case "text_delta": {
  const last = prev[prev.length - 1];
  if (last?.role === "banto") {
    last.text += event.delta;   // ← 同じオブジェクトを書き換える
    return [...prev];           // ← 配列だけ新しくする
  }
  ...
}
```

コメントには「参照を維持（`React.memo` の最適化）」とあったが、**逆だった**。行を描くのは
`React.memo` でくるんだ `ChatRow` で、props の浅い比較で描き直すかを決める：

| props | 差分が届いたとき |
|---|---|
| `entry` | **同じ参照**（中身だけ書き換わっている） |
| `isStreaming` | 末尾の行である限り `true` のまま |
| `onDismissError` | error 行以外は `undefined` |

すべて「等しい」と判定されるので、**`ChatRow` は描き直されない**。画面に出るのは、その行が
最後に描かれた時点の文字——実質、最初の差分だけ。

その後に別の行が積まれる（ツール呼び出し・次の発話）か、`turn_end` で busy が落ちると
`isStreaming` が変わって描き直され、そこで全文が現れる。だから「ちょいちょい」——
**次に何かが起きた行は直り、起きなかった行は止まったまま**に見えていた。

`tool_end`・`reasoning_delta`・`reasoning_end` も同じ書き方をしており、同じ症状だった。

## 再現（確定）

`tests/chat-ux.spec.ts` に「届いた分がそのまま出る」を追加した。**次の行も `turn_end` も
送らずに**差分だけを流すのが再現条件（送ると別の理由で描き直されて、症状が隠れる）。

```
✖ 本文は差分が届くたびに伸びる          Received: "ブラ"（Expected: "ブランチ一覧に …"）
✖ 思考も差分が届くたびに伸びる          Received: "まず"
✖ ツールの札は tool_end で切り替わる    Received: "実行中"
✖ 考え終わった時間も、その場で出る      Received: "考えています"
```

## 対応1: 変わった行は新しいオブジェクトにする（根の対策）

```ts
case "text_delta": {
  const last = prev[prev.length - 1];
  if (last?.role === "banto") {
    return replaceLast(prev, { ...last, text: last.text + event.delta });
  }
  ...
}
```

`text_delta` / `reasoning_delta` / `reasoning_end` / `tool_end` の4か所。差し替えれば
**変わった行だけが描き直される**——それが `React.memo` の効かせ方で、参照の維持は最適化では
なく描画の抑止だった。1差分につきオブジェクト1つの割り当ては、描画を1回飛ばす損失より遥かに軽い。

## 対応2: 考え終わりは `durationMs` で決める

再現テストを書いていて併せて見つけた。思考の見出しが「考えています」のままになるのは
`isStreaming`（＝busy かつ末尾の行）だけで判定していたため——**思考は `reasoning_end` で
終わっているのに、本文を喋り出すまで光り続けていた**。`durationMs` が入っていれば
考え終わり、と決めた（`App.tsx` の `ChatRow`）。

## 確認

```
npx playwright test tests/chat-ux.spec.ts   → 23 passed（うち新規4本）
```

## 残ること

`ChatRow` が `React.memo` である限り、**行を書き換える実装は同じ症状に戻る**。回帰は上の
4本が押さえているが、`applyDelta` に手を入れるときは「行は差し替える」を守ること
（`spec-chat-ui` §2.3 に規則として書いた）。
