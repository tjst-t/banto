# 外部公開（exposer）のモジュール化 設計提案（2026-08-11）

前提の調査は `work/reports/exposer-survey.md`（task-0090）。本書はその上に立つ**設計案**であり、決定ではない。
採否は PO 裁定 or ADR-0010 への決定追記を要する（公開 I/F・データモデルに触るので D1）。

---

## 0. 要約（先に結論）

| # | 論点 | 提案 |
|---|---|---|
| 1 | `EnvExposer` I/F | **4動詞（name/expose/unexpose/list）は据え置き**。`describe()`（静的な能力宣言）と `preflight()`（配置での実測）を足す。`handle`/`handleUpgrade` は任意の `relay` 枝へ畳んで非対称を明示する |
| 2 | 既存2実装 | **proxy は組み込みのまま**（モジュール HTTP 面と一体・依存ゼロの既定）。**caddy は「同梱の第2実装」へ格下げ**し、組み立てを bin.ts のハードコードからレジストリ経由へ移す |
| 3 | `srv0` 固定 | **自動検出を既定**（`:443` を持つサーバを選ぶ）＋**設定で上書き可**。曖昧なら黙って srv0 に落ちず断る（I2）。注入後に `GET /id/<id>` で当たったことを確かめる |
| 4 | 設定の二重化 | **公開設定は Environment Pool の設定区画に一本化**。banto-host の `caddyAdmin`/`envDomain` は**削除**（`publicUrl` だけ残す）。項目は `describe()` の `configSchema` から動的生成 |
| 5 | 新 exposer の追加方式 | **外部実行ファイル契約**（`EnvDriver` §2 と同型：argv[1]=動詞・stdin/stdout JSON）＋登録は宣言ファイル1行。**npm パッケージにも Banto の再ビルドにもしない** |
| 6 | 環境との関係 | 接点は**1点だけ**（環境のポートがどこに現れるか＝`endpoint.reach`）。能力は3軸（`reach` / `visibility` / `origin`）で exposer が自己申告し、呼び出し側は**方式名ではなく要件**で頼む |
| 7 | 本書 | `work/reports/exposer-modularization-proposal.md`（書き込み成功） |
| 8 | タスク分割 | 7本（§8）。**A（srv0 修正）と D（設定一本化）は他に依存せず単独で価値が出る**——縮めるならこの2本＋E・F |

**最重要の指摘**：現行の `exposeMode: "auto"` は「caddy の設定があれば caddy」という**有無の判定**で選んでいる。
これは「レビュー用に立てた環境が、設定次第で *banto の認証の内側* から *インターネットに無認証* へ黙って移る」ことを意味する（決定39(e) は認証を未決のまま残している）。
PO の Cloudflare Access 要求は、この穴を**要件ベースの選択**で塞ぐ機会でもある。方式を増やすだけの話にしない方がよい。

---

## 1. `EnvExposer` I/F をどう拡張・維持するか

### 1.1 維持するもの（触らない）

```ts
name: string
expose(request: ExposeRequest): Promise<ExposedEnv>
unexpose(envId: string): Promise<void>   // 冪等
list(): Promise<ExposedEnv[]>
```

この4つは正しい。理由：

- **`ExposeRequest` にポートを明示させる規律（決定39d）はそのまま**。exposer が増えるほど「handle を覗く」誘惑は強くなるが、覗いた瞬間 Environment Pool がドライバの内部表現に依存し始める。`ExposedEnv.url` を返すだけの薄さが、実装が5つに増えても崩れない唯一の形。
- `unexpose` の冪等・`list` による畳み損ねの発見は、実装が外部プロセスになっても要件として変わらない。

### 1.2 足すもの（2つだけ）

#### (a) `describe(): ExposerDescription` — 静的な能力宣言

