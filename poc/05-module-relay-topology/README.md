# 05-module-relay-topology

**捨てる。本実装に流れ込ませない。**

## 問い

`poc/step0-host-mcp-client/` の実測——**host 自前の MCP クライアント接続と、
Runner（Agent SDK）側の接続を同じ stdio Module に張ると別プロセスになる**——が
本当なら、`docs/specs/v4-architecture.md` §2.5「Module 間の呼び出し——host が
中継する」が前提にしている「Module はみな host という**同じ1箇所**にしか繋がない
ので、宛先ごとの transport もなりすまし対策も構造的に発生しない」は成立しない。
Runner が直接 spawn した Module の子プロセスと、host が別に張る接続は、そもそも
繋がっていないから。

そこで次の形を測る：

1. **Runner に実 Module を spawn させない。** host だけが実プロセスへの接続を
   1本持つ
2. Runner には、host が `createSdkMcpServer`（in-process）で作った**代理サーバ**
   を `mcpServers` として渡す
3. 代理サーバには **`agent` 可視性の tool だけ**を登録し、呼ばれたら手順1の
   実接続へ転送する

確かめること：

- **(a)** 代理サーバ経由で本物 Module まで実際に転送されて動くか
- **(b)** その過程で実 Module のプロセスが**1つだけ**（2重起動しない）か
  → §10 item 9 の「stdio Module は host 経路と Runner 経路で2重に起動される」
- **(c)** 代理サーバに登録しなかった `module`/`admin` 可視性の tool が、
  Runner の tool 一覧に**一切現れない**か
  → `docs/specs/v4-modules.md` §2.1 の可視性、および §9 の v3 知見
  「SDK 組み込みの資源系 tool は、見せない設定でも見えたまま、呼ぶと断られる」

## 偽物を本物に寄せた点

- `module.mjs` は `createSdkMcpServer`（in-process）ではなく
  `@modelcontextprotocol/sdk` の `Server` を素の subprocess として立てている。
  in-process だと JSON-RPC の枠が無く「本当に別プロセスの第三者 Module か」を
  測れないため（step0 と同じ理由）
- Vault を模して tool を3つ持たせ、`_meta` に
  `dev.banto/visibility: "agent" | "module" | "admin"` を付けた
  （`requestAlias` = agent / `resolveAlias` = module / `createAlias` = admin）。
  接頭辞の文字列は §10 item 9 でまだ未決なので、この PoC 限りの仮のもの
- 観測（pid・`tools/call` の受信）は Module 側からファイルへ直接書く。
  Agent SDK が MCP subprocess の stderr を表に出さないため（step0 で判明、教訓11）

## ガードを外したら通ってしまうことの確認

`run-baseline-direct.mjs`：代理サーバを挟まず、host 自前接続と Runner の接続を
同じ stdio Module に直接張る。

```
[module pid=2315374] process start        ← host 自前クライアント
[module pid=2315374] tools/list
[module pid=2315400] process start        ← Agent SDK 側（1回目）
[module pid=2315422] process start        ← Agent SDK 側（2回目、これが実際に使われた）
[module pid=2315422] tools/list
[module pid=2315422] tools/call {"name":"requestAlias", ...}

観測した pid: 2315374, 2315400, 2315422 (3 個)
Runner に見えた vault の tool: ["mcp__vault__createAlias","mcp__vault__requestAlias","mcp__vault__resolveAlias"]
```

**プロセスは3つ**——step0 の「2つ」より多い。Agent SDK 側だけで2回 spawn している
（1回目は接続確認とみられ、`tools/list` も来ないまま終わる）。**「2重起動」は
正確には「host 1 ＋ Runner N」で、N は SDK の内部事情で変わる。**

同時に、`module` 可視性の `resolveAlias`（値そのものを返す＝D3 を破る）と
`admin` 可視性の `createAlias` が、**そのまま Runner の tool 一覧に載っている**。

## 結果（実測、`run-relay.mjs`・3回中3回同じ）

