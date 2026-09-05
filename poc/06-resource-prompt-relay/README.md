# 06-resource-prompt-relay

**捨てる。本実装に流れ込ませない。**

## 問い

`poc/05-module-relay-topology/` で「host が実 Module への接続を1本だけ持ち、
Runner には `createSdkMcpServer` で作った代理サーバを見せる」形が成立した。
ただし `createSdkMcpServer` は **tool しか登録できない**。
`docs/specs/v4-modules.md` §2.1 A節は `vault://aliases`（resource）を AI に
見せる設計なので、代理サーバ方式のままでは resource / prompt を Runner に
渡す経路が無い——これは Vault 固有ではなく、**どの Module にも掛かる穴**。

そこで3つ測る：

- **問い1**：`createSdkMcpServer` を使わず、`@modelcontextprotocol/sdk` の
  **低レベル `Server`**（resources/prompts のハンドラを自分で登録できる）を
  in-process で作り、`{type:'sdk', name, instance}` の形に**手で整形して**
  `mcpServers` に渡したら、Agent SDK は受け入れ、resource も Runner に届くか
- **問い2**：`ListMcpResourcesTool` / `ReadMcpResourceTool` /
  `ReadMcpResourceDirTool` は「Claude Code が MCP の resource を組み込み tool で
  包んでモデルに見せている」実例か。banto の代理サーバに応用できるか
- **問い3**：`prompts/list` / `prompts/get` を Runner に渡す手段はあるか

## 偽物を本物に寄せた点

- 実 Module（`module.mjs`）は素の subprocess（stdio）。tools に加えて
  `resources/list`・`resources/templates/list`・`resources/read`・
  `prompts/list`・`prompts/get` を実装し、`_meta` に
  `dev.banto/visibility` を付けた（`vault://aliases` = agent /
  `vault://internal/audit` = admin）
- 配線は 05 と同じ：host が実 Module へ1本だけ接続し、Runner には in-process の
  代理サーバだけを見せる。違いは代理サーバが**低レベル `Server` 製**であること
- 観測は機構の外側へ：Module 側は pid つきでファイルへ、代理サーバ側は
  `instance.connect(transport)` で渡された transport の `onmessage` を包んで、
  **CLI が実際に投げてきた JSON-RPC メソッド名**をそのまま記録した

## 先に読んだこと（Agent SDK の型と実装）

`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`：

```ts
export declare type McpSdkServerConfig = { type: 'sdk'; name: string };
export declare type McpSdkServerConfigWithInstance = McpSdkServerConfig & { instance: McpServer };
export declare function createSdkMcpServer(o: CreateSdkMcpServerOptions): McpSdkServerConfigWithInstance;
```

`sdk.mjs` の該当箇所（minify 済み）を読むと、SDK は `instance` に対して
**`instance.connect(transport)` しか呼んでいない**：

```js
connectSdkMcpServer(e,t){ let n=new _T((r)=>this.sendMcpServerMessageToCli(e,r));
  this.sdkMcpTransports.set(e,n); this.sdkMcpServerInstances.set(e,t);
  t.connect(n).catch(...) }
```

`_T` は「JSON-RPC メッセージを control channel 経由で CLI 子プロセスへ流す」
だけの Transport。つまり `instance` は高レベル `McpServer` である必要が無く、
**`connect(transport)` を持つ MCP サーバなら何でもよい**はず——これを実測した。

## 結果1：低レベル `Server` を直接渡す方法は**動いた**（`run-lowlevel-relay.mjs`、3回中3回同じ）

```
[host] 実 Module tools = requestAlias(agent), resolveAlias(module)
[host] 実 Module resources = vault://aliases(agent), vault://internal/audit(admin)
[runner] init mcp_servers = [... {"name":"vault","status":"connected"}]
[runner] init tools（resource/vault 関係だけ）=
    ["ListMcpResourcesTool","ReadMcpResourceDirTool","ReadMcpResourceTool","mcp__vault__requestAlias"]
[runner] tool_use ListMcpResourcesTool {"server":"vault"}
[runner] tool_result "[{\"name\":\"vault aliases\",\"uri\":\"vault://aliases\", ... \"_meta\":{\"dev.banto/visibility\":\"agent\"},\"server\":\"vault\"}]"
[runner] tool_use ReadMcpResourceTool {"server":"vault","uri":"vault://aliases"}
[runner] tool_result "{\"contents\":[{\"uri\":\"vault://aliases\", ... POC-RESOURCE-MARKER-8823 ...}]}"

--- 代理サーバが CLI から受けたメソッド ---
["initialize","notifications/initialized","tools/list","resources/list","resources/read"]
--- 代理サーバが実 Module へ中継した内容 ---
["tools/list","resources/list","resources/read vault://aliases"]
--- module.observed.log ---
[module pid=2317759] process start / tools/list / resources/list / resources/list / resources/read vault://aliases
```