```ts
interface ExposerDescription {
  /** 実装の名前（`banto-proxy` / `caddy` / `cloudflare-tunnel`）。 */
  name: string;
  /** 人に見せる説明（設定画面と、選べなかったときの理由文に使う）。 */
  title: string;
  capabilities: {
    /** 立った環境のポートがどこに現れていれば繋げるか。 */
    reach: Array<"loopback" | "host-network" | "remote">;
    /** 誰が届くか（→ §6.2）。 */
    visibility: "banto-guarded" | "public" | "identity-gated";
    /** URL の形。絶対パスで資源を引くアプリは "subdomain" が要る。 */
    origin: "path-prefix" | "subdomain";
    /** WebSocket（HTTP Upgrade）が通るか。 */
    websocket: boolean;
  };
  /** 設定画面に出す項目（→ §4.2）。秘匿値は `secret: true` を立てる。 */
  configSchema: Array<{ key: string; label: string; type: "text" | "number"; secret?: boolean; required?: boolean; description?: string }>;
}
```

**なぜ静的宣言が要るか**：`auto` の選択根拠を「設定されているか」から「要件を満たすか」へ移すため（§6.3）。
いま `resolveExposer` が持っている `if (caddy) return caddy` は、宣言が無いので**それ以外の判断ができない**。

#### (b) `preflight(): Promise<{ ok: boolean; detail?: string }>` — いまここで使えるかの実測

`describe()` は「何ができるか」、`preflight()` は「**この配置で実際に効くか**」。両方要る。

- caddy: admin API に `GET /config/apps/http/servers` が通り、対象サーバが一意に決まるか。**srv0 事故はここで止まっていたはずのもの**（§3）。
- cloudflare: トークンが有効か、トンネルが上がっているか。
- proxy: 常に ok（依存ゼロ）。

**呼ぶ場所は3つ**：①サービス起動時（ログに出す）②設定を保存したとき（画面にその場で返す）③`expose` の直前。
①②が要るのは、**いまは「環境を立てて → 公開に失敗して → 環境を畳んで → 例外」**（`pool.ts` L859-875）という遠回りでしか設定ミスが分からないから。立てる前に断れる。

> **配置の宣言は持たない。** 「この Banto は Caddy を持つ配置である」を人が設定に書き写す形にはしない——写しは腐る（D3）。実測（`preflight`）で決める。

#### (c) `handle` / `handleUpgrade` の非対称を明示に変える

現状の綻び：core の `EnvExposer` は `handleUpgrade?` を持つが `handle` は持たない（`handle` は pool パッケージの `EnvProxy` 側にある）。
**HTTP の平文と Upgrade が別の層に分かれている**のは事故のもと。任意の枝に畳む：

```ts
interface EnvExposer {
  // ... 4動詞 + describe + preflight
  /**
   * 自分で中継する実装（`relay` 型）だけが持つ。route 型（caddy 等）は持たない。
   * ホストは経路を渡すだけで中身を解釈しない（決定39b）。
   */
  relay?: {
    handle(req: IncomingMessage, res: ServerResponse): boolean;
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  };
}
```

`relay` の有無が §2 の「route 型 / relay 型」の区別そのものになり、外部実行ファイル化できるのは `relay` を持たない方だけ、という制約が型で表れる。

### 1.3 足さないもの

- `expose` への任意設定の袋（`options: Record<string, unknown>`）。**要件は宣言語彙で表す**（§6.3）。不透明な袋を作ると、呼び出し側が実装ごとの方言を書き始め、差し替え可能性が名前だけになる。
- 認証・IdP の抽象。Cloudflare Access は `visibility: "identity-gated"` と申告するだけでよく、**誰を通すかは Cloudflare 側の設定**。Banto に認証機構を抱えない（決定40）と一貫する。

---

## 2. caddy-exposer / proxy-exposer の扱い

### 2.1 まず「exposer はモジュールにしない」

ADR-0010 は既に同型の判断をしている（L517、場所＝`PlaceProvider` について）：

