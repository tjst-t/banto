---
id: inc-0053
type: incident
kind: incident
origin: kobo
class: environment
status: open
refs: [task-0090, docker-driver]
---

## 内容

**docker のテスト実行がネットワークを leak し続ける（task-0090 の検証中に実測）。**

task-0090（職人のツール結果の退避）の検証中、docker 依存の acceptance
（`env-docker-rebuild` / `env-driver-timeout-budget`）が3/3で落ちた。
原因は「docker のアドレスプール枯渇」——過去のテスト実行が
`banto-env-task-{oneoff,wt}-*_default` ネットワークを**27個** leak させていた。
使われていないものを削除したら通った（削除後の全体実行が 1497 pass / 0 fail）。

## 原因

docker ドライバの teardown は `docker compose down -v`（コンテナ・ネットワーク・
ボリュームを削除）と one-off コンテナの掃除まで行うが、**ネットワークの掃除が
不完全**な経路がある（例: run が制限時間で殺されたときの one-off が残し、
その後 teardown が走らない、または `compose down` が対象にしないネットワークが残る）。

## 影響

- ネットワークが蓄積すると docker のアドレスプールが枯渇し、**無関係な acceptance が
  落ちる**（task-0090 の検証で実際に起きた）
- 対処は「使われていないネットワークを手で削除」だが、**機構として直っていない**
  （再発する）

## 直すべきこと（未着手）

- docker ドライバの teardown（または run の後始末）で、**プロジェクトのネットワークを
  確実に掃除する**（`docker network rm` または `compose down` の対象を広げる）
- テスト実行後もネットワークが残らないことを検証するテスト

## 確かめたこと

- 2026-08-11: task-0090 の検証中、27個の leak を確認・削除 → acceptance が通った
- 本 incident はこのときの記録。対応タスクは未着手
