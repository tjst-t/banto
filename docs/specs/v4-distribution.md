# v4 配布——ソースを閉じ、組み立てた物だけを配る（下書き）

> **これは仕様の下書きである。** 決まったことだけを書き、決まったらこの文書を更新する。
> 検討の経緯（規約の読み・使用量の見積もり・レビュー）は `docs/notes/2026-10-21-closed-distribution.md`。
>
> 関係する仕様：アーキ仕様 §2.5「画面から banto を更新する」「組み立て済みのものを使う」、セキュリティ仕様 §1「入れ方」・
> §2「banto 本体の Claude ログインは、中継で共有する」「Claude のアカウントを複数持つ」、デスクトップ版の下書き
> `v4-desktop.md`（ブランチ fork/desktop-windows）§5「自己更新」・§7「組み立てと配布」。
>
> 最終更新：2026-10-24（レビューを反映。署名は repository secret で Actions が行う——ユーザー決定）

## 用語

- **自分用の版（self）**：ソースを持つ本人が自分で組み立てて使う版。サブスクも API キーも使える
- **公開版（dist）**：一般に配る版。Claude は API キーだけ
- **目録（manifest）**：公開版の1つの版に含まれる物の一覧（名前・大きさ・sha256）。署名して配る
- **組み立て済み（prebuilt）**：自分用の版の更新を速くするため、release の commit ごとに CI が組み立てて置く物（アーキ仕様 §2.5。今のもの）
- **updater**：版を入れ替える `scripts/update.mjs`（今動いている版の中のもの）

## 0. 何を作るか

### ユーザーが決めたこと（2026-10-21〜24）

- **ソースは非公開にする。** 今の公開リポジトリ `tjst-t/banto` を非公開にする。公開サイト banto.tjst-t.dev は残す
- **組み立てた物だけを、一般に無償で配る。** サーバ版とデスクトップ版の両方
- **公開版の Claude は API キーだけ。** サブスク（Claude の Free・Pro・Max のログイン）は公開版に入れない。サブスクで動くのは
  自分用の版だけ
- **置き場は公開の配布用リポジトリ `tjst-t/banto-releases` の GitHub Releases。** 利用規約・第三者のライセンス・Issue の窓口もそこ
- **公開版の版はタグで付け、タグを付けたものだけを配る。** 人の操作はタグを付けることだけ（§6）
- **署名の鍵は非公開リポジトリの repository secret に置き、Actions が署名まで行う**（2026-10-24）。AI・Factory・毎晩の自動修正が
  push した workflow から鍵を使える弱さは承知のうえ（§6「守りと残る危険」）
- **CI**：公開版はタグのときだけ GitHub のランナーで組み立てる。自分用の組み立て済みは banto-dev-vm の自分のランナーに移すが、
  **リポジトリを非公開にした後**（§8）

### なぜ公開版からサブスクを抜くか

Anthropic の文書（2026-10-21 に読んだ。引用はノート）は、承認なしに第三者の製品が claude.ai のログインを出すこと、利用者に
代わってサブスクの資格で通信を流すこと、Claude.ai の資格情報を集める・保存する・中継することを認めていない。banto の今の
サブスクの扱い（台帳・置き場・中継・取り直し）はこれに当たりうるので、公開版には入れない。**設定のスイッチではなく組み立てで
コードごと抜く**——スイッチなら配った物の中にログインが残る。規約の解釈はここまでで、法的な判断はしていない。

### 作らないもの（最初の段）

- 有償の版・ライセンスの鍵
- 難読化（束ねて縮めるだけ。§2「ソースの守り」）
- arm64・macOS・Linux のデスクトップ版（今の banto は x64 だけで動かしている——`agent-binaries.ts`・組み立て済みのネイティブの部品）
- Windows のコード署名の証明書（お金。デスクトップ版の段2で別に決める）
- 自分用の版から公開版へ、データを移す道

## 1. 全体の形

