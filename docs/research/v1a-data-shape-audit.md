---
id: research-v1a-data-shape-audit
type: research
status: accepted
refs: [followup-directive-2026-07, research-orchestrator-survey]
---

# v1a 永続データ形状監査（フォローアップ指示書 Phase 1）

実施日: 2026-07-24。対象: マイルストーンM01完了時点の実装(banto-core / banto-daemon)とタスクスキーマ。機能実装は行わず、欠落フィールドの追加のみ。

## 1. イベントログ — **フィールド追加した**

| 項目 | 結果 |
|---|---|
| (a) プロジェクトタグ | OK — `EventBase.projectTag`(全イベント必須) |
| (b) タイムスタンプ | OK — `EventBase.timestamp`(ISO-8601) |
| (c) 起点参照 | **フィールド追加した** — `EventBase.originRef?: string` をoptionalで追加(`packages/banto-core/src/events.ts`)。既存イベントの遡及埋めはしない。値の自動生成は未実装(D8実装のカード生成時に書き手が付与する設計) |

## 2. セッションJSONL — **OK**

- セッションファイルは pi の `--session-dir`(タスクworktree/dataDir配下)に永続され、daemonは削除しない(pi-rpc-driver の `sessions.delete()` はin-memoryマップの整理のみ)
- タスクID→セッションパスの導線は二重にある: (1) `agent_spawned` イベントの `sessionPath`(イベントログ=恒久)、(2) spawn台帳の `sessionPath`(実行中のみ。exitで台帳から除去されるが、イベントログ側が残るため追跡可能)

## 3. ID名前空間 — **OK(注記1件)**

- `<project>/<id>` 解決: OK — StateStore/EventIndexは複合キー(projectTag/taskId)、APIは `GET /api/v1/tasks/:proj/:id` でグローバル参照を解決(spec-multi-project §2)
- **注記(採番の一元化)**: 採番サービスは未実装。現状IDはタスク定義ファイルの手書き(`task-\d{4,}` 形式をスキーマ検証、プロジェクト内重複はdaemonが拒否)。調査文書A-2「参考」の「採番がdaemon経由ツールに一元化されている」は**将来形**であり、enqueue系ツール(検討セッション/Extension Pack、Sprint S24ddde)実装時に一元化される。現時点で衝突リスクは重複拒否で抑止されており構造的問題ではないが、オフライン採番の未決事項(Phase 2でschemasに追記)と併せて認識しておくこと

## 4. タスクスキーマ — **OK**

- `scope.paths`: OK — 必須フィールド(glob配列、検証あり)
- `refs`: OK — optionalフィールドとして定義・パース済み(`task-frontmatter.ts`)

## 総括

- OK: 3項目(うち注記1件) / フィールド追加: 1項目(EventBase.originRef) / 構造的問題: **0件**
- 追加フィールドの後方互換: optionalのためリプレイ・スナップショット・既存テストへの影響なし(全suiteグリーンで確認)
