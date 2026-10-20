# v4 デスクトップ版（Windows）——下書き

> **これは下書きである（2026-10-20、レビュー前。同日「インストールしない」を反映）。** 決まったのは §0 の「ユーザーが決めたこと」だけで、ほかは案。
> レビューと §9 の実測を経て決まったものから、この文書を「決まったこと」に書き換える。経緯と却下した案は
> `docs/notes/2026-10-20-desktop-windows.md`。
>
> 全体の構造は `docs/specs/v4-architecture.md`（以下「アーキ仕様」）。閉じ込めと実行場所は `docs/specs/v4-security.md`
> （以下「セキュリティ仕様」）§1。この文書は、その上に「Windows の PC で、コンテナ無しで、本体ごと動く」形を足す。

## 0. 何を作るか

### ユーザーが決めたこと（2026-10-20）

- **仕事で使うために、banto を本体ごと手元の PC で動く、完全に独立したデスクトップアプリにする。** サーバは要らない
- **会社の PC は Windows。** 殻は **Electron**
- **デスクトップ版ではコンテナで分離しない。** Module・AI のコマンド・サブエージェントは、PC の人のユーザー権限のまま直に動く
- **Claude へは個人のログイン**（Claude Code の OAuth ログイン。API キー・Bedrock・Vertex ではない）
- **インストールしないで使う**（2026-10-20 追加）。インストーラを作らず、展開したフォルダの banto.exe を起こすだけで動く（§7）

### 変えないもの（案）

- **core と Module の境界（MCP）・Event Store・Project / Thread / Memory・受信箱・画面のコード**は、サーバ版と同じものを使う。
  デスクトップ版のために core や画面を分岐（fork）させない。違いは「実行場所」と「Windows で動かない部品の別実装」に閉じ込める
- **サーバ版（Linux・コンテナ）はそのまま残る。** デスクトップ版はもう1つの組み立て方であって、置き換えではない

### 作らないもの（最初の段）

- 1台の PC の banto に、ほかの端末（携帯など）から入る道。デスクトップ版は 127.0.0.1 でしか待ち受けない（§3）
- Mac・Linux のデスクトップ版（Electron なので後から足せるが、試験と配布を Windows に絞る）
- WSL を前提にする形（WSL を入れられない会社の PC があるため。却下の理由は note）

## 1. 全体の形

```
banto.exe（Electron の main プロセス）
 ├─ 窓（BrowserWindow）：http://127.0.0.1:<core のポート>/ を開く
 ├─ トレイ・通知・タスクバーの件数（§6）
 └─ 子プロセス（同梱の node.exe で起こす）
     └─ core（host）：127.0.0.1:<core のポート>
         ├─ 画面（Next の静的な書き出し）も同じ口で配る
         ├─ Canvas の隔離用の口（別のポート。別オリジンが要る）
         └─ Module（実行場所「この PC」で直に起こす。§2）
```

- **core と画面は、Electron の内蔵の Node ではなく、同梱の node.exe で動かす。** Electron の Node は Electron の版で決まり
  （Electron の内蔵の Node は core が前提にしている版（今は Node 24）と揃うとは限らない——Electron の版ごとの Node の版は段0で確かめる）。別のサーバの実行場所が「host と同じ版の node を
  送る」と決めている（セキュリティ仕様 §1「向こうに置くもの」）のと同じ考え方。Electron の main は窓と OS との繋ぎだけを持ち、
  banto のロジックを持たない
- **画面は Next の静的な書き出し（`output: "export"`）にし、core が同じオリジンで配る。** サーバ版は画面を `next start` の別の
  プロセス（4175）で動かし、`/api` を repo の外の Caddy が core（4737）へ流している。デスクトップ版には Caddy が無いので、
  同じオリジンにすれば流す役が要らない。画面はほぼ全部が `"use client"` で、middleware・server actions・`cookies()` を使って
  いないので書き出せる。妨げは2つ：`app/(shell)/p/[projectId]/page.tsx` に `generateStaticParams` が無い（動的な道を、
  画面の中の道の読み替えにする）と、`next.config` の `headers()`（`frame-ancestors`・COOP）が書き出しでは効かない（core が
  配るときに付ける）。**Canvas の隔離の口は別のポートのまま**（別オリジンでないと sandbox が破れる）
- **ポートは起こすたびに空いているものを選ぶ**（固定の 4737 を使わない——PC にほかのアプリがある）。Electron の main が
  選んで core に渡し、窓に開かせる。画面が core を探す今の決め打ち（`apps/frontend/lib/backend/client.ts` の loopback なら
  `:4737`）は、同じオリジンなら自分の origin を使う形に改める
- **banto は1つしか起こさない**（Electron の `requestSingleInstanceLock`）。Event Store はファイルの錠を持たず、1つのプロセスが
  書く前提（`event-store/log.ts`、`events.jsonl` への追記）なので、2つ目を起こすと記録が壊れる。2つ目は1つ目の窓を前に出して終わる
- **データの置き場は `%LOCALAPPDATA%\banto`**（Event Store・設定・Module の置き場・Claude のアカウント）。ローミングする
  `%APPDATA%` には置かない（会社の PC で移動プロファイルに載ると大きく・遅くなる）
