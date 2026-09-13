# AI に渡している面が手薄だった（2026-09-12）

ユーザー指摘「AI からの Tool があまりに手薄すぎないか」から。決まったことは
`docs/specs/v4-architecture.md` §2.3・`v4-modules.md` §2.1 に書いた。
ここには**測った数字**と**なぜそう直したか**を残す。

## まず測った

banto と同じ設定で SDK の init メッセージ（＝実際に有効な tool の一覧）を取った。

| 設定 | 組み込み tool |
|---|---|
| banto（`tools: ["WebSearch","WebFetch"]`） | **2つ**（WebFetch・WebSearch） |
| `preset: claude_code` | 29（Task・Skill・Read/Write/Edit・Bash・ToolSearch・**ListMcpResourcesTool**・**ReadMcpResourceTool**・**ReadMcpResourceDirTool** …） |

**実 Vault を繋いだ状態で比べたのが決定打**：preset には resource を読む3つが
出るのに、banto の設定では出ない。

## 見つかった穴——AI は resource を1つも読めなかった

SDK の `tools` は**基底集合の置き換え**（追加ではない）。`WebSearch`/`WebFetch`
だけを書いていたので、**`ListMcpResourcesTool` / `ReadMcpResourceTool` /
`ReadMcpResourceDirTool` も一緒に落ちていた**。

仕様（アーキ §2.5・modules §2.1）はこう決めている：

> Runner（Claude Code の実行系）は resource を直接読まず、組み込み tool
> （`ListMcpResourcesTool`/`ReadMcpResourceTool`）経由で `resources/list`/
> `resources/read` を呼ぶ——banto が同種の tool を自作する必要はない。

**その前提が実装で成立していなかった**（規則8）。結果：

- `vault://aliases`・`vault://aliases/{name}`（§2.1 A節の全部）が**不達**
- FileSystem の `Project file` 資源も同じく不達
- **同じ日に「`vault://aliases` を `resources/list` に載せた」と報告したが、
  それだけでは A 節は届かない**——一覧に載せても、一覧を呼ぶ手段が無かった。
  訂正して記録に残す

**なぜ気づかれなかったか**：壊れ方が静かだった。AI は resource を読まなくても
会話を続けられるので、「読まなかった」のか「読めなかった」のか画面から
区別がつかない。**E2E も tool の一覧しか見ていなかった**（`vault-visibility`）。

### 直し方——組み込みを戻す。迂回路にはならない

`RUNNER_BUILTIN_TOOLS` に3つ足した。**閉じ込めの迂回路にはならない**：
Runner は実 Module に直接繋がらず、host の代理サーバ越しにしか読めない。
代理サーバは `resources/read` のハンドラの中でも可視性を見て fail closed で
拒む（`relay/visibility.ts`、2026-09-02 の poc/06 で実証済み）。

Bash / Read / Write / Edit を落としたままにするのは今までどおり
（Landlock で絞った Shell・FileSystem を素通りさせない、決定・2026-09-04）。

**見張りを2つ置いた**：
- 単体——`RUNNER_BUILTIN_TOOLS` に resource の3つが**在る**こと、
  Bash/Read/Write/Edit/Task/Skill が**無い**こと（両方向を見る）
- E2E——**本物のターンで AI に `vault://aliases` を読ませ**、alias 名が
  返答に出て、値は出ないことを見る。**組み込みを元に戻すとこの E2E が落ちる**
  ことを確認した（規則1）

## AI が Vault の使い方を分かっていなかった

道具はあるのに、**使い方がどこにも書かれていなかった**。

- Shell の `runCommand` は `envSecrets: { type: "object" }` としか書いておらず、
  「何を鍵にして何を値にするのか」も「値ではなく alias 名を書く」ことも
  伝わりようがなかった
- Vault の `requestAlias` の説明は「このaliasが要るが無い、という判断待ちを
  起こす」だけで、**一覧の在りかも、使うときの渡し方も無い**

**置き場は tool と resource の description**（決定・2026-09-12）。system prompt は
個々の tool を語らないと決めてある（アーキ §2.3、規則3——写しを持てばいつか
食い違う）ので、**伝わる場所はそこしかない**。3箇所に同じ道筋を書いた：

1. `vault://aliases` の description——「名前だけの一覧。使うときは Shell の
   envSecrets / secretFiles / sshIdentity に渡す」
