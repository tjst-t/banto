# Claude ログインの中継——「呼び出しごとに開け閉め」をやめて、Project のコンテナに常設する（2026-09-27、検討）

**まだ決まっていない。** 決まったら `docs/specs/v4-security.md` §1、`docs/specs/v4-modules.md` §2.3（`claudeLogin`）・§4.1、
`docs/tasks.json` の `claude-login-relay-owner` を直す。

## 0. 結論（先に）

**推す案：中継を core が1本だけ常設し、Project のコンテナが起きている間じゅう、そのコンテナの環境に
「中継の住所と、その Project 用の合言葉」を入れておく（案A）。** 呼び出し口ごとの開け閉め
（サブエージェント・Shell の `claudeLogin`・将来の Service・E2E）は全部なくなる。

理由を3つに絞ると：

1. **寿命を、本当に必要な単位に合わせる。** 「この Project のコンテナから Claude を呼べる」は Project 単位の
   能力であって、コマンド1回の能力ではない。いまは1回ごとに開け閉めしているので、呼び出し口が増えるたびに
   開け閉めの配線が増え、閉じ忘れの上限（12時間）という安全網まで必要になっている。寿命をコンテナに合わせれば、
   配線も安全網も要らない
2. **持ち主が、機構の実態と一致する。** 中継は「セキュリティ境界を守るために host が持つ機構」で、境界は core が
   詰めると決めてある（`v4-security.md` §1）。コンテナを作り・起こし・止めるのも core。同じ寿命のものは同じ持ち主が
   持つのが自然で、「サブエージェントの設定の Module が持っている」という名前と中身のずれも消える
3. **安全性は下がらない。** 中の AI が root でも本物のトークンは取れない（いまと同じ）。合言葉が漏れたときの害は
   「その Project のコンテナが起きている間、推論だけ使える」で、いまの「開いてから最長12時間、ブリッジに届く誰でも」
   より狭くできる（送り元のアドレスをそのコンテナに縛る）

**今日決めた `claudeLogin: true`（Shell の runCommand の引数）は、実装しない方がよい。** 実装すると
「呼び出し口ごとの開け閉め」がもう1本増え、あとで消す対象が増える。代わりに案Aを先にやると、Shell からの
Claude 利用は**何も足さずに**通る（環境に最初から入っているため）。

## 1. 何を読んだか

- 実装：`banto/packages/modules/subagent/src/claude-login-proxy.ts`（中継本体）、同 `settings-server.ts`
  （`openClaudeLoginProxy` / `closeClaudeLoginProxy` と12時間の上限）、同 `claude-login-access.ts`
  （中継越しに開いてもらう口）、同 `server.ts` の `launchFor`（開く→env に入れる→cleanup で閉じる）、
  `banto/packages/core/src/cli.ts`（コンテナの中に Module を起こすときに `BANTO_HOST_ADDRESS` を渡す箇所）、
  `banto/packages/container/src/project-container.ts`（`hostAddress`）
- 仕様：`docs/specs/v4-security.md` §1（閉じ込め・中継は host・持ち主は `subagent-settings`）・§3
  （中継が縛らないものの表）、`docs/specs/v4-modules.md` §2.3（`claudeLogin`）・§4.2（Service）
- 検討ログ：`docs/notes/2026-09-24-subagent-acp.md`（setup-token → 本体のログイン共有への切り替え、3案の比較）、
  `docs/notes/2026-09-27-vault-credential-proxy.md`（Vault の汎用中継、却下）
- Claude Code の公式ドキュメント（2026-09-27 に取得。§3 に確かめた内容）

## 2. 今の形の何が「パッチ的」なのか

感覚を言葉にすると、**5つのずれ**に分けられる。

### 2.1 寿命が、必要な単位より短い

必要なのは「この Project のコンテナで動くものが Claude を呼べる」こと。これは Project（＝コンテナ）の寿命を持つ
能力である。ところが中継の寿命は「1回の仕事」（サブエージェントの1回・コマンド1回）にしてあるので：

- 呼び出し口ごとに **開く→env に入れる→終わったら閉じる** の配線が要る。サブエージェント（`launchFor` の
  `cleanup`/`explain`）、Shell（今日足した `claudeLogin`）、次は Service、その次は E2E……と**同じ配線が増え続ける**