- **Project の根は人が選んだフォルダ**（`C:\Users\<人>\src\…` など）。根の正規化（セキュリティ仕様 §1「根の正規化」）は
  Windows のパスの規則で行う：ドライブ文字は大文字にそろえる、`\` で持つ、大文字小文字を区別しない比較にする、
  `\\?\` と UNC（ネットワークのドライブ）は最初の段では断る
- **core と Module を起こす node**：今は `process.execPath` を Module の `command` にし（`cli.ts` の `nodeExec`）、Repositories が
  git に渡す credential helper にも書いている。Electron の中ではこれが electron.exe になるので、core を同梱の node.exe で起こす
  （上）ことで、そのまま正しい値になる
- **core の寿命と、書き手が1つであること**（レビュー高）：core（node.exe）も Job Object の起動役で起こし、Electron が落ちたら
  core も止まるようにする。そのうえで、書き手が1つであることを Electron の錠だけに任せず、**core 自身がデータの置き場に排他の錠を
  取る**（取れなければ起きない。規則4——観測を機構の外に置く）
- **ポート**：起こすたびに変えると画面のオリジンが変わり、localStorage が毎回空になる。最初に選んだポートをデータの置き場に覚え、
  ぶつかったときだけ選び直す。選ぶのは core（`listen` で決まったポートを Electron に返す）——Electron が選んでから渡すと、間に取られうる
- **ログオフ・シャットダウン・スリープからの復帰**：`session-end` で core に畳ませ、`powerMonitor` の復帰で Module の生き死にを確かめ直す
- **閉じる**：窓を閉じてもトレイに残り、会話の走行・Service・待たない形のコマンドは続く。トレイの「終了」で core に
  畳ませてから（走行中のターンは止めたターンとして記録する——アーキ仕様 §2.3「止めたターンの記録」）子を止める

## 2. 実行場所「この PC」（コンテナ無し）

**セキュリティ仕様 §1「実行場所は core の中の差し替え口」に、3つ目の実装 `local-machine` を足す。** 別のサーバの実行場所
（`remote-machine`）が「向こうのユーザーのまま、コンテナ無しで Module を動かす」形をすでに持っているので、それを手元に
寄せたものと考える。

| 約束 | この機械のコンテナ | 別のサーバ | **この PC（デスクトップ版）** |
|---|---|---|---|
| 用意する | `incus init`／`start` | SSH で繋ぎ、コードと node を送る | 前提（§2.1）を確かめるだけ。送るものは無い |
| プロセスを起こす | `incus exec` | `ssh` | **直に `spawn`**（同梱の node.exe） |
| 確実に止める | host が切れば中も死ぬ | 向こうの systemd の単位 | **Windows の Job Object**（§2.2） |
| Project の根 | 同じパスでマウント | 向こうのフォルダ | そのまま（`pathInside` は同じ値を返す） |
| 中から banto に届く住所 | ブリッジのアドレス | 逆向きのトンネル | `http://127.0.0.1:<core のポート>` |
| host から中のソケットへ | 同じパス | SSH の転送 | **名前付きパイプ**（§2.3） |
| 資源の上限・見張り | Incus・cgroup | 作らない | **作らない**（設定の画面にも出さない） |
| Publish | ブリッジのアドレス | 向こうの LAN | **作らない**（§4） |

- **Project の記録の `runtime` は `local`**。`runtime-kind.ts` の `RuntimeKind` に `local-machine` を足す——足すと問いごとの
  `switch` が型で落ちるので、答えを1つずつ決める（根はこの機械のもの・コンテナは無い・眠らせる／閉じるときは Service を止める）。
  **ただし今の `runtimeKindOf` は `undefined` と `host-container` 以外を全部 `remote-machine` にする**ので、これも直す。さらに
  `runtime === "host-container"` を直に比べている所（`repositories/src/relay-client.ts:76`・`branch-sync.ts:87` など）は `switch` を
  通らず型で落ちない——grep で数えて全部を問いの関数に寄せる
- **デスクトップ版で選べる実行場所は「この PC」だけ**（最初の段）。この機械のコンテナは Windows に無い。別のサーバは §8 の後の段
  ——Windows に入っている ssh.exe（Win32-OpenSSH）は接続の多重化（`ControlMaster`）を持たず、今の別のサーバの実装の土台が使えない
- **`BANTO_IN_CONTAINER` は渡さない。** 代わりに `BANTO_LOCAL_MACHINE=1` を渡す（「banto が用意した箱ではなく、人の機械で直に
  動いている」）。Shell の待たない形など、今「箱の外の人の機械では断る」ものは、段1では今どおり断り、段2で §4 の形で動かす
- **中継の合言葉の刻印**：今は `inContainer` で「AI の手の届く側」を見分けている（セキュリティ仕様 §3）。この PC の Module も
  **同じ扱い**（AI の手の届く側）にする。ただし §2.4 のとおり、同じユーザーの AI は合言葉そのものを読めるので、これは誤りを防ぐ線で
  あって AI に対する境界ではない
