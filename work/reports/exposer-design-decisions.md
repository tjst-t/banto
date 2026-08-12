# exposer モジュール化 設計裁定（2026-08-11）

提案レポート: `work/reports/exposer-modularization-proposal.md`
調査レポート: `work/reports/exposer-survey.md`
根因調査: `work/reports/caddy-rootcause.md`

## PO 裁定（3件とも確定）

### 1. visibility の既定（提案 §9-1）
**裁定**: `banto-guarded` 優先（安全側に倒す）。
現行の `auto`（caddy があれば caddy＝public になり得る）から変更し、
要件で明示されない限り認証の内側（banto-guarded）を選ぶ。
D9 対象の利用体験変更。

### 2. 決定39(e) 認証未決（提案 §9-2）
**裁定**: Cloudflare Access で決着させる。
ADR-0010 決定39(e)「公開した検証環境そのものへの認証は別途」は、
`identity-gated` visibility（Cloudflare Access）の導入をもって解決とする。
タスクF（Cloudflare Tunnel/Access exposer 参考実装）がこの決着を実装する。

### 3. TLS 方針（根因調査 §修正方針-2）
**裁定**: **B: dns-01 ワイルドカード証明書で HTTPS 対応**。
DNS プロバイダモジュール（Cloudflare）を caddy バイナリに導入し
`*.banto.tjstkm.net` ワイルドカード証明書を発行。検証環境は
`https://env-xxx.banto.tjstkm.net` で公開する。
dns-01 は multi-perspective validation の影響を受けないため、調査で確認された
HTTPS 失敗（Let's Encrypt 検証の断続失敗）が根本解消する。

## 確定した設計方針

### I/F
- `EnvExposer` に `describe(): ExposerDescription` と `preflight(): Promise<{ok, detail?}>` を追加
- `handle` / `handleUpgrade` は `relay` 枝に畳む
- 既存の `name` / `expose` / `unexpose` / `list` は据え置き

### 選択方式
- visibility（`banto-guarded` / `public` / `identity-gated`）・origin（`subdomain` / `path-prefix`）・reach（`loopback` / `host-network` / `remote`）の3軸マッチ
- 既定の visibility は `banto-guarded`（安全側）
- 要件を満たす exposer が無ければ理由つきで断る（黙って弱い方式に落ちない）
- `exposeVia` による直接指定は残す（デバッグ用）

### caddy-exposer（根因調査で方針確定）
- `srv0` 固定を外し、`GET /config/apps/http/servers` から自動検出
- `caddyServer` 設定で上書き可能、候補0/2以上は断る
- **前提が HTTPS 対応に確定**（裁定3 による）。srv0 が自動HTTPSサーバであることを踏まえた route 注入
- `@id` 前提の状態管理を env-ledger との再同期で堅牢化

### 新 exposer 追加方式
- 外部実行ファイル契約（argv[1]=動詞、stdin/stdout JSON）
- `meta/exposers.json`（または Environment Pool 設定）で登録
- 秘匿値は exposer プロセスの環境変数として注入（stdout に出ない）

### 設定
- 公開設定を Environment Pool へ一本化（banto-host の `caddyAdmin`/`envDomain` は削除）

## タスク分割（7本）＋インフラ作業

根因調査により、タスクA（caddy-exposer）の**前にインフラ作業（Caddy 構成修正）が要る**。

### インフラ作業（コード変更ではない。先にやる）
| id | 内容 | 判定 |
|----|------|------|
| INF-1 | 孤児 route の後始末（env-ledger との二重管理解消） | D1 |
| INF-2 | dns-01 ワイルドカード証明書導入（Cloudflare モジュール・caddy 再ビルド・`*.banto.tjstkm.net` 発行） | D1（裁定3 で確定） |
| INF-3 | caddy.service に `--resume` 追加（Caddyfile 静的部分との混在に注意） | — |

### コードタスク（7本）
| id | 内容 | 優先度 |
|----|------|--------|
| A | caddy-exposer の srv0 固定解除＋サーバ自動検出（HTTPS 前提） | 高 |
| B | I/F 拡張（describe/preflight）＋選択方式 | 高 |
| C | ドライバ契約に endpoint 追加（保留可） | 低 |
| D | 公開設定の Environment Pool 一本化 | 中 |
| E | 外部 exposer 実行ファイル契約＋アダプタ | 中 |
| F | Cloudflare Tunnel/Access exposer 参考実装（決定39(e) を閉じる） | 中 |
| G | spec/ADR 追随 | 低 |

実行順: **INF-seq（孤児後始末 → dns-01 → --resume）→ A → D → B → E → F**