- Service は「止めるまで動く」ので**1回の寿命と合わない**。Vault 中継案のノートでも「Service では合言葉の寿命＝
  サービスが動いている間」と別扱いにする必要が出ていた。呼び出し口が増えるたびに寿命の規則も増える
- **閉じ忘れの上限（12時間）**が要るのは、寿命を短くしたことの副作用。「Module が落ちたら残る」を心配して
  安全網を足している——寿命をコンテナに揃えれば、コンテナを止めるときに一緒に消えるだけで済む

### 2.2 持ち主が、機構の実態と合っていない

- 中継が `subagent-settings` にあるのは、**最初の利用者がサブエージェントだった**から。仕様も「名前と合わない」と
  認めたうえで当面そのまま、としている
- Shell から使うと、**Project の Module（Shell）が、無関係な banto 全体の Module（subagent-settings）に
  `dependsOn` で依存する**形になる。Shell の宣言に「サブエージェントの設定」が現れるのは、初見の人が読んで
  意味が分からない（規則11 に反する）
- しかも Shell → `openClaudeLoginProxy` は `module` 可視性で `valueFree` ではないので、**Module 間中継の初回承認
  ゲート**に掛かる。人に出る問いは「Shell が subagent-settings の openClaudeLoginProxy を呼ぼうとしています」
  ——Claude のログインの話だと読み取れない。承認画面に「Claude のログインを使う」と別に出す決定もあるので、
  **同じことに2つの承認**が出る

### 2.3 待ち受けが1回ごとに生まれる

- 開くたびに**新しいポート**で待ち受ける（`listen(0, host)`）。合言葉も住所も毎回違う
- そのために **listenHost をコンテナの中から host に伝え返す**配線がある（core が `BANTO_HOST_ADDRESS` を
  コンテナに渡し、中の Module がそれを引数にして host の Module に「ここで待ち受けて」と頼む）。host は自分の
  ブリッジのアドレスを知っているのに、一度コンテナを経由して戻ってきている
- 開いた中継の一覧（`proxies` の Map）が Module のプロセスに載る。Module が再起動すれば失われ、コンテナの側には
  もう届かない住所が残る

### 2.4 AI が「使う」と言わないと使えない

- Shell では `claudeLogin: true` を AI が引数に書く。**書き忘れると `claude -p` が「ログインしていない」で落ちる**。
  E2E や Agent SDK を使うアプリのテストを AI に頼むとき、毎回この引数の存在を思い出させる必要がある
- サブエージェントでは Module が黙って入れる（`sharesHostClaudeLogin`）。**同じ能力の得方が呼び出し口ごとに
  違う**（暗黙／明示の引数／将来の Service は登録時の項目？）

### 2.5 「コンテナの中の AI は1人」という原則と、粒度が合っていない

`v4-security.md` §1 は「中から来たものは、その Project の AI と同じに扱う」と決めている。中では root なので、
コマンド1回に渡した合言葉も、同じコンテナの別のプロセスから読める。**1回ごとに分ける粒度は、コンテナの中では
守れていない**——分けているように見えるだけで、実際の境界は「コンテナ」である。機構を境界の粒度に合わせるなら、
合言葉は Project（コンテナ）ごとに1つで足りる。

## 3. Claude Code 公式の仕組みで、確かめたこと・推測

**確かめた**（`code.claude.com/docs`、2026-09-27）：

- **認証の優先順位**（`/docs/en/authentication`）：クラウド事業者の資格情報 → `ANTHROPIC_AUTH_TOKEN`（`Authorization: Bearer`
  で送る）→ `ANTHROPIC_API_KEY`（`x-api-key`）→ `apiKeyHelper` の出力 → `CLAUDE_CODE_OAUTH_TOKEN` → プロファイル →
  `/login` のサブスクのログイン
