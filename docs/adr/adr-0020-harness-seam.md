---
id: adr-0020
type: adr
status: proposed
refs: [adr-0009, adr-0010, adr-0011, adr-0017, adr-0019, inc-0055, inc-0056, task-0090]
amends: adr-0010
---

# ADR-0020: ハーネスは**会話の契約**で差し替える。プロセス境界は**関所**であって抽象ではない

> status: **proposed**（2026-08-12）。**ADR-0010 決定11 を改訂する**（番頭ハーネス＝pi の
> SDK モード → 複数バックエンド）。決定番号は 87（ADR-0019）の続きから採る。
> 下ごしらえは `/home/ubuntu/banto-desk/reports/2026-08-11-banto-harness-seam-agent-sdk.md`。

## 決めたいこと

**pi も Agent SDK 経由の Claude Code も、番頭にも職人にもなれるようにする**（PO 意向 2026-08-12）。

いま埋まっていないのは1マスだけ:

| | 番頭 | 職人 |
|---|---|---|
| **pi** | ✅ 現状（`createAgentSession` を埋め込み） | ✅ 現状（`pi --mode rpc`） |
| **Agent SDK** | ❌ **ここを作る** | ✅ 現状（`claude-agent/` 931行） |

## 決定

### 決定88: **2層に分ける。**会話の契約は差し替え、プロセス境界は関所として残す

職人の `RuntimeDriver`（`spawn` / `inject` / `subscribe` / `kill`）を番頭に流用しない
——下ごしらえの結論は正しい。ただし理由は「粒度が合わない」ではなく、**層が違う**から。

```
BantoHarness（会話の契約）        ← 差し替えるのはここ：pi / Agent SDK
      ↑ 直に使う              ↑ プロセスの中で使う
    番頭                  RuntimeDriver（プロセスの監督＝関所）
                                  ↑
                                職人
```

**`RuntimeDriver` は差し替え可能性の機構ではなく関所である。** cgroup で殺せる・隔離される・
職人が記憶を持てない（D11「隠れ状態が無い＝再現可能・監査可能」）——これらは**プロセス境界が
機構として担保している**もので、抽象の中へ吸い上げると「実装の都合」に格下げされる。

**この2層で4マスすべてが埋まる。** 差し替えるのは会話のやり方だけで、どこで走るかは役割が決める。

### 決定89: `BantoHarness` の契約

`banto-core` に新設する（`RuntimeDriver` と併置）。

```ts
export interface BantoHarness {
  prompt(text: string, opts?: PromptOptions): Promise<void>;   // steer 付き
  readonly isStreaming: boolean;
  abort(): Promise<void>;
  subscribe(handler: (e: HarnessEvent) => void): () => void;
  contextTokens(): number | undefined;                          // 章の閾値判定
  startChapter(opening: ChapterOpening): Promise<void>;         // 決定92
  restore(record: ThreadRecord): Promise<void>;
}

export type HarnessEvent =
  | { type: "notice"; ... }      | { type: "text_delta"; ... }
  | { type: "reasoning_delta"; ... } | { type: "reasoning_end"; ... }
  | { type: "tool_start"; ... }  | { type: "tool_end"; ... };
```

**この語彙は新しく発明しない。** `server.ts` の `toServerEvent()` が既に生のイベントを
この6語へ翻訳している——**正規化は存在していて、置き場所が pi のイベントを受ける形なだけ**。
seam を切る作業は、それをバックエンド側へ下ろすことに等しい。

**契約に含めないもの**（漏れると pi 依存が残る）: `agent.state.messages` /
`SessionManager` / `appendCompaction` / `buildSessionContext` / pi の `ToolDefinition` /
`AgentMessage` 等の型。

**seam の外に置くもの**: `chapter-summarizer.ts` / `memory-extraction.ts` の
`completeSimple` は**単発の呼び出しであってハーネスではない**。LLM 側の関心として残す。

### 決定90: **思考は一級の要素。**本文と別チャネルであることを契約の約束にする

表示のためのおまけではなく、**往復させないと壊れるプロトコルの一部**（inc-0056）。

- 思考モデルは前ターンの思考を送り返すことを要求する。正式版 `deepseek-v4-flash` は
  `reasoning_content` の無い履歴を **400 で拒否**した