| | 自分用の版 | 公開版 |
|---|---|---|
| ソース | 非公開の `tjst-t/banto` | 持たない |
| Claude | サブスク（今の台帳・中継）と API キー | API キーだけ |
| 版の名前 | release の commit | タグ（`v2026.10.22` の形、§5） |
| 入れ方・更新 | 今の install.sh・updater（取ってくる先が非公開のリポジトリになる、§7） | 署名つきの目録を見て落とす（§6・§7） |
| 組み立て | 今の tsc の組み立て（そのまま） | 束ねて縮める組み立て（§2） |

- **同じソース・同じ commit から、組み立て方の違う2つの物を作る。** コードは1本。サブスクに関わる部分を「自分用の版のときだけ」の
  印で囲み、公開版の組み立てで消す
- 開発の流れ（main・release・毎晩の自動修正・Factory・判断役）は非公開のリポジトリの中でそのまま回る
- **release に入る＝本人の host に入る、タグを付ける＝一般に配る**。タグを付けるのは人（外への公開）

## 2. 公開版の組み立て——束ねて、抜いて、確かめる

### 束ねる

- 今の組み立ては tsc で、`.d.ts`・`.map`・コメントをそのまま出す。**公開版には新しい組み立ての段を作る**：core と各 Module
  （Module はそれぞれ別のプロセスで動く）を、プロセスの入口ごとに esbuild で1つに束ね、縮め、ソースマップを付けない。
  ネイティブの部品と、手を加えない第三者の package（Agent SDK・claude-agent-acp 等）は束ねずに `node_modules` に置く
- 画面（Next.js）は組み立ての時に `NEXT_PUBLIC_BANTO_EDITION` を埋め込み、サーバ側も含めて同じ印で分ける。`.next` の
  ソースマップは出さない
- 印は `BANTO_EDITION`（`self` | `dist`）。esbuild の `define` で定数にし、`dist` で通らない分岐を消す。自分用の版は今の tsc の
  組み立てのまま（印の既定は `self`）

### 公開版で抜くもの

| 何 | 場所 |
|---|---|
| サブスクのログインの口と画面（「アカウントを足す」・ログインし直し） | `claude-login/account-login.ts`、設定の画面 |
| トークンの取り直しと置き場（`.credentials.json`）を読むこと | `claude-login/refresh.ts`・`accounts.ts` |
| 5時間・週の枠の表示、枠で選ぶ・切り替える仕組み、429 でアカウントを替えて送り直す道 | `select.ts`・`usage-view.ts`・`relay.ts` |
| 空いた会話のキャッシュの温め直し（予算をサブスクの使用率で決めていて、API キーではお金になる） | `keep-alive.ts` |
| コンテナに `CLAUDE_CODE_OAUTH_TOKEN`・`CLAUDE_CODE_SUBSCRIPTION_TYPE`・`CLAUDE_CODE_RATE_LIMIT_TIER` を渡す道 | Subagent・Terminal・Service |
| Subagent の `envSecrets` に claude.ai の資格情報を入れる道（`credentialEnv` の `CLAUDE_CODE_OAUTH_TOKEN`、説明の例、表示名）——**規約に一番近いので最優先** | `subagent/src/agents.ts`・`server.ts`・`ui/settings-view.ts` |
| install.sh がその場で `claude auth login` を流す段 | 公開版の install.sh には無い（§7） |
| Project 設定の「Claude のログインを使わせる」等の文言、手順書・サイトの手順 | 画面・`docs/runbooks`・`site` |

### 抜けたことの確かめ

- 公開版の組み立ての最後に、**banto 自身の出力**（束ねた core・Module・`.next`）に決めた文字列（`claudeAiOauth`・`/v1/oauth/token`・
  `CLAUDE_CODE_OAUTH_TOKEN`・`oauth-2025-04-20` 等）が無いことを調べ、あれば落とす
- 手を加えずに同梱する Anthropic の本体（Agent SDK とその中の Claude Code の本体・claude-agent-acp）は調べる範囲から除く。
  それらはサブスクのログインを持っているが、利用者が自分で手を加えていない本体にログインすることは規約が妨げない。banto は
  それを使わせる道を持たない（下の「閉じた側に倒す」）

### 閉じた側に倒す

