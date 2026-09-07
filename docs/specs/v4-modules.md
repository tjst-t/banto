# v4 Module 一覧

> **これは仕様である。** 決まったことだけを書き、決まったら**この文書を更新する**。
> 検討の経緯は `docs/notes/` に残す。
>
> 全体の構造は `docs/specs/v4-architecture.md`（以下「アーキ仕様」）。
> **この文書はその §5（Module と Skill の契約）の下にぶら下がる。**
>
> 最終更新：2026-09-02

## 0. どこに置くかの判定

「これは Module か」を毎回議論しないために、判定を先に置く。**4通りに割れる。**

| 分類 | 判定 | 理由 |
|---|---|---|
| **core の状態に触る** | **core の MCP のインターフェース** | Module にすると「Module は完全に独立したコード」（アーキ仕様 §1）が崩れる。**Module が Event Store の実体を持ち、MCP を通さず直接読み書きする**形になり、MCP で区切った意味が消える |
| **banto が境界を課す** | **Module** | 境界を Module の中に閉じ込められる |
| **ベンダが提供する能力** | **組み込みのまま** | 再実装すると劣化する。縛る境界もない |
| **観測** | **banto の外** | 規則4——観測は観測される機構の外側。**Module でも core でも banto の中**なので、banto が止まれば観測も止まる |

**`WebSearch` / `WebFetch` が3番目**である。Web 全体が相手なので banto が課す境界が
無く、実行はベンダ側で行われる。**要件にも記録がある**——「**新しいモジュールは
作らない方針**。Claude Agent SDK の組み込み `WebSearch`/`WebFetch` を、必要な
Project・会話で `allowedTools` に足すだけで済むはず」。

**`fs` / `shell` との違いはここ**：こちらには **Project の根**という境界がある。
組み込みの `Read`/`Write`/`Bash` は banto の境界を知らない。**作業範囲の根が
cwd に落ち、試験を走らせただけで本物のリモートに `git push` が到達した**という
事故が実際にある（アーキ仕様 §9）。**だから `fs`/`shell` は Module にする理由がある。**

### 0.1 判定の実例——RAG は Module にできるか

**「できる。ただし2つの形があり、片方だけ。」** 判定の使い方の例として置く。

| 形 | 判定 |
|---|---|
| **(a) 探す道具として**——AI が「これを探して」と呼び、結果が返る | **Module でよい。** core の状態に触らない。索引を持つなら Project の根という境界も課せる |
| **(b) 毎ターン、関連しそうなものを自動で文脈に差し込む** | **Module にできない。** 文脈に何を入れるかは core の仕事（アーキ仕様 §2.5(a)） |

**(b) はキャッシュ規律と正面からぶつかる**（アーキ仕様 §3）。毎ターン中身が
変われば**前方一致が毎回途切れる**——実測で **98.5% がキャッシュ読み**だったものが
崩れる。

**そして banto は「必要なときだけ文脈に入れる」の答えを既に持っている**
——**Skill の progressive disclosure**（名前と説明だけ常時、本体は合致したときだけ。
アーキ仕様 §5.6）。**(b) を足すと3つ目の答えになり、しかもキャッシュを壊す。**

> **`Memory` は RAG ではない**（アーキ仕様 §2.2 に明記）。Memory は
> 「この Project の決まったこと」で**常に全部入る**もの。
> **RAG Module は、それとは別に置ける。**

**(a) には副産物がある**——MCP の資源とテンプレート補完に乗せれば
（`resources/templates/list` ＋ `completion/complete`）、**Command Palette から
そのまま引ける**（`docs/specs/v4-frontend.md` §6.3）。**検索のインターフェースを banto 側に作らずに済む。**

## 1. core の MCP のインターフェース（Module ではない）

**core の状態を触るので Module にできない。** ただし AI から使うにはインターフェースが要るので、
**core が直接 MCP のインターフェースを持つ**。AI から見れば Module の tool と区別が付かない。

> **`Memory` を Module にしない。** Memory は Project が持つもの（アーキ仕様 §2.2）で、
> **Thread の定義の一部**である。薄い Module にすると、その Module が core の状態を
> 直接触ることになり、**§0 の1行目が禁じている形になる**。
> ——ただし**この判断は未確定**（§5-1）。

### 1.1 tool 一覧

**名前は仮**（`A-Za-z0-9_-.`・1〜128字、アーキ仕様 §5.2 のとおり banto が採番した
接頭辞が付く）。**「決」＝この文書で決まった／「未」＝形がまだ無い。**

#### Memory（アーキ仕様 §2.2）

| tool | 何をするか | |
|---|---|---|
| `read_memory` | この Project の Memory を読む | 決 |
| `append_memory` | Memory に書き足す | 決 |
| （書き換え・削除） | — | ~~未決~~ → **決定（アーキ仕様 §2.2、2026-08-30、item 3）。** 物理的な書き換え・削除はしない——**訂正は無効化イベントの追記**（規則3）。したがって書き換え/削除 tool は作らない。**訂正が要るときは `append_memory` で無効化イベントを積む形にする**——別 tool は増やさない、決 |

#### 判断待ち（アーキ仕様 §2.4）

| tool | 何をするか | |
|---|---|---|
| `ask` | 人に問いを立てる。**引数は Elicitation の形をそのまま使う**（`mode`：`form` \| `url`、`message`、`requestedSchema` または `url`） | 決 |
| （答えを受け取る側） | — | ~~未決~~ → **決定（アーキ仕様 §2.4、2026-08-30、item 13）。** 同期なら Elicitation の仕組みでそのまま返る。**「後で答える」は tool を作らない**——`requestState` を Event Store に持ち、その場の呼び出し自体はタイムアウトに委ね、人の回答は**次のターンへの新しい入力**として渡る。答えを受け取る専用 tool という概念自体が無くなった、決 |

#### Project / Thread の操作（アーキ仕様 §2.2・§4.2）

| tool | 何をするか | |
|---|---|---|
| `list_threads` | 宛先の一覧。**id・題・状態だけ。中身は読まない**（アーキ仕様 §4.2） | 決 |
| `send_message` | 別の Thread へメッセージを送る | 決 |
| `fork_thread` | Fork Thread を立てる | 決 |
| （会話を畳む） | 同じ Thread のまま、いまの会話をリセットする | ~~呼び名が未決~~ → **決定（モック、2026-09-02、`mock/README.md`「Project / Thread のライフサイクル操作」）。** Claude Code 自身のコマンド名に統一——**Clear**（履歴を消す）／**Compaction**（圧縮）。tool 名は仮に `clear_thread`／`compact_thread` とする、決 |
| `list_modules` | この Project に繋がっている Module を見る | 決 |
| `list_skills` | この Project で効いている Skill を見る | 決 |
| （Module を足す・外す） | — | ~~AI に開くかが未決~~ → **決定（アーキ仕様 §2.10、2026-09-01、item 20）。** Yes、tool として露出してよい。通常の tool 呼び出しと同じ承認ゲートを通る。新しい承認 UI は要らない、決 |
| （Skill を効かせる・外す） | — | **未**——「Module を足す・外す」と同型の判断だが、Skill について明示的に決めていない（アーキ仕様 §5.7） |

