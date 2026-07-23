---
id: spec-schemas
type: spec
status: draft
refs: [spec-document-system, spec-daemon-core, spec-improvement-loop, spec-environment]
---

# Spec: スキーマ（frontmatterフィールド定義）

各ドキュメントtypeのfrontmatterフィールドの正式定義。JSON Schemaの実体は `meta/schemas/<type>.json` に置き、本仕様はその規範的な記述とする。

共通規律（→ spec-document-system §2）：
- フィールドは**daemonが分岐に使うものだけ**。散文で足りる情報は本文へ
- **statusは遅い状態のみ**。daemonがファイルへ書き戻すのは終端遷移（クローズ時に1回）に限る。実行時状態（フェーズ）はイベントログが持つ
- IDはtype別プレフィックス＋4桁連番（`task-0042`）。採番はツールが行う。ファイル名は `<id>-<slug>.md`

## 1. task（実行契約）

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `id` | string | ✓ | `task-NNNN` |
| `type` | `task` | ✓ | |
| `kind` | enum | ✓ | `feature` / `fix` / `batch` / `refactor` / `conflict`（解消タスク）/ `improvement` |
| `title` | string | ✓ | 1行 |
| `status` | enum | ✓ | `draft` / `queued` / `done` / `failed` / `superseded` / `cancelled`。daemonが書くのは終端3種＋`failed` のみ |
| `resolution` | string | | 終端時にdaemonが記録する1行（supersede先ID等） |
| `parent` | id | | 所属Epic |
| `depends` | id[] | | 明示的依存。依存駆動ゲートの入力 |
| `refs` | id[] | | 注入されるspec/ADR/改善項目。**実行者のコンテキストはこれで閉じる** |
| `scope.paths` | glob[] | ✓ | スコープ内パス。①依存ゲートの重複判定 ②P1執行 ③classifyの機械層、の3つに使う |
| `acceptance` | list | ✓ | `{id, text, verify?}`。`verify` は機械検証コマンド（あればマージ前ゲートでdaemonが実行。→ I1） |
| `items` | list | batch時✓ | `{id, text, done}`。バッチの内訳チェックリスト |
| `environment` | string | | 環境プロファイル名（→ spec-environment §1）。レビュー・ゲートで使用 |
| `review.policy` | enum | | `auto` / `sampled` / `mandatory`。省略時は kind × governance × 実績から`meta/config.yaml` の規則で導出。明示は上書き |
| `governance` | bool | | 統治コード変更フラグ。trueは強制mandatory・バッチ混載禁止 |
| `hypothesis` | object | improvement時✓ | `{expect, metric, horizon}`。`metric: none` 可（→ spec-improvement-loop §5） |
| `order` | number | | Nextレーン内の並び順（GUI/検討セッションが編集） |
| `model_tier` | enum | | `reasoning` / `standard` / `fast`。省略時は役割×kindの既定表から導出（→ spec-daemon-core §3.5）。明示は上書き |

本文の必須見出し：`## 背景` `## スコープ外`。任意：`## 実装メモ`。

例：

```yaml
---
id: task-0042
type: task
kind: feature
title: バックリンクパネルの表示
status: queued
parent: epic-0003
depends: [task-0040]
refs: [spec-editor-state, adr-0007]
scope:
  paths: ["src/panel/**", "src/state/backlinks.ts"]
acceptance:
  - { id: a1, text: リンク元一覧が表示される }
  - { id: a2, text: クリックで該当ノートへ遷移する }
  - { id: a3, text: 500ノートで100ms以内, verify: "npm run bench:backlinks" }
environment: dev
order: 3
---
```

## 2. epic

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `id` / `type` / `title` | | ✓ | `epic-NNNN` |
| `status` | enum | ✓ | `draft` / `active` / `done` / `cancelled` のみ。**これ以上の状態管理を意図的に持たない**。進捗はGUIが `parent` 集計で導出 |
| `refs` | id[] | | 関連spec/ADR |

本文見出し：`## 目的` `## ユースケース`（受け入れセッションの台本になる）`## スコープ外`。

## 3. adr

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `id` / `type` | | ✓ | `adr-NNNN` |
| `status` | enum | ✓ | `draft` / `accepted` / `superseded` |
| `supersedes` | id | | 置換対象。逆方向（superseded_by）はインデックス生成で導出し、ファイルには書かない |
| `refs` | id[] | | 起点タスク・関連spec |

本文の必須見出し：`## 文脈` `## 決定` `## 帰結`。本文は追記のみ、書き換え禁止。

## 4. design-request（design-inbox）

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `id` / `type` | | ✓ | `dsg-NNNN`、type: `design-request` |
| `mode` | enum | ✓ | `advisory` / `blocking` |
| `task` | id | ✓ | 発生元タスク。blockingならdaemonがこれをpausedにする |
| `status` | enum | ✓ | `open` / `resolved` / `rejected` |
| `refs` | id[] | | ADRドラフト・同期QAログ等 |

## 5. improvement（improvement-inbox）

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `id` / `type` | | ✓ | `imp-NNNN`、type: `improvement` |
| `kind` | enum | ✓ | `incident` / `friction` / `proposal` / `sensor-gap` / `rca` |
| `origin` | enum | ✓ | `system` / `po` / `agent`（→ spec-improvement-loop §2） |
| `class` | string | ✓ | 失敗クラス語彙（初期語彙は運用で育てる。集計・照合キー） |
| `status` | enum | ✓ | `open` / `pattern`（同型集約済）/ `tasked` / `resolved` / `rejected` / `reverted` |
| `refs` | id[] | | 発生元タスク、対処タスク、類似imp |
| `resolution` | string | | 終端時の1行（keep/revert理由、reject理由）。**reverted項目は類似提案の照合対象**（→ spec-improvement-loop §5） |

## 6. spec / vision / principles / roadmap（docs/散文ゾーン）

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `id` / `type` | | ✓ | typeは `spec` / `vision` / `principles` / `roadmap` |
| `status` | enum | ✓ | `draft` / `accepted` / `superseded` |
| `refs` | id[] | | |

最小限で固定。フィールド追加は「daemonが分岐に使い始めた」証明を要する。

## 7. 検証と運用

- JSON Schema（`meta/schemas/`）はプロダクト既定として配布し、プロジェクトは拡張フィールドの追加のみ可（既定フィールドの削除・型変更は不可）
- `work/` 配下：watcherがスキーマ検証＋必須見出しチェックを行い、不正コミットを拒否する。`docs/` 配下：検証はするが拒否はしない（警告のみ）
- 生成ツール（`enqueue_task` 等）は雛形（`meta/templates/`）から生成し、採番・検証を通してからコミットする
- スキーマ変更は層B変更として改善ループの正規フローに乗せる。フィールド昇格（散文→frontmatter）はその代表例

## 8. 未決事項

- `class` の初期語彙（運用開始後、最初のケイデンスで最初の版を切る）
- `verify` コマンドの実行環境（environmentプロファイル内で走らせる規約の明文化）
- プロジェクト拡張フィールドの名前空間規約（`x-` プレフィックス等）