- 分離に失敗すると思考が本文に入り、**それが会話の記録として焼き付く**。以後モデルは
  「思考を本文に書く」自分の履歴を手本にし続ける。寛容なサーバは拒否しないので静かに悪化する
- pi 側の往復は既に実装されている（`openai-completions.js`）。**seam を切るときに落とすと退化する**

`restore` でも思考を含めて組み直すこと。

### 決定91: 道具は **wire 名**で載せる。名前の対応はハーネスが持つ

**実測（2026-08-12・Agent SDK 実機）**：MCP に登録した道具名は `mcp__<server>__<name>` に
なるが、**ドットは黙って単一アンダースコアへ書き換えられる**。

| 登録した名前 | モデルに見えた名前 |
|---|---|
| `worker.delegate`（論理名） | `mcp__banto__worker_delegate` ← **ドットが `_` に化ける** |
| `worker__delegate`（wire名） | `mcp__banto__worker__delegate` ← そのまま |

論理名を渡すと**第3の名前体系**が生まれ、`fromWireToolName` の逆引きが外れる。
したがって **`tool()` には wire 名（決定22 の右側）を渡す**。ハーネスは
「論理名 ↔ そのバックエンドでの名前」の対応を**両方向**持ち、`server.ts` の逆引きは
ハーネス越しに行う。職人側の `claude-agent/naming.ts` が同じ役を既に担っている。

**道具のハンドラは番頭側に置く。** 退避（`withArtifactOffload`）・ターン予算・place の砦が
**ハンドラの中で**効くなら、どちらのバックエンドでも同じように効く（task-0090 の再発防止）。

### 決定92: 番頭に組み込みツールを持たせない。`tools: []` で切る

**実測で分かった罠**：`disallowedTools` に名前を並べても**組み込みは消えない**。
Read/Bash/Edit 等10本を並べても、`AskUserQuestion` / `Cron*` / `Task*` / `Monitor` /
`Workflow` / `Skill` / `ToolSearch` など **26本が残り、モデルは実際に `ToolSearch` を呼んだ**。

正しい梃子は `Options.tools`（SDK の型注釈が明示している——
`To restrict which tools are available, use the tools option instead.`）。
**`tools: []` を渡すと組み込みは0本**になり、MCP の口だけが見える（実測で確認）。

これは D10 の話であると同時に**関所の話**である。組み込みツールの出力は banto の退避を
通らないので、ADR-0019 で 56本に絞った番頭に 26本が黙って足されると、
**絞った意味が消えるうえに大きな出力が文脈に直接載る**。

**`canUseTool` は当てにしない。** 名前を `allowedTools` に並べると
`canUseTool` は**呼ばれない**（SDK が警告を出す。実測で確認）。番頭の掛け金は
ハンドラの中にあるので成立するが、**「`canUseTool` でターン予算を受けられる」は誤り**
——下ごしらえのこの記述は撤回する。

### 決定93: 章の切れ目は「文脈を捨てて**系プロンプトの種**から始め直す」

`closeChapter()` は `appendCompaction` に `keepNothing`（どのエントリとも一致しない番兵）を
渡している——**境界より前は1件も残さない**。seam の操作としては
`startChapter(opening)`＝「生きている文脈を捨てて、この要約から始め直す」で言い切れる。

**実測で確認したこと**：
- Agent SDK で `resume` を渡さずに `query()` を起こし直すと、**文脈は引き継がれない**
  （前ターンの合言葉を尋ねて `NO_CONTEXT`）。`startChapter` は成立する
- **種は「系プロンプト」に入れる。** 前章の要約をユーザーメッセージとして渡した回は
  モデルが「前の文脈は無い」と答えたが、**系プロンプトに入れた回は正しく使った**

| | pi バックエンド | Agent SDK バックエンド |
|---|---|---|
| `startChapter` | `appendCompaction(keepNothing)` ＋ `buildSessionContext` | 現 `query()` を畳み、**種を系プロンプトに入れて**起こし直す |

### 決定94: モデルは **カタログ／ポリシー／束縛**の3層。`NotSupported` を型で持つ