- **Claude のログインの中継の送り元**（レビュー高）：サブエージェントは中継を Project の合言葉で使い、中継は送り元がその Project の
  コンテナかを `sourceMatches` で確かめる（`claude-login/relay.ts`）。この PC では全部が 127.0.0.1 から来るので、**今のままでは断られる**。
  `local-machine` では `sourceMatches` を「127.0.0.1 から来た」で通し、合言葉だけで見分ける（§2.4 の「守られなくなるもの」に入る）
- **渡す環境変数**：今どおり宣言の `env`・中継の住所と合言葉・置き場だけにし、host の環境は引き継がない。ただし Windows では
  `SystemRoot`・`windir`・`ComSpec`・`PATHEXT`・`TEMP`/`TMP`・`USERPROFILE`・`LOCALAPPDATA`・`APPDATA` が無いと動かない
  プログラムが多い（`SystemRoot` が無いと TLS もソケットも落ちる）ので、この一覧だけは引き継ぐ。`PATH` は §2.1 で決めたものを渡す

### 2.1 前提の確かめ

起こす前に確かめ、足りなければ名指しして直し方を添えて断る（セキュリティ仕様 §2「前提が欠けていれば、Module を起こさずに断る」と同じ）：

- **Git for Windows**（`git.exe` と `bash.exe`）——Shell・Repositories・Factory が使う（§4）。インストーラは同梱しない
  （会社の PC では IT 部門の配布物を使うことが多い）。見つける順：設定で人が指したパス → `PATH` の `git.exe` の隣 →
  `C:\Program Files\Git`
- **Claude Code の本体**：Agent SDK に同梱の Windows 向けの本体（`@anthropic-ai/claude-agent-sdk` の win32-x64 の本体）を
  アプリに入れて使う。人が入れたものには依らない
- データの置き場に書ける
- Windows の ssh.exe（OpenSSH クライアント）——会社の配布物から外されていることがある（§2.3 の git の ssh に使う）
- Project の根が OneDrive の下なら注意を出す（`.git` の同期がぶつかる・オンデマンドのファイルが手元に無い。§9 の13）

### 2.2 プロセスを確実に止める——Job Object

Linux では「プロセスグループに SIGTERM、だめなら SIGKILL」「cgroup ごと止める」で、孫まで止めていた。Windows には
シグナルもプロセスグループも無く、`child.kill()` は子だけを止めて孫（AI のコマンドが起こしたもの）を残す。

- **既存の差し替え口 `module-contract/src/work-scope.ts` の `inWorkScope`（Linux では `systemd-run --scope`。Shell・Subagent・
  Terminal・Browser が使う）の Windows 版として Job Object を入れる**（規則12）。今はコンテナの外では黙って組に入れずに起こす——
  Windows で組に入れられないときは、黙って素通しにせず断る（規則2）
- **Module・Shell のコマンド・Service は、それぞれ Windows の Job Object に入れて起こし、止めるときは Job ごと止める**
  （`TerminateJobObject`。Job に「閉じたら中を全部止める」を付けておけば、banto が落ちても孫は残らない）。node の標準
  ライブラリには Job Object が無いので、**小さな起動役の実行ファイル**（Job を作って中で目的のプロセスを起こし、標準入出力を
  そのまま繋ぐ）を同梱する。名前がある既知の答え（規則12）なので、自前で作る前に既存の実装を探す——§9 の実測項目
- 「止まってください」の段（SIGTERM に当たるもの）：stdio の MCP の Module は標準入力を閉じて伝え、数秒待って止まらなければ
  Job ごと止める。`CTRL_BREAK_EVENT` は、新しいプロセスグループで起こし同じコンソールを持つものにしか届かず、窓の無い起こし方では
  届かない見込み——Shell のコマンドに使えるかは段0で確かめる

### 2.3 Unix ソケットの代わり——名前付きパイプ

今 Unix ドメインソケットで繋いでいるもの（流れの口 `stream.sock`・Vault の鍵の窓口 `ssh-agent`・`socketDir`）は、
Windows では**名前付きパイプ**（`\\.\pipe\banto-<データの置き場の印>-<名前>`）にする。node の `net` は同じ口
（`listen(path)`・`connect(path)`）で名前付きパイプを扱える。

- **パイプには置き場のフォルダの権限（0700）という信用の根拠が無い**（レビュー中）：名前が予測できると、先に同じ名前を作られて
  成りすまされうる。名前に乱数を入れ、最初の1つは「先に誰かが作っていたら失敗する」形（`FILE_FLAG_FIRST_PIPE_INSTANCE`）で作る。
  node から付けられなければ、パイプの上で合言葉を確かめる
- **Vault の鍵の窓口（ssh-agent）を git に使わせる**：Git for Windows の ssh（MSYS の ssh）は名前付きパイプの agent に
  繋げない。Windows の ssh.exe（Win32-OpenSSH）は繋げる。git の `core.sshCommand` を Windows の ssh.exe にして渡す——§9 の実測項目

### 2.4 閉じ込めが無いことで成り立たなくなるもの（セキュリティ仕様 §1 との関係）

