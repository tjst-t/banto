# 2026-09-02 実装着手前レビュー（記録・対応状況の追跡）

Vault・FileSystem・Shell の3Module検討が終わった時点で、Opus Subagentに
`docs/specs/*.md` 全体と Mock（`mock/`）のレビューを依頼した。**このファイルは
その指摘の記録と、対応状況の追跡台帳**——`docs/specs/`は決まったことだけを書く場所
なので、検討過程・指摘一覧はここに置く。

対応順は2026-09-02にユーザーと合意：
1. まずこのファイルに指摘を記録する（このファイル自体）
2. すでに決まった2件を先に実行——**VaultをPhase 0/1へ格上げ・RepoをPhase 3以降へ**、
   **「面」という語を全廃してCanvasに統一**
3. PoCが必要なブロッカーは全部PoCして決定する
4. その他、仕様化にあたり意思決定が必要なものは相談して決める

## レビュー原文の指摘一覧

Opus Subagent（`localhost:4173`で起動中のモックをPlaywrightで操作し、
`docs/specs/*.md`約3,400行・`docs/notes/`9本を全読して作成）による指摘。
重大度：**A＝実装をブロックする／B＝実装後に手戻りが起きる／C＝軽微**。

### A. 実装をブロックする

| # | 指摘 | 対応方針 | 状態 |
|---|---|---|---|
| A1 | 「Phase 0/1で書く3つ」がrequirements.md（Repo・Shell・ファイル）とユーザーの前提（Vault・FileSystem・Shell）で食い違う。ShellのenvSecrets/secretFilesはVault無しには実装できない | **決定：VaultをPhase 0/1へ、RepoをPhase 3以降へ** | **解決**（`docs/requirements.md` C5・`docs/specs/v4-modules.md` §2 反映済み） |
| A2 | Module→hostの中継経路が未定義。host=client/Module=serverの向きで決めたはずだが、MCPでserver→clientに`tools/call`は送れない。Runnerがspawnしたstdioモジュールとhostの接続は別プロセスという実測結果があり、中継口に到達する経路が構造的に無い。Vaultでは秘密鍵が2プロセスに二重展開されうる | **PoCで接続トポロジを検証してから設計し直す** | **解決**（`poc/05-module-relay-topology/`。hostが実接続を1本だけ持ち、Runnerには`createSdkMcpServer`の代理サーバを見せる方式で実証。`docs/specs/v4-architecture.md` §2.5・§9・§10 item9、`docs/specs/v4-modules.md` §2.1 に反映済み。**新規未決**：resource/promptは代理サーバ方式で持てない——`vault://aliases`をRunnerに見せる経路が無い） |
| A3 | 可視性（agent/module/admin）を「Runnerに見せない」で本当に強制できるか未測定。v3実測では「見せない設定でも見えたまま、呼ぶと断られる」だった。D3（鍵の値をAIに見せない）がこの1点に依存している | **PoCで`allowedTools`/`disallowedTools`によるMCP module tool隠蔽を実測** | **解決**（A2と同じPoCで確認。代理サーバに登録しない＝「隠す」でなく「存在しない」。v3知見は`allowedTools`系フィルタ経路限定と判明） |
| A4 | セキュリティ境界（§10 item 11）が未決。FileSystemのアプリ層強制の具体手段（Nodeに`openat2(RESOLVE_BENEATH)`相当が無い）、Landlock許可リストの粒度、Shellのネットワーク可否、cgroundが無い | 一部PoC・一部意思決定。**FileSystem強制手段の技術調査が必要（PoC寄り）**、ネットワーク可否は製品判断（相談） | **解決**。FileSystem強制手段（subprocess化+Landlock）・Shellのネットワーク（既定許可）・Landlock許可リストの粒度（PATH由来の動的組み立て、`poc/07-landlock-allowlist-from-path/`）すべて決定し反映済み。cgroupはPhase 1では作らないと明示的に決定（未決事項として記録、黙って忘れない）。**残る運用上の注意**：PATHに含めるディレクトリに機微なファイルを置かない、という前提に機構ではなく運用で依存する点をドキュメント化する必要あり（実装時TODO） |
| A5 | `secretFiles`がProject根の中に平文で置かれ、同じ根を見る`readFile`（agent可視性）から読める。削除失敗時・書き出し中はD3が構造でなく運用で守られている状態 | 意思決定（相談）——FileSystemの根に含まれない場所を決めるか、Phase 1では作らないか | **決定：現時点では受け入れ、TODOとして記録**（2026-09-02）。`docs/specs/v4-modules.md` §2.3の`secretFiles`節に明記済み。対処は実装時に検討 |
| A6 | requirements C11「必須role未充足なら起動しない」とarchitecture §2.5「起動を止めない」が矛盾。必須/任意を`_meta`に書く場所も無い | 意思決定（相談） | **解決**（2026-09-02）。「起動を止めない」はbanto host自身の話、「必須role未充足なら起動しない」は個々のModule自身の話——2階層に分けて両立させた。既存の`_meta["dev.banto/module"]`（role解決の静的宣言/動的自己申告/突き合わせ機構、§5.1）の`dependsOn`に`required: boolean`を追加する形で解決（ユーザーが機構を正確に記憶しており、それを再利用しただけ）。`docs/specs/v4-architecture.md` §5.1・§2.5に反映済み |

