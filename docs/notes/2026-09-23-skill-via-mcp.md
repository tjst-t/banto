# Skill は MCP の仕組みに寄せる——SDK の Skill 機構は使わない（2026-09-23）

## なぜ調べたか

「Skill を Module でどう実現するか」を提案しようとして仕様（§5.6・§5.7）を読み直したら、
**仕様が前提にしていない事実が実装側にあった**。そこから測ることになった。

## 出発点で見つかった食い違い（規則8）

`packages/core/src/runner/adapter.ts` の `RUNNER_BUILTIN_TOOLS` は
**`Skill`・`Read`・`Bash` を意図的に落としてある**（決定・2026-09-04。Landlock で
閉じ込めた Shell/FileSystem の迂回路を作らないため。`builtin-tools.test.ts` が
「生えていないこと」を見張っている）。

Agent Skills の progressive disclosure は3段で、**段ごとに使う口が違う**：

| 段 | 必要な口 | banto のいま |
|---|---|---|
| 名前＋説明（常時） | `skills:` オプションだけ | 通る |
| `SKILL.md` 本体 | **`Skill` tool** | 落ちている |
| `references/` | **`Read`** | 落ちている（戻せない——迂回路になる） |
| `scripts/` 実行 | **`Bash`** | 落ちている（同上） |

つまり **§5.7 の実体化層だけ作っても2段目で止まる可能性があった。**

裏返しの良い面もある。§5.7 は「SDK の `skills` 指定は文脈フィルタであって
サンドボックスではない——外した Skill も `Read`/`Bash` で読めてしまう」を
弱点として記録しているが、**banto には `Read` も `Bash` も無いので、この穴は
そもそも開いていない**（実体化ディレクトリを FileSystem Module の可視範囲の
外に置く限り）。

## 転回——MCP 側に、名前と説明を文脈に入れる口がある

MCP の `initialize` 応答に **`instructions`** がある。仕様の言葉で
「サーバとその機能の使い方を説明する。クライアントが**モデルに tool や
resource の理解を与える**のに使える——モデルへのヒント」。

**これを使えば、SDK の Skill 機構を一切使わずに、名前と説明を文脈に入れられる。**
本体は MCP 資源として読む（`ReadMcpResourceTool` は既に生えている）。

繋ぎ先も既に在った——`relay/agent-proxy.ts` の `new Server(info, options)` の
第2引数に `instructions` を渡せる（いまは渡していない）。
**そしてこの代理サーバは core の持ち物**なので、
「Module が配り、core が効かせる」（§5.6）がそのまま成立する。

## 測ったこと（使い捨てスクリプト、`/tmp/skill-probe/`）

banto と同じオプションの形（`tools` は置き換え指定、`settingSources: []`、
`strictMcpConfig: true`）で `query()` を呼び、合言葉／事実を仕込んだ
stdio MCP サーバを繋いだ。

### 測定1：`instructions` は文脈に入るか → **入る**

```
[tool_use] ReadMcpResourceTool {"server":"probe","uri":"skill://konpeito"}
[text] Q1: MARKER-7Q3X-ALPHA（MCPサーバ「probe」のinstructionsとして文脈冒頭に含まれています）
       Q2: BODY-9K2M-OMEGA
```

**しかもモデルは資源一覧を引かずに、`instructions` に書かれた URI を直接読みに行った。**
「名前と説明は push、本体は pull」が端から端まで動いた。

### 測定2：`resume` で差し替えられるか → **差し替わらない**

覚え書きを1つ（konpeito・保存温度17度）配ってターン1、
2つ目（ramune・42度）を足して `resume` でターン2：

| | ターン1（配布=konpeito のみ） | ターン2（ramune 追加・resume） |
|---|---|---|
| コンペイトウの保存温度 | **17**（正解） | — |
| ラムネの保存温度 | — | **「不明」** |

**対照**：同じ構成を**新規セッション**で配ると **42** と答えた。
→ 資源の配り方は正しく、**`resume` のときだけ届いていない**。
初回の `instructions` がそのまま使い回されている。

### 測定3：資源の一覧は `resume` でも生きているか → **生きている**

同じ resume の続きで一覧させると、モデルはこう答えた：

> probe サーバから参照できる覚え書きは2件です。
> 1. konpeito-handling (`skill://konpeito`)
> 2. ramune-handling (`skill://ramune`)
>
> なお、サーバ側の案内文で「いま効いている覚え書き」として明示されていたのは
> konpeito-handling だけで、ramune-handling は資源一覧にはあるものの
> 案内文には挙がっていませんでした。

