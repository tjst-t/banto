---
id: task-0054
type: task
kind: feature
title: CSV/TSV のテーブル表示（papaparse）
status: draft
parent: epic-0011
refs: [2026-07-30-file-browser-preview-mode]
scope:
  paths: ["packages/banto-web/package.json", "packages/banto-web/src/views/FileBrowser.tsx"]
acceptance:
  - { id: a1, text: ".csv / .tsv ファイルがテーブル表示される" }
  - { id: a2, text: "ヘッダ行が強調される" }
  - { id: a3, text: "引用符で囲まれたカンマ・改行を含むセルが正しくパースされる（papaparse の正確なエスケープ処理）" }
  - { id: a4, text: "npm run build・npm run typecheck:web が通る" }
---

## 背景

PO 裁定 2026-08-02 で採用。papaparse（約20KB）は引用符で囲まれたカンマ・改行を含むセルのエスケープ処理が正確。自前パース（行分割→カンマ/タブ split）ではこの正確性が得られないため、依存追加の理由（D6）になる。`.tsv` はタブ区切りとして同じパーサで扱う。

## スコープ外

- 列型推論・並べ替え・フィルタ等の高度なテーブル操作（表示のみ）
- 巨大ファイルの仮想化表示（現在の `maxLines` 制限に従う）
