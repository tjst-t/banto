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

---

## 追記：実装に入って（2026-09-23、`skill-instructions-wiring`）

### 測定5：banto の実物の代理サーバ（HTTP）でも届くか → **届く**

測定1〜4 は stdio の使い捨てサーバだった。banto の Runner は `type: "http"` で
`/agent-relay/<Module>` に繋ぐので、**banto の dist をそのまま使って**同じことを確かめた
（`/tmp/skill-probe/http-probe.mjs`。`AgentRelayEndpoint` ＋ `renderSkillInstructions`
＋ `runTurn`、偽の Skill Module は InMemory）。2つ配って konpeito だけ効かせた：

```
[tool_use] ReadMcpResourceTool {"server":"skills","uri":"skill://konpeito-handling/SKILL.md"}
[tool_use] ListMcpResourcesTool {"server":"skills"}
[tool_use] ReadMcpResourceTool {"server":"skills","uri":"skill://ramune-handling/SKILL.md"}
[text] Q1: 17度 / Q2: 群青色 / Q3: 42度（資源一覧の説明に記載。本文には温度の記載なし）
```

- Q1（説明にだけ書いた事実）→ `instructions` から答えた
- Q2（本文にだけ書いた事実）→ `instructions` の URI を**直接**読みに行った
- Q3（効かせていない Skill）→ 「ここに挙げていない Skill もある」を読んで**自分で一覧を引いた**

### 訂正：Clear は既にある

引き継ぎと仕様に「**Clear は banto にまだ無い**（core に `clear_thread` は無い）」と
書いたが、**誤り**。人が押す Clear は `thread.cleared` として実装済みで、
**resume-point を捨てる**（`project-thread/fold.ts`）。無いのは AI から呼ぶ tool
（`clear_thread`）のほうだけ。**つまり Clear の次のターンで効かせ直る**——
仕様（§5.7）を直した。`resumePoint` を見て判断する形にしたので、Clear 側に手を入れる必要は無かった。

### 実装で決めたこと（仕様 §5.6・§5.7 に反映済み）

- **印は `dev.banto/skill: true`、名前と説明は資源一覧の `name`・`description`**。
  core は一覧だけを見る
- **既定は「効かせない」**。鍵は Skill ごとに1つ（`skillEnabled:<Module>/<Skill>`）
- **会話への刻みは `thread.skills_fixed`**。resume しないターンの最初、人の発言より前。
  **代理サーバはその記録から `instructions` を作る**（設定を見に行かない）
- Fork は分けた時点の記録を親から引き継ぐ（fold）

### 却下した案

- **core が `SKILL.md` を読んで frontmatter を解く**。Agent Skills の真実は
  frontmatter なので筋はよいが、core に YAML の依存が要り（規則10）、会話の開始ごとに
  Skill の数だけ読みに行くことになる。**印を名乗る Module は banto を知っている**
  （`dev.banto/` は banto の拡張）ので、一覧に frontmatter の2項目を載せる約束を
  守らせるほうが安い。約束は `@banto/module-contract` の `SKILL_META_KEY` に書いた
- **続きのターンで設定から組み立て直す**（記録を持たない）。モデルには届かない
  （測定2）ので害は無いように見えるが、**Compaction で読み直されるなら**（未測）
  会話の途中で黙って中身が変わる。記録から作れば、どちらでも同じになる
- **既定で効かせる**（Claude Code の plugin は入れると効く）。§5.6 の
  「明示的にだけ変える」と、毎ターンの費用が黙って増えることを重く見た

### 見つけたが直していないもの（規則7・8）

- **`npm run check:agent-sdk` が動かない。** `dist/runner/adapter.smoketest.mjs` を
  指しているが、ファイルは `src/runner/` にしか無く、中身も `runTurn` が
  AsyncGenerator になる前の形（`result.messages` を読む）。仕様 §6.5 は
  「SDK との疎通確認は `npm run check:agent-sdk` の1本に集約する」と書いているので、
  **その1本が壊れている**。tasks.json に起票した（`agent-sdk-check-broken`）

---

## 追記：残量メーターを作るときに測ったこと（2026-09-23、`skill-context-meter`）

### 測定6：`instructions` は文脈のどこに入るか → **system prompt ではなく、会話の中の添付**

メーターの Skill の行をどこから出すか決めるため、`getContextUsage()` を
`instructions` あり／なしで1回ずつ取った（`/tmp/skill-probe/usage-probe.mjs`、HTTP の代理サーバ越し）：