- Agent SDK の CLI は、資格情報の環境変数が無いと `~/.claude/.credentials.json` を自分で読む。**公開版では、中継の合言葉が無ければ
  Runner もサブエージェントも起こさない**（本人がその機械で `claude` にログインしていても、それで動かない）
- 利用者が Terminal・Shell で自分で `claude` にログインして使うのは止めない。そのシェルにも合言葉の環境変数が入るので、
  シェルの `claude` は API キーの中継で動く（本人のログインは使われない）。これは狙いどおりとする

### ソースの守り

束ねて縮め、ソースマップを付けないところまで。画面の JavaScript とコンテナの中の Module のコードは利用者の手元に届くので、
読まれることは防げない。守りの本体は利用規約（§4）。

## 3. 公開版の Claude——API キー

- **API キーのアカウント**：Claude のアカウントの台帳に種類 `api-key` を足す。キーは Vault に置き、台帳には alias だけ
  （キーは台帳にも Event Store にも書かない）。自分用の版でも使える
- **中継**：Runner とコンテナには合言葉を **`ANTHROPIC_AUTH_TOKEN`** で渡す（`Authorization: Bearer` で送られる。`ANTHROPIC_API_KEY`
  で渡すと `x-api-key` で届き、中継が外して 401 になる）。中継は上流へ出すとき `Authorization` を外して `x-api-key` を差し込み、
  `anthropic-beta: oauth-…` を付けない。`CLAUDE_CODE_SUBSCRIPTION_TYPE`・`CLAUDE_CODE_RATE_LIMIT_TIER` は渡さない。
  **キーはコンテナに入らない**
- **使用量**：API キーには 5時間・週の枠が無い。メーターは使ったトークン（入力・出力・キャッシュの書き・読み）と金額の目安。
  金額の目安の値段の表は banto に版つきで持つ（出どころと更新の仕方は §10）
- 初めて起こしたとき API キーが無ければ、画面がキーを入れるところへ導く（Claude Console へのリンクつき）

## 4. 配布用リポジトリ `tjst-t/banto-releases`

- `README.md`（入れ方・公開サイトへのリンク）・`EULA.md`（利用規約：無償・再配布の禁止・無保証。逆コンパイルの禁止は LGPL の
  部品を除く文言にする、§10）・`SECURITY.md`・Issue のテンプレート（ログを貼るときに秘密を伏せる案内つき）
- 既定のブランチに ruleset を掛け、push できるのを本人だけにする（公開のリポジトリでは無料）
- Release `v…` ごとに：
  - `banto-<版>-linux-x64.tar.zst`（サーバ版）
  - `banto-<版>-win-x64.zip`（デスクトップ版。デスクトップ版の仕様の段1c 以降）
  - `THIRD_PARTY_NOTICES.txt`（組み立てで依存から作る。LGPL の libvips は別ファイルのまま同梱、MPL の部品は手を加えない。
    Anthropic の package はその LICENSE の文を載せる）
  - `manifest.json` と `manifest.json.sig`
- 最新は GitHub の `releases/latest` から引く（pre-release は入らない。試験は §7 の差し替えで pre-release を指す）

## 5. 版とタグ

- タグは `v<年>.<月>.<日>`（同じ日の2つ目からは `.<n>`、例 `v2026.10.22.1`）。非公開のリポジトリの release の commit に付ける
- 版の並べ方：年・月・日・`n`（無ければ 0）を数として順に比べる
- `manifest.version`＝タグ＝ファイル名の版。どれか1つでも違えば入れない
- 画面と `GET /api/admin/update` の「今の版」：公開版はタグ、自分用の版は今どおり commit

## 6. 組み立てと署名（CI）

`.github/workflows/distribute.yml`（非公開のリポジトリ）。`v*` のタグの push でだけ走る。GitHub のランナー。

1. **タグが release から辿れるか**を確かめる（`git merge-base --is-ancestor <タグ> origin/release`）。辿れなければ止める
2. 公開版を組み立て、単体テストを流し、§2 の抜けたことの確かめをする
3. tar・zip・THIRD_PARTY_NOTICES・目録を作り、目録に **ed25519 で署名**する（鍵は repository secret `DIST_SIGNING_KEY`、鍵の id を目録に入れる）
4. 配布用リポジトリに Release を作って置く（書く鍵は repository secret `RELEASES_TOKEN`：`banto-releases` の Contents の書き込みだけを持つ
   fine-grained トークン）

