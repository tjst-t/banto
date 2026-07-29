---
id: epic-0003
type: epic
title: Kobo/Banto 統合デプロイ
status: draft
refs: [adr-0010]
---

## 目的

ADR-0010 決定19 で決めたデプロイ方式を実装する。Kobo・Banto それぞれ独立した systemd ユニットを維持しつつ、起動順序依存（`Wants=`/`After=`）と単一インストーラで、利用者からは一体的な体験に見えるようにする。

## ユースケース

- 開発者/POが単一のインストールスクリプトを実行すると、Kobo・Banto 両方の systemd ユニットが有効化・起動される
- Banto を起動すると、Kobo が未起動なら先に起動してから Banto が立ち上がる
- Banto の Settings › Kobo接続画面で、Kobo の起動状態が可視化される（banto-shell プロトタイプで先取り済みのUIに実データを繋ぐ）

## スコープ外

- バージョン整合性チェックの具体的な実現方法（ADR-0010 未決事項として残置。本エピックのスコープに入れる場合は追って決定してから着手）
- Kobo・Banto 本体の実装そのもの（それぞれ既存実装／epic-0001）
