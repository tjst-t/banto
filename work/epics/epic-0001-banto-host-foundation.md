---
id: epic-0001
type: epic
title: 番頭核ホストの実装基盤（pi SDK統合・Tool/SKILL基盤・記憶システム）
status: draft
refs: [adr-0009, adr-0010]
---

## 目的

Banto ホスト（番頭核）を、pi Agent SDK の上に実際に立ち上げる。ADR-0010 決定9〜11・15 で決めた土台（Tool/SKILL契約の形状・pi SDKモードでのターンループ埋め込み・記憶システムの自前実装方針・ADR/specからwork/への引き継ぎ運用）を、実際に動くコードとして banto-core・新規 `packages/banto-host` に落とす。

## ユースケース

- 開発者が `packages/banto-host` を起動すると、pi Agent SDK を使った最小限のエージェントセッションが立ち上がる
- Tool 定義が決定9の名前空間規則（`kobo.*` / `canvas.*` 等）に従って banto-core に登録され、番頭がターン内で呼び出せる
- 番頭は自分の手続き記憶（SKILL.md、agentskills.io形式）を読み込んで従える。最初のSKILLは「ADR/spec確定時のwork/起票」（決定15）
- 番頭が「好み・習慣」を蓄積し、次回のセッションで参照できる（Hermesの三層メモリ設計のうち第一層）

## スコープ外

- キャンバス・GUIカタログ・Reactコンポーネント埋め込み（epic-0002）
- Kobo/Banto の一体的デプロイ（epic-0003）
- セッション開始リクエストの受信処理（epic-0004）
- 記憶システムの三層すべての完全実装（第一弾は好み・習慣の蓄積のみ。SKILL自動蒸留・セッション横断検索は後続）
