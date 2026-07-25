---
id: adr-0006
type: adr
status: accepted
refs: [spec-environment, spec-multi-project, principles, adr-0002, adr-0007]
---

# ADR-0006: 実行環境は Provider をシステム登録＋プロジェクト割当、環境の具体情報は非コミットで注入

## 文脈

spec-environment はドライバ（`process` / `docker` / proxmox-vm）と `meta/environments.yaml` のプロファイルを定義済み。全体像設計プロトタイプで、POが次を求めた：**Provider（実行環境バックエンド）はシステムレベルで登録し、その中からプロジェクトに使えるリソースを割り当てたい。テスト環境の具体情報（エンドポイント・認証・リソース）を git リポジトリにコミットするのはおかしいので、banto がコンテキストに注入したい。加えて Main と開発ブランチの動作を常に触れるようにしたい**。

## 決定

- **Provider（ドライバ＋接続先＋リソースプール＋認証参照）はシステムレベルで登録**する（Docker（ローカル）/ process / Proxmox VM プール 等）。
- 各プロジェクトには、登録済 Provider から使える環境プロファイル（dev / test / staging）を**割り当てる**。プロジェクトの `environments.yaml` には**プロファイル参照名のみ**を書き、**具体情報（認証・エンドポイント・リソース仕様）はコミットせず banto が実行時に注入**する（spec-environment §4 の credentials 原則を Provider 全体へ拡張。秘密の保存は ADR-0007＝sops）。
- ライフサイクル動詞（provision / deploy / healthcheck / run / collect / teardown / list）・台帳・TTL・quota・照合（reconcile）は従来どおり daemon が執行する（spec-environment §2/§5）。ドライバを起動するのは常に daemon であり、エージェントが Provider を直接叩く経路は提供しない（I1）。
- **Main は常設環境として常に起動**し（いつでも触れる）、開発ブランチ/タスク環境は Provider 上に TTL 付きで立てる。どちらも App（共有ブラウザ）/ Terminal で触れる。

## 帰結

- (+) 環境の秘密・具体情報が repo（契約層）から分離され、契約は「参照」だけを持ち可搬・レビュー可能を保つ
- (+) 物理資源（Proxmox プール等）を一元管理し、プロジェクト間で共有・割当できる（spec-multi-project §1 グローバル資源）
- (+) Main を常に触れることで、レビューだけでなく現行動作の確認が常時可能になる
- (−) Provider 登録・割当のデータモデル、注入経路の権限分離を実装で固める。「エージェントに秘密を出さない」（spec-environment §4）を厳守する
- spec-environment に「Provider のシステム登録＋プロジェクト割当」の観点を追記する（P3）
