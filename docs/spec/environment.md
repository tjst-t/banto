---
id: spec-environment
type: spec
status: draft
decided_by: po
refs: [vision, principles, adr-0010]
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
    setup: "npm ci --ignore-scripts"   # 立てたあと一度だけ（→ 下記）
    ttl: 30m
  staging:            # 外部VM評価用
    driver: ./meta/drivers/proxmox-vm
    config: { template: 9000, node: pve1, size: medium }
    credentials: staging-pve      # 参照名のみ。実体は書かない（→ §4）
    ttl: 24h
    quota: { max_instances: 2 }
```

- `driver`: ビルトイン名（`process` / `docker`）またはプロジェクト内実行ファイルへのパス
- `ttl`: 生存期限。超過分は Environment Pool が強制teardownする。**能力側のハード上限を超える値は拒否される**（→ §5）
- `quota.max_instances`: プロファイルごとの同時実行上限。執行は Environment Pool（→ §5）
- `credentials`: シークレットの参照名。実体はsops管理でこのファイルには書かない
- `setup`: **立てたあと・検証を回す前に一度だけ**走らせるコマンド（任意・task-0080。→ §1.3）

**統一原則**：レビュー用dev server、監査時のテスト実行、自己更新の隔離検証、外部VM評価は、すべてこの同じ抽象の上で行う。環境提供の仕組みを複数作らない（→ D3, D4）。

### 1.1 プロファイルの在り処（ADR-0010 決定34c）

**呼び出し側が `repoPath` を渡し、Environment Pool が `<repoPath>/meta/environments.yaml` を都度読む**（D3：ファイルは意図。キャッシュしない）。

Environment Pool は独自のプロジェクト登録簿を持たない。Kobo は自分の `ProjectRegistry` から、番頭は自分が知っている作業場所から `repoPath` を渡す。モジュール側にも登録簿を置くと Kobo のそれと二重管理になり、食い違ったときにどちらが正か決められなくなる。

### 1.3 `setup`：「立った」と「使える」は別（task-0080）

**`provision` が返っても、検証コマンドが走る状態とは限らない。** docker のプロファイルは node_modules を名前付きボリュームに隔離するのが普通で、`compose up -d` が返っても中は空。`setup` はその差を埋める場所。

- **走らせるのは Environment Pool、`provision` の一部として**。呼び出し側から見て「provision が成功した」＝「検証コマンドを走らせられる」になる。段を分けて呼ばせると、呼び忘れた経路（番頭のアドホック・`env.verify`・マージ前ゲート）ごとに同じ穴が開く
- **1環境につき1回**。受け入れ条件ごとではない
- **失敗したら provision が失敗し、環境は畳まれる**（I2・I3）。呼び出し側には「用意できなかった」として届き、マージ前ゲートは `verify_env_unavailable` と言う——**`verify_failed` と同じ言葉にしない**。用意でこけたのにテストが落ちたと読める形が、実際に一番困った（inc-0034）
- 制限時間は能力側が持つ（`defaultSetupTimeoutMs`・→ §5.1）。依存の取得は検証コマンドより長くなりがちだが、1環境に1回しか走らない

**なぜ `verify` 側に書かせないか。** 書かせると①受け入れ条件ごとに繰り返す②タスクを書く側が用意の仕方を当てさせられる③失敗の言葉が間違う——の3つが同時に起きる。実機で踏んだ（loamium/task-0004 は node_modules が無く exit 127、task-0005 は各 `verify` の頭に `npm ci --include=dev` を足して postinstall で落ちた。正解は `--ignore-scripts` で、それはリポジトリの `Dockerfile` のコメントに書いてあった）。

**docker では、`setup` の成果が次の `run` へ渡るのは名前付きボリュームのぶんだけ。** `run` は `compose run --rm` のまっさらな one-off で動き、本体の書き込み層は共有されない（→ §2）。`npm ci` が置く node_modules はボリュームなので渡る。

### 1.2 アドホック環境（ADR-0010 決定34e）

プロファイル名の代わりに `driver` と `config` を直接渡して環境を起こせる。番頭が「このコマンドをこの worktree で回して」と頼むための経路で、そのたびにプロジェクトの `environments.yaml` を書き換えずに済む（→ P1「スコープ外パスに触らない」）。

- **既定ではビルトインドライバ（`process` / `docker`）のみ**。外部ドライバ（＝VM等、費用の出る側）のアドホックを許すかは能力側の設定で開ける（既定は閉じる。→ §5.1）
- アドホック環境にも**必ず既定 TTL を付けて台帳に載せる**。プロファイル経由かどうかで掃除の扱いを変えない（→ §5）
- 線引きの理由は「お金がかかるかどうか」。手元の検証は軽く回せて、外部リソースは形式化された定義を通る

## 2. ドライバ契約

ドライバは**動詞をサブコマンドに持つ実行ファイル**。入力は引数＋stdin(JSON)、出力はstdout(JSON)。exit 0以外は失敗。

| 動詞 | 入力 | 出力 | 規約 |
|---|---|---|---|
| `provision` | config JSON, taskId, **workdir**, **timeoutMs** | `{handle: {...}}` | handleは不透明JSON。呼び出し側は中身を解釈しない |
| `deploy` | handle, artifact path | — | 成果物の配置・反映 |
| `healthcheck` | handle | `{ok: bool, detail?}` | 起動完了・疎通の判定 |
| `run` | handle, cmd, **workdir**, **timeoutMs** | `{exit: int, log_path}` | 検証コマンドの実行。ログはファイルで返す。**時間切れは `exit: 124`**（→ 後述） |
| `collect` | handle, dest dir | — | ログ・成果物の回収 |
| `teardown` | handle | — | **冪等必須**。対象が既に無い場合は成功扱い |
| `list` | — | `[{handle, name, created}]` | **自分が作ったもの**の列挙。照合(→ §5)に使う。**名前から推測してはならない**（→ §2.1） |

- ビルトインドライバは `process`（ローカルプロセス起動）と `docker`（compose）の2本のみ
- ドライバの追加要件：管理下リソースには**taskIDを含む命名**を適用すること（例：`banto-env-task-0042`）

- **list が返す handle は、同一リソースについて provision が返した handle と一致しなければならない（フィールドの有無・値とも）**。照合（→ §5）は両者を `JSON.stringify` で突き合わせるため、`workdir` のように「渡されたときだけ含める」フィールドは省略の有無まで揃えていないと、正規に provision した環境を「台帳に無い実リソース」と誤検出する（2026-08-01 PO裁定）

**`timeoutMs`（task-0079 / inc-0034）**：**全ての動詞の入力に、呼び出し側の持ち時間が載る。** Environment Pool が §5.1 の設定から決めた値をそのまま渡す。

- **ドライバは自分で持ち時間を決めない。** 決めるのは能力側（§5.1・§8 の裁定）であり、ドライバが独自の既定を持つと同じ「持ち時間」に2つの真実ができる（D3）
- ドライバは**報告のための取り分を引いた値**を内側のコマンドに掛ける。予算をそのまま掛けると、ログを書いて出力を返す前に呼び出し側の subprocess timeout に殺され、**何が起きたか分からない失敗**になる
- **時間切れは `exit: 124` で返す**（`timeout(1)` の慣習）。マージ前ゲートの「時間切れなら延ばして再試行」はこの値を見ている。ここを外すと直しが黙って効かなくなる
- **入力に `timeoutMs` が無いときは内側で縛らない。** 短い既定へ落とすと、呼び出し側の指定を無効化する形に戻る（実際に踏んだ：同梱の docker ドライバが自前の120秒で全ての検証を切っており、`defaultRunTimeoutMs` の10分が一度も効いていなかった。しかも `docker` は SIGTERM を捕まえて 255 で終わるので、時間切れが「コマンドが 255 で落ちた」に化けていた——inc-0034）

**`workdir`（ADR-0010 決定34d）**：どこで動かすかは呼び出しごとに変わる（職人が作った worktree 等）ので、プロファイルの `config`（静的）ではなく動詞の入力として渡す。

- ドライバは `workdir` を cwd としてコマンドを起こし、`config` 内の相対パス（compose ファイル等）もそこから解決する
- **省略時は Environment Pool の cwd**。既存プロファイル・既存ドライバを壊さないための後方互換
- Environment Pool は `workdir` を台帳に残す。プロセスが落ちて起き直しても、後続の `run` に同じ場所を渡せる（handle から導出できない入力のため）

### 2.1 所有は記録する。名前から推測しない（PO指摘 2026-08-08）

**`list` が返してよいのは「このドライバが作ったと記録してあるもの」だけ。**

docker ドライバは `docker compose ls` の全件から**名前が `-docker` で終わるもの**を自分のものと
みなしていた。実測で、banto と何の関係もない `myapp-docker`——compose は既定でディレクトリ名を
プロジェクト名にするので、ごく普通に在りうる名前——が「台帳に無い実リソース（孤児）」として
挙がった。ここに孤児を畳む口を付けていたら、**POの無関係なコンテナを壊していた**。

- **作ったときに記録し、畳んだときに落とす。** `list` は記録と実在の**積**を返す
- 記録に在るのに実在しないものは、外で消された分。記録から落として溜めない
- **記録を失ったら空を返す**（＝何も自分のものと言わない）。検出は落ちるが、
  他人のものを自分のものと言うことは無い——**倒れる向きを安全側にする**
- 名前空間（`banto-env-<taskId>`）は**二重の守りの片方**であって、所有の根拠ではない

## 3. Environment Pool との関係・エージェントからの利用

> **改訂（ADR-0010 決定32、2026-07-30）**：本節は当初「ドライバを起動するのは常にKobo」としていたが、決定32 で `EnvDriver` の実行能力を Kobo から独立した **Environment Pool モジュール**へ切り出すと裁定した（決定23 の Worker Pool と同じ扱い）。守るべき不変条件は「Kobo」という固有名詞ではなく、**ドライバを回して結果を記録するのは依頼者ではない信頼された第三者である**こと（I1）。以下はその読み替え後の記述。

- ドライバを起動するのは **Environment Pool**。依頼者（番頭・Kobo）は `env.deploy` 等の**動詞ツール**（決定9 の `env.*` ドメイン）を呼び、Environment Pool がドライバプロセスを起動して結果を台帳とログに記録する
- **番頭は `env.*` を直接呼べる**（決定32c）。これにより番頭は Kobo 無しでも、機構が返した事実として検証結果を受け取れる——職人の自己申告に頼らずに済む（→ 決定29(a)）
- **職人には直接経路を与えない**。職人は「成果を出す側」であり、自分の成果を自分で検証させると I1 が崩れる。検証は依頼元（番頭）が回す
- エージェントプロセスとドライバプロセスは分離される。エージェントがドライバを直接実行する経路、Hypervisor/クラウドAPIを直接叩く経路は提供しない（→ I1、「ずるは不可能にする」）
- レビューフローとの接続：タスクがreviewフェーズに入ると、Koboはタスク定義の `environment` を Environment Pool 経由でprovisionし、tmuxウィンドウのペイン2に接続する

### 3.1 `env.*` Tool 契約（ADR-0010 決定34a・34b）

**高位1本と低位動詞の両立て。** 使い捨ての検証は高位1本で畳みまで機構が持ち、居座らせたい環境（レビュー用 dev server）は低位動詞で組む。Worker Pool の `worker.delegate`（高位）と `worker.steer` / `worker.close`（低位）と同じ形。

**識別子は `envId`。** `provision` が返し、以降の動詞はこれで指す。Kobo のタスクIDには縛られない——番頭は Kobo 無しでも呼べなければならない（決定32c）。`projectTag` / `taskId` は「何の検証か」を台帳とログに残すためのラベル。

| Tool | 入力 | 出力 |
|---|---|---|
| `env.verify` | `repoPath`, `cmd`, `workdir?`, `profile?` \| (`driver`+`config`), `taskId?`, `projectTag?`, `artifactPath?` | `{exit, logPath, logTail, envId, tornDown, teardownError?}` |
| `env.provision` | `repoPath`, `taskId`, `workdir?`, `profile?` \| (`driver`+`config`), `projectTag?` | `{envId, profile, driver, healthcheck: {ok, detail?}, ttlDeadline}` |
| `env.deploy` | `envId`, `artifactPath` | `{ok}` |
| `env.healthcheck` | `envId` | `{ok, detail?}` |
| `env.run` | `envId`, `cmd` | `{exit, logPath, logTail}` |
| `env.collect` | `envId` | `{dest}` |
| `env.teardown` | `envId` | `{ok}`（**冪等**。既に無ければ成功） |
| `env.teardown_orphan` | `name` | `{driver, name}`。**孤児を名指しで1件だけ**。一括の口は無い（§5） |
| `env.list` | `projectTag?`, `includeTornDown?` | `{environments: [{envId, profile, driver, taskId, state, createdAt, ttlDeadline, workdir}]}` |

- **`env.verify`** は provision →（`artifactPath` があれば deploy）→ healthcheck → run → collect → teardown を一息で回す。**途中で失敗しても teardown まで到達する**——番頭が畳み忘れても漏れない（→ I3）
- **teardown の失敗を成功に見せない**（I2）。`env.verify` は `tornDown: false` と `teardownError` を返し、台帳には `teardownFailed` が残ってリトライとケイデンス議題に載る（→ §5）
- **`logTail` を返すのはログ本文を番頭に渡すため**。`logPath` だけでは番頭が結果を判断できず、かといって全文は文脈を埋める。上限行数で切り、切ったことを明示する
- **職人には `env.*` を渡さない**（§3 の第3項）。職人は成果を出す側で、自分の成果を自分で検証させると I1 が崩れる

## 4. 認証情報（credentials）

原則：**credentialsはエージェントのコンテキストとツール結果に一度も現れない**。

- 実体はsops等で暗号化管理。`environments.yaml` には参照名のみ
- **Environment Pool** が復号鍵を持ち（ADR-0010 決定32d）、復号して**ドライバプロセスの環境変数として直接渡す**（例：`PVE_URL` / `PVE_TOKEN_ID` / `PVE_TOKEN_SECRET`）。復号値は Environment Pool のHTTP面の応答にもエージェントの文脈にも一度も現れない
- 外部システム側のアカウントは**スコープ済み**にする：専用リソースプール/プレフィックス内の作成・削除のみ可能な権限に限定し、動詞が乱用されても被害がプール内で止まるようにする（→ §7）

## 5. 台帳・TTL・quota・照合

制限の執行はドライバではなく**Environment Pool の台帳**が行う（ADR-0010 決定32e：作った者が片付ける。番頭が Kobo 無しで provision できる以上、台帳と強制 teardown はモジュール側に無いと誰も片付けない）。

- **台帳**：provision成功時、handleを台帳（永続化）に登録。タスク終了時に Environment Pool がteardownを保証する
- **quota**：provision要求時に台帳を参照し、`max_instances` 超過なら拒否
- **TTL**：超過した環境は強制teardown
- **失敗処理**：teardown失敗はリトライし、なお失敗ならケイデンス議題に載せる
- **照合（reconcile）**：Environment Pool は定期的に各ドライバの `list` と台帳を突合する。台帳に無い実リソース（クラッシュ中に生じた孤児等）を検出し、ケイデンス議題に載せる
- **孤児は自動で畳まない。名指しで1件ずつ畳む**（`env.teardown_orphan`・PO裁定 2026-08-08）。
  孤児かどうかはドライバの自己申告（§2.1）に依っており、そこが間違うと他人の作業を壊す。
  §2.1 で判定を記録ベースに直した後も、**誤って報告する代償（雑音）と誤って畳む代償
  （取り返しがつかない）は釣り合わない**。だから畳むのは常に人か番頭の明示の一手にし、
  **一括で畳む口は作らない**。見つからない・複数当たるときは畳まずに断る（I2）
- **番頭も判断で捨てられる**（`env.cleanup`・2026-08-01 PO提案）。期限が来れば機構も捨てるが、要らないと分かっているなら先に捨てた方が溜まらない。**ただし台帳は対象にしない**——台帳は「番頭が何を立てたか」の記録であり、番頭に消させるのは自分の監査記録を編集させるのと同じ（I1）。期間で機械的に刈るのは構わないが、判断で消す対象にはしない。成果物は中身であって記録ではないので番頭が捨ててよい。**パスは受け取らず**、環境の id か「何日より古いか」だけを受ける（`env.collect` の `dest` で塞いだ穴を開け直さないため）
- **溜まったものを捨てる**（2026-08-01・PO指摘）。回収した成果物・台帳の畳んだ記録・ドライバが書いたログは、いずれも放っておくと際限なく増える。番頭は検証のたびにこれを増やすので、Kobo が task 単位で回していた頃より速く溜まる。保存期間を過ぎたものは TTL 執行と同じ tick で捨てる。**生きている環境は期間に関係なく残す**。ドライバのログは、置いた場所を知っているドライバ自身が捨てる
- 外部リソースの消し忘れは金銭的実害が出るため、本節が本仕様で最も優先度の高い機構である（→ I3）
- **知らせは番頭が引きに行く**（task-0067）。Environment Pool は衛生に関わる出来事を
  追記専用のログ（`<台帳>/env-events.jsonl`）に残し、番頭ホストが `env.events` を
  `afterEventId` 付きで追って会話へ返す。独立サービス（決定61）にコールバックを張る案は、
  職人（決定29c）と同じ理由で採らない——起動元が落ちている間の知らせが消え、再送を
  作り始めると結局ログが要る
  - 残すのは**3つだけ**：`env_expired`（期限切れで機構が畳んだ＝呼び出し側の畳み忘れ）・
    `env_teardown_failed`（畳み損ね）・`env_orphans_found`（照合で出た孤児）。
    **立てた・畳んだの実況は残さない**——番頭の会話が検証環境の中継になる。いま何が
    立っているかは `env.list`、Kobo は自分の帳簿の `env_provisioned` を見る
  - **同じことは1度だけ**積む。畳み損ねは畳めるまで毎回の tick で検出されるので、
    そのまま積むと同じ文面が流れ続ける
  - **宛先は既定のスレッド。** `env.provision` は `origin`（決定35a）を受けておらず、
    畳み忘れ・孤児は環境1つの話ではなく置き場全体の衛生なので、会話ごとに振り分けない

### 5.1 既定とハード上限は能力側が持つ（ADR-0010 決定34f）

**Environment Pool が既定値とハード上限を持ち、プロファイルはその範囲内でのみ指定できる。**

D9 で外部VMコストは one-way な副作用（D1 に戻る）とされている。プロファイルに `ttl: 720h` と書けば通る状態では quota が歯止めとして機能しない——機構が上限を持たないと誰も止められない。

| 設定 | 意味 | 既定 |
|---|---|---|
| `defaultTtlMs` | プロファイルが `ttl` を持たないとき・アドホック環境の生存期限 | 30分 |
| `maxTtlMs` | プロファイルが指定できる `ttl` の上限 | 24時間 |
| `maxInstancesPerProfile` | プロファイルごとの同時実行のハード上限 | 4 |
| `maxInstancesTotal` | Environment Pool 全体の同時実行上限 | 8 |
| `adhocDrivers` | アドホック環境で使えるドライバ（→ §1.2） | `builtin`（他に `all` / `none`） |
| `defaultRunTimeoutMs` | `run` の既定の制限時間 | 10分 |
| `maxRunTimeoutMs` | `run` に指定できる制限時間の上限 | 60分 |
| `defaultSetupTimeoutMs` | プロファイルの `setup` に与える制限時間（→ §1.3） | 15分 |
| `collectedRetentionMs` | 回収した成果物を残す期間 | 7日 |
| `ledgerRetentionMs` | 畳んだ環境を台帳に残す期間（生存中は対象外） | 30日 |

- **`provision` も長く待つ**（task-0075・2026-08-07）。当初「他の動詞はすぐ返るはず」と
  していたが、プロファイルが `build:` を持つと `provision` は**イメージのビルド**を含む。
  実測で30秒の既定を超え、**Kobo が検証環境を必須にした以上「新しいプロジェクトの初回ゲートが
  必ず落ちる」**ことを意味した。既定10分（`DEFAULT_PROVISION_TIMEOUT_MS`）。立てるのは
  1タスクにつき1回なので、長く待っても後ろは詰まらない
- **`run` の制限時間だけは丸める**（拒否しない）。TTL や quota と違い「待つ長さ」であって外に残るものではないため、長く待たせすぎない歯止めで足りる。他の動詞（provision / healthcheck 等）はすぐ返るはずのものなので短い既定のままにする——`run` は検証コマンドそのもので、テスト一式が何分もかかるのが普通（2026-08-01 裁定。既定30秒では `npm test` が途中で切れていた）
- **範囲を超えるプロファイルは黙って丸めず拒否する**（I2）。既存の `env_profile_rejected` イベント経路に載せ、なぜ拒否したかを残す。値を勝手に縮めると、書いた人は指定が効いていると思い込む
- `quota.max_instances` は `maxInstancesPerProfile` 以下でのみ指定できる。プロファイルは上限を**緩められない**（厳しくはできる）
- 設定の置き場は Environment Pool の起動オプション（Worker Pool の `WorkerPoolOptions` と同じ形）。デプロイ時の受け渡しは ADR-0010 決定19 の単一インストーラの範疇

### 5.2 環境より長生きする置き場（`cache`・PO裁定 2026-08-08）

**問題**：`setup`（`npm ci` 等）の結果を、環境の寿命より長く生かす場所が契約に無い。
環境はタスクごとに立てて畳むので、**毎タスク同じ用意を払い直している**（実測：banto の
`npm ci --ignore-scripts` が 60 秒。それが毎タスク）。

ドライバごとに違う顔で出る。docker はボリュームが `<taskId>-docker_…` で名付くので
タスクごとに別物になり、`process` は**ワークツリーの中**に作って `removeWorktree` で消す
——同じ費用を、消える場所に払っている。

#### 5.2.1 概念は契約に、実体はドライバに

**どのドライバにも「環境より長生きする置き場」は必ずある**（docker は名前付きボリューム、
`process` はホストのディレクトリ、VM は追加ディスク、k8s は PVC）。だから
`config`（不透明）と `workdir` と同じ分け方をする——**何を置きたいかは契約が言い、
どう置くかはドライバが決める**（D5）。

プロファイルが宣言する：

```yaml
profiles:
  test:
    driver: docker
    config: { compose: docker/test.yaml }
    setup: "npm ci"
    cache:
      # この**ファイルの中身**が置き場の中身を決める。鍵はここから作る
      key:  [package-lock.json, docker/Dockerfile.test]
      # 環境の中でどこに現れてほしいか
      path: /app/node_modules
