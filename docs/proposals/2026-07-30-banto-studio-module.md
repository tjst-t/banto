# banto-studio モジュール提案

## 現状

キャンバスに開けるGUIの一覧（canvas.list_catalog）には file.browser / git.viewer / worker.viewer / demo.hello / demo.clock しかなく、記憶やSKILLをGUIで操作する手段が無い。現在は番頭が memory.save / memory.recall / skill.list / skill.read のToolを直接呼ぶ形で、視覚的な確認や編集ができない。

## 提案

banto-studio モジュールを新設し、以下の2つのGUIを追加する。

### GUI 1: memory.explorer

- 記憶（好み・習慣）を一覧表示する
- 種別（preference / habit）でフィルタ可能
- 各記憶の内容を表示・編集できる
- 新しい記憶を追加できる（memory.save）
- 記憶を削除できる

### GUI 2: skill.explorer

- SKILL一覧を表示する（skill.list）
- 各SKILLの内容を表示・編集できる（skill.read）
- 新しいSKILLを作成できる
- SKILLを削除できる

## モジュール構成（ADR-0010 4点セット）

| 要素 | 内容 |
|---|---|
| 接続情報 | 記憶の保存先パス・SKILLファイルの配置場所を登録時に指定 |
| 番頭へのTool | memory.update / memory.delete / skill.create / skill.update / skill.delete |
| キャンバスGUI | memory.explorer / skill.explorer |
| SKILL | （任意）GUI操作手順のSKILL化 |

## 既存Toolとの関係

- memory.save（既存）→ 新規保存にそのまま使う
- memory.recall（既存）→ 一覧表示のデータ取得に使う
- skill.list / skill.read（既存）→ 一覧・内容表示にそのまま使う
- **不足しているTool**: 記憶の編集・削除、SKILLの書込み・削除は現状Toolが無いため、モジュール側で追加が必要

## 作成日

2026-07-30

## 状態

draft
