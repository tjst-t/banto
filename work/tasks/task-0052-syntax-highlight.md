---
id: task-0052
type: task
kind: feature
title: シンタックスハイライト（shiki）
status: draft
parent: epic-0011
refs: [2026-07-30-file-browser-preview-mode]
scope:
  paths: ["packages/banto-web/package.json", "packages/banto-web/src/views/FileBrowser.tsx"]
acceptance:
  - { id: a1, text: "コード種別ファイル（.ts/.js/.py/.rs/.go 等）が source モードで色分け表示される" }
  - { id: a2, text: "Markdown プレビュー内のコードブロックにも shiki が適用される" }
  - { id: a3, text: "shiki は動的インポートで遅延読み込みし、初回ロードに影響させない" }
  - { id: a4, text: "テーマ切替（ライト／ダーク）ができる" }
  - { id: a5, text: "npm run build・npm run typecheck:web が通る" }
---

## 背景

PO 裁定 2026-08-02 で採用。依存追加（shiki）は D1 だが PO 裁定済み。VS Code と同じパーサ（TextMate 文法）による高品質なハイライトで、Markdown 内のコードブロックとソースコードファイルの両方に同一エンジンを使い回せる。動的インポートで遅延読み込みし、初回ロードへの影響を避ける。テーマ切替（`github-light` / `github-dark` 等）に対応する。

## スコープ外

- ハイライト対象拡張子リストの拡充（都度の追加とする）
- `highlight.js` 等の代替エンジン（shiki で代替可のため採用しない）
- エディタ機能（補完・lint 等）— 表示専用