セキュリティ仕様 §1 は「Shell はアプリ層では縛れないので、OS の閉じ込めか隔離された実行環境が要る」と決め、Project の
コンテナを境界にしている。**デスクトップ版はユーザーの決定でこの境界を持たない**（§0）。仕様どうしが食い違ったまま
黙って作らないよう（規則8）、何が守られなくなるかをここに書き、セキュリティ仕様 §1 には「デスクトップ版はこの文書 §2.4 に
よる」と1行足す。

**守られなくなるもの**（AI のコマンドは人と同じユーザーで動くので、人が読めるもの・書けるものは AI も読める・書ける）：

- **データの置き場そのもの**（レビュー高）：AI は `%LOCALAPPDATA%\banto` を書き換えられる。ログインのリンク（`auth/login-links.ts`、
  前提は「データの置き場は host にしか無い」）を作れ、`events.jsonl` に許可の記録を書き足せる。同じユーザーのプロセスの環境変数・
  メモリも読めるので、中継の合言葉・画面の合言葉を取れる。**デスクトップ版ではログインのリンクを使わない**（§3）

- **Claude のトークン**：サーバ版はトークンを host にだけ置き、コンテナの中のサブエージェントには中継越しにしか使わせない
  （中継の `sourceMatches` が送り元をそのコンテナかで見る）。デスクトップ版では `%USERPROFILE%\.claude\.credentials.json` を
  AI が直に読める。中継の送り元の見分けも、全部が 127.0.0.1 から来るので効かない
- **Vault の鍵**：Vault（local）の age の鍵（`identity.txt`）・Infisical の資格情報を、AI が直に読める。「AI には alias 名だけを
  渡し、値を見せない」は、AI が言われたとおりにふるまう間だけ成り立つ
- **FileSystem の根の内外の判定**：判定はそのまま行うが、Shell で根の外に届くので、境界ではなく誤りを防ぐ印になる
- **0600・0700 による守り**：Windows では効かない（エラーにもならない）

**AI に対して効く守りは1つだけ**：Shell・FileSystem などの呼び出しを、**実行する前に**人が承認すること（アーキ仕様の承認）。
一度 Shell のコマンドを通したら、そのコマンドの中で何をされても止める仕組みは残らない。承認の既定（Shell を毎回聞くか）は §10 で
段1より前に決める。

**AI ではなく、外から banto を守るもの**：

- **127.0.0.1 の口の合言葉**（§3）：同じ PC のほかのユーザー・ほかのアプリ・ブラウザで開いたページから banto を操作させない
- **Host ヘッダの確かめ**：ブラウザのページが DNS の付け替え（DNS rebinding）で 127.0.0.1 の core に届くのを断る。core は
  `Host` が `127.0.0.1:<ポート>`・`localhost:<ポート>` 以外なら断る
- **Canvas の二重 iframe の隔離**（画面の中の境界。プロセスの境界とは別）

## 3. 画面と人のログイン

- **待ち受けは 127.0.0.1 だけ。** 今の core は `0.0.0.0` で待ち受けている（`cli.ts`。コンテナのブリッジから届くため）——デスクトップ版は
  127.0.0.1 にする。 人のログイン（パスキー・端末の追加・ログインのリンク、セキュリティ仕様 §3「人のログイン」）は
  デスクトップ版では使わない。画面の「ログイン中の端末」「端末を追加」も出さない（規則13）
- **それでも合言葉は要る**：127.0.0.1 は同じ PC のほかのユーザー・ほかのアプリからも届く。Electron の main が起こすたびに
  乱数の合言葉を作って core に渡し、窓（だけ）にセッションの Cookie として入れる。窓の外のブラウザで 127.0.0.1 を開いても
  入れない
- **HTTPS の門**（セキュリティ仕様 §3「画面は HTTPS でしか動かさない」）は、localhost は安全な文脈なので今のままで止まらない
- **窓の中で開くのは banto の画面だけ。** 外のリンク（会話の中の URL・公開サイト）は人の既定のブラウザで開く
  （`setWindowOpenHandler`・`will-navigate` で止めて `shell.openExternal`）。Canvas の二重 iframe の隔離（画面仕様）は今のまま
- 窓の中の移動は `will-navigate`（一番上）と `will-frame-navigate`（iframe の中）の両方で止める。Canvas がカメラ・マイク等を
  求めたら `setPermissionRequestHandler` で断る
- Electron の窓は `contextIsolation: true`・`sandbox: true`・`nodeIntegration: false`。画面に渡す口（preload）は通知と
  件数を渡す2つだけにする（§6）

## 4. Module ごとの扱い

