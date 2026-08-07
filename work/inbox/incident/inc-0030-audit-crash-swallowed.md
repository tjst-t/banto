---
id: inc-0030
type: incident
kind: incident
origin: po
class: silent-failure
status: open
refs: [task-0070, task-0065]
---

## 内容

**PO報告（2026-08-07）**：「task-0001 ですが、レビューがコケたのに、黙って死んでそのまま
握り潰されてました。本当は Kobo がリトライして、それでもだめなら banto に通知すべき事案です。」

実機 `loamium/task-0001` の帳簿：

```
03:01:57  audit_started / agent_spawned
03:19:47  agent_exited
03:19:47  state_transitioned — auditing → failed
03:19:47  task_failed — audit_session_exited_without_verdict
```

**穴は2つ重なっていた。** どちらか片方でも塞がっていれば、POが手で見つけるまで
気づかれないことは無かった。

### 穴1：1回落ちただけで failed（粘る回数が逆だった）

`daemon.ts` の `applyWorkerEvent` は、監査人が判定を出さずに終わったら**即 `failed`**に
していた。一方、監査が `fail` の**判定を出した**ときは1回やり直させる
（`countConsecutiveAuditFails`）。

**逆である。** 判定を出さずに落ちるのは「判断」ではなく「事故」で、もう一度起こせば
通ることが多い。判断（監査人が「駄目だ」と言った）の方に粘る回数を与え、事故の方に
与えていなかった。

### 穴2：知らせが宛先ごと捨てられていた

`kobo-notice.ts`：

```ts
const origin = origins[`${projectTag}/${taskId}`];
// 番頭が積んだものだけを会話へ返す。PO が直にファイルを置いたものは宛先が無い
if (!origin) return undefined;   // ← ここ
```

`origin` が付くのは `kobo.enqueue` を通ったものだけ。**タスク定義ファイルを watcher が
取り込んだもの（決定64 の正規の入口）には付かない。** loamium の2本はどちらもファイル
経由で、実機の `origins` は**空**だった——`task_failed` も `review-ready` も、1通残らず
捨てられていた。

`task-0002` が `review-ready` まで来ていたことも、番頭は知らなかった。

## なぜ気づけなかったか（センサー欠落・spec-improvement-loop §2）

- **試験は `kobo.enqueue` 経由でしか知らせを見ていなかった**。`kobo-enqueue-review.spec.ts`
  はどのケースも `origin` を渡しており、**origin が無い経路を1本も通していなかった**。
  入口が2つ（Tool とファイル watcher）あるのに、試験は片方だけを通していた
- **「捨てる」が意図的なコメント付きで書かれていた**ので、読んでも穴に見えなかった。
  書いた時点では `kobo.enqueue` が唯一の入口のつもりだったが、決定64 でファイル取り込みが
  正規の入口になったときに、この行が見直されなかった

## 直したこと（task-0070）

1. 監査人の事故は **`AUDIT_ATTEMPT_LIMIT`（2回）まで起こし直す**。上限まで駄目なら
   `failed` にし、**何回試したかを理由に残す**（「1回で諦めた」と「粘って駄目だった」は別の話）
2. **宛先が無い知らせは既定のスレッドへ返す**。分からないことは、知らせなくてよい理由に
   ならない（I2）

## 残っている問い（PO判断）

- **`failed` になったタスクは、そのあと誰が拾うのか。** いまは会話へ返るところまで。
  番頭が積み直すか畳むかを判断するが、**会話が流れると忘れられる**——取次へ上げる規則が要るか
- 監査人が2回とも落ちるのは、たいてい**中身の問題**（監査の指示が大きすぎる・文脈が
  入り切らない）。回数を増やすより、落ちた理由を掴む手立ての方が効く見込み
