---
id: task-0006
type: task
kind: feature
title: Tool論理名↔wire名アダプタ（決定22。プロバイダ制約の吸収）
status: draft
parent: epic-0001
depends: [task-0004]
refs: [adr-0010]
scope:
  paths: ["packages/banto-host/**", "tests/acceptance/**"]
acceptance:
  - { id: a1, text: "論理名（<domain>.<verb>、ドット区切り）とwire名（LLM APIへ渡す関数名）の相互変換関数が実装され、変換が単射であること（異なる論理名が同じwire名に潰れない）が保証されている" }
  - { id: a2, text: "単射性が命名規則側で構造的に保証される（セグメント内の連続アンダースコアを禁止し、曖昧になる名前は登録時に例外）。ToolRegistryは加えて防御的にwire名衝突を検出する（I2）" }
  - { id: a3, text: "createBantoHostSession() がpi/LLMへwire名でToolを登録し、番頭側のコード・ログは論理名で扱える（wire名からの逆引きが可能）" }
  - { id: a4, text: "npm run build・npm run typecheck・npm test がリポジトリ全体で通る" }
---

## 背景

ADR-0010 決定22 より。task-0004 の実機デモで、決定9のドット区切りTool名（`kobo.query.ready`）をそのまま wire 名として opencode-go（deepseek-v4-flash、openai-completions互換API）へ渡すと `400 Upstream request failed` で拒否されることが判明した。同じToolをアンダースコア名にすると正常動作する。決定22は「決定9のドット記法は契約・論理層で維持し、wire層のプロバイダ差異はToolアダプタが吸収する」と定めた。本タスクはそのアダプタ本体の実装。

`canvas.*`・`memory.*` など今後追加する名前空間付きToolすべてが同じ制約を受けるため、他のTool実装より先に片付ける前提工事。

## スコープ外

- 実Kobo Tool（`kobo.query.ready` 等）の実装本体（別タスク。本タスクは変換機構のみ）
- プロバイダごとの制約の網羅的な調査・分岐（現状は「ドット不可」の1点に対応する単一の変換規則で足りる。プロバイダ別分岐が必要になった時点で拡張する。P1：先回りしない）