| Module | デスクトップ版の扱い | 段 |
|---|---|---|
| FileSystem | ほぼそのまま。根の内外の判定を Windows のパス（ドライブ文字・`\`・大文字小文字・ジャンクション）に合わせる。画面（`ui/browser.ts`）が `startsWith("/")` で絶対パスを判じているのを直す。Office の変換は Documents に頼るので、段 1 では PDF と画像だけ | 1 |
| Shell | **コマンドは Git Bash（`bash.exe -c`）で流す**（今は `/bin/sh -c`、`run-command.ts`。AI が書くコマンドの書き方を変えずに済む）。tool の説明文の「/bin/sh -c」は AI に見せる契約なので、デスクトップ版では「Git Bash（Windows）」と書き、パスの書き方（`C:\` と `/c/`）を添える。時間切れは SIGTERM の代わりに Job Object。秘密の一時の置き場（今は `/run/user/<uid>`）はデータの置き場の下へ。**待たない形（今は systemd-run）は段 2**：Shell が自分で起こし（Job Object）、出力はファイルへ。banto を終了すると止まる | 1（待たない形は 2） |
| Subagent | Claude Code（ACP）はそのまま。Claude Code の Bash 道具は Git Bash を使う（無ければ PowerShell 道具に落ちる——Claude Code の決まり）。止め方（`process-group.ts` の `kill(-pid)` と `/proc/<pid>/stat`）は Job Object に替える。子に渡す環境に §2 の Windows の必須の変数を足す。OpenCode は目録に Windows 向けの本体を足す（今は `opencode-linux-x64` だけ） | 1 |
| Backlog | git の低い層のコマンドだけで、ほぼそのまま | 1 |
| Skills | ほぼそのまま。取り込むとき、Windows で使えないファイル名（`CON`・`NUL` などの予約名、`:` など）を断る | 1 |
| Vault（directory） | そのまま | 1 |
| Vault（local） | **別実装が要る**：`mkfifo`・外のコマンド（sops・age-keygen）・ssh-agent の Unix ソケット・`${HOME}` に依っている。sops と age は Windows 向けの本体を同梱するか、age を JS の実装に替える（§9）。ssh-agent は §2.3 | 1 |
| Vault（Infisical） | `${HOME}` を既定にしているのを直す。ssh-agent は §2.3 | 2 |
| Repositories | **最初に直すものがある**：台帳（`ledger.ts`）が `startsWith("/")` でなければ例外を投げ、Windows では1件登録した時点で台帳が読めなくなる（`isAbsolute` に）。ssh の鍵のパスを `/^\/…$/` だけで受けている。git の credential の窓口が Unix ソケット（§2.3）。実行場所を `runtime === "host-container"` で見ているところに `local` を足す | 1 |
| Factory | 試験を `/bin/sh -c` で流している（`engine.ts`）→ Shell と同じく Git Bash。止めるのは Job Object。worktree の深いパスは git の `core.longpaths` | 1 |
| Service | 中核が systemd のユーザーの単位で、待ち受けを `ss -ltnH` で調べている。小さな見張り役（落ちたら起こし直す・banto を起こしたときに起こす・Job Object で止める）に替え、待ち受けは別の方法で調べる | 2 |
| Terminal | tmux の制御モードに全面的に依っている。ConPTY（Windows の疑似端末。node-pty などでネイティブの依存が増える）の別実装。画面（xterm）は流用できる | 3 |
| Browser | Xvfb に画面ありの Chrome、GStreamer・PulseAudio・apt に依っている。「見えない画面で画面ありのブラウザ」に当たるものが Windows に無いので、方針から決め直す（候補：Edge を画面無しで起こし、CDP の screencast（JPEG）だけで映す——動画と音は外す） | 3 |
| Documents | bubblewrap・root・`/usr/bin/soffice`・pdftoppm・apt に依っている。外すか、LibreOffice と poppler の Windows 版で作り直す | 3 |
| Publish（Caddy・ディレクトリ） | **作らない。** 開発サーバは人が `http://localhost:<ポート>` を直に開ける | — |
| Python のデモ・試しの Module | 外す | — |

**全 Module に共通**：

- `process.kill(-pid)`（プロセスグループに送る）は Windows では何も止めず、エラーも握りつぶされる。使っているところ（Shell・
  Subagent・Factory・Documents・core の終わりの片づけ）は、**共通の「子孫ごと止める」口**（module-contract に置く。Linux では今の
  プロセスグループ、Windows では Job Object）を通す
- `HOME`・`XDG_*` の差し替えは Windows の道具には効かない（`USERPROFILE`・`APPDATA`・`TEMP` を見る）。Shell の専用のホーム
  （セキュリティ仕様 §2、ユーザーの決定）をデスクトップ版でどうするかは §10 で人に決めてもらう（分けると、下の git の資格情報・
  `~/.ssh` の問題も小さくなる）
- **banto が起こす git には `credential.helper` を空にし、`core.autocrlf=false` を付ける**（レビュー中）：Git for Windows は既定で
  人の資格情報マネージャ（`credential.helper=manager`）を使うので、AI の `git push` が人の会社の資格情報で黙って通る・ログインの窓が
  出る。`core.autocrlf=true` も既定で、ファイル全体が差分になる。Shell の環境でどうするかも §10
- 宣言の `confinement: landlock` など、閉じ込めを名乗る印は、デスクトップ版の画面では「閉じ込め無し」と正直に出す

- 外す・後の段の Module は、デスクトップ版の目録に出さない（規則13）。出すのはその段で動くものだけ
- Shell の既定を Git Bash にする理由と、PowerShell にしない理由は note に残す。PowerShell は後から「Project ごとに選ぶ」で
  足せる形にしておく（§10 の未決）