| 確認項目 | 結果 |
|---|---|
| 低レベル `Server` が `instance` として受け入れられた | **OK**（`connect` しか呼ばれない） |
| `mcp_servers` で `vault: connected` になった | **OK** |
| `tools/list` が来た | **OK** |
| `resources/list` が来た | **OK** |
| `resources/read` が来た | **OK** |
| resource の中身（marker）が会話に届いた | **OK** |
| `prompts/list` が来た | **NG——一度も来ない** |

**実 Module のプロセスは1つ**（05 の結論はそのまま保たれる）。
`vault://aliases` の中身は最終応答に marker つきで現れた。

## 結果2：`ListMcpResourcesTool` 等の正体

**仮説どおり。Claude Code は MCP の resource を、resource protocol の直接露出では
なく組み込み tool で包んでモデルに見せている。** Runner は
`ListMcpResourcesTool({server:"vault"})` → `ReadMcpResourceTool({server, uri})`
の順に呼び、CLI がそれを我々の代理サーバへの `resources/list` /
`resources/read` に翻訳した。SDK の bundle にも旧名との別名表があり、
これらが CLI 組み込み tool であることの裏が取れる：

```js
{ ListMcpResources:"ListMcpResourcesTool", ReadMcpResource:"ReadMcpResourceTool",
  ReadMcpResourceDir:"ReadMcpResourceDirTool" }
```

**したがって「resource 専用の汎用 tool を自作して代理サーバに載せる」代替案
（問い2の後半）は、作る必要が無い。** 同じことを CLI がすでにやっている。
自作すると同じ機能の tool が二重にモデルの文脈へ載る。

副作用として分かったこと：

- **`_meta` はそのままモデルへ渡る。** `ListMcpResourcesTool` の返りに
  `"_meta":{"dev.banto/visibility":"agent"}` が入っていた。host が
  中継するときに**内部メタは落とすべき**（文脈量・情報漏れの両面）
- **`resources/templates/list` は Runner 側からは一度も呼ばれなかった。**
  テンプレート資源（FileSystem の `file:///{path}` 等）は Runner には
  この経路で見えない。Command Palette（host 側の UI、host 自身の client を使う）
  には関係しない

## 結果3：resource の可視性は「一覧から外す」だけでは守れない（`run-visibility-leak.mjs`）

`ReadMcpResourceTool` は URI を直接指定できるので、`resources/list` に
載せなかった資源も**読めてしまう**。

```
=== naive（resources/list だけ絞り、read は素通し）===
finalText: 読めました。… {"entries":["SECRET-AUDIT-ENTRY"]}
SECRET-AUDIT-ENTRY が Runner に届いた: true

=== filtered（resources/read も可視性で拒否）===
[runner] tool_result "resource not available: vault://internal/audit"
SECRET-AUDIT-ENTRY が Runner に届いた: false
```

**tool と resource は非対称。** tool は「代理サーバに登録しない＝存在しない」で
守れる（05）が、resource は名前空間が URI で、モデルは推測した URI を投げられる。
**`resources/read` の側でも可視性を判定しないと守れない。**

さらに：**`canUseTool` は `ListMcpResourcesTool` / `ReadMcpResourceTool` では
一度も呼ばれなかった**（naive・filtered どちらの実行でも `[runner] canUseTool`
の行が1本も出ていない）。§6.4 の承認ゲートは resource 読み取りには掛からない。
**resource に対する統制は、代理サーバ側でやるしかない。**

## 結果4：prompt は Runner に届かない（`run-prompts-check.mjs`）

代理サーバが `prompts` capability を申告し `prompts/list` ハンドラを持っていても、
**CLI は `prompts/list` を一度も呼ばない**。

```
=== slash（prompt = "/mcp__vault__vault-onboarding github-token"）===
[runner] init slash_commands（vault を含むものだけ）= []
--- 代理サーバが受けた prompt 系メソッド --- []
finalText: Unknown command: /mcp__vault__vault-onboarding
```

自然文で頼む版（`node run-prompts-check.mjs nl`）も同じく `prompts/list` は
来ず、モデルが手段を探して `maxTurns` に当たって終わった（`error_max_turns`）。

