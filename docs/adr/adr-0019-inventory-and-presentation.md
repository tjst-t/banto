---
id: adr-0019
type: adr
status: accepted
supersedes: adr-0018
refs: [adr-0009, adr-0010, adr-0011, adr-0017, adr-0018, inc-0056, inc-0057, imp-0018]
---

# ADR-0019: **在庫と提示を分ける**。番頭に見せる道具は選び、残りは持ったまま隠す

> status: **accepted**（2026-08-12。PO 裁可）。ADR-0018 を差し替える。決定番号は 81
> （ADR-0017）の続きから採る。決定82・83・85・84-5 は実装済み。**決定84-2/3（定義の圧縮・
> スキーマの平坦化）は実測で害が出たため保留**（下記「実測」⑤）。

## 文脈

番頭に道具を **100個・55,016字**（要求全体の41%）渡している。一覧の後ろにあるものは
呼ばれない——同じ100個・同じ質問文で必要な道具の位置だけを変えた実測で、
**先頭 16/16・39番目（元の並び）0/10・末尾 2/10**（inc-0057）。

ADR-0018 はこれを「モジュールが増えて太る」問題として立て、道具に宛先を持たせる
機構を決めた。**問題設定が実態と合っておらず、撤回した**（ADR-0018 の「なぜ撤回したか」）。

改めて調べたところ、**独立した3つの欠陥**が重なっていた。ADR-0018 は3つ目にしか
触れていなかった。

### 前提（PO 裁定 2026-08-12）

**番頭のモデルは、ローカルで無料に使える DeepSeek 系に固定する**——具体的には自宅の
vLLM（`10.10.254.20:8000`）に載っている **`deepseek-v4-flash-abliterated`**。
kimi・qwen は使えない。したがって inc-0056 の「kimi・qwen は 93%」は逃げ道にならず、
**1〜3/12 しか道具を呼ばないモデルでも成立する設計**でなければならない。

**下記の実測はこのモデルの上で取った**——狙いの台そのもので測っている。

そして実測の結果、**inc-0056 が「使わない」と結論した根拠のほうが崩れた**。
「本物のツール定義では道具をほとんど呼ばない」のはモデルの実力ではなく、
**道具箱が見えていなかった**（診断①）ためだった。inc-0056 に撤回を追記した。

## 診断——3つの独立した欠陥

### ① 見せ方（presentation）

- 道具定義 **55,016字**（推定 24,000トークン）。要求全体 134,232字の **41%**
- **システムプロンプトの "Available tools" が空。** banto は `systemPromptOverride` を使い
  （`packages/banto-host/src/host-session.ts:189-194`）、どの道具にも `promptSnippet` を
  設定していないため、pi の散文一覧に**一行も載らない**
  （`node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js:40-43`
  「A tool appears in Available tools only when the caller provides a one-line snippet」）。
  **100個の JSON スキーマだけがぶら下がっている**
- **一等地を死んだ道具が占めている。** 現在の並び（`bin.ts:905-1017` の組み立て順）:

  | 位置 | ドメイン | 呼び出し比率 |
  |---|---|---|
  | 9〜27 | `llm.*` 19個 | **0.5%**（19本中13本が0回） |
  | 37〜42 | `file.*` 6個 | 24.7% |
  | 50〜58 | `worker.*` 9個 | 42.4% |

  inc-0057 の「39番目で 0/10」は、まさにこの帯である
- 説明文が長い（`env.verify` 2,060字・`worker.delegate` 1,784字・`inbox.post` 1,768字）
- 入れ子スキーマ。DeepSeek は「合成の単純な道具なら 5/5 呼ぶ」（inc-0056）

### ② 復号（decoding）——ADR-0018 が触れていなかった軸

**道具の数とは無関係に、道具呼び出しが潰れている疑いがある。**

pi は vLLM へ**全ツールに `strict: false` を送り**（`pi-ai/dist/api/openai-completions.js:1093-1101`、
`supportsStrictMode` は vLLM で true 判定）、`tool_choice` は設定していない
（pi-coding-agent 側から設定する経路が見当たらない・**未確認**）。

