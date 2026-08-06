---
id: inc-0027
type: incident
kind: incident
origin: agent
class: spec-drift
status: open
refs: [adr-0010, adr-0013, task-0024, task-0046, task-0059, task-0060]
---

## 内容

決定23（Worker Pool）・決定32a（Environment Pool）は、いずれも**2段階**で進めると定めた——「まず振る舞いを変えず切り出し、その後 Kobo をサービス利用へ切り替える」。**1段目は完了しているが、2段目（task-0024・task-0046）が未着手のまま残っている。**

結果として、いま**同じ台帳が2箇所で開かれている**。

| 台帳 | 場所1 | 場所2 |
|---|---|---|
| 職人（`SpawnLedger`） | `banto-daemon/src/daemon.ts:360` | `banto-worker-pool/src/pool.ts:212` |
| 検証環境（`EnvLedger`） | `banto-daemon/src/daemon.ts:374` | `banto-environment-pool/src/pool.ts:214` |

TTL 執行と照合ループも、環境については両方に存在する。

## なぜ問題か

これは「未実装」ではなく **D3（状態の真実は一箇所）の齟齬**である。そう扱わないと、着手の優先順位が下がったまま放置される。

- **職人**：Kobo が起こした職人は Worker Pool のイベントログに出ないため、番頭の `worker.list` にも職人ビューアにも現れない。決定29c「職人の真実は Worker Pool に一箇所」が守られていない
- **環境**：作った者が片付ける責任（決定32e）が2箇所に分かれる。**外部VMコストは D9 が one-way な副作用と認めたもの**で、二重管理は費用に直結する

## 対処

ADR-0013 決定60 で「台帳を持つ能力はモジュール経由にし、Kobo 独自実装は消す」と裁定済み。実装は **task-0059（環境）・task-0060（職人）**。task-0024・task-0046 はこの2件をもって閉じる。