> **モジュールにしない**理由：モジュールの定義（決定25・27）は「接続情報＋Tool＋GUI＋SKILL を1単位で登録する」であり、そのどれも持たないものをモジュールと呼ぶと枠が緩む。必要になったら格上げする。

exposer は Tool も GUI も SKILL も持たない（番頭が `caddy.*` を呼ぶことはない）。
**exposer は `EnvDriver` と同じ層——Environment Pool 内部の差し替え可能な部品**。この位置づけを先に固定しないと、「モジュール化」の名の下に接続情報も HTTP 面も持つ大げさなものになる。

### 2.2 proxy-exposer：組み込みのまま残す（切り出さない）

- `relay` を持つ＝**モジュールの HTTP 面と一体**。外部プロセスへ出すと、Environment Pool の到達先の下にパスを生やす仕掛けを外へ露出させることになる（決定39b が banto-host から Environment Pool へ寄せた理由がそのまま逆向きに効く）。
- 依存ゼロ・DNS も TLS も要らず**どの配置でも動く既定**。これが無いと箱から出した Banto が何も公開できない。
- `Map<envId, port>` のインメモリ状態を持つ。外部プロセスでは持てない（毎回 spawn するので消える）。

→ **第2の relay 型実装が現れる見込みは薄い**ので、抽象化の閾値（決定18）を超えていない。1つのまま組み込む。

### 2.3 caddy-exposer：同梱の第2実装へ格下げ、組み立てをレジストリ経由に

いま `bin.ts` L83-101 が `createEnvProxyExposer` と `createCaddyExposer` を**名指しで**組み立て、`exposers: { proxy, caddy? }` という**固定2枠の型**で Pool に渡している（`pool.ts` L94、`EnvironmentPoolOptions.exposers`）。
これでは3つ目が入らない。3つ目を入れるたびに型と `ExposeMode` の union と `resolveExposer` の switch を直すことになる。

**変更点**：

```ts
// EnvironmentPoolOptions
exposers?: EnvExposer[];        // 固定2枠 → 並び（順序＝優先度）
```

`resolveExposer` は switch から**要件マッチ**（§6.3）へ。`ExposeMode = "auto"|"proxy"|"caddy"` は
`exposeVia?: string`（実装名の直接指定・エスケープハッチ）へ置き換え、旧値は当面写して受ける（pre-release なので互換の重さは要らない・D9）。

caddy 実装のコードは**当面 `banto-environment-pool` 内に残してよい**。ただし：

- 生成は `bin.ts` の `if` ではなく**登録テーブルから**（`builtinExposers: Record<string, (config) => EnvExposer>`）。`resolveDriverPath()` の「組み込み名 or パス」と同じ形。
- パッケージ境界を跨ぐ点をレジストリ1箇所に閉じておけば、後で `@banto/exposer-caddy` へ出すのは**移動だけ**で済む。**いま出す理由は無い**（D6・決定18：使う人が2人目になってから）。

### 2.4 外部 exposer の登録方式 → §5

---

## 3. `srv0` 固定への対処

### 3.1 障害の筋（推定を含む）

`caddy-exposer.ts` は `expose` で `PUT /config/apps/http/servers/srv0/routes/0`、`list` で同パスを読む。
`srv0` は Caddy が Caddyfile を JSON へ落とすときの**自動採番**で、配置ごとに何番が何のサーバかは決まっていない。

**報告されている「https リダイレクト・TLS 失敗」の最も自然な説明**：
Caddy は automatic HTTPS を有効にすると `:80` に **HTTP→HTTPS リダイレクト専用のサーバ**を自動生成する。
採番次第でこれが `srv0` になり得る。そこへ route を注入すると──

1. `http://<port>--<env>.<domain>/` は注入した route に当たり、**平文で 127.0.0.1:port へ流れる**（あるいはリダイレクト route が先に当たって 308）
2. `https://...` 側のサーバには route が無いので、**apex の設定に落ちる or TLS のホスト不一致**

