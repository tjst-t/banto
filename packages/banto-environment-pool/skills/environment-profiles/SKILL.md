---
name: environment-profiles
description: 検証環境の設定ファイル（meta/environments.yaml）の書き方。プロファイルを新しく作る・直す・なぜ使えないのかを調べるときに使う。レビューで PO に触ってもらう環境を用意したいとき、および env.verify に渡すプロファイルが無いときの最初の一歩。
metadata:
  module: environment-pool
  decision: adr-0010#32・#34・#39／adr-0013#59
---

# 検証環境の設定ファイル

## いつ使うか

**環境が「無い」とき。** `env.list_profiles` が空、または `env.verify` に渡すプロファイルが
決まらないときは、まずこのファイルを書く。使い方（立てる・走らせる・畳む）は SKILL
`environment` の方。

**置き場所は `<リポジトリ>/meta/environments.yaml` の1つだけ**（決定34c）。プロジェクトの
持ち物なので、clone すれば付いてくる。Environment Pool は**呼ばれるたびに読み直す**
（D3：ファイルは意図。写しを持たない）ので、直したら次の呼び出しから効く。

## 形

```yaml
profiles:
  dev:                        # ← プロファイル名。タスク定義の `environment: dev` が指す
    driver: process           # 組み込み: process / docker、またはリポジトリ内の実行ファイルへのパス
    config:                   # ドライバに渡す不透明なブロック（Pool は中身を解釈しない）
      cmd: "npm run dev"
      port: 5173              # ← **人が触る環境にはこれが要る**（下記）
    ttl: 8h                   # 生存期限。過ぎたら Pool が畳む
  test:
    driver: docker
    config:
      compose: docker/test.yaml
    ttl: 30m
  staging:
    driver: ./meta/drivers/proxmox-vm    # 自前のドライバ（実行ファイル）
    config: { template: 9000, node: pve1 }
    credentials: staging-pve             # **参照名だけ**。秘密の実体は書かない
    ttl: 24h
    quota: { max_instances: 2 }          # このプロファイルの同時実行上限
```

| 項目 | 効き方 |
|---|---|
| `driver` | `process`（コマンドを1つ起こす）／`docker`（compose）／実行ファイルへのパス |
| `config` | ドライバの都合。**Pool は解釈しない**——`process` は `cmd` と `port`、`docker` は `compose` |
| `ttl` | `8h` / `30m` / `90s`。**能力側の上限（既定24h）を超えると拒否される**（決定34f） |
| `quota.max_instances` | 同時に立てられる数（既定の上限は4）。**Kobo のゲートもここを見る**——上限が埋まっていると、そのプロファイルを使うタスクは `ready` に上がらない |
| `credentials` | sops で管理された秘密の**参照名**。実体をこのファイルに書かない（決定32d） |

## レビューで触ってもらう環境（決定59）

**`config.port` を持つプロファイルだけが、判断待ちの札に公開URLとして載る。**

タスクが `review-ready`（＝判断待ち）に入った時点で Kobo が環境を立て、**PO は札から開いて
触れる**。判断が付いた瞬間に畳まれる。どのプロファイルを立てるかは、上から順に：

1. タスク定義の `environment: dev`
2. プロジェクトの `meta/config.yaml` の `review.env_profile`
3. `verify.profile` ——ただし**触れる面（`config.port`）を持つときだけ**

どれにも当たらなければ**立てない**（理由は Kobo の帳簿に残る）。触れない環境を毎回立てても
費用が掛かるだけだからで、触らせたいなら `review.env_profile` を書く。

### ホスト側のポートは固定しない（番頭判断 2026-08-13）

**人が触る環境は、同じプロファイルで2つ同時に立つ**（判断待ちが2本並べばそうなる）。
ホスト側のポートをプロファイルに固定すると、そこで2つのことが起きる：

1. 2本目が bind できずに立たない
2. 仮に立っても**中継の上流が同じ番号になり、2つの URL が同じ環境を指す**
   ——**PO が別のタスクの画面を見て承認できてしまう**。これがいちばん危い。
   環境が無いのは開けば気づけるが、中身が別物なのは開いても気づけない

だから**ホスト側の番号は Environment Pool に決めさせる**。書き方はドライバごとに：

**docker** — compose の `ports` は**コンテナ側だけ**書く。ホスト側は docker が空きから選び、
Pool が `docker compose ps` で実際の publish 先を引いて、そこへ中継する。

```yaml
# docker/dev.yaml
    ports:
      - "4200"        # ○ コンテナ側だけ。ホスト側は書かない
    # ports: ["4201:4200"]   ← × 固定すると2本目が立たない
```

**process** — bind するのは**アプリ自身**なので、Pool には観測できない。
**`cmd` で `$BANTO_ENV_PORT` を参照する**こと。参照して初めて「割り当てた番号で待っている」と
分かり、その番号で公開される。

```yaml
  dev:
    driver: process
    config:
      cmd: "vite --port $BANTO_ENV_PORT"   # ○ 割り当てを使う
      # cmd: "vite --port 4201"            # ← × 従来どおり config.port で公開され、2つ立てると衝突する
      port: 4200
```

**`config.port` は「コンテナ側／アプリ側の番号」**であって、ホスト側ではない。Kobo は
この値の**有無**だけを見て「人が触れるプロファイルか」を判定するので、番号そのものは
中で待つ側に合わせて書く。

- **ポート番号を Kobo に教える必要は無い**（決定60a）。Kobo は「人が触る」という意図だけを
  渡し、どのポートかは Environment Pool が決める
- `port` を持たないプロファイル（監査用のテスト環境など、触る面が無いもの）は
  **公開せずに立つ**——環境ごと失敗にはならない
- 公開方式は Caddy のサブドメインか banto の中継（`exposeMode`）。**この機械の Caddy は :80 のみ**
  なので、URL を渡すときは `http://` に直すこと

## 書けたか確かめる

1. `env.list_profiles` で**使えるものと弾かれたもの**が両方返る。弾かれたものは理由つき
   ——`ttl` が上限超過・`driver` が空・`config` が形違い、など（I2：黙って落とさない）
2. `env.verify` を1回回す。立って・走って・畳むまでが通れば書けている
3. Kobo に載せているリポジトリなら、タスクを1本 `review-ready` まで運んで、
   **札に URL が載るか**を見る
4. 人が触るプロファイルなら、**2つ同時に立てて URL を2つとも開く**。同じ画面が出たら
   ホスト側のポートを固定したままなので、上の「固定しない」に直すこと

## 気をつけること

- **秘密を書かない。** `credentials` は参照名だけ。復号鍵を持つのは Environment Pool だけで、
  番頭にも Kobo にも渡らない（決定32d）
- **上限は能力側が持つ**（決定34f）。`ttl: 720h` のような値は**拒否される**——プロファイルに
  書けば通る状態だと quota が歯止めにならない
- **畳み忘れは費用**（I3）。`ttl` は「使い終わったら畳む」の代わりではなく安全弁。
  使い捨ての検証は `env.verify` を使えば必ず畳まれる
- **1つのファイルに全部書く。** 環境提供の仕組みを複数作らない（D3・D4）——レビュー用の
  dev server も、監査のテスト実行も、外部VMも、同じこの抽象の上に乗せる
