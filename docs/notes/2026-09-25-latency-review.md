# 人の操作に対するレイテンシーのレビュー（2026-09-25）

ユーザー指摘「全体的に人のアクションに対するレイテンシーが大きい。毎度 Module に
アクセスして時間がかかるパターンが多い気がする」を受けて、コードを読み、
**稼働中の host（4737）と本番ビルドの画面（4175）を実測**した。
推測で犯人を決めない（規則1）——数字が出たものだけを原因として書く。

前回の応答性レビューは `2026-09-07-codeblock-freeze-and-latency.md`。
そのときの物差し（`e2e/perf-probe.mjs`）をそのまま再利用した。

---

## 0. 結論（先に）

「毎度 Module にアクセスしている」は**事実**。ただし Module への往復そのものは
**1〜4 ms**で、体感に効く遅さは別のところにあった。数字で大きい順に：

| # | 何が遅いか | 実測 | どこで人が待つか |
|---|---|---|---|
| A | **vault-infisical の `resources/list` が毎回クラウド API を N+1 で叩く**（1.4〜2.3 秒）。host の多くの口がこれを毎回呼ぶ | 1.37 s（安定）〜2.30 s | Ctrl+K（入口一覧）、設定画面（2回呼ぶので 1.4 s＋2.7 s）、Skill 一覧、**新しい会話の最初のターンが始まる前** |
| B | **会話1本の記録が `usage` の履歴で肥大**し、丸ごと取り直している | 1本 1.8 MB（うち 90% が usage）。Project 1つで **9.6 MB** | Project を開く（12本まとめて取る）、Fork を畳む、Clear、復元した判断待ちに答えた後（2秒ごとに5分間） |
| C | **ターンの固定費 ≈ 2 秒**（CLI 起動 0.9 s ＋ `result` の後に CLI の終了を待つ 1.0 s） | init まで 0.95 s／result→done 1.05 s | 送信してから最初の文字が出るまで／答えが出そろってから入力欄が戻るまで |
| D | 画面の起動が **2026-09-07 より遅くなっている**（0.97 s → 1.49 s） | 転送 1.53 MB → 2.16 MB、long task 0.34 s → 0.75 s | 初回表示・リロード |

A と B は**数行〜数十行の直し**で消える。C は設計（1ターン＝1 `query()`）の
費用で、半分（`done` の遅れ 0.75 s）はすぐ削れる。

---

## 1. 測り方（次に「遅い」と言われたときに、また一から考えないため）

すべて**遅い輪で探索せず、30秒のプローブで測った**（規則15）。

- **host の口ごとの時間**：`curl` に `/usr/bin/time`。合言葉は `~/.config/banto/config.json`
- **Module 1本ずつの `resources/list` の時間**：`GET /api/ui-resource?server=<名前>&uri=probe://none`
  ——この口は指定した Module の `resources/list` を呼んでから 404 を返すので、**1本だけを測れる**
- **Module を直接起こして測る**：`@modelcontextprotocol/sdk` の `Client` で `dist/server.js` を
  stdio で起こし、`connect`／`tools/list`／`resources/list` を時計で挟む（`packages/core` の中に
  置かないと SDK が解決できない）。同梱 Module はどれも connect 150 ms・list 1〜4 ms
- **ターンの内訳**：**別の host を立てて**測る（人の会話を汚さない）。
  `BANTO_CONFIG_PATH=/tmp/…/config.json`（port 4199、dataDir 別）＋ `CLAUDE_CONFIG_DIR` を使い捨て
  ＋ `CLAUDE_SECURESTORAGE_CONFIG_DIR=~/.claude`（認証だけ本物）＋ `CLAUDE*` の環境変数を外す。
  `POST /api/threads/:id/messages` の SSE を読み、`system/init`・最初の `assistant`・`result`・`done` の時刻を取る
- **SDK 単体**：`query()` を直接呼び、`result` の後の `getContextUsage()` と、反復が終わるまでの時間を分ける
- **画面**：`e2e/perf-probe.mjs http://127.0.0.1:4175 prod`（5回の中央値）と、
  `performance.getEntriesByType("resource")` で**起動時・Project 切替・Ctrl+K・設定画面**が
  何を何回取っているかを並べる

---

## 2. 実測

