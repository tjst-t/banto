---
id: inc-0052
type: incident
kind: incident
origin: po
class: environment
status: resolved
refs: [spec-environment, inc-0043]
---

## 内容

**試験を回すたびに、本番のプールがそれを「孤児」として帳場へ知らせていた。**

同じ機械で `npm test` を回すと、受け入れ試験が docker ドライバで本物のコンテナを立てる。
常駐している Environment Pool は定期的に照合（ドライバの `list` と自分の台帳の突き合わせ）
をしており、**そのコンテナを「台帳に無い実リソース」として毎回挙げていた**。
知らせは宛先を持たないので帳場へ届く——POが実際に困っていたのはこれ。

## 原因

所有の記録の置き場が**機械に1つ**だった。

```ts
const STATE_FILE =
  process.env["BANTO_DOCKER_DRIVER_STATE"] ??
  path.join(os.tmpdir(), "banto-docker-driver-state.json");   // ← 機械に1つ
```

docker ドライバは inc-0043 の直しで「名前の綴りで推測せず、**作ったものを記録する**」形に
なっている（`myapp-docker` のような他人のプロジェクトを自分のものと言わないため）。
その記録は正しい発想だが、**置き場がプールごとに分かれていなかった**。

`EnvironmentPool` はドライバを子プロセスで起こすとき、環境変数を渡す口
（`runDriverVerb` の `extraEnv`）を持っていたのに、**この記録の置き場を教えていなかった**。
結果、試験のプールも本番のプールも同じファイルに書き、同じファイルを読む：

1. 試験が `banto-env-<taskId>` を立てる → **共有の記録に足される**
2. 本番のプールが `list` を呼ぶ → 記録にあるので**自分のものとして返る**
3. 本番の台帳には無い → **孤児**
4. 宛先の無い知らせ → 帳場

**所有はプールごとに違う。記録も置き場ごとに分かれていなければならない。**

## 直したこと

`EnvironmentPool` が `BANTO_DOCKER_DRIVER_STATE = <dataDir>/docker-driver-owned.json` を
**すべてのドライバ呼び出しへ渡す**（provision / list / teardown / cache-list / cache-remove /
低位動詞）。とくに provision が要——作ったものを記録するのがそこなので、そこで置き場を
教えないと機械に1つの既定へ書かれる。

ドライバ側の環境変数の口はそのまま使った（既に `BANTO_DOCKER_DRIVER_STATE` を先に読む）。
**ドライバは無変更。**

## 確かめたこと

`tests/acceptance/env-orphan-ownership.spec.ts` に2件：

- プールはドライバへ**自分の置き場**を教える（機械に1つの既定を指さない）
- 別の置き場のプールは別の記録を指す（試験と本番が混ざらない）

## 移行

本番のプールは、これまでの記録（`/tmp/banto-docker-driver-state.json`）ではなく
`/var/lib/banto/environment-pool/docker-driver-owned.json` を見るようになる。
**中身は引き継いだ**（デプロイ時に移した）。引き継がなくても倒れる向きは安全側
——記録が空なら `list` は何も返さず、孤児を報告しなくなるだけで、他人のものを
自分のものと言うことは無い（畳むのは台帳の handle を使うので影響しない）。
