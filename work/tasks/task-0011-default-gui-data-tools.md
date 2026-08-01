---
id: task-0011
type: task
kind: feature
title: 基本GUIセットのデータ側Tool（ファイル・Git閲覧）をBanto既定として実装
status: draft
parent: epic-0002
depends: [task-0006]
refs: [adr-0010]
scope:
  paths: ["packages/banto-host/**", "tests/acceptance/**"]
acceptance:
  - { id: a1, text: "file.list / file.read が名前空間規則に従うToolとして実装され、ディレクトリ一覧とファイル内容を返す" }
  - { id: a2, text: "git.diff / git.log / git.status / git.branches / git.blame が実装され、すべて読み取り専用である（変更操作を持たない）" }
  - { id: a3, text: "これらがKoboにもWorker Poolにも接続せず、ローカルのgitリポジトリだけで動作し検証できる" }
  - { id: a4, text: "gitコマンドの失敗（リポジトリ外・不正なrev等）が握りつぶされずエラーとして返る（I2）" }
---

## 背景

ADR-0010 決定18・決定24 より。基本GUIセット（ファイル／ディレクトリ表示・Git閲覧・ブラウザビュー・シェル・セッションビューア）は Kobo の Extension Pack が登録するプラガブルGUIとは別枠で、**Banto が既定で持つ**——Kobo が無くても価値のある汎用GUIだからである。決定24 でGit閲覧系（履歴・状態・ブランチ・blame）が追加され、閲覧専用と定められた（変更操作は職人へ委譲。D10。またKoboのマージキューと責務が競合するため）。

GUI部品（Reactコンポーネント）はキャンバスが要るため epic-0002 の後続だが、**その裏にあるデータ側 Tool はキャンバスより先に作れて、端末でも検証できる**。本タスクはそのデータ側のみを対象とする。決定17 によりカタログエントリは「Tool契約＋component参照」なので、ここで作る Tool 契約がそのままカタログの土台になる。

## スコープ外

- Reactコンポーネント・キャンバス描画・GUIカタログ本体（epic-0002 の後続タスク）
- ブラウザビュー（CDP転送）・シェル・セッションビューア（それぞれ別タスク。セッションビューアは Worker Pool 側＝epic-0005 に依存）
- Git の変更操作（決定24で持たないと決定済み）