**MCP prompt はスラッシュコマンドとして「人が」選ぶもので、
`query()`（非対話）の Runner には露出しない**、というのが実測の姿。
`createSdkMcpServer` 経由でも低レベル `Server` 経由でも同じ。

banto の仕様で `prompts` が出てくるのは
`docs/specs/v4-architecture.md` §2.5 の Module 間中継（`prompts/get` の転送）だけで、
**そこは host 自身の MCP Client が呼ぶので、この制約に掛からない。**
Runner に prompt を見せる用途は現状の仕様に無い。**深追いしない。**

## つまずいた点（正直な記録）

- **`{type:'sdk', instance}` を手で作るのは、型の上では嘘になる。**
  `McpSdkServerConfigWithInstance.instance` の型は高レベル `McpServer`。
  低レベル `Server` は構造的に互換ではない（`registerTool` 等が無い）。
  実行時は `connect` しか使われないので通るが、TypeScript では
  キャストが要る（規則9——`any` を書くならその行に理由）。
  **SDK の内部実装（`connect` しか呼ばない）に依存している**ので、
  SDK 更新で壊れうる。壊れたら init で `vault` が `connected` にならない、
  という形で表に出るはず——**起動時に `mcp_servers` の status を検査して
  落とす**のが規則2に沿う（黙って resource 無しで動き続けさせない）
- **この実行環境（Claude Code の子セッション）では、`settingSources: []` でも
  親の MCP サーバ（claude.ai 系）と組み込み tool が init の一覧に載る。**
  判定は `vault` を含む名前と marker 文字列で行った。
  `filtered` の実行でモデルが「`vault` というサーバは一覧に出ていない」と
  補足しているのは、この環境で組み込み tool が **deferred（ToolSearch 経由）**
  になっているためで、banto の本実装（単独プロセス）には無関係
- **`run-prompts-check.mjs nl` は `maxTurns` 超過で SDK が例外を投げて終わる。**
  観測したい `prompts/list` の有無は例外の前に出るので、そのまま残した

## 仕様書のどの行を更新すべきか（提案。この PoC では docs を触っていない）

- **`docs/specs/v4-architecture.md` §2.5 の末尾**（現状「resource・prompt の代理は
  未検証。…この方式のままでは持てない——resource 用の代理機構を別途詰める必要が
  ある（§10 に追記）」）→ **解決済みに差し替える。**
  決定：**代理サーバは `createSdkMcpServer` ではなく
  `@modelcontextprotocol/sdk` の低レベル `Server` で組み、
  `{type:'sdk', name, instance}` の形で `mcpServers` に渡す。**
  これで tool と resource の両方を中継できる。tool の zod 変換も不要になる
  （低レベル `Server` は `tools/list` の JSON Schema をそのまま返せる）
  ——05 の「つまずいた点」にあった JSON Schema → zod 変換の要件は**消える**
- **同 §2.5 に、prompt の限界を1行で書く**：MCP prompt は Runner には露出しない
  （CLI が `prompts/list` を呼ばない）。Module 間中継の `prompts/get` は
  host 自身の client が呼ぶので影響なし
- **`docs/specs/v4-modules.md` §2.1 の代理サーバの節**（現状「`vault://aliases`
  を代理サーバ経由で Runner に見せる手段はまだ無い」）→ **見せられる、に訂正。**
  経路は `ListMcpResourcesTool` / `ReadMcpResourceTool`（Claude Code 組み込み）
  →代理サーバの `resources/list` / `resources/read` →host の実接続
- **`docs/specs/v4-modules.md` §2.1 の可視性の節に、tool と resource の非対称を
  足す**：tool は「登録しない＝存在しない」で守れるが、**resource は URI を
  直接読まれるので `resources/read` の側でも可視性を判定する**。
  「一覧に出さない」は防御にならない（実測）
- **`docs/specs/v4-architecture.md` §6.4（承認ゲート）**：
  **`canUseTool` は resource 読み取りには掛からない**（`ReadMcpResourceTool` で
  呼ばれない）。resource に人の承認を要求したいなら、
  **代理サーバの `resources/read` ハンドラの中でやる**——という限定を追記
- **`docs/specs/v4-architecture.md` §10** の新しい未決として起こそうとしていた
  「resource / prompt の代理経路」→ **起こさない。ここで決着。**
  残るのは「host が中継するとき `_meta` をどこまで落とすか」という細部
- **`docs/specs/v4-architecture.md` §2.5 の Module 間中継**：resource の転送
  （`resources/read`）は host の client でそのまま呼べることを実測で確認済み
  （代理サーバがまさにそれをやっている）

## 破棄

段3（本実装）の頭で `poc/` ごと削除する。