- **`ANTHROPIC_BASE_URL` だけを設定し、ゲートウェイ用の資格情報の変数を設定しない場合、claude.ai のログインが
  そのまま有効な資格情報として使われる**（`/docs/en/llm-gateway`「Subscriptions and gateways」）。そのとき
  上流に流す gateway は `anthropic-beta` ヘッダーの OAuth の項目をそのまま転送しなければならず、剥がすと 401 になる
  （`/docs/en/llm-gateway-protocol`「Request headers」）。**今の中継が動いているのはこの形**——エージェントは
  `CLAUDE_CODE_OAUTH_TOKEN` を「ログイン」と解釈して OAuth 用の beta ヘッダーを付け、中継はヘッダーを触らずに
  Authorization だけ差し替えている
- **`ANTHROPIC_AUTH_TOKEN` や `apiKeyHelper` を使うと、サブスクのログインは使われない**（同「Subscriptions and
  gateways」：「the credential replaces the subscription login for that session, and the subscription's usage limits
  don't apply」）。つまり **合言葉を `ANTHROPIC_AUTH_TOKEN` で渡す形にすると、エージェントはサブスクではなく
  API キー扱いで振る舞う**。`apiKeyHelper` も同じ（出力は `x-api-key` と `Authorization` の両方に載る）
- **gateway が受けるのは `/v1/messages` と、任意で `/v1/messages/count_tokens`**。起動時に `HEAD /api/hello`・
  `GET /v1/models?limit=1000` が来ることがあるが断ってよい。fast mode の可否確認と WebFetch のドメイン確認は
  `ANTHROPIC_BASE_URL` を無視して `api.anthropic.com` へ直接行く（`/docs/en/llm-gateway-protocol`）
- **`claude setup-token`**：1年もの、サブスク（Pro/Max/Team/Enterprise）が要る、「model requests しかできない」
  （Remote Control・claude.ai のコネクタは不可）、`--bare` では読まれない
- **Agent SDK には gateway 専用の設定は無く、起こす Claude Code のプロセスに環境変数を渡すだけ**
  （`/docs/en/llm-gateway-connect`「Agent SDK」）。TypeScript と Python で `env` の扱いが違うと書いてあるが、
  どう違うかまでは今回読んでいない
- **Incus の `environment.*`**（instance option）：「Extra environment variables to set on boot and during exec」。
  `incus exec` で起こす全プロセスに入り、動かしたまま変えられる（live update: exec）

**推測**（測っていない）：

- `CLAUDE_CODE_OAUTH_TOKEN` に合言葉、`ANTHROPIC_BASE_URL` に中継、という今の組み合わせは、**エージェントを
  「サブスクでログインしている」状態に見せる唯一の組み合わせ**だと思われる。`ANTHROPIC_AUTH_TOKEN` に替えると
  OAuth の beta ヘッダーが付かず、中継が本体の OAuth トークンを差し込んでも上流で 401 になる可能性が高い。
  **したがって「公式の gateway の作法（`ANTHROPIC_AUTH_TOKEN`）に乗り換える」案は、サブスクの枠を使う限り成り立たない**
- `apiKeyHelper` でコンテナの中から host に「いまの合言葉」を取りに行かせる形も、同じ理由でサブスク扱いにならない
- 合言葉の寿命を延ばしても、上流に出る要求は変わらない（中継が毎回本物を読み直す設計はそのまま）

## 4. 案

### 案A：core が中継を1本常設し、Project のコンテナの環境に住所と合言葉を入れておく（推す）

**形**：

- 中継は **core の HTTP サーバに1つの口**として置く（コンテナからすでに届いている `http://<host側アドレス>:<port>/relay`
  の隣、たとえば `/claude/v1/messages`）。新しいポートも、Module のプロセスも増えない
- 合言葉は **Project（コンテナ）ごとに1つ**。core がコンテナを起こすとき（`containers.ensure`）に発行し、
  コンテナを止めるときに無効にする。起こし直せば替わる
- **コンテナの環境に常時入れる**：`ANTHROPIC_BASE_URL`・`CLAUDE_CODE_OAUTH_TOKEN`・`CLAUDE_CODE_SUBSCRIPTION_TYPE`・
  `CLAUDE_CODE_RATE_LIMIT_TIER`。入れ方は2通りあり、どちらでもよい：
  - (a) core が `incus exec` で Module を起こすときの env に足す（いま `BANTO_HOST_ADDRESS` を渡している場所）。
    Shell の子プロセスへは `buildChildEnv` が `BANTO_*` 以外を通すので、**何も足さずに**届く。サブエージェントは
    `PASS_THROUGH_ENV` にこの4つを足すだけ。Service は Module が systemd の定義に写す
  - (b) Incus の `environment.*` に置く。`incus exec` で起きる全部に入り、人が `incus exec` で中に入って手で
    `claude` を打っても通る。値がインスタンスの設定に載る（host の `incus config show` で見える——host 側なので
    境界は越えない）
