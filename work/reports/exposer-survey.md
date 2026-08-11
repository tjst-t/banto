# exposer 調査メモ（2026-08-11）

検証環境の外部公開（`EnvExposer`）まわりの構造・I/F・設定・環境結合を、モジュール化の設計判断材料として整理する。

## 1. 関連ファイル一覧

grep（`exposer|expose|caddy` 系）で洗い出した主要ファイル。

### コア契約
- `packages/banto-core/src/env-exposer.ts` — `EnvExposer` / `ExposeRequest` / `ExposedEnv` インターフェース定義

### 実装（2つ）
- `packages/banto-environment-pool/src/caddy-exposer.ts` — Caddy admin API 実装
- `packages/banto-environment-pool/src/proxy-exposer.ts` — banto 自身が中継する実装（`EnvProxy`）

### 呼び出し元・組み立て
- `packages/banto-environment-pool/src/pool.ts` — `EnvironmentPool`。`exposeMode`/`exposeProfilePort`/`expose` の受付と選択ロジック（`resolveExposer`）
- `packages/banto-environment-pool/src/tools.ts` — `env.*` Tool のパラメータ定義（`expose`/`exposeProfilePort`/`exposeMode`）
- `packages/banto-environment-pool/src/bin.ts` — Environment Pool 独立サービスの起動時に exposer を実際に構成する場所（唯一の本番組み立て地点）
- `packages/banto-environment-pool/src/service.ts` — HTTP面。`EnvProxy.handle`/`handleUpgrade` をルーティングに差し込む
- `packages/banto-environment-pool/src/module.ts` — モジュール定義（`createEnvironmentPoolModule`）。`proxy` を受け取って `serve`/`handleUpgrade` として公開
- `packages/banto-environment-pool/src/env-ledger.ts` — 台帳。`exposedPort`/`exposer` フィールドを持つ

### banto-host 側（別プロセスとして中継するだけ）
- `packages/banto-host/src/remote-pools.ts` — `createRemoteEnvironmentPoolModule`。Environment Pool サービスへの中継（`relay.serve`/`handleUpgrade`）のみ持つ。exposer 自体は持たない
- `packages/banto-host/src/bin.ts`（L590〜660付近） — 設定画面の `caddyAdmin`/`envDomain` を読むが**警告を出すだけで使わない**（後述・罠）
- `packages/banto-host/src/core-settings.ts`（L114〜189） — 設定画面「接続と公開」に `caddyAdmin`/`envDomain`/`publicUrl` フィールドを宣言
- `packages/banto-host/src/settings-store.ts` — 上記フィールドの型定義（`network.caddyAdmin`/`network.envDomain`）

### テスト・仕様
- `tests/acceptance/env-exposure.spec.ts` — 中継/Caddy双方の受け入れテスト
- `docs/spec/environment.md` — 検証環境の仕様書（**`expose`/`exposeMode`/`exposeProfilePort` は§3.1のTool契約表に載っていない = spec/実装の乖離あり。後述P3候補）
- `docs/adr/adr-0010-pluggable-harness.md` 決定39（L620〜681、**同一内容が2回重複して書かれている**。ドキュメント上の軽微な不整合）
- `work/inbox/improvement/imp-0008-env-access-url.md` — `EnvExposer` 抽象化の起票・決定の経緯（resolved）
- `work/inbox/improvement/imp-0009-public-http-and-access-control.md` — https化・アクセス制御のbacklog。proxy exposerがWSを中継しない問題（当時）等の実測記録

「問題7（実行環境の抽象化の見直し）」という名前の文書は `docs/`・`work/`・`desk/` のいずれにも見つからなかった（`desk/` ディレクトリ自体が存在しない）。srv0固定によるTLS/リダイレクト障害の記述も見当たらず、依頼文にある「2026-08-11 調査済み」の内容は本セッションでは未確認・未文書化とみられる。詳細は末尾「不明点」参照。

## 2. caddy-exposer の実装詳細

**モジュール**: `banto-environment-pool`（`caddy-exposer.ts`。独立モジュールに属し、banto-host は関与しない）

**Caddy admin API への注入方法**:
- `fetch` のみで完結（D6: SDK不使用）。`adminUrl`（例 `http://localhost:2019`）に対して `/id/<id>` と `/config/apps/http/servers/srv0/routes/0` を叩く
- `@id` による**冪等 upsert**: `expose()` はまず `DELETE /id/banto-env-<envId>` で既存ルートを消してから、`PUT /config/apps/http/servers/srv0/routes/0` で新規ルートを先頭挿入する（Palmux の `caddy_admin.go` と同じ設計思想）
- ルートの中身: `match.host` に `<port>--<dnsLabel(envId)>.<baseDomain>` を指定、`handle` は `reverse_proxy` で `upstreams[0].dial = "<upstreamHost>:<port>"`（既定 `upstreamHost` は `127.0.0.1`）、`terminal: true`

