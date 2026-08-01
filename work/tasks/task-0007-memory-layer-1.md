---
id: task-0007
type: task
kind: feature
title: 記憶システム第一層（好み・習慣）のMemoryStoreとJSONL実装
status: draft
parent: epic-0001
depends: [task-0004]
refs: [adr-0010]
scope:
  paths: ["packages/banto-core/src/memory.ts", "packages/banto-core/src/index.ts", "tests/acceptance/**"]
acceptance:
  - { id: a1, text: "保存形式に依存しない MemoryStore インターフェース（save / get / list / supersede）が定義され、呼び出し側がファイル操作を直接触らない" }
  - { id: a2, text: "追記のみのJSONL実装が提供され、プロセスを跨いで記憶が保持される（保存→別インスタンスで読み直し）" }
  - { id: a3, text: "記憶の訂正が supersede で表現でき、active な記憶のみが既定で返る。導出できる状態（active/superseded）はファイルに保存せず再生で導く（D3）" }
  - { id: a4, text: "受け入れテストが MemoryStore インターフェースに対して書かれ、将来のSQLite実装でも同一テストで等価性を検証できる" }
  - { id: a5, text: "npm run build・npm run typecheck・npm test がリポジトリ全体で通る" }
---

## 背景

ADR-0010 決定10 より。番頭の定義そのものが「記憶を持つ」ことであり（D11：番頭は記憶を持つ、職人は持たない）、記憶なしでは番頭核は成立しない。決定10は Hermes Agent 本体を組み込まず、その三層メモリ設計を参考に banto-core 内へ薄く自前実装すると定めた。本タスクはその第一層（(a) 好み・習慣の蓄積）のみを対象とする。

保存方式は JSONL（追記のみ）とする。決定10は「SQLite等の標準的な構成要素」を挙げるが、本リポジトリの実行環境は Node 20 系で `node:sqlite`（Node 22.5+）が使えず、SQLite の採用は外部ネイティブ依存の追加（D1）か Node 要件の引き上げを伴う。第一層は好み・習慣の少量データで全文検索を必要としないため、まず標準ライブラリのみで実装し（D6）、全文検索が要る第三層（セッション横断検索）の着手時に SQLite を再検討する。将来の差し替えコストは `MemoryStore` インターフェース（a1）と、インターフェースに対して書かれたテスト（a4）で抑える——PO 確認済み（2026-07-29）。

## スコープ外

- 第二層（タスク完了ごとの SKILL.md 自動蒸留）・第三層（FTS5全文検索＋LLM要約によるセッション横断検索）
- SQLite 実装本体と JSONL からの移行スクリプト（全文検索が必要になった時点で別タスク）
- 記憶を番頭に読ませる `memory.*` Tool と自動注入（別タスク。本タスクは保存層のみ）