| | System prompt | 添付（`messageBreakdown.attachmentsByType`） | totalTokens |
|---|---|---|---|
| あり | 1,483 | `mcp_instructions_delta` 132 ＋ `total_tokens_reminder` 23 | 2,311 |
| なし | 1,483 | `total_tokens_reminder` 23 | 1,954 |

**system prompt は1トークンも変わらない。** `instructions` は **Messages の中の添付**
（会話の最初のメッセージに付く system-reminder）として入っている。

続けて **resume で2ターン**（`resume-probe.mjs`、ターン2で集合を変えた）：

```
[turn1] 不明です。案内文にあるのはコンペイトウ（17度）のみ…   attachments: mcp_instructions_delta 132
[turn2] 不明です。案内文に記載があるのはコンペイトウ（17度）だけ… attachments: mcp_instructions_delta 132
```

- **ターン2でも差し替わらない**（測定2 を HTTP 経路で再現）
- **添付はターン2の内訳にも同じ量で残る**——メーターは毎ターンこの値を読める

### 訂正：「キャッシュ境界の問題は解決しない」の根拠

上の「代償として受け入れたもの」に「`instructions` も**指示文の先頭側**に入るので」と
書いたが、**入る場所は system prompt ではなく最初のメッセージの添付だった**（測定6）。
効かせる集合を変えればその位置から先のキャッシュが切れる、という結論は変わらない
（集合は会話の始まりでしか変わらないので、実害はそもそも出にくい）。

### メーターの作り（仕様 §5.7・v4-frontend §6 に反映）

- **総量は SDK の値**（`mcp_instructions_delta`）。banto で `instructions` を載せるのは
  Skill だけなので、これを Messages から切り出して「Skill」の行にする
- **Skill ごとの内訳は按分**。core が `instructions` の中で各 Skill の行が占める文字数を返す
  （`GET /api/threads/:id/skills` の `footprint`）。割り切れない残りは「使い方の説明」
- 同じ面に「この会話で効いている Skill」（会話に刻まれた集合）を出す

**却下**：画面が `instructions` の書式を真似て文字数を数える——書式の写しが2つになる（規則3）。

### E2E（`e2e/specs/skills.spec.ts`、4本）とフル

偽 Runner に「繋いだ MCP サーバの `instructions` を受け取って `sayContext` に含める」
「添付として使用量に数える」を足した（本物の SDK の振る舞いの写し）。

1. 設定の一覧に名前・説明・配り手が出て、画面から効かせられる（件数も変わる）
2. 新しい会話で、効かせた行（名前・本文の URI・説明）が届き、本文と兄弟ファイルが読める。
   メーターに Skill の行・内訳・「この会話で効いている Skill」が出る
3. 全体で外しても**続いている会話は変わらない**。Clear の後は外れ、「1つも効かせていない」
   が届き、それでも本文は読める
4. 全体では外したまま、Project でだけ効かせられる

**最初は3が落ちた——試験の書き方の誤り。** 外した後の確認を「説明の文字列が無いこと」で
見ていたが、同じターンで本文を読ませていて、**本文の frontmatter に同じ説明が入っている**。
`instructions` の中の「効いている行」そのものを見る形に直した。

フル E2E は 114 本すべて緑（3組に分けて同期で流した：34・41・39）。

---

## 追記：取り込み口を作って（2026-09-23、`skill-import`）

### 形（仕様 §5.7 に反映）

「取り込むかどうかは人が決める。AI は提案できる」を**2段**にした：AI の `import_skill` は
取ってきて**仮置き**するまで。置き場に入るのは、人が画面で中身を見て押したときだけ。
同じ画面を Module の設定面（「Skill の置き場」）にも出し、人が GitHub・ZIP から直接
取り込めるようにした。Vault の `requestAlias` と同じ型（AI の tool はすぐ返し、画面の
ボタンが人の操作の口＝`admin` の tool を呼ぶ）。

### 踏んだ穴：画面に `structuredContent` が届かない

最初は `import_skill` の結果の `structuredContent` に中身（仮置きの内容）を載せ、画面が
それを読む形にした。**E2E で画面が「読み取れませんでした」になった。** tool の結果は
**会話の記録を通って**画面に届く（偽 Runner も本物の SDK も、モデル向けの本文に直す）
ので、`structuredContent` はその道で落ちる。

