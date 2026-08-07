---
id: task-0066
type: task
kind: refactor
title: 番頭ホストを Worker Pool / Environment Pool の「利用者」にする（決定61 の残り）
status: done
parent: epic-0010
refs: [adr-0013, adr-0010, task-0058, task-0060, inc-0027]
scope:
  paths: ["packages/banto-host/src/**", "packages/banto-worker-pool/**", "packages/banto-environment-pool/**", "deploy/**", "tests/acceptance/**"]
acceptance:
  - { id: a1, text: "番頭ホストが自分の中に WorkerPool / EnvironmentPool を作らず、独立サービスの利用者になる（到達先は設定で差し替えられる）" }
  - { id: a2, text: "職人と検証環境の台帳が、番頭と Kobo で**同じ1つ**になる。番頭の worker.list と職人ビューアに Kobo の職人が並ぶ（決定29c・inc-0027）" }
  - { id: a3, text: "UI から届く。ブラウザは 127.0.0.1 のサービスへ直接は行けないので、ホストが自分の面に生やして中継する（Kobo と同じ形）" }
  - { id: a4, text: "職人の報告・質問が会話へ返る経路が残る。いまは同一プロセスの購読なので、別プロセスなら worker.events を追う形になる" }
  - { id: a5, text: "banto-worker-pool.service / banto-environment-pool.service を enable できる。deploy の注意書き（いまは起動しない）を外す" }
  - { id: a6, text: "npm run typecheck / npm test が通る", verify: "npm run typecheck && npm test" }
---

## 背景

ADR-0013 決定61 と task-0058・0060 の**残り半分**。独立サービスの口は作った（`bin.ts`・
systemd ユニット）が、**番頭ホストはいまも自分の中に両方を作る**（`bin.ts` の
`new EnvironmentPool` / `new WorkerPool`）。

そのため 2026-08-07 の配置では、**Kobo を番頭ホストの口へ向けている**——独立サービスを
立てて Kobo をそちらへ向けると、番頭とKobo で台帳が2つに割れ、**task-0060 で潰した
inc-0027 の形に戻る**（Kobo の職人が番頭の worker.list に出ない）。

## やること

1. ホストが `WorkerPool` / `EnvironmentPool` を**作る側から呼ぶ側へ**変える
2. UI の経路を Kobo と同じ形にする（相対パスの `endpoint.baseUrl` ＋ ホストが中継）
3. 職人の報告・質問の購読を、同一プロセスの `pool.subscribe` から `worker.events` の
   追いかけへ（`kobo-notice.ts` と同じ形。`afterEventId` で取りこぼさない）
4. deploy の2ユニットから「いまは起動しない」を外す

## なぜ後回しにしてよいか

いまの配置（1プロセスに1つずつ、Kobo が客）でも**台帳は1つ**で、決定29c は守られている。
崩れているのは決定27b の依存の向きだけ——**番頭ホストが落ちると Kobo が職人を起こせない**。
工場が止まるのは困るが、番頭が落ちている間に工場だけ回っても判断は返せないので、実害は小さい。

## やったこと（2026-08-07）

- **番頭ホストは工房も検証環境も作らない**（a1）。`bin.ts` の `new WorkerPool` /
  `new EnvironmentPool` を落とし、`remote-pools.ts` の**到達先モジュール**に置き換えた。
  契約（Tool の名前・説明・引数）は持ち主のパッケージからそのまま取り、`execute` だけを
  HTTP 越しに差し替える（Kobo で先に踏んだ形の一般化＝`remote-module.ts`）。
  到達先は `BANTO_WORKER_POOL_URL` / `BANTO_ENV_POOL_URL`（既定 127.0.0.1:4300 / :4400）
- **台帳は1つ**（a2）。工房・検証環境の置き場は、番頭ホストが使っていたものをそのまま
  サービスへ引き継ぐ（`/var/lib/banto/worker-pool`・`/var/lib/banto/environment-pool`）。
  Kobo は**直に**サービスを叩く（決定27：Banto をブローカーにしない）
- **UI から届く**（a3）。`endpoint.baseUrl` は相対パスのままで、Tool は写しが呼ぶ。
  Tool の規約に乗らない面（`/env/<id>/` の中継）だけホストが素通しする（HTTP・WS とも）
- **報告と質問は引きに行く形へ**（a4）。`pool.subscribe` を `startWorkerNotices`
  （`worker.events` を `afterEventId` で追う）に置き換えた。最初の1回で今の位置まで
  進めるので、落ちている間の古い報告を今さら流し込まない
- **2ユニットを enable**（a5）。deploy の「いまは起動しない」を外し、実機で起動した

### ついでに要ったこと（無いと黙って壊れる）

- **工房が tier→モデルを引けるようにした**。決定60a で Kobo は tier までしか渡さないので、
  台帳が無いと**全部 pi の既定モデルに落ちる**（誰も気づけない）。ただし決定3 の網
  （モジュールは pi を import しない）があるため、pi のモデル表は使わず
  `createFileModelResolver`（models.json だけを見る）を banto-core に足した。
  **実機の3つの tier で pi 版と同じ解決になることを確かめた**（reasoning/standard/fast）
- **設定（決定41）が別プロセスへ届く口**。`createSettingsTools` で `<domain>.settings_read`
  / `settings_write` を出し、写し側の区画がそれを呼ぶ。番頭には渡さない（`internalTools`）
- **設定の保存先**。同居していたときはホストの設定ファイルの一区画を借りていたので、
  独立サービスは `createFileSettingsSection`（`<データ置き場>/settings.json`）で自分で持つ
- **LLM オーバーレイの読み直し**。番頭ホストが書いたものを工房が読むので、
  `LlmCatalog` を更新時刻で読み直すようにした（再起動しないと効かない、を避ける）

## 確かめたこと（I1）

- `npm run typecheck` / `npm test`（1224 テスト）
- **本物の pi の職人**を独立サービスから起こし、/tmp/banto-play にファイルを作らせて
  `worker.report` が返るところまで（偽ドライバのテストだけで済ませない）
- 番頭ホストを客として立て、`worker.list`・`env.list`・`settings.describe`（職人と検証環境の
  区画が実サービスの値で出る）・`/api/environment-pool/env/<id>/` の中継を確認

## 残していること（正直に）

- **検証環境の「知らせ」が会話へ返らない。** 畳み損ね・孤児は、同居していたときは
  `onAttention` で番頭の会話へ流れていたが、いまはサービスのログに出るだけ
  （`env.list` には残るので画面からは見える）。工房と同じく引きに行く形にするなら
  Environment Pool 側にイベントの口が要る——**別タスク**
- **Caddy の設定（接続と公開）はサービス側で読む。** 番頭の画面で設定しても効かないので、
  起動時に警告を出すようにした。画面から設定できるようにするなら、上の設定の口を
  Environment Pool にも通す（口はもうある）
