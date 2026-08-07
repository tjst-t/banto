---
id: task-0066
type: task
kind: refactor
title: 番頭ホストを Worker Pool / Environment Pool の「利用者」にする（決定61 の残り）
status: draft
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