**中身を本文に載せる案は却下**——`SKILL.md` は実物で 86 KB あり（`anthropics/skills` の
`claude-api`）、AI の文脈を食う。本文には**仮置きの id だけ**を書き、画面はその id から
人の操作の口（`get_skill_import`）で中身を引く。副産物として、**押した後も結果を引ける**
ようにした（会話を読み直したとき「取り込み済み／取りやめ」と言える）。

### 本物の GitHub で測った（`/tmp/skill-probe/github-probe.mjs`、Module の dist を直接）

| | ファイル | scripts/ | 届かない記述 | 時間 |
|---|---|---|---|---|
| `anthropics/skills` の `brand-guidelines`（URL、ref=main） | 2 | 無し | 0 | 1.2 秒 |
| 同 `docx`（`owner/repo/path`、ref 省略 → commit `34040c9` に固定） | 61 | 有り | 13 行 | 3.0 秒 |

どちらも確認→取り込み→資源として配られる、まで通った。E2E は偽の GitHub
（`e2e/github-fixture.ts`）で、本物は叩かない（規則6）。

### 決めたこと・却下した案

- **git は GitHub だけ**（REST API ＋ raw）。Module は閉じ込め（files-only）で git を起動できない。
  **却下**：閉じ込めを `exec` に広げて git を使う——他人の指示文を扱う Module の権限を
  広げる理由にならない。GitLab 等は要るときに足す
- **ZIP は fflate**（MIT・依存なし）。**却下**：自分で ZIP を解く（規則12——解かれた問題）。
  宣言された大きさが嘘でも、fflate は出力を宣言の大きさで打ち切る（`out` を渡すと伸ばさない、
  コードで確認）ので、解く前に宣言の大きさで上限を見れば爆弾にならない
- **確認の画面は Module 発**（MCP Apps）。**却下**：core の画面（React）に取り込みの
  ダイアログを作る——AI の提案の画面は Module 発でしか出せないので、同じ確認が2つの
  実装になる

### 残したもの（tasks.json）

- **「元が進んでいます」の検出**（§5.7「写しは追わない。記録した commit と元を比べ、
  人に出すまで」）はまだ無い。記録（repo・path・commit）は残してあるので、比べるだけ
- 仮置きの上限（20件）は AI の繰り返し呼び出しへの備え。上限に当たったら理由を言って断る

---

## 追記：本番で「fetch failed」（2026-09-23、ユーザー報告）

「Skill の置き場」に `https://github.com/anthropics/claude-code/blob/main/plugins/frontend-design/skills/frontend-design/SKILL.md`
を貼ると、画面に `fetch failed` とだけ出た。

**測った**（犯人を先に決めない）。本番と同じ ruleset（`~/.local/share/banto/run/skills.landlock.json`）で
launcher の下から fetch させると：

```
confined:   FAIL https://api.github.com/... | fetch failed | cause: EAI_AGAIN getaddrinfo EAI_AGAIN api.github.com
unconfined: OK 200
```

`/etc/resolv.conf` → `/run/systemd/resolve/stub-resolv.conf`（systemd-resolved）。Landlock は
**シンボリックリンクを辿った先**で判定するので、`/etc` を許しても名前が引けない。
ruleset にその1ファイル（`read_file`）だけを足すと 200 になった。

**閉じ込めた Module 全部に掛かる穴だった**——Shell の `git fetch`・`curl`、registry から入れた
Module も同じ。直すのは ruleset を組むところ（`@banto/landlock` の `derive.ts`）：
名前解決のファイルの実体が `/etc` の外なら、**そのファイルだけ**読めるようにする
（`/run` のディレクトリは開けない）。仕様（v4-security）に足した。

**2つ目の穴：理由が画面に出なかった。** Node の fetch は失敗を `fetch failed` にまとめ、本当の
理由を `cause` に隠す。skills Module はそれをそのまま返していた——画面から直す先が読めない
（規則2）。いまは「api.github.com に繋がりません（EAI_AGAIN）」と言う。

**E2E で捕まらなかった理由**：偽の GitHub は 127.0.0.1 に立っていて、名前解決が起きない。
名前解決を E2E で起こすには外の DNS が要る（規則6 に反する）ので、ruleset の単体試験で見る
（この機械の `/etc/resolv.conf` はシンボリックリンクなので、試験は空振りしない——導出結果に
`/run/systemd/resolve/stub-resolv.conf` が入ることを確かめた）。

直したあと、本番でユーザーの URL そのものを「中身を見る」まで通した（commit `56f3653`、
1ファイル）。取り込みは押さずに取りやめた。