> **見るインターフェースと変えるインターフェースを分けてある。** 一覧は AI が自分の状況を知るために要るので
> 開く。**変える側はキャッシュ境界を切る**（アーキ仕様 §3）ので、AI に開くかは
> 別の判断になる。

#### Canvas（`docs/specs/v4-frontend.md` §6.2・§6.5）

| tool | 何をするか | |
|---|---|---|
| `show` | 資源を指して、人の画面に出す | 決 |
| （A2UI を出す） | AI がその場で UI を作る | **未**——**core のインターフェースにするか Module にするかが未決**（アーキ仕様 §10 item 22。旧「§10-19」は番号の誤り——item 19 は無関係な項目（役割の有効/無効切替の安全性）を指していた） |

### 1.2 この一覧の使いかた

- **ここに無いインターフェースは、まだ存在しない。** 「未」の行は**形が決まっていない**ことを
  示していて、実装で埋める余白ではない
- **AI に見せる tool の選別は別の判断**（アーキ仕様 §10）。この一覧は「core が
  持つインターフェース」であって「毎回モデルに見せるインターフェース」ではない
- tool の並び順は**決定的に保つ**（アーキ仕様 §3——順序が揺れるとプロンプト
  キャッシュのヒット率が落ちる）

## 2. 必ず作る Module

**これが無いと banto が成り立たない。** これは「いずれ必要」という最終形の話で、
**Phase 0/1 で作る順番とは別**——`docs/requirements.md` C5・CLAUDE.md の
「Phase 0/1 でモジュールを増やさない」のとおり、Phase 0/1 で実際に書くのは
**Vault・Shell・ファイルの3つ**に絞る（2026-09-02、Repo と入れ替え。
`docs/notes/2026-09-02-implementation-readiness-review.md`）。Shell の
`envSecrets`/`secretFiles`/`sshIdentity`（§2.3）は Vault 無しには実装できず、
**Vault を Phase 3 に残したまま Shell だけを Phase 1 に置くことができない**
と分かったため。Repo（複数リポジトリ管理・GitHub 身元の割り当て）は無くても
Factory 1本の体験は検証できるので、Phase 3 以降に回す。

| Module | 何をするか | 備考 |
|---|---|---|
| **Subagent** | サブエージェントに仕事を頼む | アーキ仕様 §4.1 のとおり**薄い層**——「どの backend で走らせるか選ぶ」だけ。会話を走らせるのは core |
| **Skill** | Skill を取り込む・作る・配る | アーキ仕様 §5.7。`skills` は**役割**なので、複数の Module が名乗ってよい。これはそのうちの1実装 |
| **FileSystem** | ファイルを読む・書く | **Project の根の外へ出さない**（§3）。tool/resource の具体形は §2.2 |
| **Shell** | コマンドを実行する | **FileSystem と同じ境界だが、強制できる層が違う**（§3）。**Environment とは別実装**（下記） |
| **Vault** | 鍵・トークンを預かる | **必須に格上げ**（決定・2026-09-01、アーキ仕様 §2.8）——複数資格情報の使い分けが中核機能である以上、無いインストールは成立しない。**Phase 0/1 に格上げ**（決定・2026-09-02、上記）——Shell が依存するため。**複数バックエンド可**（`vault` を役割として、複数の実装が名乗る形、アーキ仕様 §2.5）。**banto はローカルの組み込みバックエンドを同梱**し、追加インストール無しに動く。実行は他バックエンド同様 **core とは別プロセス**（`docs/requirements.md` C8b：鍵を持つものは subprocess）。他バックエンドを足したときの**移行操作は人専用**（AI には露出しない） |

### 2.1 Vault のインターフェース（決定・2026-09-02）

**実装構造は単一 Module 方式**——SOPS 実装・HashiCorp Vault 実装・OS キーチェーン
実装は、それぞれ独立して `vault` 役割の全 tool／resource を実装する（アーキ仕様
§2.5 のとおり）。共通ロジック（alias 管理・Elicitation 文言・Event Store への
記録・下記 A/B/C の配線）は npm ライブラリ（例 `@banto/vault-kit`）で共有し、
Module 間の MCP 契約にはしない——**Module を分けるとエンジン↔バックエンド間の
中継が1ホップ増え、汎用シークレットの値がエンジンのプロセスメモリを余分に
経由することになり、「秘密鍵は Vault のプロセスから一度も出ない」（D5）という
保証が弱まる**ため。

#### 可視性（`agent` / `module` / `admin`）の実現方法（決定・2026-09-02）

下記 A〜C で使う3段の可視性は、**新しいマニフェストを作らず、アーキ仕様 §5.4
で決めた `_meta` の banto 拡張キーにそのまま乗せる**——tool の `_meta` に
`{バントの逆DNS接頭辞}/visibility: "agent" | "module" | "admin"` を持たせるだけ。
banto host はこの値を見て、Runner に渡す tool 一覧（`agent` のみ）と、
host 中継が取り次ぐ tool（`module`・`admin`）を分ける。**新しい仕組みではなく、
既存の `_meta` 拡張の使い先が1つ増えるだけ**（role 宣言・設定 Canvas の印と同じ形）。

**既定値（決定・2026-09-03）**：`visibility` を書かない tool/resource の
既定は `agent`。第三者 Module の多くは banto 独自のこのキーを持たないので、
既定を `agent` にしないと何も動かなくなる。**ただし `handlesSecrets: true`
を宣言した Module（アーキ仕様 §5.1）は例外**——**その Module が持つ全ての
tool・resource に明示的な `visibility` が無い限り、mount 自体を拒否する**。
秘密を扱うと自己申告した Module が、うっかり `visibility` を書き忘れた
1つの tool から秘密を漏らす、という事故を構造的に防ぐ（宣言漏れが
「気づかれない既定」ではなく「起動できない」という目に見える形で出る、
規則2）。

**実現方法は「フィルタで隠す」ではなく「代理サーバに最初から登録しない」**
（決定・2026-09-02、`poc/05-module-relay-topology/` で実証。アーキ仕様 §2.5
「Runner は実 Module に直接繋がない」）。Runner は実 Module に直接 spawn ・
接続せず、host が実 Module への接続を1本だけ持ち、Runner には host が
低レベル `Server`（`@modelcontextprotocol/sdk`）で作った代理サーバを見せる。
代理サーバには `agent` 可視性の tool・resource だけを登録するので、
`module`/`admin` 可視性の tool は Runner の tool 一覧に**そもそも存在しない**
——v3 で見つかった「見せない設定でも見えたまま」（アーキ仕様 §9）という
壊れ方は `allowedTools` のようなフィルタ経路の話で、この代理サーバ方式には
当てはまらないことを実測で確認した。