**モデルがズレに自分で気づいて報告した。** push は凍っていても pull は届く。

### 測定4：Fork なら読み直すか → **読み直さない**

ユーザーの予想（「Fork はキャッシュを引き継ぐから、Clear か Compaction のときでは」）
を測った。ターン1で konpeito だけ、ターン2で ramune を足して
`resume` ＋ `forkSession: true`：

```
[turn1 配布=A]      17      ← 効いている
[turn2 配布=B fork] 不明    ← 足した覚え書きが届かない
```

**予想どおりだった。** 境目は「会話を畳んだか」ではなく、
**`resume` を外したかどうか**。Fork は resume を引き継ぐので、
キャッシュと一緒に前置きも引き継ぐ。

| | 読み直されるか | |
|---|---|---|
| `resume`（普通の継続） | **されない** | 実測（測定2） |
| **Fork** | **されない** | **実測（測定4）** |
| 新規の会話（＝ Clear 相当） | **される** | 実測（測定2の対照） |
| Compaction | **未測** | 文脈を埋めないと起こせないので高くつく |

**Clear は banto にまだ無い**（core に `clear_thread` は無い）。
`resumeSessionId: thread.resumePoint` を渡す形なので、
**Clear を「resume を外す」として実装すれば効かせ直せる**
——実装時にここだけ気をつける。

## 測定が消した選択肢

判断ではなく**機構として**決まったもの：

- **AI が会話の途中で Skill を効かせる**——不可能。届かない。
  費用の問題だと思っていたが、そうではなかった
- **実体化層**——不要。`instructions` ＋ 資源で足りる
- **`Skill` tool が `tools:` の置き換えを通り抜けるかの測定**——不要になった
- **`scripts/` の実行**——できない（2026-09-04 の決定の帰結）
- **効かせる集合をいつ決めるか**——会話の開始時以外にない

## 決定（ユーザー・2026-09-23）

**Skill はまず MCP の仕組みに寄せる。SDK の Skill 機構は使わない。**

- **形式**は Agent Skills（`SKILL.md`）のまま。§5.6 の「形式を発明しない」は守る
- **配達**は MCP（`instructions` ＋ 資源）。SDK の `skills:` オプション、
  ディスクからの発見、`Skill` tool は使わない

### 代償として受け入れたもの

- **残量メーターの Skill 内訳が只ではなくなる。** SDK の `getContextUsage()` は
  `skills: { totalSkills, includedSkills, tokens, skillFrontmatter[] }` を返すが、
  それは SDK の Skill 機構を使った場合の値。**自分で数える**ことになる
  （`instructions` の文字列は core が組み立てるので長さは分かる）
- **キャッシュ境界の問題は解決しない。** `instructions` も指示文の先頭側に入るので、
  効かせる集合を変えればキャッシュは切れる。「末尾に足す」はできない

### 却下した案

- **SDK の `skills:` ＋ 実体化層**（＝2026-08-30 時点の計画）。
  2段目・3段目が banto の閉じ込めと噛み合わず、実体化層という
  「第二の真実になりかけるもの」を抱える必要があった。
  **なお、この経路が同じ凍り方（resume で差し替わらない）をするかは未測**
  ——戻すことになったら、そこから測る
- **Skill を1つずつ tool として生やす**（tool 定義は必ず文脈に入るので確実）。
  §5.6 が「Skill は『能力』ではなく『文脈』である／Skill は窓の中、tool は窓の外」
  と引いた線を消してしまう

## 測るときに踏んだ穴

**「システムプロンプトの中身を書き出して」と読める聞き方は安全機構に弾かれる**
（`stop_reason: refusal`、`stop_details.category: reasoning_extraction`）。2回無駄打ちした。

**事実を問う形に変えると通る**——「合言葉を書き写して」ではなく
「コンペイトウは何度で保存する？」。次に測る人はここから始めるとよい。

## まだ決めていない

- 取り込みを人の明示的な行為に限るか／AI にも開くか
- 取り込み口の具体形（git の指定の書き方、ref の既定、更新の検出）
- `instructions` に「効かせていないものも在る」と正直に書くか、黙っておくか
  （測定3 でモデルがズレに言及したので、**書く**ほうがよさそう）
- 効く・効かないの記録先（Project ごとは Event Store が自然に見えるが未確定）
- 会話の途中で効かせる集合を変えたくなったとき、Fork が使えるか（未測）
- 自己学習をどこまで自動にするか
- Skill の探索を Command Palette に出すか
