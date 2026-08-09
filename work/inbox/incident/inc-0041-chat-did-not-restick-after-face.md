---
id: inc-0041
type: incident
kind: incident
origin: agent
class: ui-behavior
status: resolved
refs: [spec-chat-ui, spec-ui, inc-0031]
---

## 内容

**設定・履歴の面から会話へ戻ると、3回に1回くらい会話の先頭のまま止まっていた。**

`tests/chat-ux.spec.ts`「設定の面から会話へ戻っても、先頭から滑り落ちない」が間欠的に
落ちていた。**測ってみたら、落ちているのは滑りではなく貼り付きそのもの**だった：

```
DIAG {"present":true,"top":0,"sh":1510,"ch":664,"contentH":1510}
SAMPLES [0,0,0,0,0,0]..[0,0,0,0]     ← 1.5 秒のあいだ 1px も動かない
```

中身は全部届いている（`scrollHeight` は成功時と同じ 1510）。`scrollTop` が 0 のまま
動かないだけ——**POから見れば「戻ったら会話の一番上に飛ばされた」**。

## 原因

面（設定・履歴・取次）は条件分岐で描いているので、会話へ戻ると `.chat-scroll` は
**器ごと作り直される**。そこを `useStickToBottom({ initial: "instant" })` に任せていた。

`initial` は **その hook が最初に中身を掴んだ1回**にしか効かない。`App` は面を開いている
間も生きているので、二度目は来ない。戻ったあとは「ライブラリ内部の at-bottom 状態と
ResizeObserver が先に動くか、描画が先か」の競争になり、負けると 0 のまま残る。

スレッドの切替には**明示的に**貼り付き直す effect が既にあった（`activeThreadId` を見る）
——同じ理屈が「面から戻ったとき」にも要ることに気づいていなかった。

## 直したこと

`packages/banto-web/src/App.tsx`。貼り付き直す場面を2つとも明示する。

```ts
const chatFace = view.face === "chat";
useEffect(() => {
  if (!chatFace) return;
  void scrollToBottom({ animation: "instant" });
}, [session.activeThreadId, chatFace, scrollToBottom]);
```

直後の実測では、以前より**1フレーム早く**貼り付く（`[0,0,845,…]` → `[0,845,…]`）。
競争していたぶんが消えた。4回連続で通ることを確認。

## 学び（inc-0031 と同じ）

**間欠的に落ちる試験は、間欠的に起きる不具合だった。** 直前まで「既存の flake」として
扱っており、実際に私の変更を外しても同じ割合で落ちていた——**落ちる原因が私の変更で
ないことは、不具合でないことを意味しない。**

診断は「失敗したときの画面の状態を1行出す」だけで足りた（中身の有無・`scrollTop`・
毎フレームの標本）。**滑っているのか動いていないのかは、標本を見るまで区別が付かない。**
