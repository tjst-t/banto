---
id: spec-daemon-core
type: spec
status: draft
refs: [vision, principles, spec-multi-project, spec-environment, spec-improvement-loop, spec-ui]
---

# Spec: Daemonコア

オーケストレータ本体（Core Daemon）の状態モデル、イベントログ、実行制御、マージ機構、稼働形態の仕様。

原則：daemonは**決定的なコード**であり、制御ループにLLMを置かない（→ D2）。LLMが必要な判断（分解・要約・診断・分類）はSDK単発セッションをスポットで呼ぶ。

## 1. タスクのステートマシン

```
draft → queued → ready → planning → implementing → auditing
  → review-ready → in-review → approved → merging → merged
  → evaluating → closed
```

横断遷移：
- **paused**：blocking設計依頼の発生時（→ 解決で元の状態へ復帰）
- **failed**：回復不能エラー（→ I2。黙って続行せず止まって台帳に残す）
- **superseded**：escalateによる置換
- **quarantine保留**：検疫マーク領域への新規spawn時の保留勧告（→ spec-improvement-loop §8）

規則：
- `queued → ready`：依存駆動ゲートを通過したもののみ（→ spec-multi-project §3。依存グラフ、スコープ重複×未レビュー祖先、物理quota。数値WIPは存在しない）
- `auditing → merging`：マージポリシーが auto のタスクは in-review を経ずに直行（→ spec-improvement-loop §7）
- `merged → evaluating`：hypothesis を持つタスクのみ。horizon経過後に評価カードを生成
- かんばんの Now / Next / Later はこの状態の集約ビューであり、独立した状態ではない

## 2. イベントソーシング

実行時状態はmutableなDBに持たず、**追記専用のイベントログを真実とし、状態はリプレイで導出する**（→ D3：ファイルは意図、イベントログは実行時状態）。

採用理由（設計配当）：
- クラッシュ回復と自己更新時のdaemon引き継ぎが「ログを読み直す」に統一される
- シャドー実行（候補daemonに同一ログを与えて判断差分を検証）が自然に成立する（→ 自動更新パイプライン）
- D8の起点参照（判断要求→POの入力）がイベントIDで機械的に張れる

### 2.1 ログの内容（何を入れないかが本体）

- 記録するのは**オーケストレーションイベントのみ**：状態遷移、spawn/exit、ゲート判定、承認・却下、環境provision/teardown、POの操作、カード生成。1イベント数百バイト規模
- **セッショントランスクリプトは記録しない**。piが持つセッションJSONLへの参照（ファイルパス）のみを持つ
- 全イベントにプロジェクトタグを付与（→ spec-multi-project §1）

### 2.2 構造：グローバル1本＋時間セグメント

- ログは**daemonに1本**（タスク別に分割しない）。キュー順序・quota・照合・依存ゲートはタスク横断の状態であり、分割すると全体順序の再構成問題を生むため
- セグメント化：`events/2026-07.jsonl` のように分割し、追記は常にアクティブセグメント1本のみ
- タスク別ビュー（カードの経緯表示等）はインデックスで導出する

### 2.3 ログのライフサイクル（肥大化の有界性）

ディスク使用量は「スナップショット＋アクティブセグメント＋保持期間分のアーカイブ」で**有界**であること。無限に育つファイルを持たない。

1. **ローテーション**：アクティブセグメントは月次または上限サイズのどちらか早い方で切る（閾値は層B）
2. **スナップショット**：セグメント切替時に導出済み状態＋イベント位置をダンプ。リプレイは常に「最新スナップショット＋アクティブセグメント」のみで、起動コストはログ全長と無関係に一定
3. **ロールアップ**：ケイデンス集計時、閉じたセグメントから統計値（escaped defects、パッチ効率等の時系列）を別ファイルへ抽出。改善ループの長期材料はロールアップ側が担う。ロールアップのエクスポート形式はOTLP互換とし、既製の可視化基盤（Grafana等）を利用可能にする。v1では不要、ロールアップ実装時に形式を寄せる（→ research-orchestrator-survey G）
4. **アーカイブ／削除**：ロールアップ済みセグメントはzstd圧縮でアーカイブし、保持期間（層B。例：生ログ1年、ロールアップ無期限）経過後に削除。**例外：openなタスクが参照するイベントを含むセグメントは削除対象から除外する**

