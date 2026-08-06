---
id: task-0060
type: task
kind: refactor
title: Kobo の職人を Worker Pool へ寄せ、独自の spawn と tmux を消す（決定60・63）
status: draft
parent: epic-0010
refs: [adr-0013, adr-0010, task-0024]
scope:
  paths: ["packages/banto-daemon/**", "packages/banto-worker-pool/**", "tests/acceptance/**", "tests/e2e/**", "meta/**"]
acceptance:
  - { id: a1, text: "Kobo の spawn 実装（SpawnLedger の直接オープン・PiRpcDriver の直呼び・孤児回収・tmux 窓）が削除され、worker.* のモジュール呼び出しに置き換わる" }
  - { id: a2, text: "職人の台帳が1つになる。Kobo は SpawnLedger を開かない（D3・決定29c）" }
  - { id: a3, text: "Kobo が起こした職人が番頭の worker.list と職人ビューアに並ぶ。origin で Kobo 由来と分かる" }
  - { id: a4, text: "origin が Kobo の職人は、番頭からは worker.close / worker.stop で畳めない（決定63）。拒否の理由が呼び出し側に返る（I2）" }
  - { id: a5, text: "Kobo がタスク用に渡す道具立て（banto-executor 拡張・executor のシステムプロンプト）が worker.delegate 経由でも届く" }
  - { id: a6, text: "worktree の作成・削除が repo-manager 経由になり、gwq の配下に作られる。番頭と PO が場所として中を読める" }
  - { id: a7, text: "Kobo が tmux を一切呼ばない。職人を覗くのはセッションビューア（決定18）" }
  - { id: a8, text: "Kobo はモデル名を知らない。worker.delegate へ tier（reasoning/standard/fast）だけを渡し、解決は Worker Pool が行う。BANTO_PI_PROVIDER / BANTO_PI_MODEL による直指定を廃止する（決定60a）" }
  - { id: a9, text: "監査2回不通過の tier 昇格が、渡す tier を変えるだけで成立する（spec-daemon-core §3.5）" }
  - { id: a10, text: "tests/e2e/pipeline-merge.e2e.spec.ts が通る（実 pi・実 LLM の通し）", verify: "npm test" }
---

## 背景

ADR-0013 決定60。`SpawnLedger.open()` が `banto-daemon` と `banto-worker-pool` の両方にあるため、**Kobo が起こした職人は番頭の `worker.list` にも職人ビューアにも出ない**。決定29c は「職人の真実は Worker Pool に一箇所」と定めており、それが守られていない。決定23・task-0010 が定めた2段階の**2段目**（task-0024 の実体）。

`worktree` を `gwq` 配下に移すのは決定36h の2段目でもある。現状 Kobo は `<dataDir>/worktrees/` に作るため、**実装中の中身を番頭も PO も読めない**。

## 注意（決定63）

- **場所の砦は Kobo には掛からない。** `worker.delegate` の `worktreePath` を検査しているのは番頭ホストが Tool を束ねる層であり、Kobo が直接呼ぶ経路には無い。砦が縛るのは「LLM が自由なパス引数を渡すこと」で、決定的コードである Kobo は対象外——**これは穴ではなく設計**なので、二重に検査を足さない
- **`worker.close` の制限は Worker Pool 側に置く**（呼び出し元の層ではなく）。番頭ホスト経由でも Kobo 経由でも同じ判定が効くようにする

## モデルの扱い（決定60a）

**Kobo は pi の設定も LlmCatalog も読まない。** 公開の口を通らない経路が1本でもあると、その口の
変更が黙って Kobo を壊し、モジュールを差し替えられなくなる。Kobo が知ってよいのは **tier** まで。

## スコープ外

- 検証環境（task-0059）
- `kobo.*` Tool の公開（epic-0010 の2段目）