**srv0 固定の箇所**（依頼にある障害の直接原因）:
- `expose()`: `/config/apps/http/servers/srv0/routes/0`（L84）
- `list()`: `/config/apps/http/servers/srv0/routes`（L99）
- **サーバ選択の方法は無い**。`srv0` はコード中に決め打ちのリテラルで、Caddy 側が複数サーバ（`srv0`, `srv1`...）を持つ配置や、Caddyfile の自動採番でapex用サーバが `srv0` にならない配置では届かない。`CaddyExposerOptions` にサーバ名を指定する口は存在しない
- `unexpose()` は `/id/banto-env-<envId>` を直接叩くのでサーバ名に依存しない（`@id` はグローバル解決のため）。srv0固定の影響を受けるのは `expose`（ルート追加）と `list`（一覧）のみ

**その他の制約（コード内コメントより）**:
- Caddy admin API は既定でホストの `localhost:2019` に閉じているため、banto が別のものが管理する箱（コンテナ等）の中で動く配置では届かない、と明記されている（この制約自体は既知で、依頼にある「srv0固定による齟齬」は追加で判明した別問題と見られる）
- ワイルドカード証明書と apex の認証は静的な Caddyfile 側に置く前提。ここは「ホスト名→ポート」の追加のみを担当

## 3. proxy-exposer の実装詳細

**モジュール**: `banto-environment-pool`（`proxy-exposer.ts`。`EnvProxy` として `EnvExposer` を拡張）

**到達先の契約（A5）**:
- 公開URLは `{baseUrl}{ENV_PROXY_PATH}<envId>/`（`ENV_PROXY_PATH = "/env/"`）。既定 `baseUrl` は Environment Pool モジュールの到達先 `/api/environment-pool`
- `publicBaseUrl` を渡すと絶対URL（`https://banto.example.com/api/environment-pool/env/<envId>/`）、省略すると相対パス（同一オリジンで開く前提）
- **中継先ポートの対応は `Map<envId, {envId, port}>` のインメモリ状態**として exposer 自身が持つ（D3の例外ではないとコメントあり——「いまどのポートへ流すか」は導出できない事実だから、と明記）

**ポート転送の仕組み**:
- HTTP: `handle(req, res)` が `{baseUrl}/env/<envId>/...` プレフィックスにマッチしたリクエストを、`node:http` の `http.request` で `targetHost:port`（既定 `targetHost` は `127.0.0.1`）へパスを書き換えて（`/env/<id>/x` → `/x`）中継。Host ヘッダも書き換える
- WebSocket（Upgrade）: `handleUpgrade(req, socket, head)` が同じプレフィックス判定の後、`relayUpgrade()` で `net.connect` により生ソケットを直接扱う。`http.request` の `'upgrade'` イベント経由だと `head`（先行バイト）の書き込み順序が壊れる罠が実測で見つかっており、raw HTTP ヘッダを再構築して「リクエスト本体 → head → 双方向pipe」の順で書く実装になっている
- 未知の `envId` は HTTP なら404、Upgradeなら404レスポンス後にソケット破棄（黙って別経路へ流さない）
- 中継先が死んでいる場合は502（200で包まない）

**呼び出し経路**:
- `EnvironmentPoolService.start()`（service.ts）が `proxy.handle`/`proxy.handleUpgrade` を自分のHTTPサーバに差し込む（`{prefix}/env/...` はTool面 `{prefix}/tools/...` より先に判定）
- `createEnvironmentPoolModule()`（module.ts）は `proxy` を受け取ると `serve`/`handleUpgrade` としてモジュール契約に載せる。banto-host は独立プロセス構成では `remote-pools.ts` の `createRemoteRelay(remoteUrl)` で**単純なHTTPプロキシとして**この経路をさらに中継する（中身は解釈しない）

## 4. 公開方式の選択ロジック（exposeMode / exposeProfilePort / expose）

**型定義**: `pool.ts` L227 `export type ExposeMode = "auto" | "proxy" | "caddy";`