**resource（`vault://aliases`）も同じ代理サーバで見せられる**（決定・
2026-09-02、`poc/06-resource-prompt-relay/`。当初 `createSdkMcpServer` は
tool しか受け付けないため resource を代理できないと判明していたが、代理
サーバを低レベル `Server` で組み直すことで解決した）。Runner（Claude Code の
実行系）は resource を直接読まず、組み込み tool
（`ListMcpResourcesTool`/`ReadMcpResourceTool`）経由で `resources/list`/
`resources/read` を呼ぶ——banto が同種の tool を自作する必要はない。

**ただし resource には tool と違う非対称がある。** tool は「代理サーバに
登録しない＝存在しない」で守れるが、**resource は `resources/read` で URI を
直接指定されると、`resources/list` に載せていなくても読めてしまう**（実測で
確認）。**`admin` 可視性の resource（Vault にはまだ無いが、将来足す場合の
注意点として記録）は、`resources/read` ハンドラの中でも可視性を判定する
必要がある**——一覧から外すだけでは D3 を守れない。また `canUseTool`
（承認ゲート）は resource 読み取りには掛からないため、resource の統制は
代理サーバの中で完結させる。prompt は Runner に届かないと実測で判明した
ため、Vault では対象外（人が使う操作は Elicitation・GUI 側で足りる）。

**この区分は banto host による自主的な尊重であって、暗号的な強制ではない**
——他の MCP ホストが `_meta` の意味を知らずに `module`/`admin` の tool も
そのまま AI に晒す可能性は残る。**Module は他の MCP ホストでもそのまま動く**
という独立性（アーキ仕様 §1）の代償として、この境界は「banto という行儀のよい
host が守る」ところまでしか保証できない。同じ限界は §2.5 の Module 間中継
（「core に先に聞く」という行儀のよい Module の前提に乗る）にも既にあり、
新しい種類の弱さではない。**Vault を他ホストに繋ぐ場合の注意点として、
Vault 自身のドキュメントに明記する**（実装時のTODO）。

#### A. Agent（Runner）に直接見せるインターフェース——読み取り専用に絞る

D3「鍵そのものが AI の文脈に出ない」を守るいちばん単純な方法は、**値を返す
tool を AI には一切見せない**こと。AI 向けは「存在を知る」「無ければ人に頼む」
だけに絞る。

| 種別 | 名前 | 内容 |
|---|---|---|
| resource | `vault://aliases` | alias 一覧。**値は含まない**——`name` / `kind`（`secret`\|`ssh-identity`\|`file`）/ `scope`（`instance`\|`project`）/ `note`（自由記述、任意）/ `lastUsedAt` / `expiresAt`（あれば） |
| resource | `vault://aliases/{name}` | 単一 alias のメタデータ（同上、詳細版） |
| tool | `requestAlias({name, hint, kind})` | **値を渡さない。** 「このaliasが要るが無い」という判断待ちを起こす（受信箱／Elicitation経由で人に、設定 Canvas から追加してもらうよう頼む） |

#### B. 他 Module（Repo・Shell 等）に対して——host 中継経由でのみ呼べる、`module` 限定

| tool | 引数→戻り値 | 用途 |
|---|---|---|
| `resolveAlias({name})` | → 値（文字列 or バイト列）。**静的保存か動的発行かは Vault 内部の実装詳細**——呼び出し側はどちらでも同じ形で受け取る | 汎用シークレット注入（Shell の alias 方式、アーキ仕様 §2.5）、ファイル内容、動的短命トークン |
| `startSshAgent({identity})` | → `{socketPath}` のみ。**秘密鍵は返さない** | ssh-agent 経由の git 認証（D5）。**旧名 `hostSshAgent` から改名**（2026-09-02）——「host」はアーキ仕様で core の配線・解決層を指す予約語（§2.5）であり、ここで別の意味（ssh-agentプロセスを起動する）に使うのは規則11（一般的な用語を使う）に反する紛らわしさがあった |
| `generateKeypair({identity, kind: "ssh"\|"gpg"})` | → 公開鍵のみ。秘密鍵は Vault 内部に留まる | Repo が新しい identity をセットアップするとき（D5） |
| `verify({alias, payload, signature})` | → true/false のみ。値は一切返さない | Webhook 署名検証など、値そのものが要らない検証 |

いずれもアーキ仕様 §2.5 の中継の規律がそのままかかる：呼び出し元の依存宣言で
許可確認 → 初回のみ承認ゲート → 以降 Project 内で自動許可 → Event Store には
メタデータ（呼び出し元・宛先・tool 名・**alias 名などの識別子**・成否・時刻）
だけ記録し、**値そのものは記録しない**（alias 名は「どの秘密が」を示す識別子で
あって秘密の値ではないので、記録してもD3を破らない——むしろ記録しないと
「どのaliasが使われたか」が一切追えなくなる）。

**承認キャッシュの粒度は「呼び出し元・宛先・tool 名」までで、alias 名は含まない**
——Shell→Vault の `resolveAlias` を一度承認すれば、以降どの alias でも
再承認なしに解決される。**これは意図した設計**：個々の呼び出しに対する
実質的な防波堤は、Shell 側の承認ゲート（コマンド文字列＋使う alias の一覧を
人に見せる、アーキ仕様 §2.5「alias 方式」）であり、Module 間中継の承認は
「この Module 同士がこの tool で話してよいか」という一段粗い、初回だけの確認
にとどめる——alias 単位まで中継側で確認すると、Shell 側のゲートと二重になる。

#### C. 管理操作——人専用だが、他 Module からも呼べる `admin` 限定（決定・2026-09-02）

alias の新規登録・値の入力・編集・削除／鍵ペアの import／`note` の記入／
scope（instance⇔project）の割り当て／バックエンド間の移行／alias 使用履歴の
閲覧。

**使用履歴の出所は2つあり、混同しない**——(1) 「いつ最後に使われたか」
（`lastUsedAt`）は Vault 自身が A節の alias メタデータとして持つ（値を
持つ場所と同じ Vault 内部の管理下）。(2) 「どの Module がいつ resolveAlias を
呼んだか」という Module 間呼び出しの履歴は、host 中継が Event Store に記録する
メタデータ（呼び出し元・alias 名・成否・時刻、B節末尾）から追える。**どちらも
Event Store の「メタデータ射影」ではない**——(1) は Vault 内部の状態、(2) が
Event Store 由来。C 節の管理画面は両方を並べて見せてよい。

**「AI に見せない」と「他 Module から呼べない」は別軸。** 当初はこれらを
「各 backend 自身の `ui://<id>/config` の中に閉じた話」としていたが、
**Vault の管理だけをまとめて行う別 Module（例：VaultUI。§2.5 の「role→実装の
一覧を依存する Module に渡す」を、1つ選ぶのではなく全部横断して使う側）を
作りたい**という要望が出て、それには対応できない設計だった。