- **中継が確かめるもの**：合言葉が Project のものと一致すること、**送り元のアドレスがその Project のコンテナの
  アドレスであること**（core は `incus` の状態からコンテナの IP を引ける）、パスが `/v1/messages` 系であること。
  Authorization は本体のトークン（毎回読み直す）に差し替える——ここは今の `claude-login-proxy.ts` のまま
- **人への確認**：Project 設定に「この Project に Claude のログインを使わせる」を置き、**既定はオン**でよいと考える。
  理由：その Project の会話の本体（Runner）はすでに同じログインで動いており、コンテナの中の AI は「その Project の AI」
  と同じ扱い（§1）。オフにすると中継はその Project の合言葉を断り、環境からも外す（次に起こすときに効く）。
  banto 全体の「サブエージェント」設定画面にある「本体のログインを使う」の表示は、この Project 設定に移す
- **観測**：中継は常設なので、**Project ごとの要求数と直近の 401**を持てる。本体のトークンが切れたら受信箱に
  「banto 本体の Claude ログインが期限切れ」と1件出す（いまは呼び出しが失敗した後で `explain` が推測している）

**呼び出し口はどうなるか**：

| 口 | いま | 案A |
|---|---|---|
| サブエージェント | Module が host に開いてもらい、終わったら閉じる | 環境を通すだけ。`claude-login-access.ts`・`openClaudeLoginProxy`・`closeClaudeLoginProxy` は消える |
| Shell の `runCommand` | `claudeLogin: true` で開け閉め（今日決めた、未実装） | **引数は要らない**。`claude -p` がそのまま通る |
| Service | 未設計（合言葉の寿命をサービスに合わせる案） | 環境を定義に写すだけ |
| コンテナの中で banto の E2E | 準備処理が資格情報ファイルを要求して止まる | E2E 側が環境変数でも通るようにすれば動く（Vault 中継案のノートと同じ手直し） |
| 人が `incus exec` で中に入る | 通らない | (b) なら通る |

### 案B：今の形（呼び出しごとに開け閉め）のまま、持ち主だけを独立した Module に移す

`tasks.json` の候補にある「独立した『Claude ログイン』の Module」。名前のずれ（§2.2）だけが直り、寿命のずれ
（§2.1）・待ち受けの増殖（§2.3）・引数の書き忘れ（§2.4）はそのまま。Service の分は別途設計が要る。
**「パッチ的」の中身の大半は残る。**

### 案C：`claude setup-token` の長期トークンを Vault に置き、`envSecrets` で渡す（中継を持たない）

2026-09-24 の午前に一度決めて、同日に「本体のログインを共有する」で置き換えた案。機構としては最もシンプル
（中継が無い。公式が CI 用に用意している形）。**中の AI が root なので1年もののトークンを読める**のが代償——
推論しかできないトークンとはいえ、コンテナの外に持ち出せば1年使える。無効化はできる。人の手間は「1年に1回
`claude setup-token` を打って Vault に貼る」。既定のモデルは `CLAUDE_CODE_SUBSCRIPTION_TYPE` を別に渡さないと
Sonnet に落ちる（実測済み）。**ユーザーが「別途ログインが要るのは違和感」と退けた案**なので、選ぶなら決定を
明示的に覆すことになる。

### 案D：Vault の汎用「中継で渡す鍵」の出どころの1つに Claude を加える（今日却下した案の B2）

Claude 専用ではなく、OpenAI 等の鍵も同じ機構で渡す。行き先を鍵に縛る・要求ごとに記録できる、という利点は
本物だが、**寿命は「1回の仕事」のまま**（Service は別扱い）で、§2.1・§2.3・§2.4 は残る。今日「登録の手間が増える」
で却下されたとおり、汎用化の分だけ人の手間が増える。**案Aと排他ではない**——将来、汎用の鍵を中継で渡したくなったら、
案Aの中継に「出どころ」を増やす形で足せる。