### B. 実装後に手戻りが起きる

| # | 指摘 | 対応方針 | 状態 |
|---|---|---|---|
| B1 | Module間中継の承認ゲートが`canUseTool`と別物なのに未設計。`runCommand`実行中に入れ子で発生する中継承認がどこに出るか、外側のtool呼び出しがどうなるかが未定義 | 意思決定（相談） | **解決**（2026-09-02）。判断待ち（§2.4）＋hold-the-line（`canUseTool`と同じモデル、ただし`notifications/progress`でタイムアウト回避）＋既存承認ゲートUIの二重表示（会話内カード＋受信箱）の組み合わせ。`docs/specs/v4-architecture.md` §6.0「Module間中継の承認（入れ子の承認）」に反映済み。**追加要望**：`--dangerously-skip-permissions`相当の全許可トグル（`dangerouslySkipPermissions`、設定画面からON/OFF、Project単位で上書き可）も同時に決定・反映——`permissionMode: bypassPermissions`（SDK既存値）＋中継承認のスキップの両方を切り替える。Elicitation由来の判断待ち（人にしか出せない答え待ち）はスコープ外。**2026-09-03追記**：ユーザーからComposerでpermissionModeを選べるようにしたいという要望があり、`dangerouslySkipPermissions`という個別ON/OFFフィールドは撤回——Thread単位でComposerから6値（`auto`/`default`/`acceptEdits`/`plan`/`dontAsk`/`bypassPermissions`）を直接選べる形に統合した（規則3、真実は一箇所）。Configurationは`defaultPermissionMode`（新Threadの初期値）だけを持つ。`docs/specs/v4-frontend.md`に反映済み。**同日再追記**：`bypassPermissions`がModule間中継の承認ゲートも一緒に飛ばす、という統合はユーザー指摘で撤回した——`permissionMode`（AIへの信用の軸）とModule間中継の承認（Projectの内部配線への信用の軸）は別物で、`bypassPermissions`は`canUseTool`だけに効く。Module間中継の承認ゲートは`permissionMode`の値に関わらず常に初回確認する（元の設計に戻した）。モック側は元々Shellの承認ゲート（canUseTool層）にしか実装しておらず、コード変更は不要だった。`docs/specs/v4-frontend.md`に反映済み |
| B2 | Shellの承認ゲート表示が§2.5の要求（コマンド文字列＋alias一覧、値は出さない）を満たさず、モックにも該当UIが無い。承認用tool名`banto_shell_exec`がShell本体`banto_shell_run_command`と別toolとして併存——README「toolは1本」と矛盾 | Mock修正 | 未着手 |
| B3 | §10 item14(b)「Vaultのような裏方roleはProjectの選択肢に出てこない」が§2.1 A節（Vaultにagent可視面`vault://aliases`等がある）と矛盾。モックはA節側に従っており、説明文の直下に矛盾する一覧が表示される | 仕様の文言修正 | **解決**。「Runnerに直接繋ぐ」という前提自体が代理サーバ方式（PoC05）で古くなっていたため、対象選定基準を「agent可視性のtool/resourceを1つでも持つrole」に言い換え、Vaultを誤った例から除去。`docs/specs/v4-architecture.md` §10 item14(b)に反映済み |
| B4 | `_meta`のベンダ接頭辞が「未決」のままだが、`dev.banto/module`等3箇所で既に決定済みであるかのように使われている | 決めるだけ（`dev.banto/`で確定と明記） | **解決**。`dev.banto`で正式決定（ドメイン非所有でも逆DNS記法は名前空間の衝突回避のためのものであり実際のDNS解決は不要）。§5.4・§10 item9に反映済み |
| B5 | モックの`MockModuleImplementation`に`dependsOn`/`visibility`の型が無い。`breaksIfDisabled`は依存宣言からの導出でなく手書きの写し（規則3違反） | Mock修正 | 未着手（Mock修正はB2・C2・C3とまとめて後日実施） |
| B6 | `v4-modules.md §1.1`のcore tool一覧が古く、決定済みの項目（item3・item13）を「未決」と誤記。§10番号への参照も現在の番号とズレ。両仕様書のヘッダが「最終更新：2026-08-29」のまま更新されていない | 仕様の記述修正 | **解決**。Memory書き換え（item3）・後で答える層（item13）・会話を畳む呼び名（モックで決定済み）・Module足す外す（item20）を「決」に更新、A2UIの参照番号を§10-19→item22に訂正、両ヘッダを2026-09-02に更新 |