- **これらの操作も B と同じ形で MCP tool として公開する**（`createAlias` /
  `updateAlias` / `deleteAlias` / `migrateTo` / `listGroups` / `createGroup`
  等）。ただし**可視性は `admin`**——AI（Runner）には出さない（A の原則は
  そのまま）が、host 中継を経由して他 Module からは呼べる
- **各 backend 自身の `ui://<id>/config` は残す。** Module は他の MCP ホストでも
  単体で動く必要がある（アーキ仕様 §1）ので、VaultUI が無い環境でも
  backend 単体の画面から同じ操作ができなければならない。**`ui://<id>/config`
  自身も、この `admin` tool を呼ぶだけの薄い実装でよい**（自分の tool を
  自分の GUI から使う、という形で C8a と整合する）
- **新規登録時に人が入力する値は、VaultUI の画面から host 中継（一過性、
  記録はメタデータのみ）を経由して backend へ渡る。** これは B で決めた
  中継の規律（許可確認・Event Store にはメタデータのみ）と D3（AI の文脈に
  出ない）のどちらも壊さない——人が人の画面に打ち込んで、人の管理下にある
  別 Module へ渡るだけだから

  > **VaultUI の `isolation` は `in-process` のままでよいか（決定・
  > 2026-09-02）**：**よい。** この一過性の値は、**VaultUI の Canvas（ブラウザの
  > iframe、常に sandboxed）から直接、host 中継経由で Vault backend の
  > `admin` tool を呼ぶ**——**VaultUI 自身の Module バックエンド（`isolation`
  > が指すプロセス境界）は、この経路に一切登場しない**。要件 C8c
  > 「秘匿情報を**扱う**モジュールは `in-process` を拒否される」の「扱う」は
  > **Module 自身のバックエンドコードが、平文の値を変数・引数として一度でも
  > 受け取ること**と定義する（決定）——値の**発生源**が Module の Canvas
  > であることや、値がその Module を**経由地**として通過することは含まない。
  > VaultUI のバックエンドはこの定義に当てはまらないので `in-process` のままでよい。
  >
  > **機械で押さえる部分**（要件C8c「判定できる分は機械で押さえる」）：
  > `_meta["dev.banto/module"]` に **`handlesSecrets: boolean`**（自己申告、
  > 既定 `false`）を足す。**`handlesSecrets: true` かつ `isolation: "in-process"`
  > の組み合わせは起動を拒否する**（§5.1 の静的宣言／動的自己申告の突き合わせと
  > 同じ経路でチェックする）。Vault backend 自身（`resolveAlias`/`createAlias`
  > 等で平文を扱う）は `handlesSecrets: true`・`isolation: "subprocess"`。
  > VaultUI は `handlesSecrets: false`（Canvas が発生源で、バックエンドは
  > 経由しないため）
- **VaultUI 自体の画面構成（一覧の見せ方等）はここでは決めない。** モックで
  作るときに詰める（§10 相当の未決事項）
- **`migrateTo` の具体形（実行主体・失敗時の部分移行の扱い）は未設計。**
  「人専用」という制約以外は決めていない——モックで VaultUI の画面を作る
  ときに、この操作の呼び出し元・進捗表示・失敗時のロールバックを合わせて
  詰める（下記 §5 item 7 に追記）
- **`admin` tool への承認ゲートは、VaultUI 経由の呼び出しでは循環しうる**
  ——人が VaultUI の画面上で操作した結果を、Module 間中継の初回承認ゲートで
  もう一度確認させるのは冗長な UX になりうる。**`agent`/`module` 可視性の
  承認ゲート運用（アーキ仕様 §2.5）を `admin` 可視性にそのまま適用してよいかは
  未決**——VaultUI 設計時に合わせて詰める

#### Project ↔ backend グループの紐付け（複数ホスト共有、決定・2026-09-02）

**複数台のホストで動く banto インストールが、同じ backend（同じ HashiCorp Vault
サーバ・同じ Infisical アカウント等）を共有できるようにする**ための決定。

- **backend は自分の秘密情報をグルーピングする仕組みを元々持つ**
  （Infisical の Folder、HashiCorp Vault の path プレフィックス／mount、
  組み込み backend なら自分の内部実装が使う任意の区分け）。**banto は、
  Project ごとにこのグループのどれを使うかを、人が明示的に紐付けられる
  ようにする**——D5「どのリポジトリにどの身元を使うか」の割り当て表と
  同じパターン（アーキ仕様 §2.5 の「role 依存の解決は Module の仕事」の
  延長）
- **既定は自動生成された専用グループ**（`projectId` をそのままグループ名に
  使う等）。`projectId` は衝突しない値（UUID 等）なので、**別ホストの
  banto インストールという概念を banto core に新たに持たせる必要は無い**
  ——複数ホストを区別するための識別子（instanceId 相当）は不要と判断した
- **人が2台のホストの Project に同じ backend・同じグループを割り当てれば、
  それが共有の合図になる。** 自動的な衝突回避ではなく、**人の意図で共有が
  起きる**——組み込み backend であっても、その保存の実体（ファイルか、
  他の形か）を複数ホストから触れる場所に置くかどうかは、その backend
  自身の実装の話であって、この「グループの紐付け」という概念とは別の層
- **紐付けの選択肢は2つ：既存グループから選ぶ／新しいグループを作る。**
  「既定は自動生成された専用グループ」と上で書いたが、それは Project
  作成時の**暗黙の1回きりの作成**にすぎない。**人がいつでも明示的に
  「新しいグループを作る」操作をできる必要がある**——例えば「共有していた
  グループから離れて、この Project 専用の新しいグループに切り替えたい」
  という場面は、既存グループの選択では表現できない
- **訂正：`VaultBackend`（下記 D節）のインターフェースは変更が要る。**
  当初「`path` 引数だけで足りるので変更不要」としたが誤りだった——
  **backend によっては、書き込む前にグループそのものを明示的に作成する
  API 呼び出しが要る**（例：Infisical の Folder は事前に作成しないと
  秘密を置けない。HashiCorp Vault の path プレフィックスは逆に、
  事前作成が要らない）。この違いを VaultUI 側で意識させないために、
  `VaultBackend` に `listGroups()` / `createGroup(name)` を足す
  （後者は、事前作成が不要な backend では単に何もしない no-op でよい）

#### D. バックエンド実装者向けの内部インターフェース（MCP ではなく npm ライブラリ）

単一 Module 方式なので、各実装は共通ライブラリを使い、alias 管理・
Elicitation 文言・Event Store 記録・A/B/C の tool/resource 配線は共有コードが持つ。
各実装が書くのはこれだけ：