**Agent SDK は Claude 以外のモデルに繋げない。** 公式が明文で拒否しており
（`doesn't support routing Claude Code to non-Claude models through any gateway`）、
機構としても塞がっている（ゲートウェイのモデル発見は `id` に `claude` / `anthropic` を
含むものだけ残す）。

したがって**契約は「どのモデルもどのハーネスでも動く」と仮定してはならない**。

```ts
resolve(ref: ModelRef): Binding | NotSupported
```

概念は **7 → 5** に減らす（`tier` / `pick` / `default` / `hostUsable` / `workerUsable` を畳む）:

| 概念 | 定義 |
|---|---|
| **ModelRef** | `provider/id` の1文字列。番頭・職人・Kobo の間を流れるのはこれだけ |
| **Binding** | ModelRef → 実体（endpoint / wire format / 資格情報の参照 / 能力）。**ハーネスごとに実装が違ってよい** |
| **RoleBinding** | 役割名 → ModelRef。役割は banto が定義（`banto.main` / `worker.default` / …） |
| **Policy** | 使ってよい ModelRef の allowlist。**論理 ID に対して評価する** |
| **Catalog** | 存在する ModelRef と能力の列挙。**ハーネスに問い合わせる**（自前で持たない） |

この三分割は Claude Code が `availableModels`（ポリシー）／`modelOverrides`（束縛）として
出荷済みで、相互作用の規則まで文書化されている——
`The allowlist is evaluated against the Anthropic model ID, not the override value`。
**ポリシーは論理 ID に対して評価し、束縛は評価後に適用する**を不変条件として採る。

**能力メタは「宣言」ではなく「問い合わせ」に倒す。** pi は cost/contextWindow を宣言できるが
Agent SDK はできない（事後に usage が返るだけ）。両対応の最大公約数は問い合わせ。

**モデル操作の Tool は 19本 → 4本。** 設定変更は Tool ではなく GUI とファイルの担当にする
——調べた製品はどこもモデル設定をエージェントの Tool にしていない。ADR-0019 の実測で
**19本中13本が一度も呼ばれていない**のは、それらが Tool であるべきでなかったから。

### 決定95a: **バックエンドはプロバイダの上位の階層。会話の途中で切り替えられる**

（PO裁定 2026-08-13。当初案「設定で選び、再起動で効く」を差し替える）

**モデル名からバックエンドは決まらない。** 同じ `opus` が pi（opencode zen 経由）でも
Claude Code（Agent SDK 経由）でも選べる——職人側の「ランタイムは名前から決まる」
（`pool.ts`）は**番頭には当てはまらない**。当初この規則を流用しようとして、誤りだった。

したがって人が選ぶのは**3段**:

```
バックエンド（pi / Claude Code）→ プロバイダ（opencode-go / huihui / claude …）→ モデル
```

**再起動は要らない。** モデルを会話の途中で変えられるのと同じ感覚で変えられるべきなので、
`Thread.replaceHarness` で購読ごと張り替える。設定画面の「番頭のバックエンド」は
**新しい会話の既定**だけを決める面に降格する。

- 切り替えは**その会話だけ**に効く（モデル切替と同じ・PO裁定 2026-08-04）
- **pi へ戻ると文脈も戻る**——pi のセッションは会話が開いている間ずっと生きており、
  章立てもそこに紐づいている。だから pi のハーネスは常に組んでおき、同じものを返す
- Claude Code 側は別セッションなので、**戻ると向こうの文脈は消える**。引き継ぐなら
  種（`startChapter`・決定93）で渡す
- 選べないバックエンドは**黙って消さず理由を出す**（認証が無い等・I2）

**画面は1つにまとめる。** 「LLM・モデル」「番頭のバックエンド」「職人」に散っていると
人には複雑すぎる（PO指摘 2026-08-13）。会話のモデル選択が
`settings.harness_models` から3段を引いて**そこで完結する**。

### 決定95: `defaults.host` はバックエンド選択の隣へ移す

いま `llm-registry.json` にあるが、職人側が `backends.ts` を分けた理屈——
「Claude Code のモデルは登録に載らないので同じ表に並べられない」——が番頭にもそのまま来る。

**棚卸しで分かった実害**：`llm-registry.json` の `picks` と `defaults.workerTier` は
**既にデッドコード**で、職人は工房側の `tierAssignments` で決まっている。同じことを
番頭側でも繰り返さないために、番頭の既定もバックエンドの隣に置く。