### 2.1 host の口（稼働中の 4737、実データ）

| 口 | 時間 | 備考 |
|---|---|---|
| `GET /api/projects`・`/threads`・`/inbox`・`/modules`・`/models`（温）・`/memory` | **0〜2 ms** | 一覧系は問題なし |
| `GET /api/threads/:id` | 20 ms | ただし **1.78 MB**（下 2.2） |
| `GET /api/threads/:id/ui-tools` | 20〜70 ms | 全 Module に `tools/list`（並列・上限 5 s） |
| `GET /api/ui-settings` | **1.38 s**（初回 2.26 s） | instance の Module に `resources/list`（**直列**） |
| `GET /api/skills`（`?project=` も） | **1.37 s**（初回 2.13 s） | 全 Module に `resources/list`（並列） |
| `GET /api/projects/:id/ui-launchers` | **1.37〜2.18 s** | Project＋instance の Module に `resources/list`（**直列**） |
| `GET /api/projects/:id/ui-settings` | 0 ms | Project の Module だけ（Infisical を通らない） |

**1本ずつに分けた `resources/list`**（`ui-resource` の口で測定、各2回）：

| Module | 時間 |
|---|---|
| vault-local・vault-directory・subagent-settings・skills・mcp（URL）・markdown-mcp | **0 ms** |
| **vault-infisical** | **2.30 s／1.37 s** |

同じ vault-infisical でも `tools/list`＋`getConnectionSettings` は **10 ms**。
遅いのは `resources/list` だけ。

**原因（コード）**：`packages/vault-kit/src/server.ts` の `resources/list` は
`listableAliases()` を呼んで alias を1つずつ資源として並べる。Infisical 版の alias 置き場
`packages/modules/vault-infisical/src/infisical-alias-store.ts` の `list()` は
**`listFolders` を1回、その後フォルダごとに `listSecrets`** を Infisical Cloud に投げる
（N+1）。キャッシュは無い。**`resources/list` が呼ばれるたびに、これが走る。**

`relay-audit` のログでも、`vault-directory → vault-infisical listAliases` は
`vault-local` の同じ呼び出しの **約 1.85 秒後**に記録されている（Vault 管理画面を開くたび）。

**`resources/list` を呼んでいる host 側の経路**（＝毎回 1.4 s を払う場所）：

| 経路 | いつ |
|---|---|
| `listSettingsCanvases`（`app.ts`） | 全体の設定画面を開く。**画面が2箇所から同じ hook を呼ぶので2回**（1.39 s と、後ろで詰まった 2.70 s） |
| `listLauncherCanvases` | Command Palette（Ctrl+K）を開く・Project を変える |
| `discoverSkills`（`skills/discover.ts`） | 設定の Skill 一覧、**新しい会話（Clear 後も）の最初のターンの直前**（`turn-runner.ts` の `resolveSessionSkills`） |
| `readUiResource` | vault-infisical の Canvas を開く |
| `relay/visibility.ts` | AI が vault-infisical の資源を読むたび（`resources/read` の前に `resources/list`） |

`getServerCapabilities()` で資源を名乗らない相手は飛ばしているが、Vault は資源を持つので飛ばせない。

### 2.2 会話の記録の大きさ

`GET /api/threads/:id` の中身（ユーザーの主な Project の Base Thread）：

| 鍵 | バイト（概算） |
|---|---|
| `usage`（59 件、1件 ≈ 30 KB） | **1,657 KB（90%）** |
| `messages`（119 件） | 185 KB |
| それ以外 | 2 KB |

**画面が使うのは `realUsage.at(-1)` だけ**（`context-usage-meter.tsx`）。履歴は1バイトも読まれない。
1ターンごとに約 30 KB ずつ増える（`contextUsage` は SDK の内訳をそのまま保存している）。

**Project を開くと取るもの**：その Project の**全 Thread（閉じた Fork も含む）を1本ずつ丸ごと**
（`loadRealProjectThreads` → `getRealThread` × N）。実測 **12 本・合計 9.62 MB**。
うち 9 本は閉じた Fork（履歴からしか開かない）。

