---
id: task-0074
type: task
kind: fix
title: docker で検証する経路の穴を2つ塞ぐ（compose の基点・one-off の畳み忘れ）
status: done
refs: [inc-0032, inc-0033]
scope:
  paths: ["packages/banto-environment-pool/src/docker-driver.ts", "packages/banto-environment-pool/src/pool.ts", "tests/acceptance/env-docker-teardown-list.spec.ts"]
acceptance:
  - { id: a1, text: "workdir 未指定でも、プロファイルの相対 compose パスが repoPath から解ける" }
  - { id: a2, text: "teardown が one-off コンテナも消す。畳めなかったら成功に見せない（I3）" }
  - { id: a3, text: "どちらの検体も、直す前の実装で落ちることを確かめる" }
  - { id: a4, text: "npm run typecheck / npm test が通る", verify: "npm run typecheck && npm test" }
---

## 背景

PO の問い「inc-0032 は docker provider を使えばいいのかな？」に答えるため、
**実際に `env.verify` を docker で回してみた**。方向は正しいが、**回してみたら2つ壊れていた**。

## 穴1：相対 compose パスの落ち先（a1）

決定34d は「相対 compose パスは workdir から解決する」と定めた。それは正しいが、
**workdir が無いときの落ち先が Environment Pool 自身の cwd**だった。独立サービスに
なってからは、それは「banto のリポジトリ」を指す——**受け持つプロジェクトとは何の関係も
無い場所**で compose を探す。

実測：

```
env.verify(repoPath=<loamium>, profile="test")
→ 環境を用意できませんでした（docker）: compose file not found:
  /home/ubuntu/ghq/github.com/tjst-t/banto/docker/test.yaml
```

プロファイルは `<repoPath>/meta/environments.yaml` から読んだのだから、そこに書かれた
相対パスの基点は `repoPath`。Pool が `repoPath` を渡し、ドライバが
`workdir ?? repoPath ?? cwd` で解く形にした（`config` の中身は Pool が解釈しない・spec §2 のまま）。

## 穴2：one-off コンテナの畳み忘れ（a2・I3）

`run` は `docker compose run --rm` の一時コンテナ（ラベル `oneoff=True`）で動く。
**`--rm` を消すのはクライアント側**なので、run が制限時間で殺されるとクライアントごと落ち、
**コンテナだけが残る**。そして `docker compose down` は one-off を対象にしない。

結果、`env.verify` が **`tornDown: true` を返しながら外でコンテナが走り続ける**
——I3 の不変条件（畳めなかったら成功に見せない）が、いちばん破れてはいけない形で、
**黙って**破れる。

実測：run の10分上限で切られたあと、one-off が9分以上走り続けていた。

teardown の最後に `com.docker.compose.project` ラベルで残りを拾って `docker rm -f` する。
消せなかったら成功にしない（I2）。

## 検体が空振りしていた（記録・a3）

穴2 の検体を最初「run を正常に終わらせてから teardown」と書いた。**直しを無効にしても
通った**——正常終了では `--rm` が効いてコンテナが消えるので、元の壊れ方を再現していない。
**run を途中で殺す**形に直し、「殺したあと one-off が残っていること」を前提の確認として
足した。直しを無効にすると落ちることを確認済み。

task-0068・task-0072 に続いて3度目。**空振りする検査は、無い検査より悪い。**

## ついでに拾ったもの

`unrelated-proj-1786030924783-svc-1` が**20時間走り続けていた**（受け入れテストの fixture）。
`after()` で畳む形にはなっているので、テストが途中で落ちたときの取り残しと見られる。
手で消した。→ inc-0033