つまり「リダイレクトループに見える」「証明書が合わない」の両方が同じ原因から出る。
**この推定は実機の Caddy JSON（`GET /config/apps/http/servers`）を1回見れば確定する**。修正タスクの最初の一手はこれ（I1：憶測で直さない）。

### 3.2 対処：自動検出を既定、設定を上書き、注入後に確認

`(a) 設定でサーバ名を渡す` 単体では不採用。理由は「人が調べて書き写す＝写しが腐る」（D3）。同じ事故が設定ミスの形で再発する。

**採用する形（3段）**：

1. **自動検出（既定）** — `GET /config/apps/http/servers` を読み、
   - `listen` に `:443`（または `tlsPort` 設定値）を含むサーバを候補にする
   - リダイレクト専用サーバを除外する（route が `static_response` の 308 のみ、`automatic_https.disable_redirects` 等の徴候）
   - **候補がちょうど1つのときだけ採る**
2. **設定で上書き** — `caddyServer` を設定できる。候補が0個/2個以上なら**黙って srv0 に落ちず**、候補名を並べて「どれか指定してください」と断る（I2）。この分岐が `preflight()` の中身になる。
3. **注入後の確認** — `PUT` の後に `GET /id/banto-env-<envId>` を引き、入ったことと**どのサーバに入ったか**を確かめる。当たっていなければ `expose` を失敗させる（I2：公開したと言わない）。

**第3の手（採らないが記録）**：Caddyfile 側に `@id` 付きの空 route（アンカー）を置いてもらい、`PUT /id/<anchor>/...` で入れる（Palmux 方式の堅い版）。
「apex より先に当てる」保証は最も強いが、**配置側の準備を要求する**ので敷居が上がる。自動検出で足りなかったときの次の手として残す。

### 3.3 これは抽象化の問題ではない

survey §7-3 の通り、`srv0` は Caddy 実装内のハードコードであり `EnvExposer` I/F とは独立に直せる。
**だから先に単独で直す**（§8 task-A）。モジュール化の設計合意を待たせない。

> 併せて **incident を1本積む**。「調査済みだが記録が無い」状態（survey 末尾の未検証事項）は、次に同じ症状が出たときに一から調べ直すことになる。

---

## 4. 設定の二重化の解消

### 4.1 原則：設定は「効く場所」が持つ

決定41 は「モジュールが自分の設定区画を出す。読み書きの実装はモジュールが持つ」と定めている。
Environment Pool は既にそれをしている（`createEnvironmentSettings` → `createSettingsTools("env", ...)` で別プロセス越しに番頭ホストの設定画面へ出る）。
**つまり受け皿は既にある**。`caddyAdmin`/`envDomain` が banto-host の `network` 区画に居るのは、Environment Pool が同居していた頃の名残（決定61 で独立した際の取り残し）。

### 4.2 具体案

| いまの場所 | 移す先 |
|---|---|
| banto-host `network.caddyAdmin` | **削除**。Environment Pool の設定区画「検証環境の公開」へ |
| banto-host `network.envDomain` | **削除**。同上 |
| banto-host `network.publicUrl` | **残す**（banto 自身の外向き URL＝ホストの持ち物。proxy の URL 組み立てに Pool へ渡す） |
| `BANTO_CADDY_ADMIN` / `BANTO_ENV_DOMAIN` 環境変数 | **読むが弱い**（設定 > 環境変数）。起動ログで移行を案内 |
| banto-host bin.ts L643-651 の警告 | **削除**（言うべきことが無くなる） |

**新しい区画の中身は動的**。exposer ごとに項目が違う（Caddy は admin URL とドメイン、Cloudflare は account/tunnel、ngrok は authtoken）ので、
`describe().configSchema` から fields を組み立てる。**新しい exposer を登録すると、設定画面にその欄が生える**。