## 3. spawn管理と回復

- **spawn台帳**（永続化）：起動した子プロセス（pid、タスクID、セッションパス、worktree）を登録。daemon再起動時は台帳から孤児を引き取り再接続する（→ 自動更新の前提条件）
- **照合ループ**：spawn台帳・環境台帳と実態（プロセス、ドライバ `list`）を定期突合し、差分をケイデンス議題に載せる（→ spec-environment §5）
- **健康状態taxonomy（v1.x）**：照合ループはエージェント健康状態を導出する：`working` / `stalled`（進捗低下）/ `no-progress`（一定期間無進捗）/ `zombie`（セッション死亡）/ `idle`。判定はイベント間隔とdiff変化から機械的に行う。介入動詞として `nudge`（注意喚起メッセージ注入）と `handoff`（新セッションへのコンテキスト再注入）をdaemon APIに持つ（→ research-orchestrator-survey D）

## 3.5 セッションランタイムとモデルルーティング

### ランタイムドライバ
セッション起動は**ランタイムドライバ契約**（spawn / メッセージ注入 / イベント購読 / kill）で抽象化する：
- `pi-rpc`：参照実装（headless pi、RPCモード）
- `claude-agent-sdk`：サブスクリプション課金枠で回すためのドライバ。**注**：サブスク経由の可否・課金条件（プラン枠かextra usageか）はAnthropicのポリシーに依存し変動する（2026年前半に2度変更あり。piのOAuth認証は現在extra usage従量課金）。ドライバ隔離はこの変動をconfig1行の影響範囲に局所化するための設計である
- **検討・レビューの対話セッションはpi固定**とする。Extension Pack（文脈アクション面、classify、bridge）の主資産がpi Extensionにあり、二重実装しない。ランタイム可換なのは実行者・監査・SDK単発系のみ
- 可搬性の構造保証：ツール定義・daemon APIクライアント・プロンプト資産読込は**ランタイム中立の共通ライブラリ（banto-core）**に置き、pi Extension／agent-sdkの各アダプタは薄い皮（ツール登録とフック接続のみ）に留める。実行者のツールは中身がすべてdaemon API呼び出しであり、判断ロジックをアダプタに置かない（→ D5）
- スコープ執行の最終防衛はランタイム非依存にする：`scope.paths` 違反はマージ前ゲートでdaemonがdiffを機械検査して拒否する（→ I1）。セッション内フックは早期警告に格下げし、統治をランタイムの規律差に依存させない
- ランタイム間の品質差の検出：E2Eシナリオはドライバごとに実行し、テレメトリ（監査通過率・/fix回数等）にランタイム軸を持たせてロールアップする。差はケイデンスで評価し、割に合わないドライバの撤退はconfig変更のみで行える

### モデルtier（層B）
コードとタスクはモデル名を知らず、**tier**（`reasoning` / `standard` / `fast`）のみを参照する。`meta/config.yaml` にルーティング表を置く：

```yaml
models:
  reasoning: { runtime: claude-agent-sdk, model: ... }   # まずサブスク枠
  standard:  { runtime: pi-rpc, provider: zen, model: ... }
  fast:      { runtime: pi-rpc, provider: vllm-local, model: ... }
  fallbacks: { reasoning: reasoning-api, fast: standard }
providers:
  vllm-local: { endpoint: "http://...", max_concurrent: 4 }
  subscription: { window_budget: ... }    # 時間窓予算
```

- 既定の割当は役割×kindの決定的マッピング（監査・診断・検討=reasoning、feature=standard以上、batch/fix・要約・分類=fast）。検討エージェントはenqueue時にタスク単位で `model_tier` を上書きできる
- プロバイダ同時実行上限・サブスクの時間窓予算は物理quotaとして台帳管理し、枯渇時はfallbackに退避する（→ spec-multi-project §3の3番目の実行停止理由）
- モデルの入替・格下げ実験は層B変更として仮説付き改善に乗せる（→ spec-improvement-loop §5）

### ask_predecessor（v1.x）

status_reporterの姉妹機能として `ask_predecessor` を提供する：対象タスクの先行セッション（escalate元・conflict元・handoff前）のJSONLログを注入した短命SDKセッションに一問一答させる。呼び出し元は実行者・レビューセッション・PO（→ research-orchestrator-survey E）。