```
interface VaultBackend {
  getSecret(path): Promise<string | Buffer>
  putSecret(path, value): Promise<void>
  deleteSecret(path): Promise<void>
  listPaths(prefix?): Promise<string[]>
  generateKeypair(kind): Promise<{ publicKey, privateKeyRef }>
  loadIntoAgent(privateKeyRef): Promise<{ socketPath }>  // このプロセス内でssh-agentを立てる
  listGroups(): Promise<string[]>       // Project ↔ グループの紐付け用（上記）
  createGroup(name): Promise<void>      // 事前作成が要らない backend では no-op でよい
}
```

**`note` を含むメタデータ（`kind`／`scope`／`note`／`expiresAt`／`lastUsedAt`）は
値と分離して持つ。** 値を復号・解錠せずに読める必要がある（`vault://aliases`
は AI が毎回読みうるもので、そのたびに値を復号するのは最小露出の原則に反し、
頻度的にも無駄）。候補にしているバックエンドはいずれも対応できる——組み込み
（SOPS）はメタデータの持ち方自体を banto が決められる、HashiCorp Vault は
KV v2 の `custom_metadata` が最初からこの用途を持つ、OS キーチェーンはコメント
／ラベル属性を値本体と分離して読める。**これで新しいバックエンドを足す人
（`docs/requirements.md` C6）は、alias 解決や Elicitation の作法を再実装せずに
済む。**

近く見えるが**用途が違う**。同じ Module にすると、片方の都合がもう片方を歪める。

| | **Shell** | **Environment** |
|---|---|---|
| 用途 | **いまここでコマンドを打つ** | **動くものを載せる場所を用意する** |
| 寿命 | **1回の呼び出しで終わる** | **作って、使って、壊すまで生き続ける** |
| 返すもの | 標準出力・終了コード | **場所そのもの**——以降その識別子を渡して操作する |
| 状態 | 持たない | **持つ**（識別子で参照する） |
| 誰が使うか | AI が会話の中で直接 | 主に Factory 的なものが裏で |

**状態の有無が決定的**である。MCP は「プロトコルにセッションの概念は無く、
呼び出しをまたぐ状態は**明示的な識別子**で参照させよ」という指針を持つ
（アーキ仕様の調査で確認済み）。**Environment はその型に当てはまり、Shell は
当てはまらない。** 契約の形が違うものを1つの Module に入れない。

**隔離の実装は重複しない。** 閉じ込めの機構（コンテナ／Landlock 等、`docs/specs/v4-security.md`）
は**共有ライブラリ**でよい——「共有ライブラリは第3の箱ではなく npm 依存」
（アーキ仕様 §1）。Module を分けても、閉じ込めのコードは1つで済む。

**したがって Shell は自分で閉じ込める。** Environment の中でだけ走らせる形は採らない
——**必須 Module（Shell）が任意 Module（Environment）に依存しなくなる。**

### 2.2 FileSystem のインターフェース（決定・2026-09-02）

**tool の語彙はゼロから作らない**（規則12）。ファイル操作の tool 名・引数の形は
MCP 公式の filesystem リファレンス実装で既に解かれているので、それに乗る。

| tool（`agent` 可視性） | 内容 |
|---|---|
| `readFile({path})` | 読み取り。**返り値の型は MIME で出し分ける**（下記） |
| `writeFile({path, content})` | 新規作成／全体上書き |
| `editFile({path, edits})` | 部分編集。結果は Canvas の差分ビュー（下記）と対にする |
| `listDirectory({path})` | 直下の一覧 |
| `searchFiles({path, pattern})` | 名前／中身の検索 |
| `createDirectory({path})` | mkdir -p 相当 |
| `moveFile({from, to})` | 移動・リネーム |
| `deleteFile({path})` | 削除 |
| `getFileInfo({path})` | サイズ・更新時刻・種別 |

**承認ゲートは独自に設計しない。** 「毎回確認すると承認依頼ストームになる」問題
への対処は既に Agent SDK に委ねると決定済み（`docs/specs/v4-frontend.md` §6.0、2026-08-31：
`canUseTool` ＋ `permissionMode`（`'auto'`＝モデル分類器が判定し、人に上げるのは
本当に必要なものだけ））。`writeFile`/`deleteFile` もこの一般機構にそのまま乗る
——FileSystem 固有のゲートを別に作ると、二重の確認 UX になる。

**resource は `file:///{path}` テンプレート1本**——数えきれない資源なので
`resources/list` ではなく `resources/templates/list` ＋ `completion/complete`
（`docs/specs/v4-frontend.md` §6.3「深い検索は仕様の completion API に乗せる」）。**これは
FileSystem 固有の決定ではなく、§6.3 の一般則がそのまま適用されるだけ**——
資源を持つ Module はすべてこの経路に乗る。加えて、少数の「最近開いた／
ピン留め」だけを `resources/list`（`annotations.priority`／`lastModified`つき）
で別枠に出してよい。

**`readFile` はテキスト以外もできる限り対応する。** MCP の tool 結果は
`text`／`image`／`resource`（embedded、`blob`）の content block を持てる
（規格が既に用意している型なので新設しない）：

| ファイルの種類 | 返す content block | AI から見えるか |
|---|---|---|
| テキスト（コード等） | `text` | 見える |
| 画像 | `image` | **見える**（モデルはそのまま画像入力として解釈できる） |
| その他（PDF 等バイナリ） | `resource`（`blob`） | 見えない。Canvas 側でのみ使う |

**Canvas のプレビューは拡張子／MIME→レンダラーの内部対応表を持つ**
——Markdown はレンダリング＋「ソースを見る」トグル、HTML は sandboxed iframe
＋ソース、画像は`<img>`、PDF は埋め込みビューア。**これは FileSystem Module
自身の Canvas 実装の内部詳細**であり、tool/resource の契約には現れない。
対応形式を増やすときは対応表に1行足すだけでよく、契約が決まっていることの
恩恵で core・他 Module に影響しない。未対応の拡張子はソース表示のみに
フォールバックする。

`editFile` の結果は、Repo Module の差分ビューと同じ材料（before/after の
行単位差分）で inline カードに埋め込む（§6.2「MCP Apps display mode」）。
launcher（人が AI を介さず直接ファイルを開く、`docs/specs/v4-frontend.md` §6.2）で開いたときも
同じプレビューを fullscreen で使う。

**launcher が開くファイルブラウザ（fullscreen）には、人向けのダウンロード／
アップロードを置く。** これは新しい AI 向け tool を要らない——Vault の
「backend 自身の `ui://<id>/config` が自分の tool を呼ぶだけ」（§2.1 C節）と
同じ形で、ブラウザ UI 自身が`readFile`/`writeFile`を内部的に呼ぶ（AI には
出さない）。複数ファイルをまとめて ZIP でダウンロードする操作も同様——
ZIP 化は launcher 側（Module の実装）の仕事であって、新しい tool の形は増やさない。