**秘匿値は設定ファイルに平文で置かない**。`secret: true` の項目は値ではなく**参照名**を持ち、実値は sops credentials と同じ経路で exposer プロセスの env にだけ入る（決定32d の再適用）。
Cloudflare のトークンを `settings.json` に平文で書く形にすると、番頭の `file.read` が届く場所に鍵が出る可能性がある。

**`restartRequired` を外す**。exposer の解決は provision のたびに走るので、設定を保存した時点で `pool.applyExposers()` を呼べばその場で効く（上限設定 `applyLimits` と同じ形）。
いまは Caddy を設定するたびにサービス再起動が要る——実運用の摩擦として無視できない。

### 4.3 移行

pre-release なので互換の重さは要らない（D9）。ただし**PO が既に画面へ入れた値は別プロセスの設定ファイルには自動で移らない**ので、
banto-host 側に旧値が残っていたら**起動ログで「新しい場所に入れ直してください」と1回言う**（今の警告文の置き換え）。データは壊れない。

---

## 5. 新しい exposer（Cloudflare Access / Tunnel / ngrok 等）の追加方式

### 5.1 採用：外部実行ファイル契約（`EnvDriver` §2 と同型）

**npm パッケージにしない。`meta/` の設定だけにもしない。**

- **npm パッケージ（in-process プラグイン）を採らない理由**：exposer を1つ足すのに Banto へ依存を足し（D6）、ビルドし直し、TypeScript を書かせることになる。
  Cloudflare Tunnel の実体は「`cloudflared` に ingress を1本足す」で、**bash 20行で済む**ものにその重さは釣り合わない。
- **設定だけ（宣言的テンプレート）を採らない理由**：公開の手順は API 呼び出し・CLI 実行・トークン更新を含み、宣言では書ききれない。書ける形に絞ると Cloudflare が入らない。
- **外部実行ファイルを採る理由**：
  - **前例がある**（`EnvDriver`。spec-environment §2。`resolveDriverPath` は「組み込み名 or パス」で既に外部実装を受けている）
  - 言語非依存。runner（`runDriverVerb`）はほぼそのまま使い回せる
  - **権限の分離**：トークンは exposer プロセスの env にだけ入り、Pool の文脈にもログにも出ない（credentials と同じ経路）
  - 外部実装が Pool のプロセスを落とせない

### 5.2 契約

`EnvDriver` と同じ規約：`argv[1]` に動詞、stdin に入力 JSON、stdout に出力 JSON、exit 0 が成功。

| 動詞 | 入力 | 出力 | 規約 |
|---|---|---|---|
| `describe` | — | `{name, title, capabilities, configSchema}` | 静的。Pool は起動時に1回だけ呼ぶ |
| `preflight` | `{config}` | `{ok, detail?}` | 設定・資格情報・到達性の実測 |
| `expose` | `{envId, port, label?, target: {host}, config}` | `{url, port}` | 失敗は非0 exit（黙って url 無しで成功にしない） |
| `unexpose` | `{envId, config}` | — | **冪等必須**（`teardown` と同じ） |
| `list` | `{config}` | `[{envId, url, port}]` | **自分が公開したものだけ**。名前から推測しない（§2.1 と同じ規律） |

`relay` は持てない（毎回 spawn なので状態も HTTP 面も持てない）。**route 型だけが外部化できる**——§1.2(c) の型がそれを表す。

秘匿値は `config` には入れず、**exposer プロセスの環境変数**として渡す（`config` は stdout ログに出得る）。

### 5.3 登録

```jsonc
// meta/exposers.json（または Environment Pool 設定内の同等の区画）
{
  "exposers": [
    { "name": "banto-proxy", "builtin": "proxy" },
    { "name": "caddy", "builtin": "caddy", "config": { "envDomain": "env.example.com" } },
    { "name": "cf-access", "exec": "/opt/banto/exposers/cloudflare-access",
      "config": { "account": "...", "tunnel": "..." },
      "secrets": { "CF_API_TOKEN": "cloudflare-token" } }   // 値ではなく参照名
  ]
}
```