vLLM 公式ドキュメント verbatim（https://docs.vllm.ai/en/latest/features/tool_calling/）:

> For `tool_choice="auto"`, setting `strict: true` on at least one tool opts in to
> structural-tag constraints; **without it, the model generates freely and tool calls are
> extracted from raw text.**

そして「では strict を付ければよい」は**罠**である。arXiv:2606.25605 抄録 verbatim:

> when Tool Calling and JSON Schema constraints are simultaneously enabled, multiple
> open-weight models cease invoking tools despite maintaining high schema compliance.
> We refer to this behavior as **Tool Suppression**. … JSON Schema constraints are compiled
> into grammar-based token masks, causing tool-call tokens to become unreachable during decoding.

緩和は**2パス分離**（道具の実行と、スキーマ制約つきの応答生成を分ける）。
inc-0056 が `strict: true` で改善しなかった実測（1/12 → 3/12）とも符合する。

**この軸は本 ADR では決めない**（設計ではなく設定と実測の問題）。incident として別に起票する。

### ③ 在庫（inventory）

`/var/lib/banto/threads/sessions/*.jsonl` の実測（総呼び出し 11,231回・88種類）:

- **18本が一度も呼ばれていない**（`llm.set_*` 13本・`git.blame`・`env.deploy`・`env.cleanup`・
  `skill.learn`・`skill.unlearn`）
- **5回以下が更に20本**。合わせて **38/100 が実質死んでいる**
- 上位25個で **90.0%**、上位30個で 92.4%（連続重複を畳んだ 7,056回ベース）
- `llm.*` は道具定義の **15.8%（8,712字）** を占めて呼び出し **0.5%**

## 世の中はどうしているか（一次情報）

**調べた製品で、平坦な一覧のまま押し込んでいるものは一つも無かった。**

| | 番頭/主エージェントに渡す道具 |
|---|---|
| OpenHands（既定） | **3**（実装は13、渡すのは3） |
| pi 組み込み（既定 active） | **4**（在庫7） |
| Cline SDK（既定） | **9** |
| opencode | 15〜17 |
| Claude Code | 44（**MCP は既定で遅延**） |
| **banto（番頭）** | **100** |

公式の閾値（両方とも verbatim 確認済み）:

- Anthropic: `Claude's ability to pick the right tool degrades once you exceed 30–50 available tools.`
- OpenAI: `Aim for fewer than 20 functions available at the start of a turn at any one time`

全社が最低1つ、たいてい複数の構造を採っている——**在庫と提示の分離**（OpenHands 13→3、
GitHub MCP の toolsets 20+→既定5、Claude Code は MCP を名前だけ提示）、**役割ごとのセット**
（Cline `ToolPresets`、Claude Code subagent の `tools`）、**モデル別の差し替え**
（opencode `registry.ts`、Cline `model-tool-routing.ts`）、**遅延開示**、**委譲**。

**banto は「役割ごとの分離」（番頭／職人）を既に持ち、しかも D11（記憶の有無で分ける）で
業界標準より厳しい。欠けているのは在庫と提示の分離だけである。**

## 実測（2026-08-12・実施済み）

**実装の前に切り分けを回した。結果はこの ADR の予測と部分的に食い違った。**

- 台: ローカル vLLM（`10.10.254.20:8000` / `deepseek-v4-flash-abliterated`）
- 題材: 実ログから**機械的に抽出**（user 発話 → 番頭が直後に呼んだ道具）。967組から
  gold ごと最大3件で層化し、seed 固定で 80件。**私は1件も選んでいない**
- 各条件 n=80、**同じ問い合わせを条件間で対にして** McNemar 検定

