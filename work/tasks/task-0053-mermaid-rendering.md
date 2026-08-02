---
id: task-0053
type: task
kind: feature
title: Mermaid レンダリング（mermaid.js 動的インポート）
status: draft
parent: epic-0011
refs: [2026-07-30-file-browser-preview-mode]
scope:
  paths: ["packages/banto-web/package.json", "packages/banto-web/src/views/FileBrowser.tsx"]
acceptance:
  - { id: a1, text: ".mmd / .mermaid ファイルが SVG にレンダリング表示される" }
  - { id: a2, text: "Markdown 内の ```mermaid コードブロックがレンダリングされる" }
  - { id: a3, text: "mermaid は動的インポートで遅延読み込みする（約700KB を初回ロードに載せない）" }
  - { id: a4, text: "npm run build・npm run typecheck:web が通る" }
---

## 背景

PO 裁定 2026-08-02 で採用。Mermaid は JS ネイティブでローカル完結（外部送信なし）のため、図の形式として番頭が第一に推す。Markdown のコードブロックにそのまま書ける（図とテキストが同じファイルに収まる）。mermaid.js（約700KB、minified）は動的インポート（`import("mermaid")`）で遅延読み込みし、初回ロードに載せない。Markdown 内のコードブロックは `react-markdown` の `components.code` でフックし、`.mmd` / `.mermaid` ファイルは内容を直接 `mermaid.render()` に渡す。

## スコープ外

- PlantUML レンダリング（描画先 URL の設定機構が要るため別タスク。epic-0011 スコープ外）
- draw.io レンダリング（`@maxgraph/core` は依存追加を伴うため保留）