```
[host] 実 Module の tools/list = requestAlias(agent), resolveAlias(module), createAlias(admin)
[host] 代理サーバに載せる tool = requestAlias
[runner] init が申告した tools = [... "mcp__vault__requestAlias"]     ← vault は1個だけ
[runner] canUseTool mcp__vault__requestAlias
[host/relay] 転送: requestAlias {"name":"github-token","hint":"poc"}
[host/relay] 実 Module の応答: [{"type":"text","text":"REQUEST-ACCEPTED alias=github-token ticket=poc-ticket-4711 ..."}]
[runner] result subtype=success is_error=false
[host] module 可視性 resolveAlias を host 経由で呼んだ: [{"type":"text","text":"SECRET-VALUE-OF-github-token"}]

--- module.observed.log ---
[module pid=2315276] process start
[module pid=2315276] tools/list
[module pid=2315276] tools/call {"name":"requestAlias","arguments":{"name":"github-token","hint":"poc"}}
[module pid=2315276] tools/call {"name":"resolveAlias","arguments":{"name":"github-token"}}
```

| 確認項目 | 結果 |
|---|---|
| 代理経由で本物 Module まで転送された | **OK** |
| 結果が同じ会話の続きとして返った（`poc-ticket-4711` が最終応答に出た） | **OK** |
| 実 Module のプロセス数 | **1つだけ**（対照実験は3つ） |
| `agent` 可視性の tool は Runner に見えた | **OK**（`mcp__vault__requestAlias`） |
| `module` 可視性（`resolveAlias`）は Runner に見えない | **OK**（一覧に一切現れない） |
| `admin` 可視性（`createAlias`）は Runner に見えない | **OK**（同上） |
| host 側からは `module` 可視性を同じ1本の接続で呼べた | **OK**（`SECRET-VALUE-OF-...`） |

3回連続で同じ結果。間欠は観測されなかった。

## 決定的な発見

**代理サーバ方式は成立する。§10 item 9 の「stdio 2重起動」と、
modules §2.1 の「可視性は本当に隠せるのか」は、同じ1つの構造で同時に消える。**

1. **2重起動は「避けられない制約」ではなく、配線の選択の結果だった。**
   実プロセスへの接続を host が独占し、Runner には in-process の代理を見せれば、
   実 Module のプロセスは1つになる。§2.5 が心配していた
   「状態を持つ Module（`Environment`）で2つのプロセスが別々の内部状態を持つ」も、
   そもそも2つ目のプロセスが無いので発生しない
2. **§2.5 の中継の前提（Module はみな host という同じ1箇所にしか繋がない）は、
   代理サーバ方式を採ることで初めて真になる。** 直結モデルのままだと、
   Runner が spawn した実プロセスと host の実プロセスが別物で、前提が崩れる。
   **代理サーバは §2.5 の付随的な実装詳細ではなく、§2.5 を成立させる前提条件**
3. **可視性は「隠す」のではなく「存在しない」にできる。**
   §9 の v3 知見（SDK 組み込みの資源系 tool は見せない設定でも見えたまま、
   呼ぶと断られる）は **`allowedTools` のような「フィルタで隠す」経路の話**で、
   `createSdkMcpServer` に**そもそも登録しない**経路には掛からない。
   Runner の `system/init` が申告する tool 一覧に `resolveAlias` /
   `createAlias` は1つも現れなかった。**モデルの文脈に名前も説明も入らない**
   ——文脈量の面でも有利
4. **`canUseTool` は代理サーバの tool でも正しく呼ばれる**
   （`mcp__vault__requestAlias`）。承認ゲート（§6.4、`poc/04-`）はこの形の上でも
   そのまま効く

## つまずいた点（正直な記録）

- **`createSdkMcpServer` の `inputSchema` に、本物 Module から受け取った
  JSON Schema をそのまま渡せない**（`run-rawschema-check.mjs` で実測）：

  ```
  例外: inputSchema must be a Zod schema or raw shape, received an unrecognized object
  ```

  代理サーバは**本物 Module の `tools/list` が返す JSON Schema を zod へ変換**
  してから登録する必要がある。この PoC では文字列プロパティの平たいオブジェクト
  だけを扱う最小の変換関数で足りたが、**本実装では汎用の JSON Schema → zod
  変換（`json-schema-to-zod` 等の既製品を含めた検討）が要る**。
  規則12（機構を作る前に名前があるか調べる）に当たる部分——名前のある解決済み
  問題なので、自作せず既製品を引く判断でよいはず