- **並びが優先度**（要件を満たすものが複数あれば先頭）。`auto` の挙動が設定で読める形になる。
- `meta/modules.json`（決定27b のモジュールレジストリ）とは**別ファイル**。exposer はモジュールではない（§2.1）。同じファイルに混ぜると枠が緩む。
- ただし survey §5 の指摘どおり `meta/modules.json` は**現状使われていない可能性がある**（到達先は環境変数で決まっている）。
  レジストリ運用の実態を先に確かめること——2つ目の使われないレジストリを増やす価値は無い。

### 5.4 Cloudflare の2つを混同しない

- **Cloudflare Tunnel** = 到達性（内から外へ張る。DNS も固定 IP も要らない）→ `visibility: "public"`
- **Cloudflare Access** = その手前の認証ゲート → `visibility: "identity-gated"`

実装としては1本（Tunnel を張り、Access ポリシーを付けるかを設定で選ぶ）でよいが、
**`describe()` が返す `visibility` は設定によって変わる**。→ `describe` は設定を受け取れる形（`describe {config}`）にしておく方が正しい。
Access 無しの Tunnel を `identity-gated` と申告すると、**要件ベースの選択が嘘をつく**。

---

## 6. exposer と環境（EnvDriver / プロファイル / 配置）の関係

### 6.1 言葉の整理

| 層 | 何を決めるか | 誰が持つか |
|---|---|---|
| **EnvDriver** | どう立てるか | プロファイルの `driver`（実行ファイル） |
| **プロファイル** | 何を立てるか・どう使えるようにするか | `meta/environments.yaml` |
| **配置（deployment）** | Banto 自身がどこで動いているか | 宣言しない。**実測**（`preflight`） |
| **EnvExposer** | 立ったものをどう見せるか | Environment Pool の設定 |

ドライバと exposer は**直交**。ただし完全に無関係ではなく、**1点だけで接する**：

> **立った環境のポートが、どのネットワーク面に現れるか。**

`process`/`docker` ドライバは Pool と同じホストの loopback に出す。Proxmox のような remote ドライバは別マシンの IP に出す。
proxy-exposer は Pool プロセスから TCP を張るので loopback なら届く。Caddy はホスト上の Caddy から張るので、Pool から見た loopback と一致するとは限らない。
**この1点が合わないと、どの exposer も動かない。**

### 6.2 宣言の3軸

exposer が `describe().capabilities` で自己申告する：

| 軸 | 語彙 | 意味 | 現行実装の値 |
|---|---|---|---|
| `reach` | `loopback` / `host-network` / `remote` | 環境のポートがどこに出ていれば繋げるか | proxy: `[loopback]` / caddy: `[loopback, host-network]` |
| `visibility` | `banto-guarded` / `public` / `identity-gated` | 誰が届くか | proxy: `banto-guarded` / caddy: **`public`** |
| `origin` | `path-prefix` / `subdomain` | URL の形（絶対パス参照が壊れるか） | proxy: `path-prefix` / caddy: `subdomain` |

`websocket` は4つ目の真偽値（proxy は自前中継で true、caddy は Caddy が通すので true、ngrok も true）。

**`visibility` を軸にするのが本提案の核**。いまの `auto` はここを見ずに選んでいるので、
「レビュー用の環境を立てたら、設定次第で無認証でインターネットに出る」が黙って起きる。

### 6.3 「どの公開方法がどの環境をサポートするか」の表し方

**環境側（何が要るか）**：

1. **ドライバが `provision` 出力に任意で `endpoint` を返す**（`cache: {primed}` と同じ「任意・劣化しても安全」の足し方・spec §5.2.2 の形）
   ```json
   { "handle": {...}, "endpoint": { "host": "10.0.3.42", "reach": "remote" } }
   ```
   返さなければ `{host: "127.0.0.1", reach: "loopback"}`（現状の暗黙の既定そのもの）。
   **これは handle を覗くことにはならない**——handle は不透明のまま、公開のためだけの明示フィールドを別に返す（D1/D3 の規律を保つ）。