### C. 軽微な整合性・規律の問題

| # | 指摘 | 対応方針 | 状態 |
|---|---|---|---|
| C1 | 仕様書が追記ログ化している（取り消し線・訂正履歴が本文に残存、CLAUDE.mdの「更新する（追記ログにしない）」違反）。2,821行という分量自体が症状 | 仕様書のクリーンアップ（訂正履歴はnotesへ、本文は現在の決定だけに） | **解決**（2026-09-02）。`v4-architecture.md`を4ファイルに分割（`v4-architecture.md`本体・新設`v4-security.md`・新設`v4-frontend.md`・`v4-modules.md`）し、12件の訂正履歴を本文から`docs/notes/2026-09-02-spec-cleanup-and-split.md`へ移動。CLAUDE.mdの「まず読む」リストも更新。詳細は同ノート参照 |
| C2 | 画面に出る文字列に仕様書の節番号が再混入（`vault-manage-view.tsx`等5箇所以上） | Mock修正 | 未着手 |
| C3 | 「他バックエンドへ移行」ボタンがVaultUIからは削除済みだが`/settings`のrole一覧側に残存。`migrateTo`は§5 item7で未設計のまま | Mock修正 | 未着手 |
| C4 | aliasの表記が3通り（裸`github-token`／`$`前置／`alias:`前置）混在 | 意思決定（相談）——1つに統一 | **解決**。3通りではなく2通りが意図した違いだったと判明——`envSecrets`/`secretFiles`（独立引数、混同の恐れが無い）は裸表記、`mcpServers`の`env`（値と参照が同じフィールドに同居しうる）は`$`前置。モックの`alias:`表記はUI表示上の体裁であり別途Mock修正で統一（後日）。`docs/specs/v4-architecture.md` §5.5「mcpServersへの秘密情報の注入」に反映済み |
| C5 | VaultUIが`in-process`だが、C節では人が入力した秘密の値がそこを通る。requirements C8c「秘匿情報を扱うモジュールはin-process拒否」の「扱う」の定義・判定フィールドが存在しない | 意思決定（相談） | **解決**。「扱う」＝Module自身のバックエンドコードが平文の値を変数・引数として受け取ること、と定義。VaultUIのCanvas（ブラウザiframe）が発生源でバックエンドを経由しないため`in-process`のままでよい。`_meta["dev.banto/module"].handlesSecrets`を新設し、`true`＋`in-process`の組み合わせを機械的に拒否。`docs/specs/v4-modules.md` §2.1・`docs/requirements.md` C8cに反映済み |
| C6 | 「面」の英語対応語が用語表に無い（**→ 2026-09-02 決定：「面」は全廃してCanvasに統一**、下記）。requirements C8cの「台帳」がarchitectureでは「役割一覧」——同じ概念に2つの呼び名 | 「面」は対応中。「台帳/役割一覧」は別途決定要 | **解決**（全項目）。「面」は4ファイル完了。UIコンテンツの意味はCanvas、MCPインターフェース／APIサーフェスの意味は「口」→ユーザー指摘を受け更に「インターフェース」に統一（規則11、独自用語を避ける）。「入口」（launcher）「取り込み口」（Skill取り込み）「窓口」（single point of contactの比喩、§6.3）は別概念として区別し不変更。「台帳」→「役割一覧」に統一（`docs/requirements.md` C8c・§2箇所） |

