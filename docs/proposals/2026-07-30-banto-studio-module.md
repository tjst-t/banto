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

**一部採用。task-0031 で実装（2026-07-30、番頭裁定）。**

### 採用したもの

- **skill.viewer** — 計画に無かった本物の穴。決定18 の基本GUIセットにも入っておらず、
  番頭の手続き記憶を人が確かめる手段が無かった。出所（決定26 の層：番頭核／モジュール）も
  見えるようにした
- **memory.viewer（閲覧のみ）** — 記憶を見る部分だけ先に入れた

### 採用しなかったもの

- **記憶の編集・削除** — `task-0023`（記憶ビューア）が既に、より詳しく規定している：削除は
  追記で表して有効な記憶は読み出し時に導出する（D3）、出所（明示保存／自動抽出）の可視化、
  訂正済みの履歴。GUI側の都合でこの設計を先取りせず、task-0023 に残す
- **skill.create / update / delete** — SKILL の書き込みは決定26 の**学習層**（task-0017）に
  属する。「番頭の学習が既定を上書きする3層構成」をどう実装するかが決まる前に、GUIから
  書ける口だけ作ると層が崩れる

### 構成の変更点

提案は banto-studio モジュールが `memory.update` / `skill.create` 等の**Toolを番頭に提供する**
形だったが、**`memory.*` / `skill.*` のドメインは Banto 中核の持ち物**（決定27a）。所有を
モジュールへ移すと、中核が自分の記憶に触れなくなる。

そこで studio モジュールは番頭向けの Tool を持たず（`tools: []`）、GUI と、その GUI が
データを取る口（`studio.*`、task-0026 で入れた `internalTools`）だけを提供する形にした。
決定25 の「人の経路とAIの経路は別。契約は1つ」がそのまま当てはまる。