| 条件 | 中身 | **何か道具を呼んだ** | gold@1 |
|---|---|---|---|
| **A** | 現状（100個・そのまま） | **48.8%** [38-60] | 8.8% |
| **B** | 43本に絞る | **98.8%** [93-100] *** | 8.8%（差なし） |
| **C** | 100個・定義を圧縮 | 75.0% *** | 12.5%（差なし）**不正名6件** |
| **D** | 43本＋圧縮＋並び＋散文 | **98.8%** *** | 8.8%（差なし） |
| **E** | 100個・**正解を先頭へ** | 97.5% *** | **27.5%** *** |
| **F** | 100個・**散文の一覧だけ足す** | **100%** *** | 16.2%（p=0.07） |

（*** = 対比較で p<0.001。gold は「番頭が実際に呼んだ道具」であって唯一の正解ではないので、
**gold の絶対値は解釈しない**——条件間の差だけを見る）

### 分かったこと

**① 本当の欠陥は「埋もれた道具が呼ばれない」ではなく、「道具箱ごと見えていない」だった。**
現状の番頭は **48.8%——半分のターンで道具を1本も呼ばない**。inc-0057 は「39番目は 0/10」を
位置の問題として立てたが、実体はもっと手前にあった。

**② 散文の一覧を足すだけで 48.8% → 100%**（条件F・p<0.001）。**道具は1本も減らしていない。**
`promptSnippet` 未設定＋`systemPromptOverride` で "Available tools" が空だったこと
（診断①）が、単独で最大の原因だった。**最も安い直しが最も効いた。**

**③ 数を減らすこと（B）は「呼ぶかどうか」には効くが、「どれを選ぶか」には効かない**
（gold@1 は 8.8% のまま・差なし）。ADR は「30〜50 の帯へ入れば選べるようになる」を
暗に期待していたが、**そうはならなかった**。

**④ 位置は効く**（E: 8.8% → 27.5%・p=0.00006）。ただし **E は実装できない**
——「必要な道具」が事前に分かっていることが前提の診断用の条件。決定85（実測順に並べる）は
この効果を**部分的にしか**取れない。

**⑤ 定義の機械的な圧縮（C）は不正な道具名を6件生んだ**（他の条件は0件）。説明文を
第一文へ切り詰め、入れ子の説明を落とす、という機械的なやり方は**害があった**。

## 決定

### 決定82: **在庫と提示を分ける。** 道具は全部登録し、番頭に見せるものだけ選ぶ

道具の登録（在庫）と、モデルへ提示する集合（提示）を別の概念にする。

- **在庫**＝`createAgentSession` の `customTools` に渡す全部。いままで通り
- **提示**＝`AgentSession.setActiveToolsByName()` で選んだ部分集合。**モデルにはこれだけが載る**

**新しい機構は作らない（D6）。** pi の公開 API で足りる:

```
node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts:308
  Set active tools by name. Only tools in the registry can be enabled.
  Also rebuilds the system prompt to reflect the new tool set.
```

`createAgentSession()` は `{ session }` を返す（`host-session.ts:245`）ので、
**banto は拡張を書かずにこれを呼べる。**

**関所は一切動かない。** `guardTurn` / `withArtifactOffload` / `guardPathArg` /
`bindToolArgs` はすべて `toPiTool` の**手前**に掛かっている（`host-session.ts:216-243`）。
提示を絞っても掛け金は在庫側に残る。

**「隠す」であって「消す」ではない**ことが要点:

- モジュールの HTTP 面（`module-serve.ts:103-104`）は `BantoModule.tools` を見るので、
  GUI（FileBrowser / EnvManager / KoboBoard 等）は動き続ける
- 逆引き（wire名→論理名）も在庫から引ける
- 戻すのが安い。仕分けを間違えても設定1つで戻る

**実装上の注意（実物で確認済み）:**

- 渡す名前は **wire 名**（`worker__delegate` 形式）。在庫は `toPiTool` を通した後の
  名前でレジストリに入っている（決定22）
- `noTools: "builtin"` は `initialActiveToolNames = []` にするが（`dist/core/sdk.js:136`）、
  `_refreshToolRegistry` が**新しく登録された名前を自動で有効化する**
  （`agent-session.js:2008-2014`）。いまの100個が全部載っているのはこの経路。
  `setActiveToolsByName` で選び直した後は、その選択が保たれる（既存の active は維持され、
  以後は**新規登録分だけ**が足される）