```

- **鍵は「中身を決めるもの」を全部挙げる。** 挙げ忘れたものが変わると、古い置き場を掴む
  ——`package-lock.json` だけでは足りない場面がある（土台のイメージが変われば
  ネイティブ依存のバイナリが変わる）。**挙げるのは書く人の責任**で、機構は
  ドライバ名とプロファイル名だけを自動で混ぜる（別のプロファイル同士が衝突しないように）
- 鍵はファイルの**中身**。ブランチ名・タスクID・時刻を混ぜない（混ぜた瞬間に鍵の意味が消える）

#### 5.2.2 動詞への足し方（任意・劣化しても安全）

| 動詞 | 足すもの |
|---|---|
| `provision` 入力 | `cacheKey`（文字列）, `cachePath`（環境の中の場所） |
| `provision` 出力 | `cache: {primed: bool}` — その鍵の置き場に**既に中身があるか** |
| `cache-list`（新・任意） | `[{key, sizeBytes?}]` — そのドライバが持っている置き場の全部 |
| `cache-remove`（新・任意） | `{key}` を消す。**冪等必須**（`teardown` と同じ） |

**ドライバが `cacheKey` を無視して `cache` を返さなければ、`primed` は未定義＝毎回 `setup`。
いまとまったく同じ挙動になる。** 既存プロファイル・既存ドライバを壊さない
（`workdir` を足したときと同じ作法）。

Environment Pool の側：

1. `cacheKey = sha256(driver | profile名 | key に挙げたファイルの中身)` を作る
2. `provision` に `cacheKey` / `cachePath` を渡す
3. 返ってきた `cache.primed` が真なら **`setup` を飛ばす**
4. `setup` が成功したときだけ `<cachePath>/.banto-primed` に印を書く
   （**成功したときだけ**——途中で死んだ半端な置き場を「入っている」と誤判定しないため）

#### 5.2.3 上限を先に入れる（PO条件 2026-08-08）

置き場は**外に累積するディスク**なので one-way（D1）。**上限の仕組みを先に入れる**という
条件で採った。機構で担保する：

- **`cacheMaxEntries` に「無制限」を用意しない。** 既定 8。`0` にするとキャッシュ機構
  そのものが止まる（`cache` を書いたプロファイルも、書いていないのと同じ挙動になる）
  ——**上限を外して使う道を作らない**のが条件の守り方
- **`cacheMaxAgeMs`**（既定 30 日）。それだけ使われていない置き場は落とす
- 落とす順は **LRU**。最後に使った時刻は Pool の台帳（`<dataDir>/env-cache.json`）が持つ
  ——ドライバ側からは導出できない（ボリュームに「最後に使った」は無い）
- **掃除は provision のたびに走らせる。** 別の周期を作らない——置き場が増えるのは
  provision のときだけなので、増えた直後に見るのがいちばん漏れない
- **台帳とドライバが食い違ったら、ドライバが真**（§5 の照合と同じ）。台帳に無い置き場は
  「最後に使った時刻が分からない」＝**最初に落とす**
- 掃除で消せなかったことは黙らせない（I2）。理由を出来事として残す

**上限に当たって落とすのは正常な動作**であって失敗ではない。落としたぶんは次に使うとき
また作られる（60 秒払い直す）だけで、正しさは変わらない——置き場は**導出物**であって、
真実は `package-lock.json` の側にある。

#### 5.2.4 これは「環境の使い回し」ではない

環境そのものを貸し借りする案（プールに戻して次のタスクへ貸す）は**採らない**。
`node_modules` は `package-lock.json` から一意に決まる導出物なので共有しても
「まっさらで通った」の意味は変わらないが、**環境ごと使い回すと前のタスクの残骸が次に見え、
落ちた検証が再現しなくなる**（D11）。マージゲートが「確かめた」と言える根拠がそこにある。

ワークツリーの使い回しを採らないのも同じ理由。**使い捨てるのはワークツリー、
キャッシュするのは導出物**、と役を分ける。

## 6. ログ・成果物

- `run` のログ、`collect` の成果物はタスクごとの所定ディレクトリに集約し、監査セッション・レビューセッションのコンテキスト注入元とする
- 収集先パスの規約はKoboが定め、ドライバは渡された`dest`に書くのみ
- **`dest` を決めるのは Environment Pool で、呼び出し側は指定しない**（2026-08-01 裁定・imp-0007）。番頭にパスを書かせると、場所の砦（決定36g）を通らない書き込み先を指定できてしまう——`worker.delegate` の `worktreePath` と同じ形の穴になる
- **回収先は読み取り専用の場所（Place）として登録する。** 置き場所を機構が決めるだけでは、そこは砦の外なので**番頭が取り出したものを読めない**（PO指摘）。場所として出すことで `file.*` からそのまま読め、書き込みは開かない
- Kobo を配線する段では、Kobo が定める収集先の規約で Environment Pool の既定を上書きできる必要がある（→ task-0046）

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
| `deploy` / `run` | SSH経由。鍵はcloud-init注入分をKobo→ドライバの環境変数経路で受け取る |
| `collect` | SSH/scpでdestへ回収 |
| `teardown` | stop → VM削除。**404は成功扱い**（冪等） |
| `list` | プール `agents` のメンバー列挙 |

### 7.4 可視性の保険

provision時、VMのnotesまたはタグに `expires: <timestamp>` を書き込む。Kobo停止期間中の孤児も、Proxmox UIを開くだけで期限切れが目視できるようにする。

## 8. 未決事項

- 隔離検証（自己更新パイプライン）用プロファイルの標準名。自己検証を実際に回す段で決まる

### 裁定済み（2026-08-01）

- **`run` のタイムアウト**：能力側が既定と上限を持ち、呼び出し側は**厳しくのみ**できる（§5.1 の表）。
- **`docker` ドライバの compose 以外（単一コンテナ）対応**：**不要**。1コンテナも compose で書けるので今のままとする。
- **HTTP 面の認証**：**Banto は持たない**（ADR-0010 決定40）。守るのは前段（Caddy 等）の役目で、代わりにホストは既定で localhost だけを待ち受ける——全インターフェースで待つと前段を素通りでき、その裁定が成り立たないため。