## 2026-09-02 に決定した2件（このレビューを受けて）

### Vault → Phase 0/1、Repo → Phase 3以降

A1への対応。ShellのenvSecrets/secretFiles/sshIdentity（v4-modules.md §2.3）は
Vaultの`resolveAlias`/`startSshAgent`無しには実装できないため、Vaultの方を
Phase 0/1に合わせる方が自然——Repoを先に作る理由（要件C5の元の記述）は
「Factoryが1本通るのに要る最小集合」だったが、**Vault・Shell・ファイルの3つで
Factory 1本の体験は成立し、Repo（複数リポジトリ管理・GitHub身元）は無くても
Factoryの検証はできる**、という判断。`docs/requirements.md`・
`docs/specs/v4-modules.md`を更新する（このファイルの直後のコミットで反映）。

### 「面」を全廃してCanvasに統一

C6への対応。「面」はMCP Appsが描画するModuleのUI（inline/fullscreen/設定画面
埋め込み/launcher、いずれも同じpostMessage受け皿を使う1つの概念）を指す
内部用語だったが、英語対応語が無く、しかも「Canvas」という既存語（fullscreen
表示モードの置き場所を指す固有名詞）と意味が重なっていた。

**決定**：「面」という語を仕様書から全廃し、**Canvas**に統一する。Module が
描画するUIコンテンツそのものを Canvas と呼び、`inline`/`fullscreen`/`pip`は
その Canvas をどれだけの画面でどこに出すか（display mode）を表す——「面」が
上位概念、「Canvas＝fullscreen」が下位概念、という旧来の逆転していた関係を、
「Canvas」を上位概念に統一することで解消する。ChatGPT Canvas等、業界で既に
使われている語でもある（規則12・規則11）。

**適用範囲**：「Module の面」「MCP の面」「設定面」「面を持つ」等、Moduleの
UIコンテンツという概念を指す「面」はすべてCanvasに置き換える。「画面」
（screen、UI全体を指す一般語）・「場面」「当面」「表面」「全面」「反面」等の
複合語はこの語と無関係なので変更しない。詳細な置換は`docs/specs/v4-architecture.md`・
`docs/specs/v4-modules.md`本体で反映する（このファイルの直後の作業）。

**追記（作業後）**：実際に4ファイル（`v4-architecture.md`・`v4-modules.md`・
`requirements.md`・`CLAUDE.md`）を洗い出したところ、「面」には**2つの異なる
意味**が混在していた。UIコンテンツの意味（設定面・launcherが開く面）は上記の
通りCanvasにしたが、**「機能はすべてMCPの面の向こうにある」のような、MCPが
唯一のインターフェース境界であるという根本原則を指す「面」**は、Canvasにすると
UIの話とプロトコル境界の話が同じ語になり意味が壊れるため、既存語**「口」**
（要件C13「口を1つにする」・architecture「送る口」で既に使われている語）に
寄せた。「core の MCP 面」→「core の MCP の口」、「Module の面を MCP で
区切る」→「Module の境界を MCP で区切る」等。**この分離は2026-09-02 時点で
ユーザー確認待ち**——「口」で確定するか、別の語にするかは次のやり取りで詰める。

### 「口」を「インターフェース」に統一（2026-09-02、ユーザー指摘を受けて）