- **`setActiveToolsByName` はシステムプロンプトも組み直すが、banto ではその結果が捨てられる:**

  ```
  agent-session.js:641-643
    this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
    this.agent.state.systemPrompt = this._systemPromptOverride ?? this._baseSystemPrompt;
  ```

  banto は `systemPromptOverride` を使っている（`host-session.ts:189-194`）ので、
  左辺は更新されるが**モデルへ渡るのは override のまま**。

  - 良い面: プロンプト側が動かないので、プレフィックスキャッシュが切れるのは
    **道具配列の分だけ**で済む
  - 悪い面: **診断①の「"Available tools" が空」は決定82 では直らない。**
    散文の一覧は `systemPromptOverride` の中に自分で書く必要がある → **決定84-5**

### 決定83: 提示する集合は**版として固定する**。番頭は **25個前後**

使用頻度を見て人が決め、**コードに書いて版として固定する**。会話の途中で勝手に増減しない
（ADR-0018 が却下した「使用頻度による自動昇格」の却下は維持する——隠れ状態は D11 に反し、
監査もできなくなる）。

**選ぶ基準は頻度ではなく「番頭に持ってほしいか」**（PO 裁定 2026-08-12）。頻度は
**落とす候補を見つける道具**として使い、残す判断は役割から行う。

出発点（実測の上位と、役割から必要なもの）:

| 残す | 本数 | 理由 |
|---|---|---|
| `worker.*` | 9 | D10 の主経路。呼び出しの42% |
| `file.read/grep/list/find/stat` | 5 | 判断の材料。24.7% |
| `file.write` | 1 | 決定38 で開けた番頭の唯一の出力口。SKILL が9箇所で前提にしている |
| `artifact.read` | 1 | 退避した観測の引き戻し（決定47a） |
| `git.status/diff/log/show` | 4 | 閲覧のみ（決定37） |
| `kobo.enqueue/list/task/approve/reopen` | 5 | **使用頻度で切らない**——`bin.ts:728-731`「`kobo.*` が消えると番頭は『積み方を知らない』状態になり、**自分で実装を始めてしまう**」 |
| `memory.save/recall/search/forget` | 4 | D11。番頭が番頭である理由 |
| `skill.list/read` | 2 | 段階的開示の口。**決定86 が依存する** |
| `canvas.open/show/close` | 3 | 決定78・81a |
| `thread.open/list/send/merge` | 4 | 決定77 |
| `inbox.post` | 1 | 決定73。判断を求める唯一の口 |
| `place.list/request_write` | 2 | 決定36・38c |
| `handoff.read/list` | 2 | 決定47b |
| `llm.list` | 1 | **読み取り1本だけ残す**。番頭が「いま何で動いているか」を答えられないとモデルの相談ができない（実測32回・`llm.*` 中最多）。書き換え系18本は設定画面にある（決定41c） |
| `env.*` | 12 | **未決①のため現状維持。** 一度「外す」と裁定され取り下げられた以上、決めていないことを絞り込みのついでに実装しない |

**合計 56本**（`env.*` 12本を含む。外すなら 43本）。Anthropic の 30〜50 の帯を少し超える。

**それでも実測上は問題にならない**——条件F が示すとおり、「何か呼ぶ」を決めているのは
数ではなく**散文の一覧**で、100個のままでも 100% に戻る。数を減らす効き目（B）は
**選択の質には及ばなかった**ので、`env.*` を残す代償は小さい。

**更に削る余地は決定86（束を開く）で作る**——ただし実測④のとおり、位置の効果を
本当に取るには「必要な道具を先頭に置く」ことが要り、それは事前に分からない。
**束を開く形はその近似**になる。

落とすもの（在庫には残す）:

