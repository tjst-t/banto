---
id: imp-0009
type: improvement
kind: security-hardening
origin: po
status: backlog
resolution: ""
refs: [task-0102-banto-live, spec-environment, adr-0010]
---

# 検証環境の公開（http のまま進めた先の検討事項）

## 内容

2026-08-01、テスト用 Banto を外から見せる方法の検討で判明した事実を記録する。**いまは http で進めることで PO 合意済み。このメモはその先（https 化・アクセス制御）の backlog。**

### 判明した事実

1. **proxy exposer（`/api/environment-pool/env/<envId>/` の中継）は HTTP のみ中継し、WebSocket は中継しない。**
   中継 URL で開いた WebUI は、JS が WS を「開いているページのオリジン + `/ws`」に接続するため、
   **画面はテスト環境なのに会話は本番 banto と成立してしまう**（実機確認済み）。
   テスト環境の検証に中継 URL は使えない。
2. **Caddy サブドメイン公開（caddy-exposer）は EnvExposer として実装済み。**
   `env.provision` の `expose` から動き、Caddy admin API に `@id` 付き route を冪等 upsert / delete する。
   サブドメイン形式は `<port>--<envId>.<baseDomain>`。前提は `*.<baseDomain>` の DNS と証明書。
3. **2026-08-01 に `*.banto.tjstkm.net` のワイルドカードを 192.168.1.47（このVM）に向けた**（PO設定）。
   新規の名前にはワイルドカードが効くことを dig で確認済み。
4. **Banto は認証を持たない（決定40）。** https は「通信の盗聴防止」に過ぎず、「アクセス制御」にはならない。
   認証なし公開の実リスクは「LAN 内の誰でもアクセスできる」ことであり、これは https では変わらない。
5. **この VM の Caddy は http 専用**（`http://banto.tjstkm.net` のサイトのみ、自動HTTPS無効・証明書なし）。
   Private IP のため通常の HTTP-01 は使えず、https 化には DNS-01 チャレンジ
   （Caddy の DNS プラグイン + 自前 DNS の対応）か internal CA（クライアントへの CA 配布）が必要。

## 決めること（backlog）

1. **https 化**：DNS-01 か internal CA か、http のままか。Private IP ではどれも手間がかかる割に
   得られるのは盗聴防止のみ。本番 banto も現在 http のため、非対称にならない方針が要る。
2. **アクセス制御**：Caddy の IP 制限（例：`192.168.1.0/24` からのみ許可）を入れるか。
   認証なし公開の実リスク（誰でもアクセスできる）を塞ぐのは https よりこちらが先。
3. **caddy-exposer の URL が `https://` 固定で返る件**：http 環境では PO 側で `http://` に読み替える
   必要がある。URL スキームを設定可能にするか（コード変更＝D1 相当、PO 裁定が必要）。

## 現状の措置（2026-08-01）

- テスト環境は **http で直接公開**（`banto serve --host 0.0.0.0`、ポート 4200、認証なし・LAN 内・使い捨て、TTL で自動 teardown）。
- 本番は `http://banto.tjstkm.net`（Caddy → 127.0.0.1:4100）のまま。