### 案E：透過型の egress proxy（`HTTPS_PROXY` とコンテナごとの使い捨て認証局）で、全通信に差し込む

Cloudflare Sandbox・nono の形。`gh`・`git` のような住所を差し替えられない道具にも効く。代償が大きい：コンテナに
認証局を入れる、中継が全通信を復号して読む（`v4-security.md` §4 に「TLS を割る代理は、通る資格情報を全部平文で
読める」と懸念を書いてある）、Claude Code は一部の要求を `ANTHROPIC_BASE_URL` を無視して直接送る（fast mode の
確認）。**Claude のためだけに入れるものではない。**

## 5. 比較

| | A 常設（core） | B 開け閉めのまま持ち主だけ | C setup-token を Vault | D Vault 汎用中継 | E 透過 proxy |
|---|---|---|---|---|---|
| シンプルさ | 口1つ・合言葉は Project に1つ・開け閉め無し | 今と同じ複雑さ | 中継が無い（最も単純） | 汎用化の分だけ増える | 認証局・TLS 復号が増える |
| root の AI が本物のトークンを取れるか | 取れない | 取れない | **取れる**（1年もの） | 取れない | 取れない |
| 合言葉が漏れたときの害 | 推論だけ・その Project のコンテナが起きている間・**送り元をコンテナに縛れば外からは使えない** | 推論だけ・開いてから最長12時間・ブリッジに届く誰でも | 推論だけ・1年・どこからでも（無効化は可） | Bと同じ | 認証局の秘密鍵が漏れると全通信 |
| 人の手間 | Project 設定のスイッチ1つ（既定オン） | 承認カード（開くたび／Module 間の初回） | 1年に1回トークンを取り直して貼る | 鍵ごとに行き先・差し込み方を登録 | 認証局の管理 |
| 実装量 | 中継の移設（既存コード流用）＋ env を足す＋消す側が多い | 新 Module 1本＋Shell の開け閉め＋Service の分 | ほぼ無し（E2E の手直しのみ） | Vault・vault-kit・窓口の拡張 | 大 |
| 既存の決定との食い違い | 「持ち主は subagent-settings」「`claudeLogin` 引数」「承認画面に出す」を変える | 「当面 subagent-settings」を早めに覆すだけ | 2026-09-24 の決定を覆す | 今日の却下を覆す | §4 の懸念に正面から当たる |
| Service・E2E への広がり | そのまま効く | 別設計が要る | そのまま効く | 別扱いが要る | そのまま効く |

## 6. 案Aの細部で、決めるべきこと

1. **持ち主は core か、同梱の banto 全体 Module か。** core を推す。中継の寿命はコンテナと同じで、コンテナを持つのは
   core。セキュリティ境界は core で詰める（§1）。「機能はすべて MCP の向こう」の原則には反するように見えるが、
   これは AI に見せる機能の話であり、中継は**境界の機構**で AI の tool ではない（host 中継 `/relay` と同じ層）
2. **環境の入れ方は (a) exec の env か (b) Incus の `environment.*` か。** まず (a) を勧める——いま `BANTO_HOST_ADDRESS`
   を渡している経路と同じで、新しい機構を増やさない。(b) は「人が中に入って `claude` を打てる」利点があるので、
   欲しくなったときに足す（規則12：`environment.*` は名前のある既知の答え）
3. **送り元のアドレスの縛り。** コンテナの IP は DHCP で振られる。core は `incus` の状態から読めるので毎回引くか、
   合言葉だけで守るか。縛れば漏れた合言葉が外で効かなくなるので縛る方を勧めるが、先に「同じブリッジの別コンテナ
   から届くか」「IP が変わることがあるか」を測る（30秒のプローブで済む）
4. **既定でオンにするか。** 今日の「承認画面に『Claude のログインを使う』と出す」を、Project 設定のスイッチに
   置き換えることになる。1回ごとの承認は、中で root の AI が同じコンテナの合言葉を読める以上、本当の柵にはなって
   いなかった（§2.5）。**枠の消費を人が見られること**（観測）を柵の代わりにする