| 落とす | 本数 | 理由 |
|---|---|---|
| `llm.*` のうち `list` 以外 | 18 | **13本が0回。** 設定画面に同じ操作がある。決定41c「設定の口は番頭に渡さない」の趣旨と、`llm.*` を番頭に渡していることは元々矛盾していた |
| `repo.*` | 5 | 30回。ワークツリーの作成は委譲で足りる |
| `git.branches/blame` | 2 | 48回・0回 |
| `skill.learn/unlearn` | 2 | 0回。学習層の機構は残る（章境界の蒸留が本筋） |
| `canvas.switch/query_state/list_catalog` | 3 | カタログは有限の語彙（決定78）なので説明文に書ける |
| `thread.open_trunk/rename/close_trunk` | 3 | 稀。畳むのは決定77 の機構側でよい |
| `inbox.list/resolve` | 2 | 取次は PO が捌く面（決定73） |
| `artifact.list` | 1 | 栞は結果の末尾に必ず出る（`artifacts.ts:427`） |
| `pi.agent.describe` / `system.restart` | 2 | 設定画面にある／PO が開けたレベル1の口。**`system.restart` を落とすかは PO 判断** |
| `file.write` 以外の書き込み系 | — | 元々持っていない |

### 決定84: 道具定義は**短く・例つき・平ら**。引数の値は**英語**

弱いモデル前提での定義の書き方を、契約として決める。整形は `toPiTool`
（`packages/banto-host/src/tool-registry.ts:50-64`）で行う——**pi は description も
スキーマも一切加工せず素通しする**（`openai-completions.js:1074-1105`）ので、
短縮できるのは banto 側だけ。

1. **入出力例を付ける。** Anthropic 内部測定 verbatim:
   `In our own internal testing, tool use examples improved accuracy from 72% to 90% on complex parameter handling.`
   **API 機能に依存せず、説明文に数行足すだけ。最も安い一手。**
2. **説明文は短く。盛らない。** arXiv:2602.14878（856道具の実証）verbatim:
   `augmenting these descriptions for all components improves task success rates by a median of
   5.85 percentage points … it also increases the number of execution steps by 67.46% and regresses
   performance in 16.67% of cases` ——同論文は compact 版を推奨している。

   **ただし実装は保留**（実測・条件C）。「説明文を第一文へ切り詰め、入れ子の説明を落とす」
   という**機械的な圧縮は不正な道具名を6件生んだ**（他の条件は0件）。短くすること自体は
   筋が良くても、**機械的にやってはいけない**。道具ごとに人が書き直す形で、
   別途 task を立てて進める。
3. **スキーマは平ら。** 入れ子・`anyOf`/`oneOf` を避ける。DeepSeek の `strict` は
   「全プロパティ required・`additionalProperties: false`」を要求する（公式 API ドキュメント）。
   **これも実測していない**——2と同じ task で扱う
4. **引数の値は英語/識別子で埋めさせる**と説明文に明示する。arXiv:2601.05366 は
   `parameter value language mismatch`（道具の選択は正しいのに、引数の値をユーザーの言語で
   埋める）を dominant failure mode と呼んでいる。**PO とのやりとりが日本語・道具 I/F が
   英語という banto の構図は、この故障の型そのもの**
5. **システムプロンプトに、道具の散文一覧を出す。**

   **いまは一行も出ていない。** pi は `promptSnippet` を設定した道具だけを
   "Available tools" に載せる仕様で（`dist/core/system-prompt.js:40-43`
   「A tool appears in Available tools only when the caller provides a one-line snippet」）、
   banto はどの道具にも設定していない。加えて `systemPromptOverride` を使っているため
   pi 側の組み立て自体が捨てられる（決定82 の「実装上の注意」）。
   **結果、100個の JSON スキーマだけが、案内文なしでぶら下がっている。**

   `promptSnippet` は使わない——付けると `setActiveToolsByName` のたびに
   システムプロンプトが組み直され、キャッシュが余計に切れる（pi 公式が警告しており、
   決定86 の遅延開示とも相性が悪い）。**`systemPromptOverride` の中に banto が自分で書く。**

   書き方は Anthropic の指針に合わせ、**個別の道具ではなくドメイン（＝カテゴリ）を並べる**:

   > Add a system prompt section describing available tool categories: "You can search for
   > tools to interact with Slack, GitHub, and Jira."
   > （https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool）

   banto なら「職人へ委譲する `worker.*`／場所を読む `file.*` `git.*`／工場に積む `kobo.*`／
   覚える `memory.*`／手順を引く `skill.*`／…」という数行。**道具1本ずつを再掲しない**
   ——定義はスキーマ側にあるので、二重に載せると決定84-2（盛らない）に反する。

   これは**決定85（並び）と対になる**。散文の一覧は「何があるか」を、並びは
   「何が目に入りやすいか」を決める。**片方だけでは効かない。**

