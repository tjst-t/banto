---
id: spec-environment
type: spec
status: draft
refs: [vision, principles, adr-XXXX-environment-contract]
---

# Spec: 評価環境（Environment）

エージェントが実装物を動かして検証するための環境（dev server、テストコンテナ、外部VM等）の定義・提供・回収の仕組み。

形式化と自由の線引み：**システムはライフサイクル動詞・台帳・掃除・権限分離を形式化する。環境の中身（技術・OS・デプロイ方法）はプロジェクトの自由とする**（→ vision非目的「汎用CI/クラウド管理基盤にはしない」）。

## 1. 環境プロファイル

環境はプロジェクトの `meta/environments.yaml` に**プロファイル**として定義する。タスク定義は `environment: <profile名>` で参照するだけで、環境の詳細を持たない。

```yaml
# meta/environments.yaml
profiles:
  dev:                # レビュー用dev server
    driver: process
    config: { cmd: "npm run dev", port: 5173 }
    ttl: 8h
  test:               # 監査・マージ前ゲート用
    driver: docker
    config: { compose: docker/test.yaml }
    ttl: 30m
  staging:            # 外部VM評価用
    driver: ./meta/drivers/proxmox-vm
    config: { template: 9000, node: pve1, size: medium }
    credentials: staging-pve      # 参照名のみ。実体は書かない（→ §4）
    ttl: 24h
    quota: { max_instances: 2 }
```

- `driver`: ビルトイン名（`process` / `docker`）またはプロジェクト内実行ファイルへのパス
- `ttl`: 生存期限。超過分はdaemonが強制teardownする
- `quota.max_instances`: プロファイルごとの同時実行上限。執行はdaemon（→ §5）
- `credentials`: シークレットの参照名。実体はsops管理でこのファイルには書かない

**統一原則**：レビュー用dev server、監査時のテスト実行、自己更新の隔離検証、外部VM評価は、すべてこの同じ抽象の上で行う。環境提供の仕組みを複数作らない（→ D3, D4）。

## 2. ドライバ契約

ドライバは**動詞をサブコマンドに持つ実行ファイル**。入力は引数＋stdin(JSON)、出力はstdout(JSON)。exit 0以外は失敗。

| 動詞 | 入力 | 出力 | 規約 |
|---|---|---|---|
| `provision` | config JSON | `{handle: {...}}` | handleは不透明JSON。daemonは中身を解釈しない |
| `deploy` | handle, artifact path | — | 成果物の配置・反映 |
| `healthcheck` | handle | `{ok: bool, detail?}` | 起動完了・疎通の判定 |
| `run` | handle, cmd | `{exit: int, log_path}` | 検証コマンドの実行。ログはファイルで返す |
| `collect` | handle, dest dir | — | ログ・成果物の回収 |
| `teardown` | handle | — | **冪等必須**。対象が既に無い場合は成功扱い |
| `list` | — | `[{handle, name, created}]` | ドライバが管理下に持つ全リソースの列挙。照合(→ §5)に使う |

- ビルトインドライバは `process`（ローカルプロセス起動）と `docker`（compose）の2本のみ
- ドライバの追加要件：管理下リソースには**taskIDプレフィックスの命名**を適用すること（例：`task-0042-staging`）

## 3. daemonとの関係・エージェントからの利用

- ドライバを起動するのは**常にdaemon**。実行者エージェントは `env deploy staging` 等の**動詞ツール**（Extension Pack）を呼び、ツールはdaemonへのリクエストに変換される
- エージェントプロセスとドライバプロセスは分離される。エージェントがドライバを直接実行する経路、Hypervisor/クラウドAPIを直接叩く経路は提供しない（→ I1、「ずるは不可能にする」）
- レビューフローとの接続：タスクがreviewフェーズに入ると、daemonはタスク定義の `environment` をprovisionし、tmuxウィンドウのペイン2に接続する

## 4. 認証情報（credentials）

原則：**credentialsはエージェントのコンテキストとツール結果に一度も現れない**。