2. `requestAlias` の description——「まず `vault://aliases` を見て、無いときだけ呼ぶ。
   値は受け取らない」
3. `runCommand` の description と**各引数**——`{"GITHUB_TOKEN": "github-token"}`
   の形、値ではなく alias 名、結果には出ない、既定 120 秒、`secretFiles` は
   終わったら消える

却下した案：**system prompt に Vault の節を足す。** 上の決定に反するうえ、
Module を外したときに嘘が残る。

## 秘密を Vault の中で作れるようにした

`generateSecret`（admin 可視性）。暗号論的乱数から作り、**値を返さない**
——人も画面も受け渡しの経路も、一度も値を見ない。VaultUI の新規登録に
「自分で入力する／Vault の中でランダムに作る」を足した。

- `format` の既定は **`base64url`**——`A-Za-z0-9_-` だけなので、シェルの引用符・
  URL・環境変数のどこに入れても壊れない。強さは `bytes` が決めるので、
  見た目の選択は「入れ先で壊れないか」だけの話になる
- `bytes` は 16〜256（既定 32）。**弱い長さを黙って受けない**（規則2）
- SSH 鍵は対象外——`generateKeypair` の仕事。**画面でも「作らせる」を選んだら
  種別を選べなくする**（選べるふりをしない、規則13）

**可視性を `admin` にした理由**：仕様 §2.1 A は「AI 向けは『存在を知る』
『無ければ人に頼む』だけに絞る」と決めている。`generateSecret` は値を返さないので
D3 は破らないが、**A を広げるのは別の決定**なので、ここでは広げなかった。
`admin` は AI に見えないだけで、**他 Module からは host 中継経由で呼べる**（§2.1 C）
ので、将来 Repo や Environment が使う道は既に開いている。
**AI にも呼ばせたくなったら、可視性を1行変えるだけ**——そのときは §2.1 A を
決め直してから変える。

## `requestAlias` を「会話の中の入力欄」にした（ユーザー提案）

実物を見た指摘から。AI が `requestAlias` を呼ぶと、こういうカードが出ていた：

> vault があなたの判断を待っています／Vaultに alias "test_secret" が無いため、
> 登録が要ります（…）。設定画面の Vault から登録してください。
> **この問いはまだ banto に繋がっていません**——ここで答えても元の処理には届かず、
> 呼び出し側のタイムアウトを待つことになります。

2つ悪いことが起きていた：

1. **人を会話の外へ追い出していた。** 秘密が要ると分かったその場で入れられず、
   設定画面まで歩かされる
2. **本当に繋がっていなかった。** banto は Elicitation の応答を解決しない設計
   （アーキ仕様 §2.4.1 の帰結1、`runner/adapter.ts` の
   `onElicitation: … return new Promise(() => {})`）なので、**人が答えても
   Module には届かない**。呼び出し側は既定 60 秒のタイムアウトを待つだけ。
   画面はそれを正直に出していた——**正直だが、動いてはいなかった**

**直し方：`requestAlias` に `_meta.ui.resourceUri` を付けて、会話の中に
入力欄（inline の MCP App）を出す。** 新しい機構は作っていない——§6.2 の
4形態のうち「会話の中」は既に動いていて、FileSystem の `listDirectory` が
同じ形を使っている。`ui.resourceUri` は **MCP Apps 自身の印**なので、
代理サーバ（`dev.banto/*` だけを剥がす）を通っても落ちない。

- 人が打った値は **iframe → host の画面 API → Vault 自身の `admin` tool** と
  渡る。**Runner はこの経路に登場しない**ので、A の原則（AI は値を見ない）は
  そのまま
- **自分の Module を呼ぶだけ**なので中継も承認も要らない（決定・2026-09-07）
- `requestAlias` は**すぐ返る**——人を待って呼び出しを止めない。60秒の壁が消える
- 画面には「自分で入力する／Vault の中でランダムに作る」の両方を出した
  （`generateSecret` がそのまま使える）。**SSH 鍵のときは「作る」を選べなくする**
  ——鍵ペアは `generateKeypair` の仕事で、ここでは作れない（規則13）

**実ブラウザで端から端まで見た**（規則14）：AI が `requestAlias` を呼ぶ →
会話に入力欄が出る → 人が打つ → **実 Vault に入る** → 値はページのどこにも
出ない → その後 AI は `vault://aliases` で**名前だけ**見つけられる。