### 決定85: 並びは**実測順**。一等地に死んだ道具を置かない

提示する集合の順序を、呼び出し実測の降順に固定する（`worker.*` → `file.*` → …）。
**現在 `llm.*` 19個が占めている 9〜27番目を空ける。**

順序は**版として固定**する。動かすとプレフィックスキャッシュが切れるので、
仕分けと同時に一度だけ動かす。

### 決定86: 遅延開示は、**必要になったら pi の口で**。自作しない

決定83 で 43本に落ちてもなお多い場合、**束を畳んで必要なときに開く**。

**自作しない。** pi が公式に持っている:

```
docs/extensions.md（"Dynamic Tool Loading"）
  Extensions can register many tools while keeping only a small initial set active.
  A tool can then add more tools with `pi.setActiveTools()` during execution. …
  This works with every model.
```

`search_tools` の完全な実装例が同ドキュメントに載っている。ADR-0018 が約400行かけて
書いて捨てたものは、**書く必要が無かった**。

**いま実装しない。** 決定82〜85 の効果を実測してから判断する（下記「実測で確かめること」）。
判断の分かれ目は「提示する集合が 30個を大きく超えたまま下がらないとき」。

**制約を記録しておく**（実装するときに効く）:

- vLLM では pi の native な遅延ロードは**効かない**（`deferredToolsMode` の既定は
  `undefined`、対応は kimi のみ・`openai-completions.js:1233`）。fallback 経路で
  動作はするが、**道具を増減するたびにプレフィックスキャッシュが切れる**。
  ローカル無料モデルなので費用ではなく待ち時間の問題
- 遅延させる道具に `promptSnippet` / `promptGuidelines` を付けない
  （システムプロンプトが再構築され、キャッシュが余計に切れる。pi 公式が警告している）
- 束を開く道具（loader）は**セッション中ずっと提示したまま**にし、置き換えではなく追加で使う

### 決定87: 職人には**広げない**（ADR-0018 決定D を継承・根拠を差し替え）

同じ機構を職人にも広げない。

**根拠は「職人の道具数が少ないから」ではない**（ADR-0018 のその根拠は標本の取り方が
誤っていた——`tools` 省略の 369回/1,187回＝31.1% を数えていなかった）。

**根拠は、職人の道具箱が既にギリギリで設計されていること。**
`packages/banto-worker-pool/src/claude-agent/naming.ts:26-32` verbatim:

> **絞り込みで消してはいけない。** これが無いと、実装を終えても工場へ伝えられず、
> 監査人は判定の出しようが無い——**タスクが1本も完走しなくなる（実機でそうなった）。**

**職人に効く梃子は検索ではなく、起こすときの絞り込み。** 委譲する番頭は仕事の中身を
知っているので、`worker.delegate` の `tools` で名指しできる。

**ただし既定が安全側でない**（imp-0018）。31.1% が省略＝read/bash/edit/write/grep/find/ls
全部持ち。`worker.delegate` の説明文自身が「調べるだけのつもりでも書き換えられる」と
警告している。**これは本 ADR では決めない**——imp-0018 で別に扱う。

## 採らなかった案

- **道具に宛先を持たせ、2段で許可する**（ADR-0018 決定A）——守る対象（第三者モジュール）が
  存在せず、中核48本に効かず、既存の設定機構（決定41・73）と衝突する。目的は決定82 が
  新しい機構なしで満たす