- 実体はsops等で暗号化管理。`environments.yaml` には参照名のみ
- daemonが復号し、**ドライバプロセスの環境変数として直接渡す**（例：`PVE_URL` / `PVE_TOKEN_ID` / `PVE_TOKEN_SECRET`）
- 外部システム側のアカウントは**スコープ済み**にする：専用リソースプール/プレフィックス内の作成・削除のみ可能な権限に限定し、動詞が乱用されても被害がプール内で止まるようにする（→ §7）

## 5. 台帳・TTL・quota・照合

制限の執行はドライバではなく**daemonの台帳**が行う。

- **台帳**：provision成功時、handleを台帳（永続化）に登録。タスク終了時にdaemonがteardownを保証する
- **quota**：provision要求時に台帳を参照し、`max_instances` 超過なら拒否
- **TTL**：超過した環境は強制teardown
- **失敗処理**：teardown失敗はリトライし、なお失敗ならケイデンス議題に載せる
- **照合（reconcile）**：daemonは定期的に各ドライバの `list` と台帳を突合する。台帳に無い実リソース（daemonクラッシュ中に生じた孤児等）を検出し、ケイデンス議題に載せる
- 外部リソースの消し忘れは金銭的実害が出るため、本節が本仕様で最も優先度の高い機構である（→ I3）

## 6. ログ・成果物

- `run` のログ、`collect` の成果物はタスクごとの所定ディレクトリに集約し、監査セッション・レビューセッションのコンテキスト注入元とする
- 収集先パスの規約はdaemonが定め、ドライバは渡された`dest`に書くのみ

## 7. リファレンス実装：Proxmoxドライバ

外部VMドライバの第1号。他のVM/クラウドドライバの雛形とする。

### 7.1 Proxmox側の隔離設定（前提）

- 専用リソースプール `agents` を作成。エージェント用VMはすべてここに所属
- 専用ユーザーに**APIトークン**を発行（privilege separation有効）。失効・ローテーションをトークン単位で行う
- カスタムロールを `/pool/agents` にACL割当：`VM.Allocate`, `VM.Config.*`, `VM.PowerMgmt`, `VM.Audit`, `VM.Monitor`
- **ストレージとネットワークにも限定権限が必要**：`Datastore.AllocateSpace` はエージェント専用ストレージのみに、ネットワークは専用ブリッジ/VLANのみに付与する。`/` への付与は隔離の形骸化なので禁止
- **VMID帯を予約**（例：90000番台）。命名規約と合わせ、照合と目視識別の両方に使う

### 7.2 provision方式

- **テンプレートVMからのlinked clone＋cloud-init**を標準とする（provision数十秒以内）
- テンプレートはnixos-generatorsでビルドしたNixOSイメージを登録。テンプレート更新はNix式の変更としてGit管理する
- cloud-initはIP・SSH鍵の注入のみに使い、構成はNix側に寄せる
- テンプレートにはQEMU guest agentを同梱すること（healthcheckに必要）

### 7.3 動詞の対応

| 動詞 | 実装 |
|---|---|
| `provision` | clone API（pool=agents, 予約帯からVMID採番, name=taskIDプレフィックス）→ 起動 → handle `{vmid, node}` |
| `healthcheck` | guest agent ping、またはSSH疎通 |
| `deploy` / `run` | SSH経由。鍵はcloud-init注入分をdaemon→ドライバの環境変数経路で受け取る |
| `collect` | SSH/scpでdestへ回収 |
| `teardown` | stop → VM削除。**404は成功扱い**（冪等） |
| `list` | プール `agents` のメンバー列挙 |

### 7.4 可視性の保険

provision時、VMのnotesまたはタグに `expires: <timestamp>` を書き込む。daemon停止期間中の孤児も、Proxmox UIを開くだけで期限切れが目視できるようにする。

## 8. 未決事項

- ビルトイン `docker` ドライバのcompose以外（単一コンテナ）対応の要否
- `run` のタイムアウト規約（daemon側で一律か、プロファイルごとか）
- 隔離検証（自己更新パイプライン）用プロファイルの標準名
