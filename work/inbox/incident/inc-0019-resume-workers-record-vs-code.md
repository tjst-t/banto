---
id: inc-0019
type: incident
kind: incident
origin: agent
class: spec-drift
status: open
refs: [inc-0018, imp-0017, task-0057, bin-ts-resumeWorkers]
---

## 内容

`resumeWorkers()` について、**記録と実装が食い違っている**（P3）。

- `inc-0018` は status `resolved`、resolution に「`resumeWorkers()` を無効化（空オブジェクト返却）」と書き、コード片まで載せている
- しかし `packages/banto-host/src/bin.ts` の `resumeWorkers()` に `return {}` は無く、**閉じた職人の復帰は動いている**
- 実装にあるのは `imp-0017` 案3 の 30 秒フィルタだけ。これは `inc-0018` 自身が「44 件すべてが 30 秒より古く、フィルタを素通りした」と書いている、効かなかった方の対策である

つまり `inc-0018` が「効かなかった」と結論した対策だけが残り、「代わりに入れた」と書いた対策は入っていない。

## 確認したこと

2026-08-03 に `banto.service` を再起動したところ、起動時に数十件の `worker resumed` がログに出て、HTTP が待ち受けるまで 40〜80 秒かかった。復帰処理は現に動いている。

```
[banto] [resume]: worker resumed (sessionId=..., taskId=post-restart-healthcheck)
[banto] [resume]: worker resumed (sessionId=..., taskId=imp-0017-implementation)
...
```

## なぜ問題か

`inc-0018` の再発条件がそのまま残っている。閉じた職人が履歴に溜まった状態で再起動し、そのうち1つでも `system.restart` を呼ぶタスクを持っていれば、再び無限再起動ループに入る。30 秒フィルタは「閉じた直後の1周」しか断てない。

いまループが起きていないのは、`imp-0017` の応急処置で `worker-events.jsonl` から `worker_closed` を削除し、復帰対象を空にしたためであって、コードが直ったからではない。履歴が溜まればまた同じ状態になる。

副作用として、起動時の復帰処理が終わるまで HTTP が待ち受けないため、再起動のたびに 1 分前後アクセスできない。

## どちらに寄せるかは未決

- **記録に寄せる**（`resumeWorkers()` を無効化する）: `inc-0018` の resolution どおり。ただし再起動をまたいだ職人の継続は失われる
- **実装に寄せる**（`inc-0018` の resolution を訂正する）: 30 秒フィルタだけが対策である旨に書き換え、根本対応は `imp-0017` に残す

いずれにせよ**根本原因（復帰した職人がホスト自身を再起動しうる）は未解決**。`system.restart` を持つ職人を復帰対象から外す、復帰を明示操作にする、といった案は `imp-0017` の候補に含まれている。

## 備考

30 秒フィルタ自体は無害なので、コードはそのままコミットした（`bin.ts` に上記の限界をコメントで明記）。この incident はどちらへ寄せるかの裁定待ち。