2. **プロファイルが `expose` ブロックで要件を書ける**（`meta/environments.yaml`）
   ```yaml
   web-review:
     driver: docker
     config: { ... }
     expose:
       port: 3000
       origin: subdomain          # 絶対パスで資源を引く SPA なので path-prefix では壊れる
       visibility: banto-guarded  # 無認証で外に出してはいけない
   ```
   これは決定59（プロファイルがポートを持つなら公開する）の自然な拡張。
   **副次効果**：いま Pool は `resolved.config.port` を読んでいる（`pool.ts` L837）——**ドライバ設定ブロックの中身を Pool が解釈している**、つまり不透明の規律に既に穴が開いている。
   `expose.port` へ移せばこれが閉じる（P3 候補として別途起票の価値あり）。

**呼び出し側（要件で頼む）**：

```ts
env.provision({ ..., expose: 3000, exposeNeeds: { origin: "subdomain", visibility: "banto-guarded" } })
```

**Pool の選択（`resolveExposer` の置き換え）**：

```
候補 = 登録順の exposer のうち
       ①capabilities.reach ⊇ 環境の endpoint.reach
       ②capabilities.visibility が要件を満たす
       ③capabilities.origin が要件を満たす
       ④preflight() が ok
先頭を採る。0件なら **落とさずに断る**——満たせなかった条件と、各 exposer が外れた理由を並べる（I2）
```

**「黙って弱い方式へ落ちない」が最重要**。`origin: subdomain` を要求したのに path-prefix へ落ちれば壊れたアプリが出るし、
`visibility: banto-guarded` を要求したのに public へ落ちれば**事故になる**。

`exposeVia: "caddy"` の直接指定は残す（デバッグ・明示の逃げ道）。指定した方式が要件を満たさないときは、**警告して通す**のではなく断る。

### 6.4 段階的に入れる（決定18を守る）

`reach` の軸を**いま実装する必要は無い**。組み込みドライバ（process/docker）はどちらも `loopback` で、`remote` を返すドライバは存在しない。
**実装の引き金**：Proxmox ドライバ（spec §7）など、loopback でない環境を返すドライバが実際に入るとき。

それまでは `visibility` と `origin` の2軸で足りる。**設計としては3軸で書いておき、実装は2軸で始める**——
契約に空欄のフィールドを予約するのではなく、**「既定 `loopback` を暗黙に置いたまま」**にしておけば、後から足すのは非破壊で済む。

---

## 7. 本書の書き込み

`work/reports/exposer-modularization-proposal.md`（書き込み成功）。既存の `work/reports/exposer-survey.md` は上書きしていない。

---

## 8. 実装タスク分割案

依存関係：`A` は独立。`D` は独立。`B` → `E` → `F`。`C` は保留可。