- **`worker.tools` で候補を引く**（ADR-0018 決定E）——モジュールの道具を職人に載せる配線が
  存在しない
- **遅延開示を自作する**——pi が持っている（決定86）
- **使用頻度による自動昇格**——隠れ状態（D11）・再現性・キャッシュ（ADR-0018 に詳細）
- **code mode**——関所が全部外れる。独立評価で文脈汚染下 32% 劣化（ADR-0018 に詳細）
- **1モジュール1道具＋`action`**——入れ子スキーマを誘発し、決定84 と正面から衝突する

## 未決

1. **`env.*` 12本を番頭に見せ続けるか。** 一度「外す」と裁定されたが、**取り下げた**
   （PO 2026-08-12）。これは**単なる仕分けではなく I1 の設計に触れる**ため、他の決定と
   同じ物差しでは決められない。

   ADR-0010 決定32c と `docs/spec/environment.md:126-127` が明文で「番頭は `env.*` を
   直接呼べる／職人には渡さない——**自分の成果を自分で検証させると I1 が崩れる**」と
   言っており、決定32 はこれを「番頭の急所」と呼んでいる。実測でも番頭の検証手段として
   動いている（`env.verify` 289回・`env.list` 289回・`env.run` 150回）。

   一方で 12本は道具定義 7,468字を占め、決定83 の削減対象としては大きい。**外すなら
   I1 の代替が要る**——候補: ①検証結果を番頭が呼ばずに機構が積む ②`env.verify` 1本だけ
   残す（12→1 で削減効果はほぼ維持）③Kobo のゲートに寄せる。**PO 判断が要る**
2. **`system.restart` を提示に残すか**（PO がレベル1として明示的に開けた口）
3. **②復号の軸**（`strict` / `tool_choice` / Tool Suppression）。本 ADR では決めない。
   incident として起票し、実測で切り分ける
4. **`worker.close` の冪等 no-op**（`pool.ts:1179-1181`）。呼び出しの48.8%を生んだ暴走の
   原因。本 ADR の主題ではないので incident として別に扱う（P1）

## 実測で確かめること

**ADR-0018 の反省を繰り返さない**——n を十分に取る、評価の題材を自分で選ばない、
合成データで「直った」と言わない、**モデルは実際に使うもので測る**。

### 切り分けの実測（実装の前に回す）

「数を減らす」「説明を短くする」「並べ替える」のどれが効いているかを分離する。
本物の道具100個（`/home/ubuntu/banto-desk/reports/tap/req-0007.json`）を使い、
banto には触らずローカルの vLLM へ直接投げる。

| 条件 | 数 | 説明 | スキーマ | 並び |
|---|---|---|---|---|
| A（現状） | 100 | そのまま | そのまま | そのまま |
| B | 43 | そのまま | そのまま | そのまま |
| C | 100 | 短縮＋例 | 平ら | そのまま |
| D | 43 | 短縮＋例 | 平ら | 実測順 |
| E（対照） | 100 | そのまま | そのまま | **必要な道具を先頭へ** |
| F | 100 | そのまま | そのまま | そのまま（＋**散文の一覧**を系に足す） |

- 各セル **n ≥ 30**。問い合わせは既存の会話ログから**機械的に抽出**する（選ばない）
- E は inc-0057 の「16/16」の再現確認。**再現しなければ位置の実測そのものを疑う**
- F は決定84-5 の単独効果。**数もスキーマも触らずに散文の一覧だけ足す**ので、
  効けば最も安い直しになる（実装は `systemPromptOverride` に数行）

### 実装後

1. 提示後の道具数と、同じ質問文での呼び出し率（**0/10 → どこまで戻るか**）
2. 番頭が「持っていない能力」に当たったとき、**委譲へ回れているか**。
   実測では `bash` 23回・`web.fetch/search` 14回の空振りがある（すべて `Tool not found`）
   ——番頭が最も欲しがっている「無い能力」はシェルと外部ネットワークである
