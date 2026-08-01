---
id: epic-0008
type: epic
title: Environment Pool（動作検証環境）— Koboから独立したモジュール
status: draft
refs: [adr-0010, adr-0009]
---

## 目的

ADR-0010 決定32 で決めたとおり、動作検証環境（`EnvDriver` の実行能力）を Kobo から独立した Environment Pool モジュールとして立ち上げる。決定23 の Worker Pool とまったく同じ扱い——Kobo のサブシステムではなく、Kobo が無くても単体で成立する能力とする。

**番頭の急所を解く。** 番頭は実行系の Tool を一つも持たない（D10・D5）ため、「テストが通った」を職人の自己申告でしか得られず、決定29(a)「報告は主張であって完了の証明ではない」と噛み合っていなかった。Environment Pool があれば、番頭は Kobo 無しでも**機構が返した事実**として検証結果を受け取れる——狭い自己開発が Kobo の完成を待たなくなる。

現状、`EnvDriver` の具象（`docker-driver.ts`・`process-driver.ts`・`env-driver-runner.ts`・`env-ledger.ts`・`sops.ts`）は `packages/banto-daemon`（＝Kobo）の中にある。契約（`banto-core/src/env-driver.ts`）は既にランタイム中立。この従属関係を解く。

## ユースケース

- 番頭が Kobo 無しで環境を provision し、`env.run` で検証を回し、終了コードと成果物を**事実として**受け取れる（職人の主張に頼らない）
- 職人には直接経路を与えない（決定32c：成果を出す側に自己検証させると I1 が崩れる）
- Kobo は、独立した Environment Pool を利用する側に回る（自前で env ドライバを抱えない）
- 台帳・TTL・quota・reconcile が Environment Pool 側にあり、番頭が起こした環境も消し忘れなく片付く（決定32e）

## 決定事項（決定32）

- 名前は Environment Pool、ドメインは `env.*`（決定32b）
- sops 復号鍵は Environment Pool が持つ（決定32d）
- 台帳・quota・TTL・reconcile は Environment Pool が持つ（決定32e）
- spec-environment §3〜§5 は決定32 に沿って改訂済み

## タスクの割り方（決定32a・task-0010 の教訓）

Worker Pool（task-0010 → task-0024）と同じく2段階に割る。切り出しは振る舞いを変えず、差し替えは検証に集中する。

- **切り出し**（task-0033）：`EnvDriver` の具象を新パッケージへ移し、Kobo は当面ライブラリとして参照し続ける。振る舞いを変えない
- **サービス化・番頭への `env.*` 提供**（別タスク）：Environment Pool を独立サービスとして立て、番頭が `env.*` を直接呼べるようにする。GUI（環境の稼働状況・健康状態・ログ）もここ
- **Kobo のサービス利用への切り替え**（別タスク、task-0024 相当）：Kobo が env ドライバを自前で抱えるのをやめ、Environment Pool をサービスとして使う

## 未決（実装時に詰める）

- モジュール HTTP 面の認証（決定27b／決定32d の帰結。Worker Pool 共通の課題）
- 環境 quota の上限を誰が決めるか（能力側の既定か Kobo の裁定か。D9）