### 2.3 Shell のインターフェース（決定・2026-09-02）

**Shell は1回の呼び出しで終わり、状態を持たない**（§2.1「Shell / Environment」比較表）。
これに反する設計（プロセスを識別子で参照して後から操作する）は Environment
（§4）の仕事であって、Shell に持ち込まない。

| tool（`agent` 可視性） | 引数 | 内容 |
|---|---|---|
| `runCommand` | `command`（文字列）／`cwd`（Project 根からの相対パス、省略時は根）／`timeout`（秒、上限あり）／`envSecrets`（`{ENV名: alias名}`、アーキ仕様 §2.5「alias 方式」で決定済みの形）／`secretFiles`（`{書き出し先パス: alias名}`、下記）／`sshIdentity`（`identity名`、下記） | 返り値は `stdout`／`stderr`／`exitCode`／`timedOut` |

**tool はこれ1本だけにする。** `listProcesses`/`killProcess` のような、プロセスを
識別子で参照する tool は意図的に作らない——状態を持つことになり、Shell の契約
（1回で終わる）を破る。バックグラウンド実行・後からの操作が要る用途は
Environment 側で扱う（§4、下記）。

**`secretFiles`**（`.npmrc`・`kubeconfig` 等、アーキ仕様 §2.5 に原則はあるが
tool 引数の形は未設計だった部分——ここで決める）：実行直前、Shell が host 中継
経由で alias を解決し、指定パス（Landlock された根の中に限る）へ書き出す。
実行後（成功・失敗・timeout いずれでも）**必ず**削除する。承認ゲートに見せるのは
「どのパスにどの alias が書き出されるか」まで（値は出さない）——`envSecrets`
と同じ扱い。

> **既知の限界として受け入れる（TODO、2026-09-02）**：書き出されている間、
> および削除に失敗したときは、`readFile`（FileSystem の `agent` 可視性 tool）
> が同じ Landlock 根を見ているため、AI が `secretFiles` の値をそのまま読める。
> D3（鍵の値が AI の文脈に出ない）が、この間だけ構造ではなく「Shell が必ず
> 消す」という運用で守られている状態になる。FileSystem の根に含まれない
> 場所へ書き出す・Phase 1 では `secretFiles` 自体を作らない、といった代替案は
> 今回は採らない——**現時点ではこの限界を受け入れ、実装時に対処を検討する
> TODO として残す**（規則8：黙ってどちらかに寄せず、記録を残して人に上げる）。

**`sshIdentity`**：Vault B節の `startSshAgent`（アーキ仕様 §2.5 では Repo 向けの
例だったが、Shell が生の `git` を叩く場面にも同じ経路を使う）を呼び、返ってきた
`socketPath` を `SSH_AUTH_SOCK` として子プロセスの環境変数に注入する。ソケット
パスは秘密ではないので `envSecrets` とは別枠にした。

**timeout と MCP の既定タイムアウト**：`npm install` 等、60秒を超えるコマンドは
普通にある。バックグラウンド起動＋poll という状態を持つ形は採らず（Shell の
契約を破るため）、`runCommand` は1回の呼び出しのまま、実行中に
`notifications/progress` を定期送出してクライアント側のタイムアウトを更新させる
——新しい機構ではなく、MCP 仕様が既に持つ仕組みの使い先が増えるだけ（規則12）。
副産物として、この進捗通知に stdout の断片を載せれば Canvas 側でコマンド完了前
のライブ出力も出せる。

**resource は持たない。** FileSystem が `file:///{path}` テンプレートを持つのは
「数えきれない資源（ファイル）がある」からだが、Shell には参照可能な永続オブジェクト
が無い（プロセスは1回で消える）。実行履歴を Shell 自身が保持して `resources/list`
で見せる案は規則3（真実は一箇所）に反する——host 中継の呼び出しは既に Event Store
に記録される（Vault B節と同じメタデータ記録）。履歴が要るなら Shell に持たせず
Event Store を読む。

**承認ゲートは独自に設計しない**（FileSystem §2.2 と同じ理由——`docs/specs/v4-frontend.md` §6.0
の一般機構 `canUseTool` ＋ `permissionMode: 'auto'` にそのまま乗る）。

**UI**：会話内のインラインカードは `command`／`exitCode`／`stdout`/`stderr` を
モノスペースのターミナル風ブロックで表示（長い出力は折りたたみ）。launcher
（人が AI を介さず直接触る画面）は「コマンドを1つ打つ→結果を見る」を繰り返す
パネルに留める——`cd` の永続化や対話的プログラムは非対応と明示する。**対話的な
（PTY の）ターミナルは作らない**——それは状態を要求し、Shell の契約と衝突する
（下記 §4「Environment」を参照）。launcher UI 自身が内部で `runCommand` を呼ぶ
だけで、AI 向けの新しい tool は増やさない（FileSystem のファイルブラウザと同じ形）。
Shell には数えきれない資源が無いので Command Palette の `completion/complete`
統合は無く、Palette に載るのは launcher（ターミナルを開く）への入口だけ。

## 3. 境界の問題——FileSystem と Shell を同じ扱いにしない

**両方「Project の根の外へ出さない」を求められるが、強制できる層が違う。**
ここを混ぜると、片方だけ守られた状態になる。

| | 何ができるか | どこで強制できるか |
|---|---|---|
| **FileSystem** | 自分が開くファイルを自分で決められる | **アプリ層で強制できる**——ただし正しくやるのは難しい（`..`・シンボリックリンク・ハードリンク・検査と使用の間の競合）。**既知の脆弱性の型なので、既知の答えを使う**（規則12） |
| **Shell** | **任意のプロセスを起こせる** | **アプリ層では強制できない。** 起こされたプロセスは banto の検査を通らない。**Landlock で縛る**（`docs/specs/v4-security.md`）——非特権で使え、子プロセスに継承され、`execve` をまたいで残り、外せない。ただし**リソースは対象外**なので cgroup が別に要る |

**引数で根を渡すことは、強制ではない。** アーキ仕様 §2.5 は「Project ごとの違いは
その呼び出しに何を渡すかで吸収する」と決めているが、**渡した根を Module が守る
保証はどこにも無い**——第三者の Module なら、なおさら。**「渡した」は依頼であって
境界ではない。**

**だからセキュリティは core で詰める**（`docs/specs/v4-security.md`）。Module ごとに境界を
決めると、Module の数だけ食い違いが生まれる。

## 3.1 「banto が作る」と「外部をマウントする」を分ける

Module の一覧には**2種類が混ざる**：

| | 例 |
|---|---|
| **banto が作る** | FileSystem・Shell（Project の根という banto 固有の境界を課すので、他人の実装では代われない） |
| **外部のものをマウントする** | **Browser**（§4.1）——既に良い実装があるものは、**マウントで済ませる**（アーキ仕様 §5.1：`server.json` / `mcp.json` の形で繋ぐだけ） |