上記「口」への分離に対し、ユーザーから「bantoで独自用語は作りたくない。一般的な
IT用語に寄せたい」という指摘があり、**「口」のうちMCPインターフェース／APIサー
フェスという概念を指す用法を「インターフェース」に統一した**（`v4-architecture.md`
34箇所・`v4-modules.md` 15箇所・`requirements.md` 8箇所）。「入口」（launcher、
§6.2）・「取り込み口」（Skill取り込み、§5.7）・「窓口」（single point of contact
の比喩、§6.3——SSEの配達経路とUIの探索導線という異なるレイヤーを束ねる語なので
インターフェースに寄せると意味が壊れるため、あえて不変更のまま残した）は
別概念として区別し、対象外にした。

### PoC 05：Module→hostの中継トポロジ（A2・A3の解決）

`poc/05-module-relay-topology/`で実測。**host が実 Module への接続を1本だけ
持ち、Runner には `createSdkMcpServer`（in-process）で作った代理サーバを見せる**
——代理サーバには `agent` 可視性の tool だけを登録し、呼ばれたら host の実接続へ
転送する、という方式が3回中3回、間欠なく成立した。

- **二重起動が解消**：直結の対照実験ではプロセスが3つ（host 1 + Runner側2）
  できたが、代理方式では実Moduleのプロセスは1つだけ
- **可視性は「隠す」でなく「存在しない」で実現**：`module`/`admin`可視性のtool
  はRunnerのtool一覧に一切現れない。v3の「見せない設定でも見えたまま」という
  知見は`allowedTools`系フィルタ経路限定の話だったと判明
- **承認ゲート（`canUseTool`）は代理サーバのtoolでもそのまま効く**
- **新規の未決事項**：`createSdkMcpServer`はtoolしか受け付けないため、
  resource・promptを同じ代理経路でRunnerに見せる手段が無い。Vault A節の
  `vault://aliases`（resource）をRunnerに見せる経路がこのままでは無い

`docs/specs/v4-architecture.md` §2.5「Runner は実 Module に直接繋がない」・
§9・§10 item9、`docs/specs/v4-modules.md` §2.1 可視性の節に反映済み。

### PoC 06：resource/promptの代理（PoC 05で残った穴の解決）

ユーザーから「vault://aliasesに限らず、resource/promptを全体的に使えないのは
大問題では」という指摘を受けて追加実施。`poc/06-resource-prompt-relay/`で実測。

**結論：解決した。** 代理サーバを`createSdkMcpServer`（tool専用の高レベル
ラッパー）ではなく、`@modelcontextprotocol/sdk`の**低レベル`Server`**で組めば
resourceも代理できる。Agent SDK側の実装が`instance.connect(transport)`しか
呼ばないため、`instance`が高レベル`McpServer`である必要が無いと判明した
（実測3回とも成立）。

- **resourceの経路**：Runner（Claude Codeの実行系）はresourceを直接読まず、
  組み込みtool（`ListMcpResourcesTool`/`ReadMcpResourceTool`）経由で
  `resources/list`/`resources/read`を呼ぶ——banto側で同種のtoolを自作する
  必要は無い（Claude Code側が既に持っている）
- **promptはRunnerに届かない**（実測）：MCPのpromptは人が選ぶスラッシュ
  コマンドの領域で、`query()`のRunnerの会話には露出しない。§2.5のModule間
  中継（`prompts/get`の転送、host自身のClientが呼ぶ）は影響を受けない
- **新たに見つかった非対称**：toolは「代理サーバに登録しない＝存在しない」で
  守れるが、**resourceは`resources/read`にURIを直接指定されると、
  `resources/list`に載せていなくても読めてしまう**（実測で確認）。
  可視性判定は`resources/read`ハンドラの中でも行う必要がある
- **`canUseTool`（承認ゲート）はresource読み取りには一度も呼ばれない**——
  resourceの統制は代理サーバの中で完結させるしかない
- **`_meta`はそのままモデルへ渡る**——代理サーバが転送時に剥がす必要がある
- **実装上の留保**：`{type:'sdk', instance}`に低レベル`Server`を渡す形は
  SDKの型定義上は高レベル`McpServer`を要求しており、型としては正しくない。
  動く根拠は「SDKの内部実装が`connect()`しか呼ばない」という非公開の実装
  詳細で、SDKのバージョンが上がれば壊れうる。**起動時に`mcp_servers`の
  接続状態を検査し、代理サーバが`connected`にならなければ起動を拒否する**
  （規則2、Landlock ABI検査と同じ形）ことで対処する

