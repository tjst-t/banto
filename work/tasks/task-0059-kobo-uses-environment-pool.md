---
id: task-0059
type: task
kind: refactor
title: Kobo の検証環境を Environment Pool へ寄せ、独自実装を消す（決定60）
status: done
parent: epic-0010
depends: [task-0058]
refs: [adr-0013, adr-0010, task-0046]
scope:
  paths: ["packages/banto-daemon/**", "packages/banto-environment-pool/**", "tests/acceptance/**", "tests/e2e/**", "meta/**"]
acceptance:
  - { id: a1, text: "Kobo の env 実装（EnvLedger の直接オープン・provision/teardown/run/collect・TTL 執行・env 照合・sops 復号・プロファイル解決。daemon.ts の約995行）が削除され、env.* のモジュール呼び出しに置き換わる" }
  - { id: a2, text: "環境の台帳が1つになる。Kobo は EnvLedger を開かない（D3）" }
  - { id: a3, text: "Kobo が sops の復号値に触れない。復号鍵は Environment Pool だけが持つ（決定32d）" }
  - { id: a4, text: "Kobo の env 受け入れテスト16本が Environment Pool 側へ移設され、移設先で通る。Kobo 側には「env.* を正しく呼ぶか」だけが残る" }
  - { id: a5, text: "到達先は meta/modules.json のレジストリから解決する。コードに URL を直書きしない（決定27b）" }
  - { id: a6, text: "Environment Pool に到達できないとき、黙って成功扱いにしない。理由が Kobo のイベントに残る（I2）" }
  - { id: a7, text: "tests/e2e/pipeline-merge.e2e.spec.ts が通る（実 pi・実 LLM の通し）", verify: "npm test" }
---

## 背景

ADR-0013 決定60：**台帳（状態）を持つ能力はモジュール経由にし、Kobo 独自実装は消す。** 現状 `EnvLedger.open()` は `banto-daemon` と `banto-environment-pool` の両方にあり、TTL 執行と照合ループも両方にある。環境の真実が2つあると、消し忘れの責任が割れる——**外部VMコストは D9 が one-way な副作用と認めたもの**なので、二重管理は費用に直結する。

決定23・32a が定めた2段階（まず切り出し → 後でサービス利用へ切替）の**2段目**にあたる。task-0046 の実体。

## 進め方（I1）

**テストを先に移してから実装を消す。** 先に消すと「移した先で通ること」を確かめられない。対象16本：`env-credentials-failure` / `env-credentials-no-leak` / `env-credentials-sops` / `env-docker-provision` / `env-ledger` / `env-ledger-restart` / `env-process-provision` / `env-process-run-collect` / `env-process-teardown-idempotent` / `env-quota` / `env-reconcile` / `env-review-provision` / `env-review-tmux-pane` / `env-teardown-on-task-end` / `env-teardown-retry` / `env-ttl`。

`env-review-tmux-pane` は tmux ペインを検証しているが、**tmux は決定59 で廃止**するため移設ではなく削除し、代わりに「`in-review` で環境が立ち、公開URLが得られる」テストへ置き換える。

## スコープ外

- レビュー時の環境提示（公開URLを判断待ちに添える）— epic-0010 の3段目
- Kobo の職人まわり（task-0060）
