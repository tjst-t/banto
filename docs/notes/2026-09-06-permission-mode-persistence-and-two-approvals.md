# permissionMode が記憶されない／2回目の判断待ちが「回答済み」になる

2026-09-06、ユーザー報告2件。どちらも実インスタンスで踏んだもの。

## 1. permissionMode がリロードで消える

`lib/mock/permission-mode.ts` の Map（モジュール変数）にしか無かった。
仕様（§6.4）には「切り替えは Thread 単位・**セッション内**で効く」と書いてあり、
実装はその通りだったが、**「セッション」をブラウザのセッションと読むと、
リロード1回で `auto` に戻る**。§6.4 が「インジケータを常時表示する」と決めた
狙い——**選んだ後に忘れて事故る、を避ける**——が、そこで崩れていた。
慎重なモード（`default`）を選んだつもりで `auto` で走る、が起きうる。

### 直し方——host が持つ

ターンを実際に走らせる（`canUseTool` に効かせる）のは host なので、そこが持つ。

- `ThreadState.permissionMode?`（無ければ「選んでいない」＝カスケードから導出）
- イベント `thread.permission_mode_set`
- `POST /api/threads/:id/permission-mode`
- スナップショットの版を 3 → 4（`ThreadState` の形が変わったので、古い写しは
  読まずにログから作り直す）
- フロントの Map は host の写し。`hydrateRealProjects` で seed する

§6.4 の文言も「その Thread に残る／選んだ値は host が持つ」に改訂した。

## 2. tool 呼び出しが2回あると、答えていない判断待ちが「回答済みです」になる

前日に入れた「判断待ちのあと、普通のメッセージが届いたら `status` を running へ
戻す」（ターンが終わってもカードが答えを待ち続けるのを防ぐため）が原因。

assistant-ui は **結果の無い tool-call part の状態に、メッセージ全体の状態を
そのまま使う**：

```js
// node_modules/@assistant-ui/core/dist/utils/normalizePartStatus.js
const toMessagePartStatus = (message, partIndex, part) => {
  if (part.type === "tool-call") {
    if (part.result === void 0) return message.status;   // ← ここ
    else return COMPLETE_STATUS;
```

つまりメッセージを running に戻すと、**まだ答えていない判断待ちのカードまで
「実行中」になる**。カードは `props.status?.type === "requires-action"` で
フォームを出すので、答える口が消えて「回答済みです」の表示だけが残り、
ターンは止まったまま——誰も答えられない。

tool 呼び出しが1回だけなら、判断待ちの後にメッセージは届かないので表面化しない。
**2回目の tool_use が届いた瞬間**に1つ目のカードが死ぬ。

### 直し方

`status` を固定値で決めず、**答え待ちが1つでも残っているか**で決める
（`PartsAccumulator.hasPendingHumanTool()`）。残っている間は requires-action、
無くなったら running。真実は parts の中身1箇所（規則3）。

## 回帰（規則14）

`e2e/specs/permission-mode-and-two-approvals.spec.ts`：

- default を選ぶ → **リロード** → まだ default であること
- 2つのファイルを読ませ、**2つの判断待ちの両方に実際に答え**、
  読んだ中身（「ひとつめ」「ふたつめ」）が画面に出るまで見る

**壊した状態で落ちることを先に確かめてから**通した（規則1）：

- status を running 固定に戻す → 承認ボタンに辿り着けず 4 分でタイムアウト
- seed を外す → リロード後に `permissionMode（現在：default）` が出ず失敗

9 spec 通し ×2 回すべて通過（約57秒）。core の単体 53 件も通過。

## ついでに分かったこと（別タスクへ）

**host を再起動すると、判断待ちが永久に `live` のまま残る。**
止めているのは走行中のプロセスなので、再起動でその走行は消えるが、受信箱の
記録は生きたまま——画面には答えられるカードが出るのに、答えても続きは起きない。
いまは手で拒否して片付けている。`docs/tasks.json` の
`judgment-liveness-after-host-restart` に起票した。
