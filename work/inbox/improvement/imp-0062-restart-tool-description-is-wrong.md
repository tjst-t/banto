---
id: imp-0062
title: system.restart の説明文が現構成と食い違う——「職人が落ちる・環境が落ちる」は嘘
status: inbox
kind: improvement
origin: 枝「未反映分の反映」(thread-110)。説明文を信じて「職人5件・検証環境2件を巻き込む」と取次を上げたが、現物を見たら巻き込まないと分かった
refs:
  - packages/banto-host/src/presented-tools.ts
  - packages/banto-host/src/host-session.ts
  - deploy/banto.service
  - imp-0061
created: 2026-08-15
---

## 何が食い違っているか

`system.restart` の説明文は、いまこう言っている：

> 稼働中の職人は中断されるが、記録は残り worker.wake で再開できる。
> 検証環境は cgroup の巻き添えで落ちるので、事前に env.list で確認すること

**どちらも現在の構成では成り立たない**（2026-08-15 実測）。

| 何 | 実際の所属 | ホスト再起動で |
|---|---|---|
| 職人 | `/system.slice/banto-worker-pool.service/supervisor/w-*` | 落ちない |
| 検証環境（コンテナ） | `/system.slice/docker-<id>.scope`（docker.service 配下） | 落ちない |
| 会話セッション | `/system.slice/banto.service`（claude-agent-sdk の子） | **落ちる** |

`banto.service` は `KillMode=control-group` / `KillSignal=SIGTERM` で、`BindsTo` も `PartOf` も
空。`systemctl list-dependencies --reverse banto.service` は `multi-user.target` しか返さない。
つまりシグナルは自分の cgroup の外へは出ない。実測でも、14:52:16 の再起動をまたいで
`env-898eb2aac9`（ひらがなのデモ）は生き残り `env.healthcheck` が通り、職人プロセスも
`worker-pool` 側で走り続けた。

同じ記述は SKILL `safe-restart` の手順1・2 にもある（「中断される」「cgroup の巻き添えで落ちる」）。

## なぜ直す価値があるか

説明文を信じた番頭が、**要らない PO 判断を上げた**（取次 in-bcc82b21：「職人5件・検証環境2件を
巻き込みますが再起動してよいか」）。本当に巻き込むのは**走行中の会話のターン**だけで、そこが
いちばん危ない（imp-0056 / imp-0061 の回収漏れ）。**危険の在り処が説明文で入れ替わっている**ので、
番頭は守るべきものを守らず、守らなくてよいものに承認を取りにいく。

## どう直すか

- `system.restart` の説明文を事実に合わせる：「職人と検証環境は別ユニットなので落ちない。
  落ちるのは**この会話を含む走行中のターン**で、再起動を撃った会話自身は復帰しないことがある
  （imp-0061）」。
- SKILL `safe-restart` の手順1・2 を同じ向きに書き換える（確認の対象を「動いている職人」から
  **「走行中のターンを持つ枝」**へ）。手順3(PO の承認)は残す。
- 構成が変わったら記述も変わる性質のものなので、**試験で固定できるか**を検討する
  （`deploy/*.service` の `BindsTo`/`PartOf` が空であることを見る受け入れ試験など）。