**目録** `manifest.json`：`{ version, keyId, publishedAt, minUpdaterVersion, assets: [{ name, platform, size, sha256 }] }`。
公開鍵（鍵の id つき、2つまで持てる）は install.sh とアプリに埋め込む。

### 守りと残る危険（ユーザーが承知した）

- repository secret は、非公開のリポジトリのどのブランチの workflow からも読める。Factory・毎晩の自動修正・AI のエージェントは
  このリポジトリに直接 push するので、**それらが書いた workflow が鍵を使って署名・公開する、または鍵を持ち出すことはありうる**。
  非公開のリポジトリの無料のプランでは、environment の人の承認・environment の secret が使えないため、これ以上は GitHub の
  仕組みで守れない
- 歯止め（確実ではない）：
  - workflow はタグのときだけ走り、1. でタグが release から辿れることを確かめる
  - 毎晩の自動修正と Factory の指示に「`.github/workflows/` を触らない」と書く
  - 新しい版の公開は配布用リポジトリの Release の通知で本人に届く（身に覚えのない公開に気づける）
- **鍵が漏れたとき**：新しい鍵を作り、新しい公開鍵（新しい鍵の id）を入れた版を古い鍵で署名して出し、その次の版から新しい鍵だけで
  署名する。updater は埋め込んだ公開鍵のどれかで確かめられた目録だけを受ける

## 7. 入れ方と更新

### 公開版——サーバ

- **入れ方**：`curl -fsSL https://banto.tjst-t.dev/install.sh | bash -s -- …`。**install.sh は公開サイト（Cloudflare Pages）から
  直に配る**（`site/public/install.sh`。配布用リポジトリに置くと、書く鍵1本で install.sh と中の公開鍵を書き換えられるため）。
  install.sh は目録を取り、署名と sha256 を確かめ、tar を `versions/<版>` に展開する。git・npm の組み立ては要らない（Node は今どおり
  版を固定して入れる）。その場で Claude にログインする段は無い
- **版の見分け方**：`versions/<版>/.banto-version.json`（`{ version, manifestSha256 }`）。`current`・`previous` のリンクは今のまま
- **更新**：updater の段のうち、取ってくる・組み立てるを「目録を見る・落とす・確かめる・展開する」に替える。git に立つところ
  （`repo.git` の worktree・HEAD で版を見分ける・`merge-base` で release から辿れるかを見る）は公開版では版の印と並べ方に置き換える。
  待つ・起こし直す・確かめる・手元の `previous` へ戻すは今のまま
- **今より新しい版しか入れない**（§5 の並べ方。目録の出し直しで古い版へ戻されるのを防ぐ）。手元の `previous` へ戻すのは人が画面で選ぶ
  別の操作で、これとは混ぜない
- `minUpdaterVersion`：目録が求める updater の版。今の updater の版がそれより古ければ入れず、install.sh の打ち直しを案内する
- 更新を見たのに最新の `publishedAt` が 90 日より古ければ、画面に「新しい版が出ていません」と出す（止められているのに気づくため）
- Release の説明は署名の外にあるので、画面では文字のまま出す（リンクにしない）
- **試験の差し替え**：目録の取り先（`--dist-base`）と公開鍵（`--dist-pubkey`）を、今の `--prebuilt-base` と同じ形で差し替えられる

### 公開版——デスクトップ

- 同じ目録を、起きたときと1日1回見る。zip を落として署名と sha256 を確かめ、今のフォルダの隣に展開して「更新して再起動」で入れ替える
  （`v4-desktop.md` §7 の案。今のフォルダに書けないときの扱いはそちらの未決のまま）

### 自分用の版——非公開のリポジトリから取る

- git の fetch は**読むだけの deploy key**（SSH）。組み立て済みの取得と画面の `GET /api/admin/update` は**読むだけの fine-grained
  トークン**（`tjst-t/banto` の Contents・Actions の読み取り）で、GitHub の API の asset の口（`Accept: application/octet-stream`）から取る
  （非公開のリポジトリでは鍵なしの `releases/download` で取れない）。鍵が2本なのは、git は SSH で、API は HTTPS のトークンでしか読めないため
