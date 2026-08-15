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
  - inc-0073
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

---

## 追記（2026-08-15・枝「器で試験が通らない」／inc-0073 の作業から）

**`system.restart` だけでは反映できないコードがある。** ここが SKILL `safe-restart` に
まったく書かれていない。

`system.restart` が起こし直すのは `banto.service`（番頭本体）**1つだけ**。しかし banto は
**3つの常駐サービス**に分かれていて、それぞれ別のコードを読んでいる：

| unit | 何を持つ | どのコード |
|---|---|---|
| `banto.service` | 番頭本体・会話 | `packages/banto-host/src/bin.ts` |
| `banto-worker-pool.service` | 職人の親 | `packages/banto-worker-pool/src/bin.ts` |
| `banto-environment-pool.service` | **検証環境の台帳・ドライバ・Caddy 公開** | `packages/banto-environment-pool/src/bin.ts` |

**3つとも `WorkingDirectory=/home/ubuntu/ghq/github.com/tjst-t/banto` で、`--import tsx` により
main のチェックアウトの .ts を直接実行している**（ビルド成果物は経由しない）。つまり
**main にマージしただけでは、そのプロセスを起こし直すまで反映されない**。

実際に踏んだ形（inc-0073）：検証環境のドライバ（`banto-environment-pool` 側）を直して main に
入れたのに、番頭の `env.verify` はいつまでも古い挙動のままだった。`system.restart` を撃っても
直らない——**そこは別のサービスだから**。

### 起こし直し方（2026-08-15 実測）

`sudo` は通らない（`sudo: The "no new privileges" flag is set` — 職人の砂箱からは特に）。
`banto-environment-pool.service` は `Restart=on-failure` / `RestartSec=5` なので、
**主プロセスを `kill -9` すれば systemd が5秒後に拾って起こし直す**。

```
systemctl show banto-environment-pool.service -p MainPID -p ActiveState
kill -9 <MainPID>
sleep 15
systemctl show banto-environment-pool.service -p MainPID -p ActiveState -p SubState -p NRestarts
```

**巻き添えは無い**（このファイルの上の表と同じ理由で、実測でも確かめた）：

- 立っていた検証環境2つ（`env-898eb2aac9` / `env-d6ca9c424b`）は `Up` のまま。docker の
  コンテナは `/system.slice/docker-<id>.scope` に居て、pool の cgroup（中身は node 1本だけ）
  とは**兄弟**なので `KillMode=control-group` の一掃が届かない
- Caddy の公開 route は `caddy.service` 自身の実行時設定として保持されているので、pool の
  生死とは独立。入れ替え後も両方の `@id` が残り、公開 URL は 200 を返した
- 起動時のコードも確認済み：`sweep()` は生きている環境に触らず、`reconcile()` は孤児を
  **知らせるだけで畳まない**（畳む口は名指しの `env.teardown_orphan` だけ）。台帳はディスクに
  残るので、立っている環境は孤児にすらならない

### だから何を直すか（この追記の分）

- **SKILL `safe-restart` に「どのサービスを起こし直すのか」を足す。** いまは「banto を再起動する」
  話しか無く、**環境まわり・職人まわりの直しは `system.restart` では反映されない**ことが
  どこにも書いていない。「直したファイルがどの package の下か → どの unit か」の対応表を置くこと。
- `banto-environment-pool.service` / `banto-worker-pool.service` の起こし直し手順（上の `kill -9`）と
  **巻き添えの有無**を、`system.restart` の説明文と同じ精度で書く。
- 番頭が自分で踏めるようにするかは別の判断（いまは職人へ委譲して `kill -9` させている）。
  少なくとも**「反映が要る＝system.restart」だと思い込ませない**書き方にすること。