5. **中継の要求を Event Store に残すか。** 要求ごとだと多すぎる。Project ごとの計数（回数・最終時刻・直近の 401）を
   中継が持ち、Project 設定に出す程度でよい。本体のログインが切れたときの受信箱の1件だけは残す

## 7. 移行の順番

1. **`claudeLogin: true` は実装しない。** `v4-modules.md` §2.3 の当該項を「コンテナの環境に常に入っている」に
   書き換える（この検討が採用されたら）
2. **core に中継の口を作る。** `claude-login-proxy.ts` の中身（トークンの読み直し・パスの制限・Authorization の
   差し替え・ヘッダーの扱い）をそのまま core へ移し、`/relay` と同じサーバの1パスにする。合言葉は Project ごと。
   送り元のアドレスの確認は、先に測ってから入れる
3. **コンテナを起こすときに env を渡す。** `cli.ts` の `BANTO_HOST_ADDRESS` を渡している箇所に4つを足す。
   Project 設定にスイッチを置き、オフなら渡さない
4. **サブエージェントを痩せさせる。** `claude-login-access.ts`・`openClaudeLoginProxy`・`closeClaudeLoginProxy`・
   `PROXY_MAX_LIFETIME_MS`・`launchFor` の `cleanup`/`explain` の中継部分を消し、`PASS_THROUGH_ENV` に4つを足す。
   `claudeLoginStatus`（設定画面の表示）は core の状態を出すものに置き換える
5. **Shell は変えない。** `buildChildEnv` はもう通す。仕様の `claudeLogin` の項を消す
6. **E2E の準備処理を、環境変数でも通るようにする**（`e2e/global-setup.ts`）。これで「コンテナの中で banto の
   E2E を回す」が通る——これが今回の目的だった
7. **仕様・タスクを直す。** `v4-security.md` §1（持ち主 → core、寿命 → コンテナ）、`v4-modules.md` §2.3・§4.1、
   `tasks.json` の `claude-login-relay-owner` を決着、`BANTO_HOST_ADDRESS` が要らなくなるなら消す
8. **Service を作るときは何も足さない**——環境を systemd の定義に写すだけ

**先にやる順で言えば：2 → 3 → 6 の3つで目的（コンテナの中の E2E）に届く。4・5・7 は掃除で、同じ日にやる。**

## 8. 残る問い

- 同じブリッジ上の別 Project のコンテナから、この口に届くか（届くはず——だから合言葉と送り元の縛りが要る）。測る
- コンテナの IP が寿命の途中で変わることがあるか。測る
- Agent SDK（TypeScript）の `env` が process.env を継ぐか置き換えるか。継がないなら、中のアプリは自分で渡す必要が
  あり、E2E の手直しの範囲に効く。公式ドキュメントに「TS と Python で違う」とあるが未確認
- 案D（汎用の鍵の中継）を将来やるとき、案Aの口に「出どころ」を増やす形で足せるか——たぶん足せるが、そのときに
  Vault との関係（鍵は Vault、中継は core）をもう一度決める
- 入れ子（コンテナの中で動く banto が、さらに自分のコンテナを持つ）で、内側の banto は何をログインとみなすか。
  今回の範囲外

## 9. 出典

- [Authentication — Claude Code Docs](https://code.claude.com/docs/en/authentication)（優先順位・`setup-token` の制限）
- [Other LLM gateways — Claude Code Docs](https://code.claude.com/docs/en/llm-gateway)（「Subscriptions and gateways」）
- [Gateway compatibility guide — Claude Code Docs](https://code.claude.com/docs/en/llm-gateway-protocol)（口・ヘッダー・直接行く要求）
- [Connect Claude Code to an LLM gateway — Claude Code Docs](https://code.claude.com/docs/en/llm-gateway-connect)（`ANTHROPIC_AUTH_TOKEN`・`apiKeyHelper`・Agent SDK）
- [Instance options — Incus](https://linuxcontainers.org/incus/docs/main/reference/instance_options/)（`environment.*`）
- `docs/notes/2026-09-24-subagent-acp.md`・`docs/notes/2026-09-27-vault-credential-proxy.md`（この前の2回の検討）