**入力の流れ**（`ProvisionRequest`。`pool.ts` L111〜154）:
- `expose?: number` — 公開するポートを呼び出し側が明示（`env.provision`/`env.verify` の直接指定）
- `exposeProfilePort?: boolean` — プロファイルの `config.port` を公開する（決定59）。番頭・Koboにポート番号を教えないための口。ポートを持たないプロファイルは公開せず続行（警告ログのみ、失敗にしない）
- `exposeMode?: ExposeMode` — 公開方式の明示。**`expose`（またはそれに帰結する `exposeProfilePort`）と同時指定が必須**——`exposeMode` だけ渡すと `pool.ts` L853〜855 でエラー

**選択ロジック本体**: `EnvironmentPool.resolveExposer(mode)`（`pool.ts` L1344〜1367）
```
- exposers.proxy も caddy も無ければ「口を持っていません」で拒否
- mode === "proxy" → exposers.proxy が無ければ拒否
- mode === "caddy" → exposers.caddy が無ければ「settings の network に caddyAdmin と envDomain が必要」で拒否
- mode === "auto"（既定） → caddy があれば caddy、無ければ proxy
```

**呼び出し元**: `provision()` 内（`pool.ts` L859〜875）。**環境が立ってから**公開し、公開に失敗したら**環境ごと teardown してから例外を投げる**（I2/I3：公開できなかった環境を残さない）

**exposer の実際の組み立て（本番で唯一の場所）**: `banto-environment-pool/src/bin.ts` L83〜101
- `proxy` は常に作る（`createEnvProxyExposer`）
- `caddy` は `BANTO_CADDY_ADMIN` と `BANTO_ENV_DOMAIN` が**両方**揃ったときだけ作る。片方だけならエラーで起動を止める（I2）
- `EnvironmentPool` コンストラクタへ `exposers: { proxy, caddy? }` として渡す

**banto-host 側の設定画面は効かない罠**（`bin.ts` L640〜651）:
- 番頭ホストの設定画面「接続と公開」には `caddyAdmin`/`envDomain` フィールドが存在する（`core-settings.ts`）
- しかし Environment Pool は**独立プロセス**（決定61）であり、`caddyAdmin`/`envDomain` は Environment Pool 起動時の環境変数からしか読まれない
- banto-host はこの設定値を読んでも使わず、**警告ログを出すだけ**（「ここでの設定は効きません。banto-environment-pool.service に BANTO_CADDY_ADMIN / BANTO_ENV_DOMAIN を渡してください」）
- つまり**設定の見た目上の在り処（GUI）と実際に効く場所（環境変数・別プロセス）が乖離している**。モジュール化の際にまず解消すべきポイントの一つ

## 5. 環境（env/provision, env/verify, meta/environments.yaml）からの呼び出し契約

- `env.verify`/`env.provision` Tool（`tools.ts`）のパラメータに `expose`/`exposeProfilePort`/`exposeMode` があり、`asRequest()` でそのまま `ProvisionRequest` に写す
- `meta/environments.yaml` のプロファイル定義自体は exposer を直接は知らない。`config.port` を通じて間接的に`exposeProfilePort`から参照されるのみ（`resolved.config.port` を読む。`pool.ts` L837）
- **`docs/spec/environment.md` §3.1 の `env.*` Tool契約表に `expose`/`exposeProfilePort`/`exposeMode` が載っていない**。実装（`tools.ts`/`pool.ts`）には存在するが spec の表は決定34a/34bの時点のままで、決定39（公開）を反映していない。P3（spec/実態の乖離）候補
- `meta/modules.json` に Environment Pool を登録する運用が `bin.ts` の起動ログコメントで言及されているが、リポジトリ内に `meta/modules.json` は存在しない（`meta/` には `config.yaml`・`environments.yaml` のみ）。banto-host は実際には `BANTO_ENV_POOL_URL`/`BANTO_ENV_POOL_PORT` 環境変数（`remote-pools.ts` の `defaultEnvironmentPoolUrl()`）で到達先を決めており、`meta/modules.json` は現状使われていない可能性がある

## 6. docs/ADRの設計文書（問題7以外で見つかったもの）