`docs/specs/v4-architecture.md` §2.5・§10 item9、`docs/specs/v4-modules.md`
§2.1 可視性の節に反映済み。

### PoC 07：Landlock許可リストをPATHから動的に組む（A4の解決）

`poc/07-landlock-allowlist-from-path/`で実測。**PATH由来の動的allow-listは
機能した**——`node`/`npm`/`git`が全部動き、`~/.claude/.credentials.json`等の
資格情報は引き続き拒否された。

- **前提の一部は誤りだった**（正直な記録として残す）：「固定リストは
  `/usr/local/bin`を取りこぼす」は誤り——`/usr/local/bin`は`/usr`の部分木
  なのでこのマシンでは固定リストでも動いた。**実際に固定リストが壊れるのは
  PATHがホーム配下・`/opt`・`/snap`（nvm/asdf/Homebrew/snap）を指す環境**
  ——こちらは実際に再現して確認した
- **PATHのディレクトリだけでは足りない**：`npm`はsymlinkの実体が別ディレクトリ
  （パッケージ木）にあり、`.../bin`の兄弟`lib`/`lib64`/`libexec`/`share`も
  要る。最初`dirname(realpath)`で実装したところ`/usr`全体が静かに紛れ込み
  「動いた」ように見えるバグを踏み、直して測り直したら失敗するという経緯も
  正直に記録されている
- **`/dev`は読み取りだけでは足りない**：`git`が`/dev/null`を`O_RDWR`で開くため
  書き込みも要る（実測で発見）
- **消せないトレードオフ**：許可した`.../bin`の中に機微なファイルを置かれると
  読めてしまう。Landlock ABI 4にファイル単位の除外は無いため、「PATHに含める
  ディレクトリに資格情報を置かない」という運用上の前提に依存する

`docs/specs/v4-architecture.md` §2.7「許可リストの組み方」、
`docs/specs/v4-modules.md` §5 item2に反映済み。

## 2026-09-03：本実装着手前の最終確認で見つかった残りの論点

Phase 1（Vault・Shell・ファイル）着手前の最終チェックで、2件の未解決な
アーキテクチャ論点が見つかり、その場で解決した。

### Project の根をModule起動時に確定させる（新規発見・即日解決）

Landlockは不可逆（一度縛ったプロセスに後から許可を追加できない）。
一方アーキ仕様§2.5は「Projectごとの違いは引数の差で吸収する」という一般原則
を持っており、これがLandlockの制約と正面から衝突していた——tool呼び出し
ごとに違うProjectの根を渡す形は、Landlockを掛けた後のプロセスでは実現
できない。

**決定**：Shell・FileSystemに限り、Project単位でプロセスを分ける例外を
設ける。host はそのProjectで初めて要る Thread が動いたときに、Project の
根を渡してプロセスを spawn し、Module は起動直後にその根へ Landlock を
掛ける。他のModule（Vault等）はこれまでどおり banto全体で共有される単一
プロセスでよい。**これに伴い、`docs/specs/v4-architecture.md` §10 item9の
「Moduleプロセスの寿命をProjectに紐づけない」という記述も訂正**——元のMCP
仕様の引用が禁じていたのはThread/会話単位の話で、Project単位までは禁じて
いなかった。`docs/specs/v4-security.md`に反映済み。

### 第三者Moduleの信頼境界（§10 item9の残項目、決定）

`in-process`はbantoのプロセスで他人のコードが走ることになるので、**banto
自身が実装するModule一覧に含まれるものだけ`in-process`を使え、第三者が
持ち込むModuleはマニフェストの申告に関わらず`subprocess`へ強制する**、と
決定。判定はhostが持つ静的な列挙であって自己申告に委ねない（自己申告できる
なら信頼境界にならない）。`docs/specs/v4-architecture.md` §5に反映済み。

これで Phase 1（Vault・Shell・ファイル）着手のブロッカーは無くなった
（残るpackage type受け入れ範囲の決定は、Phase1の3Moduleの着手をブロック
しない）。Module間中継の承認ゲートのMock検証も別途実施した。
