---
id: inc-0082
kind: incident
status: open
severity: high
created: 2026-08-16
refs: [inc-0077, task-0165, task-0190, imp-0074]
---

# 工房が職人を起こせない（**工場が止まる**。本命 task-0165 が「動いているように見えて動いていない」）

## 事実（2026-08-16 08:2x〜08:3x）

### 1. 起こす口だけが通らない

番頭から `worker.delegate` を **2回**撃って、**2回とも同じ形で失敗**した：

```
Module "worker-pool" tool "worker.delegate" failed (500):
  Failed to start worker for "inv-workerpool-restarts":
  Error: [claude-agent] ホストが 10000ms 以内に応答しませんでした。
```

**一方 `worker.list` は正常に応答する。**——**工房そのものは生きていて、応答している。
起こす口（claude-agent のホストを立てるところ）だけが通らない。**

**同じ時間帯に、別の形も出ている**（他の枝の実測）：
- 08:29:00.974Z `rework session spawn failed: Failed to reach module "worker-pool" at
  http://127.0.0.1:4300/api/worker-pool/tools/worker.delegate_toolkit: Error: read ECONNRESET`
- その19分前は `audit session spawn failed: [claude-agent] ホストが 10000ms 以内に応答しませんでした`（timeout）
- `worker.close` / `worker.list` が `ECONNRESET` で弾かれ、**2回目で通った**例が複数（幹・thread-130）

**つまり「切られる（ECONNRESET）」と「10秒で応答が返らない（timeout）」の2種類が混在している。**

### 2. **職人がほぼ全滅している**

`worker.list`（稼働中のみ）で **生きているのは1本だけ**（`task-0197-direct`）。
少し前には工場の実装・監査を含めて数本走っていた。

### 3. **本命 task-0165 が、状態と実体で食い違っている**

- `kobo.task` は **`implementing`（この状態になってから45分）**
- **しかしその職人は `worker.list` に居ない**（`closed(done)` でもなく、稼働中でもない）
- **取り置き（keep）の最後の snapshot は 08:27:19**——**そこまでは生きていて、そこで消えた**
  （`banto/keep/banto/task-0165/20260816T074519Z-claude-agent`・**6枚**）

**＝ 帳簿は「作っている」と言っているが、誰も作っていない。**
**放っておくと、この状態のまま止まり続ける**（stalled の知らせは出るが、原因は「待ち」ではない）。

**幸い、成果は取り置きに残っている**（6枚）。**やり直すときは、そこから読ませること。**

## 分かっていないこと（**未確認。推測で埋めない**）

- **工房そのものが OOM で落ちて再起動したのか**。
  工房は 8 GiB の **82%**、今日の `oom_kill` は **144**（inc-0077）。**落ちていれば ECONNRESET は説明が付く。**
  ただし **`NRestarts` と journal を見ていない**ので確かめていない。
  **確かめようとしたが、そのための職人を起こせなかった**——**起こせないこと自体が、この事故の観測である。**
- **`oom_kill` 144 が「工房そのもの」なのか「中の職人の袋（`supervisor/w-*`）」なのか**の切り分けも未了。
  **子の袋ばかりなら工房は生きており、ECONNRESET の説明にはならない。**
- **timeout（10秒）と ECONNRESET が同じ根なのか**も未確認。

> **確かめるなら**（root は要らない・読むだけ）:
> ```bash
> systemctl show banto-worker-pool.service -p NRestarts -p ActiveState -p SubState -p ExecMainStartTimestamp -p Result
> journalctl -u banto-worker-pool.service --since "2026-08-16 08:00" -o short-iso | tail -60
> cat /sys/fs/cgroup/system.slice/banto-worker-pool.service/memory.events
> cat /sys/fs/cgroup/system.slice/banto-worker-pool.service/memory.events.local
> journalctl -k --since "2026-08-16 07:00" | grep -oE "oom_memcg=[^ ,]+" | sort | uniq -c
> ```

## なぜ重いか

- **工場は職人を起こせなければ何も進まない。** いま queued は 20本超、6時間を超えたものが複数。
  **今日の詰まりを「スコープの直列化」だけで説明していたが、それだけではない可能性が出てきた**（imp-0072 の見立ての更新）。
- **落ちた職人の仕事が `failed` として帳簿に残る**（inc-0077 の「瞬断で仕事が落ちる」と同じ形）。
  **中身が悪いわけではないのに落ちたことになる**——**直しは task-0190（接続段の再試行）と task-0191（見え方の区別）。**
  **今日の実例がまた増えた。**
- **帳簿と実体の食い違い**（`implementing` なのに誰も居ない）は、**人が気づくまで誰も直さない**。
  **職人が消えたことを機構が拾って状態を戻す**か、**せめて知らせる**必要がある。

## 手（順序）

1. **まず原因を確かめる**（上のコマンド。**職人が起こせないなら人が打つ**）。
   **工房が落ちているなら、起こし直す**（`systemctl restart banto-worker-pool.service`。**root が要る＝PO の操作**）。
2. **task-0165 を動かし直す**（`kobo.reopen` の `rework`）。**取り置きの6枚から続きを読ませること**——
   `sdk-sessions.ts`（505行・`SdkSessionPool` / `PooledSdkHarness`）は書けており、**試験と a10 の計測が残っている**。
3. **task-0190 / task-0191 を通す**（瞬断で仕事が落ちるのを止める／落ちた理由を読めるようにする）。
4. **職人が消えたのに `implementing` のまま、を機構で拾えるようにする**（別途）。