同じ丸ごと取得が走る他の場所：Fork を畳む（`foldForkThread`）、Clear、
復元した判断待ちに答えた後の `syncRestoredThread`（**2 秒ごと・最長 5 分**——毎回 1.8 MB）。
届くたびに `notifyMockStoreChange()` が **19 箇所の購読者**を再描画する。

### 2.3 ターンの内訳（別 host・Module 7本・プロンプト「1とだけ答えて」）

| 区間 | ターン1（新規） | ターン2（resume） | ターン3 |
|---|---|---|---|
| 送信 → `system/init`（CLI 起動＋MCP 7本の初期化） | 0.93 s | 1.05 s | 0.95 s |
| → 最初の `assistant`（モデルの応答） | 2.38 s | 2.55 s | 2.39 s |
| → `result` | 2.39 s | 2.56 s | 2.40 s |
| → **`done`** | **3.44 s** | **3.64 s** | **3.46 s** |

`result` から `done` まで **1.05 s**。SDK 単体で分けると：`getContextUsage()` **0.25 s**、
その後 **CLI プロセスの終了を待つ 0.75 s**。`runner/adapter.ts` は `for await (q)` が
終わるまで queue を閉じないので、**答えが出そろった後、CLI が死ぬまで画面は「走行中」のまま**。
`done` が来て初めて `appendRealUsage` → 全体の再描画が走る。

参考：`GET /api/models` の冷えた1回目（CLI を起こして `supportedModels()`）＝ **0.58 s**。
ModelCatalog の TTL は 10 分なので、**10 分あけて送った最初のターンはこの分も先に払う**
（`app.ts` はターンを始める前に `modelCatalog.list()` を待つ）。

ユーザーの環境ではさらに、新しい会話の最初のターンで `discoverSkills` が走り、
上の A（1.4 s）が**ターンの前に**足される。

### 2.4 中継の往復回数（`~/banto-host.log`）

`[agent-relay]` 629 件のうち **`tools/list` が 493 件（78%）**。内訳：

- ターンごとに CLI が Module 1本につき `tools/list` を1回（別 host の実測：3ターンで 21 件＝7本×3）
- **AI の `tools/call` 1回ごとに、代理サーバが実 Module へ `tools/list` をもう1回**
  （`relay/agent-proxy.ts`「名前が Runner に見えていたことを信じない」）
- 画面からの `ui-tool-call` も同じ（`checkUiCallable` が `tools/list` → `callTool`）

同梱 Module では 1〜4 ms なので体感には出ない。**URL に繋ぐ Module では往復がインターネットになる**
（Cloudflare docs：`initialize`・`tools/list` とも 40〜60 ms。呼び出し1回が2往復）。
ユーザーの仮説「毎度 Module にアクセス」はここのことだが、**数字としては小さい**。

### 2.5 画面（本番ビルド・5回の中央値）

| 測ったもの | 2026-09-07 | **2026-09-25** |
|---|---|---|
| 初回表示・操作可能まで | 0.97 s | **1.49 s** |
| リロード・操作可能まで | 0.49 s | **0.78 s** |
| long task 合計 | 0.34 s | **0.75 s** |
| 転送量 | 1.53 MB | **2.16 MB** |
| Project 切り替え | 0.21 s | 0.27 s |

起動時に画面が取るものの順（ms は開始時刻）：

```
 142  /api/projects
 249  /api/projects/<8 Project>/threads   （8本並列・要約だけ）
 669  /api/projects                        ← 2回目（ProjectPanels の hydrate）
 674  /api/projects/<開いた Project>/threads ← 2回目
 676  /api/threads/<12本>                  （丸ごと・合計 9.6 MB）
 820  /api/projects/<id>/modules/prepare
 864  /api/threads/<id>/stream, /api/models
1252  /api/ui-config ×6, /api/threads/<id>/ui-resource ×6   （会話の中の inline Canvas 6枚）
      + sandbox.html ×5（iframe）
```

- 249 → 669 ms の空白は、`useMounted()` で SSR と一致させてからでないと
  `ProjectPanels` の effect が動かないため（クライアントの初回マウント待ち）
- 転送量の内訳：JS の主チャンク 196 KB、CSS 102 KB、**woff2 フォント 5 本 ≈ 370 KB**
- 09-07 からの悪化分（+0.5 s／+0.6 MB）は**まだ切り分けていない**。候補は inline Canvas
  （iframe 6枚がそれぞれ sandbox.html＋Module の HTML を取って MCP App を起動する）と
  JS の増加。次に触るときに測る

