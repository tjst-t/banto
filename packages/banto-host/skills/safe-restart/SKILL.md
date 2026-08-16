---
name: safe-restart
description: コード更新を反映するために常駐サービスを起こし直すときの手順。banto は3つのユニットに分かれていて、system.restart が起こし直すのは banto.service だけ。落ちるのは走行中のターンだけ（職人と検証環境は別ユニットなので落ちない）。段取りを書き残し、PO の承認を得てから撃つ。
---

# Safe Restart（banto の常駐サービスを安全に起こし直す）

## いつ使うか

コード更新を稼働機へ反映するとき。反映したいコードが**どのユニットのものか**でやることが
変わる——`system.restart` は `banto.service`（番頭本体）**だけ**を起こし直す道具であって、
「反映が要る＝`system.restart`」ではない。まず次の節で宛先を決めること。

再起動そのものは systemd が行う——本SKILLが守るのは「**切れるものを控えてから**、
PO の承認を得て撃つ」こと。会話は保存済み（task-0036 の永続化）で、再起動後に続きから話せる。

## どのサービスを起こし直すのか（imp-0062 追記・inc-0073）

banto は**3つの常駐サービス**に分かれている。3つとも
`WorkingDirectory=/home/ubuntu/ghq/github.com/tjst-t/banto` で `--import tsx` により
**main のチェックアウトの .ts を直に読む**（ビルド成果物を経由しない）。つまり
**main にマージしただけでは、そのプロセスを起こし直すまで反映されない**。

| 直したファイル | unit | 何を持つ | 起こし直し方 |
|---|---|---|---|
| `packages/banto-host/**` | `banto.service` | 番頭本体・会話 | `system.restart` |
| `packages/banto-worker-pool/**` | `banto-worker-pool.service` | 職人の親 | `kill -9`（下記） |
| `packages/banto-environment-pool/**` | `banto-environment-pool.service` | 検証環境の台帳・ドライバ・Caddy 公開 | `kill -9`（下記） |

**`system.restart` が起こし直すのは `banto.service` だけである。** 職人まわり・検証環境まわりの
変更は、これを何度撃っても反映されない。

実際に踏んだ形（inc-0073）：検証環境のドライバ（`banto-environment-pool` 側）を直して main に
入れたのに、番頭の `env.verify` はいつまでも古い挙動のままだった。`system.restart` を撃っても
直らない——**そこは別のサービスだから**である。

### banto-worker-pool / banto-environment-pool を起こし直す（2026-08-15 実測）

`sudo` は通らない（`sudo: The "no new privileges" flag is set` — 職人の砂箱からは特に）。
どちらのユニットも `Restart=on-failure` / `RestartSec=5` なので、**主プロセスを `kill -9`
すれば systemd が数秒後に拾って起こし直す**。番頭は自分で踏まず、職人へ委譲する。

```
systemctl show banto-environment-pool.service -p MainPID -p ActiveState
kill -9 <MainPID>
sleep 15
systemctl show banto-environment-pool.service -p MainPID -p ActiveState -p SubState -p NRestarts
```

`banto-worker-pool.service` も同じ手順（unit 名を差し替えるだけ）。`NRestarts` が増えて
`ActiveState=active` / `SubState=running`、`MainPID` が別の値になっていれば入れ替わっている。

**巻き添えは無い**（2026-08-15 実測）：

| 何 | 所属 | pool の kill -9 で |
|---|---|---|
| 立っている検証環境のコンテナ | `docker-<id>.scope`（pool の cgroup とは兄弟） | 落ちない |
| Caddy の公開 route | `caddy.service` 自身の実行時設定 | 消えない（公開 URL は 200 のまま） |
| 台帳（ディスク） | pool の外 | 残る（立っている環境は孤児にすらならない） |

起動時のコードも確認済み：`sweep()` は生きている環境に触らず、`reconcile()` は孤児を
**知らせるだけで畳まない**（畳む口は名指しの `env.teardown_orphan` だけ）。

以下は `system.restart`（`banto.service`）の話である。

## 何が落ちて、何が落ちないか（2026-08-15 実測・imp-0062）

| 何 | 所属 | 再起動で |
|---|---|---|
| 走行中のターン（**この会話を含む**） | `banto.service`（会話セッションはその子） | **切れる** |
| 職人 | `banto-worker-pool.service` | 落ちない |
| 検証環境のコンテナ | `docker-<id>.scope` | 落ちない |

`banto.service` は `BindsTo` も `PartOf` も持たないので、シグナルは自分の cgroup の外へ
出ない。**職人と検証環境を止める必要も、巻き込みの承認を取る必要もない**——以前ここに
「職人は中断される」「検証環境は cgroup の巻き添えで落ちる」と書いてあったのは嘘で、
そのせいで要らない PO 判断が上がり、いちばん危ない走行中のターンが素通しになっていた。

## 手順（`system.restart` を撃つとき）

0. **宛先を確かめる**：反映したいコードが `packages/banto-host/**` の下か。違うなら
   `system.restart` では反映されない——上の表で unit を選び直す。
1. **切れるものを控える**：切れるのは**走行中のターン**、まず**自分のターン**である。
   いまの段取り（どこまで進んだか・次に何をするか・巻き込んでいる職人の id）を、
   撃つ前に会話へ1件書き残す。再起動後の自分はそれを読んで続きから動く。
2. **走行中の枝を見ておく**：直前に `thread.steer` / `thread.send` / `thread.consult` で
   動かした枝は、ターンが回っている最中かもしれない。切れた会話は次の起動で自動的に
   起こし直される（imp-0037・imp-0061）が、道具を叩いた直後で切れた場合は**その道具を
   やり直さず続きから**進む形になる——やり直しが要る仕事なら、先に片付けるか控えておく。
   （走行中かどうかを引く道具は無い。`thread.list` は一覧であって走行状態は出ない）
3. **PO の承認を得る**：「これから再起動します」と PO に伝えて承認を得る。
   職人や検証環境の巻き添えを断る必要は無い（落ちない）。伝えるのは
   **いま走っているターンが切れること**と、反映したい変更の中身。
4. **再起動する**：`system.restart` を呼ぶ。全クライアントへの通知 → graceful 終了 →
   systemd が起動し直す（数秒）。
5. **再起動後を確かめる**：本番の health を確認し、続きの会話ができること（会話は永続化済み）を確認する。
   再起動が終わると、この会話へホストから「再起動が完了しました。中断した続きを進めてください。」
   が届く——**それが手順5の合図**。話しかけられるのを待たず、そこから自分で続ける（imp-0037・imp-0061）。

## やってはいけないこと

- 「反映が要る＝`system.restart`」と決めつけない。番頭本体の外を直したなら、撃っても何も変わらない
  （inc-0073）。
- 落ちないもの（職人・検証環境）の承認を PO に取りにいかない。**危険の在り処はターンの側**である。
- 走行中のターンを黙って切らない（手順1の控えを書いてから撃つ）。
- `system.restart` を連打しない（再起動中の多重実行は避ける）。
