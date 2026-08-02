---
id: task-0051
type: task
kind: feature
title: preview/source 表示トグルと source 折り返しトグル
status: draft
parent: epic-0011
refs: [2026-07-30-file-browser-preview-mode]
scope:
  paths: ["packages/banto-web/src/views/FileBrowser.tsx", "packages/banto-web/src/styles.css"]
acceptance:
  - { id: a1, text: "内容部ヘッダ（.fb-preview-head）右端に preview/source のセグメントトグルが表示される" }
  - { id: a2, text: "既定は preview モード（レンダリング表示）" }
  - { id: a3, text: "source モードのときだけ「折り返し」チェックボックスが表示され、ON で .fb-code が折り返し表示（white-space: pre-wrap）になる" }
  - { id: a4, text: "トグルの状態はコンポーネントのローカル state で持ち、ファイル切替・タブを閉じるとリセットされる" }
  - { id: a5, text: "モード切替時にスクロール位置を割合で復元する" }
---

## 背景

提案の採用項目2・3。内容部ヘッダ（`.fb-preview-head`）右端に preview/source のセグメントトグルを置く（デフォルト preview）。source モードのときだけ「折り返し」チェックボックスを表示し、ON で `.fb-code` に `white-space: pre-wrap; overflow-wrap: anywhere` を適用する（既定 OFF＝現状の横スクロール表示を維持）。折り返しトグルは提案の分割単位では別項目だが小さいため本タスクに含める。トグル状態は URL パラメータやグローバルステートには保存せず、コンポーネントのローカル state で持つ。スクロール位置は切替前後の行数の違いを吸収するため割合で復元する。

## スコープ外

- レンダリング表示の中身（Markdown は task-0050、コード色分けは task-0052、Mermaid は task-0053、CSV は task-0054、diff は task-0055）
- トグル状態の永続化（URL パラメータ・グローバルステート・保存）
- 行番号・行強調（from/to）の preview モード対応（source モードでのみ有効のまま）