- **`description` / `annotations` / tool 側の `_meta` は、代理サーバ側で明示的に
  積み替えないと落ちる。** 参照渡しではなく再構築なので、転送したいメタデータは
  host が意図して写す必要がある（規則3「真実は一箇所」に注意——写しではなく、
  毎回 `tools/list` から作り直す形にすべき）
- **この実行環境（Claude Code の子セッション）では、`settingSources: []` を
  指定しても親セッションの MCP サーバ（`claude.ai AccuWeather` 等）と builtin
  tool が `system/init` の一覧に載る。** 判定は「`vault` を含む tool 名」に
  絞って行った。banto の本実装（単独プロセス）には無関係のはずだが、
  **「Runner に見える tool 一覧を host が完全に支配できるか」は、この PoC では
  代理サーバ部分についてしか測れていない**——builtin tool の露出制御は別の話
  （§10 item 9「AI に見せる tool の選別」の残り）
- **`resources` / `prompts` は測っていない。** `createSdkMcpServer` は tool しか
  登録できないため、`vault://aliases` のような resource を Runner に見せる経路は
  この方式では別に要る（`ListMcpResourcesTool` / `ReadMcpResourceTool` が
  builtin にあるが、in-process 代理サーバでそれが機能するかは未確認）。
  **modules §2.1 の A 節は resource を2つ（`vault://aliases`,
  `vault://aliases/{name}`）AI に見せる設計なので、ここは残った穴。**

## 仕様書のどの行を更新すべきか（提案。この PoC では docs を触っていない）

- **`docs/specs/v4-architecture.md` §2.5**：「stdio Module では、この2つの接続が
  別プロセスになる」の段落を**「実 Module への接続は host が独占し、Runner には
  host が `createSdkMcpServer` で作った代理サーバを見せる」という決定に差し替える。**
  「対処は item 9 で詰める。ここでは事実として §10 に残す」という保留は解消。
  併せて「Module はみな host という同じ1箇所にしか繋がない」が**代理サーバ方式に
  よって成立する**ことを明記する（現状は前提として書かれているだけ）
- **同 §10 item 9 のライフサイクル項**：「stdio Module は host 経路と Runner 経路で
  2重に起動される」→ **解決済みとして取り消し線＋決定へのポインタ**。
  実測の数値は「host 1 ＋ Runner N（SDK の内部事情で 2 になることを観測）」に訂正
- **同 §10 item 9 の「AI に見せる tool の選別」項**：**代理サーバ方式で決着。**
  「誰がどこで決めるか」＝ host が `tools/list` の `_meta` visibility を見て
  代理サーバに載せるものを決める。残るのは builtin tool の露出制御だけ
- **`docs/specs/v4-modules.md` §2.1 の可視性の節**：「banto host はこの値を見て、
  Runner に渡す tool 一覧（`agent` のみ）と、host 中継が取り次ぐ tool
  （`module`・`admin`）を分ける」に、**実現手段（代理サーバに `agent` のものだけ
  登録する。フィルタで隠すのではなく最初から存在しない）と実測の裏付けを追記**。
  「この区分は banto host による自主的な尊重であって、暗号的な強制ではない」は
  そのまま正しい（他ホストに繋がれたときの話なので）が、**banto 内では
  「隠す」より強い「渡さない」であることを書き足せる**
- **`docs/specs/v4-architecture.md` §9**（v3 知見「見せない設定でも見えたまま」）：
  **`allowedTools` 系のフィルタ経路に限った話であり、`createSdkMcpServer` に
  登録しない経路には掛からない**、という限定を追記
- **新しい未決として起こすべきもの**：`resources` / `prompts` を代理サーバ方式で
  Runner に見せる経路（`createSdkMcpServer` は tool しか取らない）。
  modules §2.1 A 節の `vault://aliases` が直接影響を受ける

## 破棄

段3（本実装）の頭で `poc/` ごと削除する。