あわせて**死んでいる機構を掃除する**：`BANTO_PROVIDER` / `BANTO_MODEL`（**どこからも
読まれていない**のに README が設定を勧めている）、`settings.json` の
`modules["worker-pool"]`、複数鍵のフェイルオーバー一式（1プロバイダ1鍵では構造上作動しない）。

### 決定96: 設定画面は **3段＋ポリシー**

事例（Cline / Open WebUI / Goose / opencode）から帰納した共通形。

1. **接続の一覧** — 名前 / エンドポイント / 有効無効 / 状態。編集はモーダルへ
2. **プロバイダと資格情報** — **Base URL は最上段**（全製品一致。Advanced に入れない）。
   カスタムヘッダ等は Advanced（**既定で閉じる**）
3. **検証 → モデル一覧 → 役割へ割り当て** — 検証は **Goose 型（実際に推論を1回叩く）**を採る。
   banto は職人に tool-calling をさせるので、`/models` が通っても tool-calling が通らない
   モデルを事前に弾ける
4. **ポリシー**（allowlist・通常は畳む）

**失敗の扱いの鉄則3つ**（事例から）:
- 検証失敗でも**保存と続行を許す**（"chat completions will still work"）
- 一覧が取れなければ**自由入力へフォールバック**
- 原因の欄が Advanced の裏なら**自動で開いてからエラーを出す**

**宣言的に書けるはず。** いま `LlmRegistryViewer` が専用 React ビューなのは
（ADR-0011 決定43）**スキーマが大きすぎるから**であって GUI 基盤の限界ではない。
opencode 型の4キー最小契約（`npm` / `name` / `baseURL` / `models[].limit`）まで削れば
単一の宣言フォームに収まる。

## CLAUDE.md との関係

「LLMプロバイダ層はプラガブル＝モデル非依存」と、Agent SDK が Claude 専用であることは
**選択肢の1つとしてなら整合する**——**pi 経路を残すことが整合の条件**。
Agent SDK バックエンドを選んでいる間、その役はモデル非依存でなくなる。明文化しておく。

## 段取り

1. **seam を切るだけ。pi バックエンド1本、挙動不変。**
   完了条件は `npm test` 全通過——**振る舞いが変わらないことを試験で押さえられる**のが
   この段の価値。`server.ts` の接点は5箇所（`subscribe` / `prompt` / `isStreaming` / `abort`）
2. **Agent SDK バックエンドを足す。** ここで初めて挙動が変わるので切り分けて検証できる
3. **設定画面にバックエンド選択**（職人側の `WorkerSettings.tsx` を写す）

**1 と 2 を分けるのは、番頭のターンループは壊れると会話そのものが成立しないから。**
常に動く番頭を手元に残したまま進む。

## 未決

1. **会話ごとにバックエンドを変えられるのか、番頭ホスト単位か。** 幹・枝（ADR-0017）を
   またぐときの扱い
2. **`banto-host` への Agent SDK 依存の追加**（D6）。いま SDK は `banto-worker-pool` 配下
   にしか入っていない
3. **サブスクリプションの消費**。番頭を Agent SDK で回すと職人（opus）と同じ枠を分け合う。
   未計測

## 実測で確かめたこと（2026-08-12・I1）

Agent SDK 実機（`@anthropic-ai/claude-agent-sdk` 0.3.226・model `haiku`）:

1. **`query()` の起こし直しで文脈は引き継がれない** → `startChapter` 成立
2. **章の種は系プロンプトに入れれば効く**。ユーザーメッセージとして渡した回は使われなかった
3. **MCP の道具名はドットが単一アンダースコアに化ける** → wire 名で載せる（決定91）
4. **`disallowedTools` では組み込みが消えない**（26本残り、`ToolSearch` が実際に呼ばれた）。
   **`tools: []` で0本になる**（決定92）
5. **`allowedTools` に名前を並べると `canUseTool` は呼ばれない**（SDK が警告）

**まだ確かめていないこと**: 番頭の56本を実際に載せたときの挙動（今回の実測は2本）、
`restore` の経路、サブスクリプション消費。
