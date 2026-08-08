---
id: inc-0037
type: incident
kind: incident
origin: agent
class: silent-staleness
status: resolved
refs: [task-0084, task-0075, inc-0032]
---

## 内容

**Dockerfile を直しても、検証環境には永久に効かなかった。**

docker ドライバは provision で `docker compose up -d` を呼んでいたが、**`--build` が無い**。
compose は「イメージが既に在れば作らない」ので、**契約は最初にビルドした時点で凍る**。

task-0075 で「**道具立ての契約は Dockerfile**」と決めた——ホストに何が入っているかに
検証結果を左右させないための場所。その契約が、書いても効かない状態だった。

## 実測（実機・loamium）

PDF 書き出しのテスト7件を直すために `Dockerfile.test` を Alpine → Debian ＋ Chromium に
書き換え、マージ前ゲートを回した。結果：

| | |
|---|---|
| 使われたイメージ | `task-0005-docker-test:latest` **675MB**（古い Alpine のもの） |
| 新しいイメージ | **2.33GB**（Debian ＋ Chromium） |
| テスト | 10件落ちたまま（**1件も変わらない**） |

**「直したのに何も変わらない」**——いちばん気づきにくい形。ゲートの所要時間からも
「ビルドしていない」と分かる（205秒のビルドが入っていない）。

## 直したこと（task-0084）

`docker compose up -d --build`。毎回付けても、変わっていなければレイヤキャッシュが
効くので安い。変わっていれば焼き直す——**それが「契約は Dockerfile」の意味**。

`env-docker-rebuild.spec.ts` が見張る：同じプロジェクト名で Dockerfile を書き換えて
立て直し、**中身が入れ替わっていること**を確かめる（`--build` を外すと落ちる）。

## 直したあと（実機）

イメージが 2.33GB に入れ替わり、**PDF 書き出し7件と llama 1件が通った**（10件 → 2件）。
所要も 439秒 → 356秒に縮んだ（glibc の方が速い）。