### 失敗駆動の昇格（非対称規則)
- **昇格は機械**：監査2回不通過、または同一acceptanceで/fix回数が閾値超過→ 一段上のtierでrespawn（イベント記録）
- **格下げは人間**：tier別テレメトリ（監査通過率・/fix回数・escalate率。ロールアップに含める）を根拠に、ケイデンスで判断する。安いモデルへの過剰最適化による静かな品質劣化を防ぐ

## 4. マージ機構

### 4.1 直列マージキュー
- approvedタスクは**マージキューで直列処理**する：先頭タスクをメインラインへrebase → マージ前ゲート（daemon自身がテスト実行。→ I1）→ マージ。メインラインは常にグリーンを保つ
- 緩い並行マージは行わない。ゲートの意味（メインの健全性保証）は直列化によってのみ成立する
- **将来拡張**：将来、ゲート実行時間がボトルネック化した場合の既定の進化先はBors型バッチ処理とする：複数の承認済みタスクを束ねて一括検証し、グリーンなら一括マージ、レッドなら二分探索で失敗タスクを隔離する。v1は直列1件ずつでよい（→ research-orchestrator-survey F）

### 4.2 コンフリクトの自動解消
- rebase失敗時、daemonは**解消タスクを自動起票**しエージェントに解かせる。解消結果も監査＋マージ前ゲートを通す（特別扱いしない）
- 解消の品質はテストで保証する。コンフリクト解消の失敗事例は再現E2Eシナリオとして追加する（→ spec-improvement-loop §4）
- 解消タスクが失敗した場合はfailedとしてアテンションキューへ

## 5. 定期処理（スケジューラ）

daemonのtickが担う定期処理の一覧：
- TTL執行・quota確認（環境）
- 照合ループ（spawn・環境）
- 依存駆動ゲートの再評価（レビュー通過・マージによる ready 昇格）
- ケイデンス／メタケイデンス／評価カードの合成キューアイテム生成
- スナップショット・ローテーション・ロールアップ
- タスク定義watcher（`work/` の変更検知 → enqueue取り込み。不正形式の拒否）

## 6. API

- daemonは HTTP API＋WebSocket（イベント購読）を提供する。GUI・CLIはその同格クライアント（→ D5：Surfaceにロジックを持たせない）
- エージェントの動詞ツール（`env deploy` 等）も同一APIに集約し、監査ログを一元化する
- **`ready` クエリ**：`ready`（依存駆動ゲートを通過し着手可能なタスクの一覧）をdaemon APIの一級クエリとする。検討エージェントの分解判断、ボードのNext表示、spawnスケジューラは同一のこのクエリを参照する（→ research-orchestrator-survey A）
- **通知イベント**：daemonはアテンションカード生成イベントを通知チャネル（層B設定: ntfy等のプッシュ通知）に送出する。通知文はD8に従い経緯1行を含める。対象はカード生成のみ（blocking発生、レビュー待ち、failed、評価カード、定期レビュー）（→ research-orchestrator-survey C）

## 7. 稼働形態

- **サーバ集中型**：自宅サーバのVM（Ubuntu）上でsystemdサービスとして常時稼働。worktree・セッション・環境接続もサーバ側に置き、POはWeb GUI／SSH（tmux）でどこからでも接続する
- 常時稼働が前提の機能：TTL執行、照合、ケイデンス生成、評価horizon
- **リリースの世代管理**：`releases/<version>/` を並べ `current` シンボリックリンクを切替える方式。ロールバック＝リンクの張り戻し（自動更新パイプラインのスワップ／ロールバック実装。Nix依存を外した読み替え）
- Proxmoxテンプレート等、environment-spec のNixOS前提箇所は素のイメージ＋cloud-init等に読み替えてよい（ドライバ契約は不変）

## 8. 未決事項

- スナップショットの形式（JSON1枚か、状態種別ごとか）
- watcherの実装方式（fs watch か git hook か、その併用）
- APIの認証方式（ローカルネットワーク限定か、トークンか）
- 解消タスク自動起票時のコンテキスト注入内容（両ブランチの由来タスク定義を含めるか）
