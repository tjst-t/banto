---
id: task-0050
type: task
kind: feature
title: Markdown プレビュー（react-markdown + remark-gfm。既存依存）
status: draft
parent: epic-0011
refs: [2026-07-30-file-browser-preview-mode]
scope:
  paths: ["packages/banto-web/src/views/FileBrowser.tsx", "packages/banto-web/src/styles.css"]
acceptance:
  - { id: a1, text: ".md ファイルを開くとレンダリング表示される（見出し・リスト・リンク・テーブル・引用・コードブロック）" }
  - { id: a2, text: "GFM 拡張（テーブル・タスクリスト・取り消し線）が効く" }
  - { id: a3, text: "既存の .markdown クラスのスタイルが適用される" }
  - { id: a4, text: "2000行を超えるファイルは preview を無効化し source 表示にフォールバック" }
  - { id: a5, text: "npm run build・npm run typecheck:web が通る" }
---

## 背景

提案の採用項目1。`react-markdown`（^10.1.0）と `remark-gfm`（^4.0.1）は既に banto-web の依存にあり、D6 により追加不要。CSS は既存の `.markdown` クラス（`styles.css`）を流用する。巨大ファイル対策として、現在の `maxLines` 制限と同じ 2000 行を超える場合は preview を無効化し source 表示にフォールバックする。

## スコープ外

- preview/source トグル・折り返しトグル（task-0051）
- Markdown 内コードブロックのシンタックスハイライト（task-0052）
- Markdown 内 ` ```mermaid ` コードブロックのレンダリング（task-0053）
- 画像プレビュー（workspace モジュール側の API 拡張が必要。epic-0011 スコープ外）