**既にあるものを作り直さない**（規則12）。Module 一覧に載っていることは
「banto が実装する」を意味しない。

## 4. 作りたい Module（必須ではない）

**banto として作りたいが、無くても banto は成り立つもの。**

| Module | 何をするか | 状態 |
|---|---|---|
| **Environment** | コードを動かす場所を用意する（**状態を持ち、識別子で参照する**） | **Shell とは別実装**（§2.1）。閉じ込めの機構は共有ライブラリとして両方が使う。**人と AI が同じ永続セッションをターン制で共有する使い方も想定**（2026-09-02、下記） |
| **Publish** | 動いているものに届く URL を生やす | |
| **Repo（git）** | 複数リポジトリの一覧・worktree・clone/branch/log | **要件に記録あり**——「この辺最低限ないと開発できない」 |
| **Backlog** | 仕事の一覧を管理する | |
| **Factory 的なもの** | 依頼を耐久ワークフローとして進める | **設計はゼロから起こす** |
| **Browser** | 人と AI が**同じブラウザ**を触る。通信も見る | **外部をマウントする**（§3.1・§4.1） |

### 4.1 Browser——人と AI が同じブラウザを触る

**作らない。既存の MCP サーバをマウントする**（§3.1）。2026-08-29 に確認した候補：
**Chrome DevTools MCP** と **Playwright MCP**。どちらも CDP で動いている
ブラウザに繋げる（前者は起動中の Chrome へ、後者は `--cdp-endpoint` や拡張経由で）。

**banto はサーバ上のブラウザに繋ぐ**——「人の手元の Chrome に繋ぐ」形は採らない
（下記）。したがって選定で見るのは「手元に繋げるか」ではなく、
**CDP をどこまで素直に開けているか**（screencast と入力注入が要るため）。

#### 通信の解析は2通りある。混ぜない

**ここを分けないと、要らない危険を背負う。**

| 何を見たいか | 要るもの | 代償 |
|---|---|---|
| **ブラウザが出す通信** | **不要。** CDP の Network ドメインが**復号済みの要求と応答**を返す（DevTools の Network パネルと同じもの）——**ブラウザの中に居るので、TLS を割る必要がない** | **無し** |
| **ブラウザ以外の通信**（開発中アプリのサーバ側、他のプロセス） | **TLS を割る代理**（`mitmproxy` 等。MCP のラッパーも既にある） | **大きい**（下記） |

**まず上を試す。** 「SSL の通信を見たい」という要求の多くは、**ブラウザの通信を
見たい**であり、その場合は**代理も証明書も要らない。**

#### TLS を割る代理を入れるときの代償（`docs/specs/v4-security.md`）

- **通る全ての資格情報を平文で読める。** banto は Vault を持ち、OAuth トークンを
  持ち、複数のサブスク資格情報を持つ（アーキ仕様 §2.8）。**その通信が代理を
  通れば、代理が全部読める**
- **AI がその代理から読める設計にすると、AI が資格情報を読めることになる**
- **CA 証明書を信頼させると、その機械全体の TLS 信頼が変わる。** banto が勝手に
  やってよい類ではない

**したがって、入れるなら分離する**——**banto 自身の通信は代理を通さない**。
**未決**（§5）。

#### 置き場は banto と同じサーバ。人は Canvas から直接触る（決定・2026-08-29）

**ブラウザは banto と同じサーバで動く。** したがって「人が使っている手元の Chrome に
繋ぐ」形（`--autoConnect`）は**採らない**——手元に Chrome が無い。
**banto のブラウザが1つあり、AI は CDP で、人は Canvas から触る。**

**「共通に触れる」の意味が変わる**——同じブラウザを2つの経路から操作する形になる。
ログイン状態は「人の普段のブラウザから引き継ぐ」のではなく、
**そのブラウザに人が Canvas からログインして貯める**ことになる。

#### 画面を Canvas に出して触る方法（既知の手法が2つ）

| | 仕組み | 向き不向き |
|---|---|---|
| **CDP の screencast** | `Page.startScreencast` が画像フレームを流し、`Input.dispatchMouseEvent` / `dispatchKeyEvent` で操作を返す | **タブ単位**。**すでに繋いでいる CDP をそのまま使える**ので部品が増えない。banto の構成に素直 |
| **VNC（＋ブラウザ側の noVNC）** | Xvfb 上でブラウザを動かし、画面ごと転送 | **デスクトップ全体**。ファイル選択ダイアログなどブラウザ外の UI も扱える。部品は増える |

**第一候補は CDP の screencast**——Browser Module は CDP を話しているので、
**新しい経路を足さずに済む**（規則12：既にあるものを使う）。

#### ぶつかる点——MCP Apps の iframe は外部通信を塞ぐ

**ここは正直に書く。** `docs/specs/v4-frontend.md` §6.2 の決定では、Module の Canvas は `ui://` 資源として
**サンドボックス iframe** に描かれる。だが **MCP Apps の仕様は、その iframe に
「外部へのネットワーク要求を塞ぐ厳しい CSP」を課している**（2026-08-29 確認）。

つまり **`ui://` の Canvas の中から、フレームを受け取るための WebSocket を自分で開けない。**
映像のように量と速さが要るものを、**MCP の JSON-RPC 経路に載せると重い**
（参考：1クエリのイベント数は中央値6。毎秒10〜30フレームは桁が違う）。

**選択肢は3つ。未決**（§5）：

1. **`externalIframes`** を使う——MCP Apps の仕様に**外部 URL の iframe を許す
   capability** への言及がある。Module が自分の生成元から生画面のページを出し、
   自分の WebSocket を使う。**細部は未確認**
2. **core が描く Canvas として特別扱いする**——banto 側の Canvas が「生画面」用の描画を持ち、
   banto の host が CDP との間を中継する。**「Module が中身を持ち core が置き場を
   決める」という原則から外れる**が、要求に対しては素直
3. フレームを MCP の経路に載せる——**遅い見込み。まず測る**

> **これは banto の「すべて MCP 経由」が、初めて運べないものに当たった箇所である。**
> 原則を曲げるかどうかの判断が要るので、**曲げるなら理由を残す。**

#### まだ決めていない

- 上の3択（`ui://` の外部 iframe／core の特別扱い／MCP 経路に載せる）
- どの実装をマウントするか（Chrome DevTools MCP / Playwright MCP / 併用）
- TLS を割る代理を入れるか、入れるなら banto の通信をどう分離するか
- **サーバ上のブラウザは資格情報の入れ物になる**——人が Canvas からログインすると、
  cookie とセッションがそこに貯まる。**AI も同じブラウザを触れる**ので、
  「AI がどこまで触れてよいか」は`docs/specs/v4-security.md` の論点に加わる

## 4.9 Module の宣言（決定・2026-09-06、Phase 1）