| id | 内容 | 依存 | 受け入れ条件（案） |
|---|---|---|---|
| **A** | **caddy-exposer の `srv0` 固定を外す**。`GET /config/apps/http/servers` からサーバ自動検出、`caddyServer` 設定で上書き、候補0/2以上は断る、注入後に `GET /id/<id>` で確認 | — | ①実機 Caddy の JSON を採取し、症状の原因を**記録**（incident 1本）②検出ロジックの単体テスト（redirect 専用サーバを除外できる）③実機で1環境をサブドメイン公開し、https で開けることを実測 |
| **B** | **`EnvExposer` に `describe()`/`preflight()` を追加**。`EnvironmentPoolOptions.exposers` を配列化、`resolveExposer` を要件マッチへ。`relay` 枝へ `handle`/`handleUpgrade` を畳む。`ExposeMode` → `exposeVia` + `exposeNeeds` | — | ①既存2実装が両方 describe/preflight を実装 ②要件を満たす exposer が無いとき理由つきで断る試験 ③`visibility` 不一致で黙って落ちないことの試験 ④既存の env-exposure.spec.ts が通る |
| **C** | **ドライバ契約に `endpoint`（任意）を追加**。spec-environment §2 の表を更新、process/docker が返す、Pool が `reach` を選択に使う | B | ①返さないドライバでも従来どおり動く（劣化して安全）②spec 更新 — **remote ドライバが現れるまで保留してよい**（決定18） |
| **D** | **公開設定を Environment Pool へ一本化**。banto-host の `caddyAdmin`/`envDomain` 削除、Pool 設定区画に「検証環境の公開」を新設、`describe().configSchema` から動的生成、秘匿値は参照名、`restartRequired` 撤廃 | （B があると動的生成が綺麗。無くても静的に着手可） | ①画面で Caddy を設定 → **再起動なしで**次の provision に効く ②旧環境変数は読むが設定が勝つ ③host 側の「効きません」警告が消える |
| **E** | **外部 exposer 実行ファイル契約 + アダプタ**。`createExternalExposer(path)`、登録テーブル（組み込み名 or exec パス）、`meta/exposers.json`（または Pool 設定）での宣言、秘匿値の env 注入 | B | ①偽の外部 exposer（シェルスクリプト）で expose/unexpose/list が通る受け入れ試験 ②非0 exit を成功に丸めない ③トークンが stdout/ログ/番頭の文脈に出ないことの確認 |
| **F** | **Cloudflare Tunnel/Access exposer の参考実装**を1本書き、契約を実地で検証 | E | ①実機で1環境をインターネット公開し、Access のログインを通って到達できる ②`describe` が Access 有無で `visibility` を正しく変える ③`unexpose` の冪等 |
| **G** | **spec / ADR の追随**。spec-environment §3.1 の Tool 契約表に `expose`/`exposeNeeds`/`exposeVia` を追記（既存の P3 乖離の解消）、ADR-0010 決定39 の**重複記載を削除**、本提案の決定を追記 | A–F と並行 | spec と実装が一致していることをレビューで確認 |

### 8.1 縮めるなら

PO の要求（Cloudflare Access で公開できる）に最短で届くのは **A → D → B(最小：visibility/origin の2軸だけ) → E → F**。
`C` は remote ドライバが無いので落とせる。`G` は各タスクに割り付けてもよいが、既存の乖離（survey §5・§6）があるので1本立てておく方が漏れない。

### 8.2 順序の理由

- **A を先頭に置くのは、いま壊れているから**。設計合意を待たせる理由が無く、単独で価値が出る。
- **D を早く置くのは、設定が効かない状態が一番わかりにくいから**。GUI に欄があるのに効かないのは、機能が無いより悪い。
- **F を最後に置くのは、契約の検証がそこで初めて成立するから**。3つ目の実装を通さないと、B/E の抽象が本当に足りているかは分からない（実装2つでは抽象の穴は見えない）。

---

## 9. 未解決・PO 裁定が要るところ

1. **`visibility: "public"` を既定の `auto` で選んでよいか。**
   本提案は「要件で明示されない限り、より強く守られる方（`banto-guarded`）を選ぶ」を推す。
   ただし**現行の挙動は逆**（caddy があれば caddy）なので、これは**利用体験を変える**変更＝ D9 で PO 裁定の対象。
2. **決定39(e)「公開した検証環境そのものへの認証は別途」の決着。**
   Cloudflare Access はこの未決事項に対する1つの答えでもある。`identity-gated` を導入する時点で、決定39(e) を閉じられる。
3. `meta/modules.json` が実運用で使われているかの確認（survey §5）。使われていないなら、`meta/exposers.json` を作る前にレジストリ運用そのものを整理した方がよい。
4. **§3.1 の障害原因は推定**。実機の Caddy JSON を1回見るまで確定しない（task-A の最初の一手）。
