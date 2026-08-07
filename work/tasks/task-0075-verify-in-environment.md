---
id: task-0075
type: task
kind: feature
title: Kobo の検証を検証環境の中でだけ回す（Environment Pool を必須にする）
status: done
refs: [inc-0032, task-0071, task-0074]
scope:
  paths: ["packages/banto-daemon/src/**", "packages/banto-environment-pool/src/**", "meta/**", "docker/**", "docs/spec/daemon-core.md", "tests/acceptance/**"]
acceptance:
  - { id: a1, text: "マージ前ゲートの検証コマンドが、プロジェクトの宣言した検証環境の中で回る。ホストでは走らせない" }
  - { id: a2, text: "検証環境へ届かないならゲートを通さない。**ホストへ落ちる道を残さない**" }
  - { id: a3, text: "立てるのは1タスクにつき1回。途中で落ちても畳む（I3）" }
  - { id: a4, text: "環境が立たないことを「テストが落ちた」と混同しない（I2）" }
  - { id: a5, text: "banto 自身にも検証環境を持たせる（受け持たせるのだから例外にしない）" }
  - { id: a6, text: "npm run typecheck / npm test が通る", verify: "npm run typecheck && npm test" }
---

## 背景

**PO 裁定「Kobo では environment pool を必須にします」**（2026-08-07）。

inc-0032 の根本策。ホストで検証を走らせると**ホストの状態が検証結果に混ざる**——
実際に混ざった：

- banto の Kobo が 127.0.0.1:3000 に居座っていたせいで、loamium のテストが1件**永久に落ちていた**
- 機械に `make` が入っていなかったせいで3件落ちていた

どちらも loamium のコード欠陥ではないのに `verify_failed` として返る。
**「loamium のテストが壊れている」と読める形で失敗する**のが一番たちが悪い。

## やったこと

### 1. ゲートは `GateVerifyRunner` 越しにしか検証しない（a1・a2）

`merge-gate.ts` から `sh -c` のホスト実行を**消した**。代わりに口（`GateVerifyRunner`）を
取り、Kobo が `env.provision` → `env.run` × N → `env.teardown` で実装する。

**渡されないときはゲートを通さない**（`verify_runner_missing`）。ホストへ落とす道を残すと、
いちばん静かに壊れる形（「たまたま通った」）に戻る。

### 2. 立てるのは1回、畳むのは finally（a3）

受け入れ条件ごとに立て直すと、テスト一式を何度も用意することになる。畳むのは `finally`
——検証が落ちても、途中で抜けても畳む。**検証コマンドが1本も無ければ立てない**。

### 3. 「確かめていない」と「落ちた」を分ける（a4）

環境が立たないときは `verify_env_unavailable:<profile>（理由）`。**`verify_failed` とは
別の言葉**にする——同じ言葉にすると、環境の不備をテストの失敗として読んでしまう。

### 4. プロファイル名は層B設定（`meta/config.yaml` の `verify.profile`・既定 `test`）

### 5. banto 自身にも検証環境を作った（a5）

`meta/environments.yaml` ＋ `docker/test.yaml` ＋ `docker/Dockerfile.test`。
**自分を受け持たせるのだから例外にしない。**

Dockerfile が**道具立ての契約**になる（git / make / g++ / python3 / docker-cli）。
ホストに `apt` した `make` は、これで正しい場所へ移った。

## 実測で見つかった穴（必須化しなければ表に出なかった）

**`provision` が30秒で切られる。** プロファイルが `build:` を持つと
`docker compose up -d` は**イメージのビルド**を含む。spec-environment §5.1 は
「他の動詞（provision / healthcheck 等）はすぐ返るはず」として短い既定のままにしていたが、
**その前提が崩れる**。

banto 自身のプロファイル（`node:22-alpine` + apk 4本）で初回が30秒を超え、
`driver timeout after 30000ms (verb=provision)` で落ちた。**Kobo が検証環境を必須にした以上、
これは「新しいプロジェクトの初回ゲートが必ず落ちる」ことを意味する。**

`DEFAULT_PROVISION_TIMEOUT_MS`（10分）を足し、`provision` だけ長く待つようにした。
立てるのは1タスクにつき1回なので後ろは詰まらない（走らせる方の上限は `run` が別に持つ）。

## 確かめたこと（I1）

- `npm test` **1,293件 green**（新規6件）・typecheck・build
- **イメージとビルドキャッシュを消したまっさらな状態**から `env.verify` を実機で回し、
  コンテナの中で `node v22.23.2` / `git 2.54.0` / **`GNU Make 4.4.1`** / exit 0 /
  `tornDown: true` を確認——**ホストに無い道具がイメージにあることを実物で見た**
- テスト後にコンテナが1つも残らないこと

## 試験専用の口について（正直に）

`tests/acceptance/gate-verify-runner.ts` はホストで走らせる偽の runner。ゲートの筋道
（スコープ検査・時間切れの扱い・畳み）を見るために docker を毎回立てていられないため。
**`tests/` に置いてあるので `packages/` からは import できない。**

`Daemon.create({ verifyRunner })` も試験のための口で、**設定ファイルからは渡せない**
（コンストラクタ引数だけ）。渡せるようにすると「ホストで検証する」に戻せてしまう。

「検証環境が無ければゲートは通らない」という不変条件そのものは
`merge-gate-env-required.spec.ts` が**偽物を渡さずに**見ている。

## 残していること

- **受け持つ全プロジェクトに profile が要る。** loamium は在る、banto は今回作った。
  新しく受け持たせるときは `kobo-onboarding` の手順に足す必要がある（未着手）
- **loamium の `meta/` が未コミット**なので、職人の worktree に profile が無い。
  コミットは loamium 側の作業（PO）