---

## 3. 改善案（効果の見込みが大きい順）

### 3.1 vault-infisical の `resources/list` を毎回クラウドに行かせない【A】

**効き目**：Ctrl+K・設定画面・Skill 一覧・新しい会話の最初のターン、それぞれ **−1.4 s**。
Vault 管理画面 −1.9 s。

選択肢（併用可）：

1. **Module 側でキャッシュする**（`InfisicalAliasStore`）。書き込み（`create`/`update`/`delete`/
   `markUsed`）で無効化し、TTL で古さを限る。**alias の名前の一覧は値ではない**ので、
   古さの害は「別の経路で足した alias が数分見えない」だけ。`listFolders` → `listSecrets` の
   N+1 も、フォルダ横断で1回に潰せるか Infisical の API を確かめる
2. **`resources/list` で alias を1つずつ資源として並べるのをやめる。** `vault://aliases`
   （1本の資源）が同じ一覧を返しており、AI もそちらを読むよう説明されている
   （`vault-kit` の `requestAlias` の説明文）。**alias ごとの資源 `vault://aliases/<name>` を
   誰が読んでいるか**を先に grep する（規則15-1）——読み手が居なければ消すだけで済む
3. **host 側でキャッシュする**（`resources/list` の結果を接続ごとに持ち、MCP の
   `notifications/resources/list_changed` で無効化する）。**名前のある機構**（規則12）。
   `tools/list` にも同じものが使える（3.4）。ただし list_changed を送らない Module に対しては
   TTL が要る

**決める必要があること**：1 と 2 は Module の中だけで閉じる。3 は host の契約（Module が
list_changed を送る約束）を足す。まず 2 を確かめ、1 で足りるなら 3 は要らない。

### 3.2 会話の記録から `usage` の履歴を外す【B】

**効き目**：`GET /api/threads/:id` **1.8 MB → 約 0.2 MB**、Project を開く転送 9.6 MB → 約 1 MB、
JSON の解析と 19 箇所の再描画がその分軽くなる。増え方（1ターン 30 KB）も止まる。

- `/api/threads/:id` は `usage` の**最新1件だけ**返す（画面はそれしか読まない）。
  履歴が要る日が来たら（F2 の推移グラフ等）別の口に分ける——**要るものが要るときに取る**
- `loadRealProjectThreads` は**開いている Thread（Base＋開いている Fork）だけ**取る。
  閉じた Fork は履歴から開くときに取る（要約は一覧に既にある）
- `syncRestoredThread` の 2 秒ごとの輪は、丸ごとではなく**要約の口**（`messageCount` が
  増えたか）で見張り、増えたときだけ丸ごと取る
- Event Store の `usage.recorded` 自体は変えない（記録は残す。返し方だけ変える）

### 3.3 `result` の後に CLI の終了を待たずに `done` を返す【C・後半】

**効き目**：毎ターン **−0.75 s**（入力欄が戻るまで）。

`runner/adapter.ts` は `result` を受けて `getContextUsage()` を取ったら、その時点で
`{sessionId, contextUsage, compactionCount, apiUsage}` は揃っている。queue を閉じる
タイミングを「`for await (q)` が終わる」から「`result`＋`getContextUsage()` の直後」に前倒しし、
CLI の終了は**背景で待つ**（`closeInput()` の後、exit を待って例外だけ拾う）。
**規則2 に注意**：終了時に CLI が例外を吐いた場合、`done` の後に届くことになるので、
その場合の伝え方（受信箱のお知らせ）を決めてから直す。

`getContextUsage()` の 0.25 s は F2 の要件なので残す。

### 3.4 中継の `tools/list` を接続ごとにキャッシュする【2.4】

**効き目**：同梱では ms。**URL に繋ぐ Module で呼び出し1回あたり −1 往復（−40〜60 ms 以上）**。
`agent-proxy.ts` の `CallToolRequestSchema` と `app.ts` の `checkUiCallable` が毎回 `listTools()`
しているところ。`tools/list_changed` を受けたら捨てる。可視性の再確認という意図
（Runner に見えていた名前を信じない）は、**キャッシュを host が持つ**限り保たれる
——Runner の申告ではなく host が実 Module から取った一覧を見るのは同じ。