## 5. core の領域ごとの扱い

| 領域 | 扱い |
|---|---|
| 実行場所 | §2 の `local-machine` を足し、デスクトップ版ではそれだけを使う。Incus・SSH の実装は組み立てに入れても起こさない。`cli.ts` には「置き場が無ければ host で直に起こす」道がすでにある（banto 全体の同梱 Module）——それを Runtime の口の実装として整える |
| Project の始め方・眠らせ方 | `project-start.ts` が git を sh の関数で呼び `GIT_CONFIG_GLOBAL=/dev/null` を渡している → git を `execFile` で直に呼ぶ。眠らせる（`project-sleep.ts`）はコンテナを止める代わりに Module を畳む |
| 流れの口（`http/streams.ts`・`stream-server`・`module-contract/src/stream.ts`） | Unix ソケットと `ws+unix:///proc/self/fd/<fd>/…`、0700 の置き場を信用の根拠にしている → 名前付きパイプ（§2.3）。Browser・Terminal の画面はこの上に載っている |
| 待ち受け・終わり方 | `0.0.0.0` → `127.0.0.1`。Host ヘッダの確かめを足す（§2.4）。SIGTERM・SIGINT での片づけを関数に切り出し、Electron の「終了」から core の口で「畳んで」と頼む（Windows の子には SIGTERM が届かない） |
| 人のログイン（`auth/service.ts`） | パスキー・端末の追加は使わない。Electron が起こすときに渡した合言葉からセッションを出す口を足す（§3） |
| 設定の置き場（`config/bootstrap.ts`） | XDG のパス → Electron が `BANTO_CONFIG_PATH` で渡す。**重なりの判定 `isAncestorOrEqual` が `"/"` を繋いで比べていて、Windows では重なりを見落とす**（不具合。`modules/root-scope.ts` も同じ形） |
| ディレクトリの一覧（`http/directories.ts`） | `~/` と `/` からの1本の木 → ドライブの一覧・`~\`・予約名 |
| Module を入れる（`modules/registry/install/npm.ts`） | `execFile("npm")` は Windows では `npm.cmd`。配布物に npm を入れるかは §10 |
| エージェントの本体（`agent-binaries`） | 目録に Windows 向けを足し、CPU の見分け（今は `/proc/cpuinfo` の AVX2）に OS の軸を足す |
| Claude のログイン・アカウント | そのまま。置き場は `%USERPROFILE%\.claude\.credentials.json`（人の CLI と同じ）と、banto の置き場のアカウント。**Windows で CLI が資格情報をどこに持つか（ファイルか、資格情報マネージャか）は §9 で実測**して合わせる |
| Claude の中継（使用率で切り替え） | そのまま（127.0.0.1 の HTTP） |
| 自己更新（`self-update`） | git の pull と組み立て直しは使わない。**アプリの更新**に替える（入れ替え方は §7・§10 の未決。electron-updater は zip の形を更新できない）。画面の「更新」はこれを呼ぶ |
| 資源の見張り・混み具合（`resources`・`host-health`・`container-pressure`） | `/proc` と cgroup に依るので**外す**。画面の「資源」・混んでいる印も出さない |
| Event Store・射影の保存 | SQLite ではなく JSONL の1ファイル（`events.jsonl`、追記ごとに fsync）と、射影ごとの `*.snapshot.json`（一時ファイル → rename）。**ディレクトリを開いて fsync する所（`log.ts` の `init` から必ず呼ぶ・`snapshot.ts`・`images/store.ts`）は Windows では開けず、直さないと core が起きない見込み**（win32 では飛ばす）。上書きの rename は、Defender などがファイルを掴むと `EPERM`・`EBUSY` で失敗するので、短くやり直す（回数は §9 の実測で決める。Claude のアカウント・エージェントの本体の置き場も同じ） |
| 実行場所を移す・Project のグループとスリープ | 移すは作らない（実行場所が1つ）。スリープは Module を止めるだけになる |

## 6. Windows との繋ぎ（Electron の main）

- **受信箱に来たら OS の通知**（Electron の `Notification`）。押すとその会話を開く。出すのは受信箱に新しく入ったものだけ
  （アーキ仕様 §2.4「受信箱は『あなたの番になったもの』だけ」）。**Windows の通知には、AppUserModelID と ToastActivatorCLSID を持つ
  スタートメニューのショートカットが要る**（Electron の手順書。インストーラがあれば作るもの）。インストールしないので、設定の
  「通知を出す」を入れたときに、banto が人のスタートメニュー（`%APPDATA%\Microsoft\Windows\Start Menu\Programs`）にショートカットを
  作る。切ったら消す。フォルダを動かしたら作り直す（ショートカットの先が切れるため）。通知が出せないときは、画面の件数とタスクバーの
  件数だけになることを設定に出す
- **タスクバーのアイコンに件数**（`setOverlayIcon`）とトレイの件数
- **ログイン時に起こす**かは人が設定で選ぶ（既定は起こさない。入れたら `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` に
  今のフォルダの `banto.exe` を書く）
- **プロキシ**：Windows のプロキシの設定（WinINET）を読んで、core・Module・Claude Code に `HTTPS_PROXY`・`NO_PROXY` として渡す。
  設定で上書きできる。PAC・WPAD・認証の要るプロキシ（NTLM）は段0で確かめる
- **会社の TLS の検査**（レビュー高）：社内のルート証明書は Windows の証明書ストアにあり、Node と Claude Code は既定ではそれを見ない
  ——**Claude にまったく繋がらない**ことがある。core・Module・Claude Code に `NODE_OPTIONS=--use-system-ca`（効く版か段0で確かめる）か
  `NODE_EXTRA_CA_CERTS` を渡す

## 7. 組み立てと配布

- **インストーラは作らない。配るのは zip に固めたフォルダ**（ユーザーの決定）。人は好きな場所に展開して `banto.exe` を起こす。
  管理者の権限も、レジストリの「アプリと機能」への登録も要らない
  - electron-builder の `portable`（1つの exe）は使わない——起こすたびに中身を `%TEMP%` に展開するので、約 1GB（大半は
    エージェントの本体と依存）だと起動が遅く、ウイルス対策が毎回全部を調べる
  - **アプリのフォルダには書かない**（ダウンロード・OneDrive の下・読み取り専用の場所に置かれうる）。データは今どおり
    `%LOCALAPPDATA%\banto`（§1）。フォルダを消せばアプリは消え、データは残る
  - **人のプロファイルに書くのは2つだけ、どちらも人が設定で入れたとき**：通知のためのスタートメニューのショートカット
    （§6）と、ログイン時に起こすための `HKCU\...\Run`。切ったら消す
- **中身**：Electron・node.exe・core と Module の `dist` と依存・画面の組み立て（Next の静的な書き出し）・Claude Code の
  Windows 向けの本体・Job Object の起動役。ネイティブの npm 依存（node-gyp で組むもの）は Windows 向けに組んだものを入れる
- **組み立てと試験は GitHub Actions の Windows のランナー**で行う（Linux から Windows 向けにネイティブの依存を組むのは避ける）
- **組み立ての台本を Windows でも通る形にする**：`scripts/build-all.mjs` が `spawnSync("npm")` を shell 無しで呼ぶ（Windows では
  `npm.cmd`）。各 `package.json` の `test` がシングルクォート（cmd.exe では文字として渡る）。`.gitattributes` が無い（`*.sh eol=lf`）。
  `install.sh`・`scripts/update.mjs`・`prebuilt.mjs`・`restart-when-idle.mjs` はデスクトップ版では使わない（zip の配布とアプリの更新に置き換える）
- **ネイティブの依存は今は無い**（node-gyp で組むものは無く、sharp・swc・Agent SDK には win32 向けの組んだものが lock にある）。
  Terminal の ConPTY（段 3）で初めて増える
- **パスの長さとファイルの数**：asar は Electron の fs からしか読めず、**同梱の node.exe で動く core と Module は asar から読めない**。
  core と各 Module を esbuild 等で1ファイルに束ね、`node_modules` の深さを無くす（260 字の問題・zip の展開の時間・Defender の走査が減る）
- **コードの署名**：署名の無い exe は SmartScreen に止められ、会社の PC では起こせないことがある——§10 の未決
- **更新**：GitHub の Releases に zip を出し、アプリが起きたときと1日1回見る。electron-updater はインストーラの形が前提で
  zip の形を更新できない。入れ替え方は §10 の未決（案：新しい版の zip を取って署名とハッシュを確かめ、今のフォルダの隣に
  展開して「更新して再起動」で入れ替える。今のフォルダに書けなければ、展開した場所を開いて人に入れ替えてもらう）

## 8. 段階

| 段 | 中身 | 終わりの印（計測） |
|---|---|---|
| 0. 実測 | §9 の項目を Windows の実機で確かめる | 各項目に結果と、決めたことが note に書いてある |
| 1a. 本体が Windows で起きる | node.exe で core と画面（静的な書き出し）・実行場所「この PC」・core の錠・ファイルの書き込みの直し・パスの不具合・FileSystem・Backlog。窓は Edge で開く（Electron はまだ） | 開発用の VM（Defender 有効・管理者なし・日本語のユーザー名）で core が起き、Edge から Project を作って AI が FileSystem でファイルを直せる。会話・承認・FileSystem の spec を Windows のランナーで 5 回中 5 回通す |
| 1b. コマンドとサブエージェント | Job Object（`inWorkScope` の Windows 版）・名前付きパイプ・Shell（Git Bash）・Factory・Subagent（中継の扱い）・Vault・Skills・Repositories・git の設定 | 同じ条件で AI が Shell でコミットし、サブエージェントが1回走り、Repositories で clone と push ができる。Shell・Subagent の spec を 5 回中 5 回通す。banto を強制終了したあと、孫のプロセスが 0 個 |
| 1c. デスクトップアプリになる | Electron の殻・zip の配布・Windows のランナーでの組み立てと E2E の移植 | zip を展開した `banto.exe` から 1a・1b と同じことができる。Electron を強制終了したあと core と孫のプロセスが 0 個で、次に起こしても Event Store が壊れない |
| 2. 毎日使える（入る条件：§10 の署名と更新の入れ替え方が決まっている） | Service・OS の通知・タスクバーの件数・トレイ常駐・アプリの更新・プロキシ | 窓を閉じても走行が続き、受信箱に来たものが通知で出る。新しい版を Releases に出すと、アプリから更新できる |
| 3. 残りの Module | Terminal（ConPTY）・Browser（CDP の画面の流れ）・Documents の代わり・別のサーバの実行場所 | 各 Module の E2E が Windows のランナーで通る |

## 9. 実測すること（段 0）

規則12・規則15 に従い、作る前に Windows の実機で確かめる：

1. Agent SDK の Windows 向けの本体で、`tools: []`（組み込みの Bash を切った形）・MCP だけの会話の1ターンが通るか。Git for Windows が無くても通るか
2. Claude Code が Windows で資格情報をどこに置くか（`.credentials.json` か、Windows の資格情報マネージャか）。banto のアカウントの置き場（`CLAUDE_CONFIG_DIR` を替える形）が効くか
3. Job Object の起動役：既存の実装（npm・小さな Rust/Go の実行ファイル）があるか。banto が落ちたときに孫まで止まるか
4. 名前付きパイプを Vault の ssh-agent の窓口にし、`git push` が Windows の ssh.exe で通るか
5. Event Store の書き替え（一時ファイル → rename）が、Defender が有効な PC で連続して通るか（1万回で何回失敗するか）
6. Vault（local）の sops・age：Windows 向けの本体を同梱する形と、age を JS の実装に替える形を、同梱する本体の数と Defender での扱いで比べる
7. 会社の PC と同じ条件（管理者の権限なし・プロキシあり）で、署名の無い zip を展開した `banto.exe` が起きるか（ダウンロードした
   zip に付く印（Mark of the Web）・SmartScreen、人が書ける場所の exe を止める規則（AppLocker・WDAC））
8. 会社の TLS の検査（社内のルート証明書）・PAC・認証の要るプロキシのもとで、core と Claude Code が Claude・GitHub に届くか
9. 日本語や空白を含むユーザー名・パスで、Git Bash・git・Claude Code が動くか。cp932 の出力が化けないか（`core.quotepath` も）
10. Defender が有効なとき、Shell の1コマンド（起動役 → bash.exe）の遅れ。zip をエクスプローラで展開する時間・ファイルの数・260 字で失敗するか
11. core を強制終了したとき、2つ目の core が起きてしまわないか（core の錠が効くか）
12. Electron で `http://127.0.0.1` に `Secure` の Cookie が入るか。Claude の OAuth のログイン（localhost に戻る形）がインストールしていない Electron から通るか
13. Project の根を OneDrive の下に置いたときに何が起きるか
14. （段2の前でよい）自分で作ったスタートメニューのショートカット（AppUserModelID つき）で、インストールしていない Electron の通知が出て、押すと
   アプリに戻るか