**波及する知見**：この「答えても届かない」は Vault だけの話ではなく、
**Elicitation を使う全ての Module に掛かる**。人の入力が要る場面は
「会話の中の画面」を使う、と仕様に書いた（`v4-modules.md` §2.1 A）。

## 「作る」の入口を1本にした（ユーザー指摘）

上で `generateSecret` を足したあと、「`generateKeypair` はどこで使われるの？
admin からも AI からも使われないとすると、謎」という指摘を受けて数えた。

**呼び出し元はゼロだった。**

| tool | 可視性 | 呼び出し元 |
|---|---|---|
| `resolveAlias` | module | Shell（`run-command.ts`） |
| `startSshAgent` | module | Shell（同上） |
| **`generateKeypair`** | module | **どこにも無い** |
| **`verify`** | module | **どこにも無い** |

仕様は `generateKeypair` を「Repo が新しい identity をセットアップするとき」の
ための口としていたが、**Repo は Phase 2 で未実装**。つまり呼び出し元より先に
書かれた口で、本番の経路（host 中継・承認ゲート）を一度も通っていなかった。

**指摘の通り、これは「別の tool」である必要が無かった。**「秘密を作る」という
同じ行為なのに入口が2本に割れていて、しかも片方（SSH）は `module` 可視性
だったので、**人の画面からは一生届かない**。`generateSecret` の `kind` にすれば、
さっき作ったばかりの「ランダムに作る」の導線にそのまま乗る（規則3）。

統合して分かった、**欠けていたもの**：

- **公開鍵を取り出す道が無かった。** SSH 鍵は公開鍵を GitHub 等に登録しないと
  使えないのに、`generateKeypair` は `module` 可視性で人には届かず、
  **作れても使えない**状態だった。統合にあわせて、画面（会話の中の入力欄・
  横断管理の両方）に**公開鍵の表示とコピー**を付けた。公開鍵は秘密ではない
  ——むしろ出さないと成立しない
- これで「**AI が SSH 身元を要求 → 人が会話の中で『作る』を押す → 公開鍵が出る
  → GitHub に貼る**」という流れが、初めて端から端まで繋がった

**気をつけたこと**：

- **backend の抽象を壊さない。** `generateSecret(kind: "ssh-identity")` は
  `VaultBackend.generateKeypair` を呼び、返るのは**公開鍵と不透明な参照**だけ。
  「秘密鍵をもらって自分で置く」形にすると、秘密鍵が backend の外に出ない実装
  （HSM・外部 Vault）が使えなくなる。**D節のインターフェースはそのまま残す**
- **`format`/`bytes` を SSH に渡したら拒否する。** 鍵の強さは鍵の種類が決めるので、
  渡されたものを黙って捨てない（規則2）
- **`kind: "file"` は作らせない。** ファイルの中身をランダムに作ることに意味が無い
  ——画面でも選択肢から消す（選べるふりをしない、規則13）
- **Repo が使えなくなるわけではない。** `admin` の tool は host 中継経由で他 Module
  から呼べる（§2.1 C）。Repo を書くときはこれを呼ぶ

**`verify` は残した。** こちらも呼び出し元ゼロだが、`generateSecret` のように
既存の導線へ畳む先が無い（「署名を検証する」は人の管理操作ではない）。
実際に Webhook を受ける Module を書くときに、署名の形（GitHub は `sha256=` 接頭辞、
Stripe はタイムスタンプ込み）が分かってから作り直す公算が高い——**いまの HMAC
決め打ちが「検証はできる」という誤解を作る**リスクは記録として残す。

## まだ手薄なまま（記録）

「手薄」のうち、**Module で埋める設計なのにまだ Module が無いもの**は手を付けて
いない。ここは道具が落ちているのではなく、作っていない：

- **Task（subagent）** — 仕様 §2 の Subagent Module が未実装
- **Skill** — §5.7 の `skills` 役割が未実装
- **中身の検索（Grep 相当）** — FileSystem は `searchFiles`（**名前だけ**）。
  中身を探すには Shell の `runCommand` で grep するしかない
- **部分読み** — `readFile` は `path` のみ。offset/limit が無く、大きいファイルは
  丸ごと文脈に載る
- **長いコマンドの背景実行・出力の追跡** — `runCommand` は同期1回きり
