---
id: imp-0056
title: 再起動で「最初のターン」が失われる——枝は知らせを抱えたまま黙る
status: inbox
kind: improvement
origin: 枝「枝が起動しない」(thread-105)。枝 thread-104 が thread.open のあと自力で動き出さず、PO が発話するまで数分黙っていた件の調査
refs:
  - packages/banto-host/src/server.ts
  - packages/banto-host/src/turn-guard.ts
  - packages/banto-host/src/bin.ts
  - packages/banto-host/src/thread-tools.ts
  - tests/acceptance/branch-seed-turn.spec.ts
created: 2026-08-15
---

## 何が起きたか（実測）

2026-08-15、枝 thread-104「バックログの仕組み」を `thread.open` で開いたが、枝は自力で
動き出さず、PO が枝を開いて「よろしく！」と発話するまで（数分）1本もターンが回らなかった。
記録には `知らせ[thread]`（＝`thread.open` に渡した最初の一言）だけが残り、**エラーの行も
台帳の行も無い**。

台帳（`/var/lib/banto/turns.jsonl`）と journal で時系列を取ると、原因は一点に絞れた。

| 時刻(UTC) | 出来事 |
|---|---|
| 13:59:53 | thread-104 が開かれる（ハーネス生成のログ） |
| **13:59:54** | **`banto.service` の主プロセスへ SIGKILL（status=9/KILL）** |
| 13:59:59 | 再起動（PID 2480611） |
| 14:00:04 | 会話 82 本を読み戻し |

同じ日に開いた他の枝（93/94/97/99/100/101/102/103/105/106）は**すべて「開いた時刻＝最初の
ターン開始」**（105 は 0.8 秒）で、例外は 104 の1本だけ。その1本の位置に再起動がある。
T1〜T3（知らせを枝で受ける）の改修は無罪——`routeNotice` は `source === "thread"` と
枝宛てを素通しし、`poFloor` も `chapterGate` も生まれたての枝では待たない。

## なぜ「知らせだけ残ってターンが消える」のか

`server.ts` の `deliverToThread` は **知らせを記録 → `turn_start` → `promptEvenWhileBusy`**
の順で走り、台帳の行を書く `logTurn` は **prompt が返ったあと**にしか呼ばれない。だから
プロセスがこの間に消えると、

- 知らせの行は**残る**（記録は prompt より前・即書き）
- 台帳の行は**残らない**（prompt から返っていない）
- error の行も**残らない**（catch に入っていない。プロセスごと消えただけ）

そして再起動をまたいだ回収（`bin.ts:1845` → `turn-guard.ts:50` `resumeInterruptedTurn`）は
**最後のメッセージが toolResult のときだけ** `continue()` する。104 は道具を1回も呼ぶ前に
消えたので**回収の対象外**——これがいまの穴である。

`thread.open` の `handOff`（`thread-tools.ts:190`）は fire-and-forget なので、幹の側にも
失敗は返らない。幹は「この枝はもう自分で動いています」と返して先へ進む。**機構の言うことと
実際が食い違う**（I2 として一番たちの悪い形）。

## 直す方向

1. **起動時の回収を1つ足す**（本命）。会話の記録の並びを見て「最後の記録が外から入った
   一言で、そのあとに番頭の応答が1件も無い」なら、そのターンは失われている——再送である
   ことを添えて `server.nudge` で1本だけ回す。既にある2つの回収（最後が toolResult ／
   `system.restart` を呼んだ会話）と同じ場所・同じ作法で、二重に起こさないこと。判定は
   純関数に切って試験で固める。
2. **回収したことを黙らせない**（I2）。ログと、その会話の記録に1行残す。
3. **`thread.open` の返り文の断定をやめる**。seed は fire-and-forget なので「渡した」までが
   事実。

## 分かっていないこと

- 13:59:54 の SIGKILL を誰が撃ったかは journal から追えない（`Stopping` が先に出ていない
  ＝手で `kill -9` した形）。同時刻に章畳みの直し（46f7cfb0）の反映で再起動している疑いが
  濃いが、証拠は取れていない。**「デプロイのための再起動が、開いたばかりの枝を黙らせる」**
  という筋なので、頻度は低くない。