- トークンはソースを読めるので、ソースと同じ重さの秘密として `/etc/banto` に root 0600 で置く。期限の 14 日前から受信箱に知らせる。
  切れたら更新は理由を出して止まる（組み立て済みが取れなければ今どおりその場で組み立てる——git は deploy key で読める）
- **入れ方の入口**：自分用の版の install.sh は非公開のリポジトリにだけ置く。本人は手元の clone から流すか、`gh` で取って流す
  （公開サイトの1行は公開版を指す）

## 8. 非公開に切り替える順番

1. **API キーと版の分け**（§2・§3）を main で作り、release に入れる。本人の host は自分用の版のまま動く
2. **公開版の組み立てと配り方**（§4〜§7）。配布用リポジトリを作り、タグで pre-release を出し、新しい VM に入れて API キーで会話できる・
   次の版に更新できる・`previous` に戻せることを確かめる
3. **自分用の版の取り方**（§7）を作り、本人の host を deploy key とトークンで取る形にする（まだ公開のまま。公開でも鍵で取れる）
4. **今の公開版の利用者への案内**：最後の公開の版（git で取る版）に、画面で「次から入れ方が変わります」と出す。git で入れた host は、
   非公開にした後は更新が「取ってこられません」で止まるので、その文に新しい install.sh の打ち直しを書く
5. **外に見えるものを替える**：公開サイトの GitHub へのリンク（ヘッダ・「このページを編集」・トップ）を配布用リポジトリへ、
   install.sh・runtime-setup.sh を公開サイトから直に配る形へ、README を配布用リポジトリへ。サイトと画面（Subagent のエージェントの
   表示名を含む）の「Claude Code」の表記を、Anthropic の呼び名の決まり（Claude Code を名乗らない・似せない）で見直す
6. **Cloudflare Pages が非公開のリポジトリから組み立てられるか**を確かめる（できなければ、サイトの組み立てを Actions から直に上げる形に替えてから）
7. **リポジトリを非公開にする**（人がする）
8. **自分のランナー**を banto-dev-vm に置き、組み立て済み（`prebuilt.yml`）を移す。非公開にした後にする（公開のリポジトリに自分の
   ランナーを繋ぐと、外の人の PR の workflow がその機械で走りうるため）。ランナーは1回ごとに使い捨て（`--ephemeral`）、専用の
   ユーザーで、`/etc/banto`・Claude の資格情報・SSH の鍵・データ置き場を読めないことを確かめる。個人のリポジトリではランナーを
   使える workflow を絞れないので、どのブランチの workflow でもラベルを書けば走る——これは残る危険として受け入れる

## 9. 試験

- 単体：版の並べ方・目録の確かめ（署名・sha256・版の一致・新しい版だけ）・合言葉が無ければ起こさない・中継の `x-api-key` の差し込み
- 組み立て：公開版の組み立てで、決めた文字列の確かめが通る・落ちる（わざと残した印で）
- E2E：偽の API で API キーのアカウントの会話。公開版の install.sh と更新は、差し替えた取り先と公開鍵で新しい VM（または
  コンテナ）に入れて確かめる

## 10. まだ決まっていないこと

- API キーの使用量の上限と知らせ方（月の目安・越えたときの出し方）、金額の目安の値段の表の出どころと更新の仕方
- EULA の文面（法的な確かめは人）。逆コンパイルの禁止を LGPL-2.1 の部品（libvips）を除く文言にする
- Anthropic の package（Agent SDK・claude-agent-acp・同梱の Claude Code の本体）を tar に入れて配ってよいかの確かめ
- 取ってきて使う OpenCode の版が、Claude のサブスクのログインを出していないかの確かめ（出しているなら公開版では使わせない）
- 自分用の版で API キーとサブスクを並べたとき、どちらを先に使うか
- arm64 をいつ足すか（非公開のリポジトリでは GitHub の arm64 のランナーが無料でない見込み——未確認）
