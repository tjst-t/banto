---
id: task-0055
type: task
kind: feature
title: diff/patch の色分け表示（unified）
status: draft
parent: epic-0011
refs: [2026-07-30-file-browser-preview-mode]
scope:
  paths: ["packages/banto-web/src/views/FileBrowser.tsx", "packages/banto-web/src/styles.css"]
acceptance:
  - { id: a1, text: ".diff / .patch ファイルが行単位で色分け表示される（追加行=緑、削除行=赤、ハンクヘッダ=青）" }
  - { id: a2, text: "既存の gv-add / gv-del / gv-hunk スタイルを流用する" }
  - { id: a3, text: "npm run build・npm run typecheck:web が通る" }
---

## 背景

提案の採用項目4。依存追加なし（D6）。行頭の文字（`+` / `-` / `@@`）で判定し、GitViewer の既存 `gv-diff` スタイル（`gv-add` / `gv-del` / `gv-hunk`）を流用して色分けする。

## スコープ外

- diff/patch の side-by-side 表示（今回は unified のみ。epic-0011 スコープ外）
- ハンクヘッダの行番号オフセット解析（side-by-side 用。本タスクでは不要）