- **ADR-0010 決定39**（`docs/adr/adr-0010-pluggable-harness.md` L620〜681）: `EnvExposer` を差し替え可能にした経緯そのもの。「配置で公開手段が決まる」「`EnvDriver`/`PlaceProvider` と同じ形」という一般化の前例。**ドキュメント上のバグ**: 決定39の節が同一内容でファイル内に2回重複記載されている（L620〜650とL651〜681が完全に同一）
- **imp-0008**（resolved）: `EnvExposer` 抽象化そのものの起票理由・決定記録
- **imp-0009**（backlog）: https化・アクセス制御の未決事項。「proxy exposerはWSを中継しない」という記述は現行実装（`handleUpgrade` あり）と食い違っており、この改善提案が書かれた時点（2026-08-01）以降にWS中継が実装された模様（コード側コメントに「案A」として明記あり）。imp-0009 自体は古い記述のまま残っている
- 「問題7」「実行環境の抽象化の見直し」という名称の文書・srv0固定によるTLS/リダイレクト障害の記録は見つからなかった

## 7. モジュール化の際に考慮すべきポイント

1. **`EnvExposer` は既にモジュール内の差し替え可能な抽象**（`EnvDriver`/`PlaceProvider`と同型）。プラガブル化そのものは決定39で一度通っている——「モジュールとして外に出す」なら、次の段階は**Environment Pool自体からexposerの実装選択・設定を切り離す**ことになる

2. **設定の在り処が二重化している**（banto-host GUIとEnvironment Pool環境変数）。exposerをモジュール化するなら、設定もそのモジュールの持ち物に一本化すべき（決定60「モジュールがあるものはKobo独自を使わない、基準は台帳を持つか」と同じ発想がここにも当てはまる）。現状のGUIフィールドは実効性のない飾りになっており、D3「状態の真実は一箇所」に反する

3. **srv0固定はCaddy実装のハードコードバグであり、抽象化の問題ではない**。`CaddyExposerOptions` にサーバ名（または「apex設定より先に当てる」ことを実現する別の手段）を足せば直る話で、`EnvExposer` インターフェース自体の設計とは独立に修正可能。ただし「Caddyのサーバ採番方式は配置ごとに違う」という事実は、Caddy実装をより一般化する（例: サーバ名を自動検出する、または設定必須にする）ことをexposerモジュール化のスコープに含めるかどうかの判断材料になる

4. **環境依存性**: proxy-exposer はどの配置でも動く既定（依存ゼロ）。caddy-exposer は「banto自身がVMに常駐しCaddyを持つ配置」専用で、配置を選ぶ。モジュール化する場合、「配置ごとにどちらが選ばれるべきか」を宣言的に表現する仕組み（現状は`exposeMode: auto`が「caddy設定があればcaddy」という単純な有無判定）を、環境プロファイル側の抽象化見直しと整合させる必要がある

5. **ドライバとの関係**: exposerはドライバ（`EnvDriver`）とは独立した軸——ドライバは「どう環境を立てるか」、exposerは「立った環境をどう外から見せるか」。両者は`handle`/`config`を不透明に保つ規律（D1/D3）で疎結合になっている。モジュール化してもこの独立性（`handle.port`を覗かない、ポートは呼び出し側が明示する）は維持すべき制約

6. **WS中継の実装状況が新しい**: `EnvExposer`インターフェースの`handleUpgrade?`は「案A」としてオプショナルに追加された比較的新しい拡張（imp-0009時点では未実装）。caddy-exposerは`handleUpgrade`を持たない（Caddyそのものが中継するのでbanto側の関与は不要なため）。モジュールI/Fを固めるときは、この非対称（proxy実装だけがWS中継責務を持つ）をどう表現するかが論点になる

7. **テストの構造**: `env-exposure.spec.ts`は`EnvExposer`契約に対するテスト（偽実装の`broken`/`fakeCaddy`）と実装固有のテストが同居している。モジュール化するなら契約レベルのテスト（例：`expose`失敗時に環境が残らない、`unexpose`が冪等等）と実装固有のテスト（Caddyのadmin API呼び出し順序、proxy-exposerのパス書き換え）を分離しておくと、新しいexposer実装を追加する際の受け入れ基準が明確になる

## 未検証・不明点（要確認）

- 「問題7（実行環境の抽象化の見直し）」に該当する文書がリポジトリ内に見つかりませんでした。`desk/` ディレクトリ自体が存在せず、`docs/`・`work/`内にも該当する記述は grep で発見できませんでした
- 依頼文にある「srv0固定によりCaddyのサーバ採番と齟齬し、httpsリダイレクトやTLS失敗を起こしている（2026-08-11調査済み）」という具体的な障害事象そのものの記録（ログ・incident等）も見つかりませんでした。コード上「`srv0`が決め打ちである」ことは確認できましたが、それが実際に起こした障害の詳細（Caddy側のサーバ採番がなぜ`srv0`にならないのか等）はコードからは分からず、別途調査が必要です
