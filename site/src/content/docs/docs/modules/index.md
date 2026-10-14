---
title: モジュールの概要
description: banto に組み込まれているモジュールと、その使い方。
---

モジュールは、banto に機能を追加するコンポーネントです。同じモジュールを AI と人の両方が利用します。

- **AI から**：ツールとして呼び出します。たとえば Shell の `runCommand` でコマンドを実行します。
- **人から**：画面（Canvas）で操作します。サイドバーのモジュールの入口や、会話の中のカードから開きます。

AI が開いた画面を人がそのまま操作したり、人が見ている画面について AI に相談したりできます。

## 組み込みのモジュール

### 作業

| モジュール | 機能 |
|---|---|
| [Shell](/docs/modules/shell/) | コンテナ内でのコマンドの実行。時間のかかるコマンドはバックグラウンドで実行 |
| [FileSystem](/docs/modules/filesystem/) | ファイルの読み書きと、ファイルの内容の表示 |
| [Terminal](/docs/modules/terminal/) | 人が操作するターミナル |
| [Browser](/docs/modules/browser/) | AI と人が共有するブラウザ |
| [Subagent](/docs/modules/subagent/) | 別の AI エージェント（Claude Code、OpenCode）への作業の依頼 |

### サービスの実行と公開

| モジュール | 機能 |
|---|---|
| [Service と Publish](/docs/modules/service/) | 開発サーバーなどの常駐と、ログイン付きの URL での公開 |

### シークレット

| モジュール | 機能 |
|---|---|
| [Vault](/docs/modules/vault/) | API トークンや SSH 鍵の保管。AI には参照名だけを渡す |

### 開発フロー

| モジュール | 機能 |
|---|---|
| [Repositories](/docs/modules/repositories/) | リポジトリの一覧、GitHub からのクローンと新規作成 |
| [Backlog](/docs/modules/backlog/) | ストーリー・タスク・バグの管理 |
| [Factory](/docs/modules/factory/) | タスクの実装からマージまでの自動化 |

## モジュールの範囲

モジュールには、動作する場所によって2種類あります。

| 種類 | 例 | 動作する場所 |
|---|---|---|
| banto 全体で1つ | Vault、Repositories、Publish | banto 本体のサーバー。すべてのプロジェクトから使える |
| プロジェクトごと | Shell、FileSystem、Backlog、Factory など | プロジェクトのコンテナの中 |

プロジェクトで使うモジュールは、プロジェクトの設定の「Module」で追加・削除・設定できます。Shell・FileSystem・Vault・Repositories は標準で組み込まれており、削除できません。

## モジュールを追加する

組み込みのモジュールのほかに、MCP（Model Context Protocol）に対応したサーバーをモジュールとして追加できます。プロジェクトの設定の「Module」から、MCP Registry を検索する、URL を指定して接続する、設定の JSON を貼り付ける、のいずれかの方法で追加します。