**どの Module を、どう起動するかは、コードではなく宣言で決める。**
宣言1本は次を持つ：

| 項目 | 意味 |
|---|---|
| 名前 | 一覧の中で一意。Runner から見える名前（`mcp__<名前>__…`）でもある |
| 起動 | 実行するプログラム・引数・環境変数（**受け入れる形はこれ1種類**、アーキ仕様 §5.4 付近） |
| meta | `dev.banto/module` と同じ語彙（`satisfies` / `dependsOn` / `isolation` / `scope` / `handlesSecrets` / `confinement`） |

- **置き場は Configuration**（instance 既定＋Project 上書き）。Module 集合は Project 単位
  （アーキ仕様 §2.2）なので、既にある仕組みに乗せる——新しい置き場を作らない（規則12）
- **同梱の既定（Vault・Shell・FileSystem）も同じ宣言の形**で持つ。特別扱いしない（規則3）
- **閉じ込め（Landlock）も宣言から決まる**——以前は「shell なら実行を許す、それ以外は
  読み書きだけ」とコードで場合分けしていた。新しい Module を足したとき、
  その閉じ込めを書く場所が無い状態だった
- 宣言は**起動する前に検める**。知らない差し込み語・空の起動・名前の重複・
  `scope` と閉じ込めの食い違いは、その場で落とす（規則2）

### 自己申告との突き合わせ（決定・2026-09-06）

**Module は `resources/list` に出す資源の `_meta["dev.banto/module"]` で自分を名乗る**
（アーキ仕様 §5.4「別のマニフェストを作らない」）。URI は Module が自由に決めてよい
——host は `_meta` の中身だけを見る。**`initialize` の応答には載せられない**
（SDK のクライアントが serverInfo をスキーマで削るため届かない、実測・2026-09-06）。
名乗りは**任意**——名乗らない Module は宣言だけで起動する。

**なぜ宣言（Config）が先で、申告が後か。** 閉じ込め・Project ごとの分離・
秘密を扱う前提の隔離は、**起動する瞬間に決まってしまう**。Module に聞けるのは
起動した後なので、「聞いてから決める」ができない。

**食い違いは方向で分ける：**

| 方向 | 扱い |
|---|---|
| Module のほうが**厳しい**（例：宣言に無い `confinement` を申告） | **Config を実際に直してから**起動し直す。直さずに読み替えるだけだと「Config にはこう書いてあるのに実際は別の形で動いている」という真実が2つある状態になる（規則3） |
| Module のほうが**緩い**（例：閉じ込め不要と申告） | **従わない。繋がずに止める。** Module は他人が書いたものでありうる——「私は秘密を扱いません、隔離は要りません」を鵜呑みにして起動するのは、攻撃者にとって一番都合がよい。**運用者の意図（Config）が上位**で、申告は「より厳しくする方向にだけ効く情報」 |
| 起動の形に関わらない差分（役割名など） | 記録して続行 |

厳しさの向きは項目ごとに決めてある：`scope` は project が厳しい、`isolation` は
subprocess が厳しい、`handlesSecrets` は true が厳しい、`confinement` は有るほうが厳しい。

## 5. まだ決まっていないこと

1. **`Memory` を core のインターフェースにするか、薄い Module にするか**（§1）——core 側が筋に
   見えるが、**確定していない**
2. ~~FileSystem 側の強制方法~~（§3）**→ 決定（2026-09-02、`docs/specs/v4-security.md`
   「FileSystem も同じ Landlock で閉じ込める」）。** Shell と同じ Landlock を
   `subprocess` 化した FileSystem 自身のプロセスに直接掛ける——アプリ層検査は
   採らない。~~Shell からネットワークに出られてよいか~~ **→ 決定（2026-09-02、
   既定で許可、`docs/specs/v4-security.md`）。** ~~Landlock 許可リストの粒度~~ **→ 決定
   （2026-09-02、`poc/07-landlock-allowlist-from-path/`、`docs/specs/v4-security.md`
   「許可リストの組み方」）。** `PATH` の各ディレクトリ＋その兄弟
   `lib`/`lib64`/`libexec`/`share`＋`ld.so.conf` 由来のパス＋`/etc`・`/proc`
   （読み取り）＋`/dev`（読み書き）＋ Project の根（読み書き）を起動時に動的に
   組む。**機構では守れないトレードオフが残る**：許可した `.../bin` の中に
   資格情報を置かれると読めてしまうため、「PATH に含めるディレクトリに機微な
   ファイルを置かない」という運用上の前提に依存する（実装時にドキュメント化）。
   **残る未決**：**リソース制限（cgroup）——Phase 1 では作らないと決定
   （2026-09-02、`docs/specs/v4-security.md`）。忘れないための記録としてここに残す**。
   起動時にどの `PATH` の値を許可リスト生成に使うか（環境変数は書き換えられ
   うるため、banto が Module 起動前に確定させた値を使う）
3. ~~Shell を Environment の中でだけ走らせるか~~
   **→ §2.1 で決着。別 Module にし、Shell は自分で閉じ込める。**
   閉じ込めの機構は共有ライブラリとして両方が使うので実装は重複しない。
   必須 Module が任意 Module に依存する問題も消えた
4. 各 Module の tool の具体形（この文書に順次書く）
5. ~~`vault` の複数バックエンドの選び方~~ **→ §2.1 で決着。** 役割として解決する
   （アーキ仕様 §2.5）だけで足り、単一 Module 方式・A〜D のインターフェースの構成まで決めた
6. **Backlog と Factory の関係**——要件には「Factory の並列モデルは依頼どうしの
   依存関係を見ていない。タスク管理機能と連携してから」という記録がある。
   **Backlog が先で Factory が後**の可能性
7. **VaultUI（Vault 管理専用 Module）自体の画面構成**——§2.1 C節で「別 Module から
   横断して alias を管理したい」という要望に応えられる形（`admin` tool 層）は
   用意したが、**VaultUI というModuleを実際に作るか、どんな画面にするかは未決**
   ——モックで作るときに詰める。合わせて詰めること：`migrateTo` の実行主体・
   失敗時の部分移行の扱い、`admin` tool への承認ゲートの循環（人がVaultUIで
   操作した結果をもう一度承認させるべきか）
8. Vault の `note` フィールドの文字数上限
9. `scope: "project"` の alias が、その Project が畳まれた（削除された）ときに
   どうなるか——Vault 側に取り残されたままになる可能性がある
10. **Environment 自体の設計**（§4）——「人と AI が同じ永続セッションをターン制
    （`execIn` のような tool 呼び出しの積み重ね、同時入力の PTY 多重化は不要と
    確認済み）で共有する」という要求があることは 2026-09-02 に確認したが、
    Environment 自体の tool/resource/UI はまだ何も決めていない。Phase 0/1 では
    作らない対象（CLAUDE.md）なので、実際に設計するのは後——ここでは要求だけ
    書き残す