## 10. まだ決まっていないこと

- **AI の繋ぎ方**：開発用の Windows の VM（ユーザーが用意する——§0）に ssh で入る形の案が `docs/notes/2026-10-20-windows-dev-vm.md`。
  組み立てと E2E は GitHub Actions の Windows のランナー
- **【段1より前に決める】AI に対する境界**（レビュー高、§2.4）：承認だけが AI に効く守り。Shell の呼び出しをデスクトップ版では
  毎回承認にするか
- **【段1より前に決める】外から足した Module**（レビュー高）：セキュリティ仕様 §1 は「banto 本体で動くのは banto 自身のコードだけ。
  外から足した Module はコンテナに入れる」（ユーザーの決定）。コンテナの無いデスクトップ版は**同梱の Module だけ**にするか。
  下の npm はこれに従う
- **Shell の専用のホーム**（セキュリティ仕様 §2、ユーザーの決定）をデスクトップ版でも作るか。Shell の環境の git の資格情報も
- **画面のモック**：デスクトップ版にしか無い画面（Git のパス・通知・ログイン時に起こす・プロキシ・閉じ込め無しの表示・更新）を、
  段1c・段2の前にモックで見るか
- **コードの署名**：証明書を用意するか（会社の PC の規則で、署名の無い exe を起こせるか——§9 の7）
- **更新の入れ替え方**：§7 の案でよいか。今のフォルダに書けないときにどうするか
- **Shell の既定**：Git Bash で決めてよいか。PowerShell を Project ごとに選べるようにするか
- **要件との食い違い**：`docs/requirements.md` の E1 は「Web アプリ／PWA」と書いている。デスクトップ版を要件に足す書き方を人と決める
  （この下書きでは要件を書き換えていない）
- **配布物に npm を入れるか**：外から Module を足す（registry から入れる）には npm が要る。入れなければ、デスクトップ版は同梱の Module だけになる
- **サーバ版との行き来**：デスクトップ版の Project をサーバ版へ（または逆へ）移す口を作るか。最初の段では作らない
- **会社の PC で AI に渡してよい範囲**：コンテナが無いので、AI のコマンドは人の権限で PC 全体に届く。承認の既定（何を聞かずに
  通すか）をデスクトップ版では厳しめにするか
