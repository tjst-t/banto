---
id: task-0070
type: task
kind: fix
title: 監査の事故をやり直し、宛先の無い知らせを捨てない（PO報告）
status: done
refs: [inc-0030, task-0065, task-0067]
scope:
  paths: ["packages/banto-daemon/src/daemon.ts", "packages/banto-host/src/kobo-notice.ts", "tests/acceptance/**"]
acceptance:
  - { id: a1, text: "監査人が判定を出さずに落ちても即 failed にせず、上限まで起こし直す" }
  - { id: a2, text: "上限まで駄目なら failed にし、何回試したのかを理由に残す（I2）" }
  - { id: a3, text: "やり直し後の再監査では試行回数を数え直す（別の回の事故を持ち越さない）" }
  - { id: a4, text: "ファイル取り込みのタスク（origin が無い）の知らせも会話へ届く。既定のスレッドへ返す" }
  - { id: a5, text: "番頭が積んだものは、いままでどおり積んだスレッドへ返る（取り違えない）" }
  - { id: a6, text: "npm run typecheck / npm test が通る", verify: "npm run typecheck && npm test" }
---

## 背景

PO報告。実機 `loamium/task-0001` が**監査で落ちて、黙って死んで、握り潰された**。
経緯と原因は inc-0030 に書いた。**穴は2つ重なっていた**——1回で諦めたことと、
その結果を誰にも言わなかったこと。

## やったこと

### 1. 監査の事故はやり直す（a1〜a3）

`applyWorkerEvent` で、監査人が判定を出さずに終わったら `AUDIT_ATTEMPT_LIMIT`（2）まで
起こし直す。上限まで駄目なら `failed`、理由に `(2回試行)` を付ける。

- **新しいイベント種を増やさない。** 監査を起こすたびに `audit_started` が積まれるので、
  直近の「→ auditing」の遷移から後ろを数えれば試行回数になる（`countAuditAttempts`）。
  イベントログの形は外に累積する副作用（D9 は one-way として D1 に戻す）なので、
  既にあるもので足りるなら増やさない
- **数え直しは回ごと**。`implementing → auditing`（やり直し後の再監査）で切る。
  持ち越すと、2回目の監査が1回も試されずに failed になる

### 2. 宛先の無い知らせを捨てない（a4・a5）

`kobo-notice.ts` の `if (!origin) return undefined` をやめ、**既定のスレッドへ返す**。
`origin` が付くのは `kobo.enqueue` 経由だけで、ファイル取り込み（決定64 の正規の入口）には
付かない——番頭が積んだものだけを見る形は、入口が2つある以上そもそも成り立たない。

## 途中で見つけた別のバグ（帳簿を見て気づいた）

**1回の事故で監査人が2人起きていた。** 起こし直すと工房が同じ taskId の前の1人を畳み、
その終了も Kobo へ届く——それも「事故」と数えて、もう1人起こしていた。
**いま動いている監査人の分だけ数える**ようにした（`currentAuditSessionId`）。

最初のテストは `audit_started` の数が `=== 4` になるのを待つ形で、3 から 5 へ飛んだために
落ちた。**落ちたから気づけた**——数を「以上」で見ていたら通っていた。

## 残していること（正直に）

- **`failed` になったタスクを誰が拾うかは決めていない。** いまは会話へ返るところまでで、
  番頭が積み直すか畳むかを判断する。**会話が流れると忘れられる**ので、取次へ上げる規則が
  要るかは PO 判断（inc-0030 に残した）
- 実機の `loamium/task-0001` は failed のまま。**積み直すかは PO の判断**なので触っていない
  （task-0002 が「task-0001 引き継ぎ」として既に review-ready まで来ている）
