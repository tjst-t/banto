---
id: task-0004
type: task
kind: feature
title: banto-hostパッケージの雛形立ち上げ（pi Agent SDK埋め込み・Tool契約名前空間規則）
status: done
parent: epic-0001
refs: [adr-0009, adr-0010]
scope:
  paths: ["packages/banto-host/**", "tsconfig.json"]
acceptance:
  - { id: a1, text: "packages/banto-host パッケージが作成され、@mariozechner/pi-coding-agent のSDKモードで最小限のエージェントセッション（システムプロンプト・1往復のTool呼び出し）を起動できる" }
  - { id: a2, text: "Tool定義が決定9の名前空間規則（<domain>.<verb>形式、例: kobo.query.ready / canvas.open）に従って型定義・登録関数の土台が用意されている（実際のKobo Tool実装はスコープ外）" }
  - { id: a3, text: "npm run build・npm run typecheck がリポジトリ全体で通る" }
---

## 背景

ADR-0010（`docs/adr/adr-0010-pluggable-harness.md`）決定9・11 より。番頭核ホストはまだ実装ゼロ（handoff.md）。pi coding agent の SDK モードで自前 Node.js ホストプロセスに pi のエージェントループを直接埋め込む方針が決定済み（決定11：Extension API・RPCモードは調査の上不採用）。Tool契約は名前空間プレフィックス方式（決定9）。本タスクはこの2つの決定を、最小限動くコードとして立ち上げる第一歩。

## スコープ外

- 実際の Kobo Tool（`kobo.query.ready` 等）・キャンバス Tool（`canvas.open` 等）の実装本体（土台の型・登録機構のみ。個別Toolは今後のタスクで追加）
- 記憶システムの実装（別タスクとして起票予定）
- GUIキャンバス・React コンポーネント埋め込み（epic-0002）
