---
id: inc-0072
title: 稼働機の banto.service とリポジトリの deploy/banto.service が食い違う——入れ直すと再起動が効かなくなる
status: resolved
kind: incident
origin: imp-0062（再起動で落ちる範囲を事実に合わせる）の実装中に、職人が稼働機とリポジトリを突き合わせて発見。P3 に従い起票
refs:
  - deploy/banto.service
  - packages/banto-host/src/restart-tool.ts
  - tests/acceptance/deploy-unit-restart-policy.spec.ts
  - imp-0062
  - task-0154
created: 2026-08-15
resolved: 2026-08-16
---

## 決着（2026-08-16 / task-0154）

**稼働の実態＝`Restart=always` を正とし、リポジトリを合わせた。**
`deploy/banto.service` を `on-failure` → `always` に変え、同じファイルに理由コメントを置いた。
`tests/acceptance/deploy-unit-restart-policy.spec.ts` で固定してある。

理由は `system.restart` の終わり方にある。あの道具は自分を落として systemd に拾わせるもので、
終了は **`exit(0)`＝正常終了**（`packages/banto-host/src/restart-tool.ts`）。
`Restart=on-failure` は正常終了では起動し直さないので、リポジトリの内容をそのまま稼働機へ
入れると **`system.restart` を撃った瞬間に番頭ホストが上がってこない**——しかも撃つまで
分からない。`exit(0)` での自己再起動は道具の設計上の前提であって事故ではないので、
**終了コードの側は触らない。**

## 4ユニットの突き合わせ（2026-08-16）

稼働機側は `/etc/systemd/system/<unit>` と `/etc/systemd/system/<unit>.d/*.conf`（ドロップイン）、
および `systemctl show -p Restart` の実効値を読んだ。**稼働機のファイルは1つも書き換えていない。**

| ユニット | 食い違った鍵 | 稼働機の値 | リポジトリの値 | 正としたのは | 理由 |
|---|---|---|---|---|---|
| `banto.service` | `Restart=` | `always`（実効値。本体は `on-failure` で、`banto.service.d/override.conf` が上書き） | `on-failure` | **稼働機** → リポジトリを `always` に直した | `system.restart` が `exit(0)` で終わる。上の「決着」のとおり |
| `banto.service` | `Environment=BANTO_PROVIDER` / `BANTO_MODEL` | `opencode` / `deepseek-v4-flash-free` が本体に残る | 行を消し、「読まれない」とコメント | **リポジトリ** → 稼働機は変えない | 2026-08-04 の裁定で env の読み取りをやめた。稼働機に残っているのは死んだ設定で、害は無い（読まれない） |
| `banto.service` | `Environment=BANTO_HOST_BIND` | `0.0.0.0`（`override.conf`） | 無し（既定の 127.0.0.1。コメントで「広げるのは自己責任」と明示） | **未決** — どちらも直さない | 待ち受けを広げるかは**機械ごとの運用判断**で、Banto は認証を持たない。リポジトリの既定を安全側に置いたまま、稼働機がドロップインで広げている今の形は筋が通っている。テンプレートに `0.0.0.0` を焼き付けるのは別の話（公開方式の裁定が要る） |
| `banto.service` | `Environment=BANTO_KOBO_URL` | `http://127.0.0.1:4500/api/kobo`（`kobo.conf`） | 無し（既定と同じ値なので書いていない） | **未決** — どちらも直さない | 既定と同値の明示にすぎず、挙動は変わらない。「既定と同じ値をどこまで明示するか」の方針が無いので、勝手に決めない |
| `banto.service` | OOM 系（`MemoryAccounting` / `MemoryMax=3G` / `MemoryMin=1G` / `OOMScoreAdjust=-500`、`oom.conf`） | 上記 | 無し | **未決** — どちらも直さない | 値が**その機械の実装メモリに依存する**。リポジトリのテンプレートに書くなら「どの機械でも妥当な値」を決める必要があり、それはこの仕事の範囲を超える |
| `banto-worker-pool.service` | **食い違い無し**（本体ファイルは1行も違わない。`Restart=` は両方 `on-failure`） | — | — | — | ドロップイン `oom.conf`（`MemoryMax=9G` / `Delegate=yes` / `BANTO_WORKER_CGROUP` 等）だけが稼働機側に増えている。**未決** — 職人の cgroup 設計に関わる値で、機械依存かどうかを言い切れない |
| `banto-environment-pool.service` | **食い違い無し**（本体ファイルは1行も違わない。`Restart=` は両方 `on-failure`） | — | — | — | ドロップイン `oom.conf` と `caddy.conf`（`BANTO_CADDY_ADMIN` / `BANTO_ENV_DOMAIN=banto.tjstkm.net`）が稼働機側に増えている。**未決** — ドメインは明らかにこの機械固有 |
| `banto-daemon.service` | `Environment=BANTO_PO_TOKEN` | 実トークンが本体に直書き（**値はここに写さない**） | 無し | **リポジトリ** → 稼働機は変えない | 秘密をリポジトリに入れない。稼働機に置くべき値で、テンプレート側に無いのが正しい |
| `banto-daemon.service` | それ以外 | — | — | — | **食い違い無し**（`Restart=` は両方 `on-failure`）。ドロップイン `oom.conf` のみ稼働機側に増えている |

`Restart=` の実効値（`systemctl show -p Restart`）は
**`banto`=`always` / `banto-worker-pool`=`on-failure` / `banto-environment-pool`=`on-failure` /
`banto-daemon`=`on-failure`**。`always` にしたのは `banto.service` だけで、残り3つは
**自分で自分を `exit(0)` で落とす道具を持たない**ので `on-failure` のままでよい。

## 起票時の見立てのうち、実地で違っていたこと（I1）

起票では「稼働機の**ユニット**が `always`」と書いたが、正確には**本体ファイルは `on-failure`**で、
`/etc/systemd/system/banto.service.d/override.conf` が `Restart=always` を重ねている。
つまり「リポジトリの本体を稼働機の本体へ上書きしても、ドロップインが残っていれば
`always` のまま」で、起票時に恐れた即死は**その経路では起きない**。
とはいえドロップインの無い機械へ入れ直せば起きるし、リポジトリが稼働の姿を写していない
状態そのものが罠なので、直した判断は変わらない。

なお `/etc/systemd/system/banto.service.d/override.conf.bak-20260804` も `Restart=always` を
持つが、`.conf` で終わらないため systemd は読まない（**効いていない**）。

「稼働機のユニットをいつ・誰が `always` に変えたか」は依然として分からない。

## 残っている宿題（この仕事の外）

- `tests/acceptance/restart-blast-radius.spec.ts` の「この試験の限界」節が、
  **「稼働機は always、リポジトリは on-failure で食い違っている」と今も書いている**。
  この記録で食い違いは解消したので、その文面は古い（P3）。スコープ外なので触っていない。
- 上の表で **未決**とした5件（`BANTO_HOST_BIND` / `BANTO_KOBO_URL` / 各 `oom.conf` /
  `caddy.conf` / worker-pool の cgroup 設定）は、**リポジトリのユニットを「テンプレート」と
  見るか「稼働機の写し」と見るか**が決まらないと片付かない。決めるなら別途。
- リポジトリの `deploy/**` を稼働機へ反映する段取り（`daemon-reload` を含む）は幹が持つ。
  この仕事ではリポジトリ側しか触っていない。
