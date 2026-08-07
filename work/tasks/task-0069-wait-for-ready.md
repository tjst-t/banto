---
id: task-0069
type: task
kind: fix
title: 受け入れテストの「積んだ直後にはもう ready」という暗黙の前提を外す
status: done
refs: [task-0066, task-0068]
scope:
  paths: ["tests/acceptance/task-flow.ts", "tests/acceptance/task-flow-ready.spec.ts", "tests/acceptance/audit-fail-rework.spec.ts", "tests/acceptance/audit-session-spawn.spec.ts", "tests/acceptance/audit-verdict-routing.spec.ts", "tests/acceptance/executor-phase-tools.spec.ts"]
acceptance:
  - { id: a1, text: "queued の次に planning を叩いているテストが、ready への昇格を待つ形になる" }
  - { id: a2, text: "昇格が遅れる状況を作って、待つ形なら通り・待たない形なら落ちることを実物で見る" }
  - { id: a3, text: "時間切れのときは、待っていた状態と今の状態の両方が出る（400 だけにしない・I2）" }
  - { id: a4, text: "npm run typecheck / npm test が通る", verify: "npm run typecheck && npm test" }
---

## 背景

task-0066 が「残る弱さ」として書いていたもの。実機の検証環境（:4400）を常駐させた途端に
`audit-*.spec.ts` が 400 で落ちた。到達先を届かない先（`127.0.0.1:1`）に固定して通したが、
**前提そのものは残っていた**。

## なぜ落ちるのか（追ってはっきりした）

状態機械の表に **`queued:planning` は無い**。間に `ready` がある：

```
draft → queued → ready → planning → implementing → auditing
```

それでもテストが通っていたのは、ゲートが背景で `queued → ready` に上げていたから。
そしてその昇格は**同期ではない**（`daemon.ts:1450`）：

```ts
this.refreshEnvQuotaView().then(() => { this.runGateReeval(); })
```

**検証環境への HTTP 往復を待ってからゲートを回す**（決定60：昇格は戻せないので、古い写しで
「空いている」と読まない）。だから検証環境が遅いと昇格が遅れ、直後の `planning` が 400 になる。

到達先が届かない先なら往復は即座に失敗して返るので**たまたま速い**。つまり task-0066 の
対処は、前提を直したのではなく**前提が崩れない条件に固定した**だけだった。

## やったこと

1. `tests/acceptance/task-flow.ts`（新）。`waitForStatus` / `transition` / `advanceTask`。
   **`planning` へ進む前に `ready` を待つ**——上げるのはゲートであってテストではないので、
   明示的に `queued → ready` を叩くと背景の tick と競る
2. `queued` の次に `planning` を叩いていた7箇所を差し替え
   （audit-fail-rework ×2・audit-session-spawn・audit-verdict-routing ×2・executor-phase-tools ×2）
3. 時間切れのときは**待っていた状態と今の状態**を出す。「400 だった」だけだと、
   何を待てばよかったのかが分からない（I2）

## 確かめ方（a2）

`task-flow-ready.spec.ts`：検証環境の到達先を**わざと遅く応える本物の HTTP サーバ**にして、
昇格が確実に後になる状況を作る。3つを1つの検体で見る：

- `queued` の直後はまだ `ready` になっていない（検体が成立していること自体の確認）
- **待たずに `planning` を叩くと落ちる**（＝元の前提が壊れる条件を再現している）
- `advanceTask`（`ready` を待つ）なら通る

「直った」だけでなく「何が壊れていたか」も同じ検体に残しているので、後から前提へ戻せない。

## 触っていないもの

`kobo-*.spec.ts` は `planning` から始めており、そこへ至るまでに `kobo.enqueue` を経て
別の待ちが入っている。同じ形の穴は無いのでそのまま（P1）。