### 3.5 設定画面と入口一覧の呼び方を直す【2.1】

- `useModuleSettingsCanvases(INSTANCE_OWNER)` を**2つのコンポーネントが別々に呼んでいる**ので
  `/api/ui-settings` が2回走る。`real-launchers.ts` と同じ「モジュールレベルの控え＋
  `useSyncExternalStore`」の形に寄せて1回にする
- `listSettingsCanvases`／`listLauncherCanvases`（`app.ts`）は**直列の for**。
  `listUiToolsForThread` と同じく**並列＋1本ずつ上限**にする（3.1 が入れば体感差は小さいが、
  答えない Module が1本あると今は全体が止まる——2026-09-22 に `ui-tools` で踏んだのと同じ穴）

### 3.6 ターンの頭を軽くする【C・前半】

- **ModelCatalog の TTL 切れをターンの前で払わない**：期限が来たら**背景で取り直し、
  古いものを返す**（stale-while-revalidate、名前のある機構）。失敗は覚えない、は今のまま
- **`discoverSkills` はターンの前に走らせない**：Skill の集合は「繋がっている Module の
  資源一覧」から決まるので、**Module が繋がった時点**（`finishModuleConnection`）で一度
  取って持ち、`list_changed` で取り直す。ターンの直前には持っているものを刻むだけにする
  ——3.1 と 3.3 の host 側キャッシュが入ればここは自然に消える
- CLI 起動＋MCP 初期化の 0.9 s は「1ターン＝1 `query()`」（§2.3 モデルB）の費用。
  **ここは設計の決定なので、この場では触らない。** 削るなら仕様（`v4-architecture.md`）で
  決め直す（SDK にセッションを保つ口があるか、resume が十分速いか、を先に測る）

### 3.7 画面の起動【D】

- hydrate の**二重呼び出し**（`/api/projects` と `/threads` を2回）を1回にする
  ——`hydrateRealProjects()` は進行中だけ共有し、完了後はまた取りに行く
- **閉じた Fork の中身を起動時に取らない**（3.2 と同じ）
- フォント 5 本（≈370 KB）のうち実際に使っている weight だけ残す
- 09-07 からの +0.5 s は、まず inline Canvas（iframe 6枚）を疑って**測る**。
  Canvas を1枚も持たない Thread で同じ物差しを当てれば分かる

### 3.8 観測を機構の外に置く（規則4）

今回、遅い口を見つけるのに手元のプローブを何本も書いた。**host に「500 ms を越えた要求」の
ログ**（口・かかった時間・Module ごとの内訳）を1行出すようにしておけば、次は
`~/banto-host.log` を grep するだけで済む。`resolveModule*` と `listResourcesIfAny` に
時計を挟むのが最小。

---

## 4. 調べて外したもの（同じ道を二度通らないため）

- **URL に繋ぐ Module（Cloudflare docs）が遅い説**：`initialize`／`tools/list` とも 40〜60 ms。
  `resources/list` は `Method not found` を即返す。外れ
- **開発モードで動いている説**：4175 は `next start`（本番ビルド）。09-07 に切り替え済み
- **Module のプロセス起動が遅い説**：同梱 Module は connect 150 ms、Project の Module は
  最初に開くときだけ（並列化済み・09-07）。ターン1がターン2より遅くなかった（2.3）
- **Event Store の fsync**：1ターンに 3〜4 回、ms 単位。効いていない
- **host の HTTP 処理そのもの**：一覧系は 0〜2 ms。09-07 の結論と同じ

---

## 5. 決めていないこと

- 3.1 の1〜3 のどれで行くか（Module の中で閉じるか、host の契約を足すか）
- 3.3 で、`done` の後に CLI が異常終了したときの伝え方
- 3.6 の最後（CLI 起動の 0.9 s）は仕様の話——`docs/specs/v4-architecture.md` §10 に載せるか

この文書は検討ログ。**直すと決めたものは `docs/tasks.json` に起票し、仕様に触るものは
`docs/specs/` を先に直す**（CLAUDE.md「ドキュメントの使い分け」）。起票はまだしていない。
