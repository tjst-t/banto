# caddy-exposer 根本原因調査（2026-08-11）

調査職人: task-A-caddy-rootcause（sessionId: a3256c5c-b0e3-4026-87f4-579556771cb5）
前提調査: task-A-caddy-inspect（sessionId: c386ab4a-93c7-4312-a3ad-45dca2955920）

## 結論（要約）

**caddy-exposer のコードは正しく動いている。** 壊れているのは実機側（banto VM）の Caddy 構成。
`srv0` 固定が直接の原因ではなく、srv0 が「自動HTTPSサーバ」であることの認識不足が根因。

## 発見事実

1. **コード層**: caddy-exposer は srv0 への PUT は正しく行う（実機再現確認済み・@id も生きる）。Palmux は単一サーバ構成だったが、banto VM は srv0(:443)・srv1(:80) の2サーバ構成。srv0 に route を入れると証明書取得が自動発動し失敗し続ける。

2. **証明書層**: HTTPS 失敗の直接原因は Let's Encrypt の multi-perspective validation が特定ヴァンテージポイントで断続的に DNSSEC 検証を失敗（journal で確認）。DNSSEC 基盤自体は健全（DS/DNSKEY/RRSIG チェーンは複数の公開リゾルバで検証成功）。
   - ZeroSSL フォールバックは死んでいる（caddy_legacy_user_removed）
   - dns-01 用 DNS プロバイダモジュールが caddy バイナリに未導入
   - env の TTL (30-45分) が ACME 再試行間隔より短く、証明書が通る前に env が消える運用上の相性問題

3. **永続化層**: `--resume` 無しの caddy.service が稼働中。`caddy-api.service`（--resume 付き）は disabled。Caddy 再起動のたびに admin API 経由の state が全消去される。

4. **重要な訂正（前提の誤り）**: 例として挙げられていた `14200--env-e9b3ad07bc.banto.tjstkm.net` は env-ledger では 2026-08-10 に tornDownAt 済み（2日前）で、現在アクセスすると 502 を返す孤児 route。2026-08-10 15:26 に人手（curl）で `POST /load` された際に @id 無しで紛れ込んだもの。
   - この手動介入により、caddy-exposer が @id 付きで管理していた route 群は全消去された
   - 以後 unexpose() の DELETE が対象を見つけられず 404 を返し続けている（Caddy の生 config と env-ledger の二重管理状態）
   - 現在 env-ledger にアクティブな env は 0 件

## 修正方針（調査職人の提案。先にインフラ、後にコード）

1. 孤児 route の後始末
2. TLS 方針の決定（HTTP 専用 vs dns-01 ワイルドカード）※ D1・D9、PO 裁定中（in-1c7d831d）
3. `--resume` 追加（ただし Caddyfile 静的部分との混在に注意）
4. caddy-exposer の srv0 固定解消
5. `@id` 前提の状態管理を env-ledger との再同期で堅牢化

## 参照

- コード: `packages/banto-environment-pool/src/caddy-exposer.ts`
- 設定: `/etc/caddy/Caddyfile`, `/etc/systemd/system/caddy.service`, caddy-api.service（disabled）
- 根因（設計提案 §9-4 の追補）: `work/reports/exposer-design-decisions.md`
