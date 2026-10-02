# Repositories Module の段階3——URL から clone・新しいリポジトリ（2026-10-02）

仕様は `docs/specs/v4-modules.md` §2.4「始める3つの手」「core との境目」、`docs/specs/v4-frontend.md` §6.2
（`dev.banto/open-new-project`）。段階1・2は `2026-10-01-repositories-stage1.md`・`2026-10-02-repositories-stage2.md`。
ここは**なぜそうしたか・却下した案・確かめたこと**の記録。段階2は本物の GitHub で動いた（ユーザーが GitHub App を作り、
ブラウザでログインと Import ができた）。

## 段階3の範囲

- 一覧（入口・設定の面）の「URL から clone」「新しいリポジトリ」。一覧の行の「clone し直す」「Project を始める」も繋いだ
  （段階1の「まだ作っていない」はこの2つから消えた。「GitHub に公開」は段階4）
- clone：GitHub（アカウントの PAT・ブラウザでログイン・SSH 鍵・アカウント無し）と GitHub の外（このマシンの git の設定）
- 新しいリポジトリ：置き場に `git init`
- 「Project も作る」（既定オン）：用意したあと core の新しい Project の画面をフォルダ入りで開く——banto の拡張
  `dev.banto/open-new-project` を足した
- clone の進み具合と時間切れ・やめる

## 決めたこと（仕様に書いたもの）とその理由・却下した案

### トークンを git に渡す道——一度きりの unix socket と credential helper

却下した案：
- **URL に埋める**（`https://user:token@github.com/…`）——ps に出るうえ、clone 先の `.git/config` の origin に残る
  （その後 AI が Project のコンテナで読める）
- **`GIT_ASKPASS` の助け手にトークンを環境で渡す**・**`http.extraHeader` を `GIT_CONFIG_COUNT` で渡す**——どちらも
  `/proc/<pid>/environ` に平文で出る（同じ持ち主なら読める・`ps e` で見える）。依頼の「環境に平文で残さない」に反する
- **一時ファイルに書いて helper が読む**——落ちたときに平文がディスクに残る

採ったのは：Module が clone の間だけ unix socket を立てる（持ち主だけが入れる一時フォルダ）。git の
`credential.helper` は `"<node>" "<dist>/git-credential-helper.js" "<socket>"`——**引数は socket の場所だけ**。git が
`get` で protocol と host を渡すと、helper が socket に問い、Module は**決めた相手（protocol と host）にだけ**
username（login）と password（トークン）を返す。clone が終わったら窓口を閉じ、フォルダごと消す。
`credential.helper` は段階2で「空」に潰してあるので、同じ段で「空 → この helper」と順に並べて、この Module の helper
だけにする（ほかの helper——人の gh 等——には聞かない）。

**踏んだこと**：unix socket のパスは 108 字まで。`os.tmpdir()` はこの環境（banto のサブエージェントの home の下）で
長く、`listen EINVAL` になった。`XDG_RUNTIME_DIR`・`/run/user/<uid>`・`/tmp` の順で短い場所に置く。

### 段階2で潰した設定との関係（§2.4 に書いた）

clone も読む口と同じ潰し（`GIT_CONFIG_OVERRIDES`）から始め、**資格情報の渡し方だけを明示して上書きする**（`writeEnv`）：

| 相手 | credential.helper | core.sshCommand |
|---|---|---|
| GitHub・アカウントの PAT／ログイン | 空 → この Module の helper | 潰したまま |
| GitHub・SSH 鍵のアカウント | 空 | Vault の ssh-agent の窓口だけを使う ssh |
| GitHub・アカウント無し | 空（公開のものだけ） | 潰したまま |
| GitHub の外 | **このマシンの設定のまま** | **このマシンの設定のまま** |

GitHub の外を「このマシンの設定のまま」にした理由：clone の前にはリポジトリの設定（`.git/config`）がまだ無く、
効くのは人がこのマシンに置いた設定（ユーザー・システムの段）だけ。段階2で潰したのは**よそのリポジトリの設定**から
コードが走るのを止めるためで、人の設定を疑うためではない。`core.hooksPath=/dev/null`・`core.fsmonitor=false` 等は
GitHub の外でも潰したまま——clone の checkout で、この機械のテンプレートの hooks を走らせない（試験：テンプレートに
post-checkout を置いた home で clone して何も走らず、潰さない git では走る）。

潰しは環境の `GIT_CONFIG_*` で渡す——`git clone -c` で渡すと、clone 先の `.git/config` に書き残る。

### clone は背景の仕事・画面が聞きに来る

clone は何分もかかる。画面の呼び出し（tool）の中で待つと、core の画面の呼び出しの上限（10分）に掛かるうえ、進み具合
を返せない。MCP の progress（`notifications/progress`）は core の画面の呼び出しの道（`/api/ui-tool-call`）が画面へ
運ばない。なので **`start_clone` は仕事を始めてすぐ返し、画面は `clone_status` を 0.6 秒ごとに聞く**（段階2の
デバイスフローの「画面が聞きに来る」と同じ形）。

- Vault（`tokenFor`・`startSshAgent`）は `start_clone` の呼び出しの中で使い終える——背景の仕事から Vault を呼ぶと
  人の画面の外の呼び出しになり、中継の承認に掛かる（段階2と同じ理由）
- **全体の時間の上限は置かず、git が5分何も言ってこなければ切る**（`--progress` で進み具合を言い続けるので、
  大きいリポジトリでも切れない。黙ったまま——相手が答えない・認証で止まった——だけを切る）
- 失敗・時間切れ・やめたときは、途中まで作ったフォルダを消す（始めたときは空いていた場所で、clone の間は
  `reserved` で同じ場所に2つ置かない）
- 終わった仕事は10分覚える（画面が結果を取りに来るまで）

### 「Project も作る」——`dev.banto/open-new-project`

段階1で「Project の列は名前だけ（押して開かない）」とした理由（Canvas から banto の画面を動かす口が無い）と同じ壁。
MCP Apps の仕様に近いものは無い（`ui/open-link` は http/https を別タブで開くだけ、`ui/message` は会話に書くだけ）。
`dev.banto/view-state` と同じ名前空間に、**最小の request** を足した：`{folder, name?}` を受けて、外枠が持つ
`RequestedNewProjectDialog`（中身は人がレールで開くのと同じ `NewProjectDialog`）を Root パスと名前入りで開くだけ。

- **作らない**——作るのは人が「作成する」を押したとき（§2.4「core に Project を作る口は足さない」）
- **人の操作の直後でなくても開く**——clone は数分かかる。ダウンロード（`ui/download-file`）は直後でなければ banto が
  確かめるが、ここは開いた画面そのものが確かめになる
- core は頼んできた Module を名指ししない（どの Module からでも同じ）
- 却下：**URL のパラメタ（`?new-project=…`）で開く**——Canvas から banto の URL を変える口がやはり要り、結局同じ拡張が要る

### 新しいリポジトリのブランチ名

**このマシンの git の設定（`init.defaultBranch`）があれば従い、無ければ `main`**。却下：「git に任せる」（設定が
無いと `master` とヒントの文言になり、GitHub の既定 main と公開のときに食い違う）・「main に固定」（人が `trunk` 等を
決めているのに上書きする）。読むために `git config --get init.defaultBranch` を走らせてよいサブコマンドに足した。

### 細かいこと

- 断る URL：手元のパス・`file://`・`git://`・`ext::`・`-` で始まるもの（git に option と読ませない——clone は `--` の
  後に URL を置く）・資格情報入り
- 偽の GitHub から clone したものの origin を GitHub と読むため、行き先を替えたとき（`BANTO_REPOSITORIES_GITHUB_URL`）
  だけ `registerGithubHost` でその host を足す
- clone し直すとき、アカウントは台帳が覚えている login を先に選ぶ
- clone したら使ったアカウントを台帳に書く（持ち主と違っても——選んだのは人）
- GitHub に同じ名前があるかは、登録したアカウントごとに `GET /repos/<login>/<name>`（そのアカウントの使える
  トークンで。確かめられなければ、そう言う。作るのは止めない）

## 確かめたこと

- 偽の GitHub を本物の git の smart HTTP にした（`git http-backend` を CGI で動かす。GitHub と同じく、資格情報が無ければ
  401、見えなければ 404 の「Repository not found.」）。単体試験と E2E で同じ偽物を使う
- 単体：Module 61本（段階3で足したもの：`clone.test.ts` 10・`credential-server.test.ts` 1・`server.test.ts` 1、
  `git.test.ts` の一覧の固定を更新）。clone の試験は**最中に `/proc/*/cmdline`・`/proc/*/environ` を全部読んで**トークンが
  無いこと、台帳・返り値・clone 先の `.git/config`・ログにも無いことを見る
- frontend：`canvas-new-project.test.ts` 2本
- E2E（`repositories.spec.ts` 4本、Repositories の spec だけ・フルは回していない）：置き場を試験の一時フォルダに
  替えてから、公開の clone（アカウント無し）・もう手元にある・非公開をアカウント無しで（「資格情報が通りません
  でした」と次の手、フォルダは残らない）・PAT を登録して同じものを clone（行にアカウント）・clone 先の設定と全部の
  フレームにトークンが無い・フォルダを消して一覧の「clone し直す」・新しいリポジトリ（ぶつかり・`-2`）・「Project も作る」で
  core の画面が Root パスと名前入りで開き、作成して Project が開き、一覧の行に Project 名。1本目の「Project を始める」も
  core の画面を開く
- **E2E が本物の不具合を拾った**：「Project も作る」を外してもボタンの言い方（「clone して Project の作成へ」）が
  変わらなかった（チェックの変化で描き直していなかった）
- **E2E の待ちを固定の秒数で書きかけた**（Vault の目録を読み終えるのを1秒待つ）——規則6。目録を読み終えた印
  （`data-choices="loaded"`）を画面に付けて、それを待つ形にした
- 段階2の E2E が Vault に PAT を残す（外しても PAT は残す決まり）ので、段階3の E2E はそれがあれば選び、無ければ貼る
- **壊して落ちることを確かめた**（Module）：窓口が相手を見ずに渡す・トークンを helper の引数に入れる・clone で
  hooksPath を潰さない・失敗したフォルダを残す・黙った clone を切らない・もう手元にあるかを見ない・ぶつかる名前を
  避けない・SSH 鍵を使わない・ブランチ名を main に固定・`file://` を受ける・資格情報入りの URL を受ける・使った
  アカウントを覚えない・トークンで clone しない・**窓口を閉じない**（最初は「失敗」ではなく試験のプロセスが止まる形
  だった——開いたままの socket がプロセスを生かしていた。窓口の server を `unref` して、閉じ忘れが失敗として出るように
  した）。画面：受け取る値の確かめを外す。E2E：banto 側の `dev.banto/open-new-project` の受け口を外すと「「Project を
  始める」で core の新しい Project の画面が開かない」で落ちる
- 壊す確かめを途中で止めた回が、資格情報の窓口のフォルダを `/run/user/<uid>` に残した（試験のプロセスごと止めたので
  片づけが走らなかった）。試験は「前からあるもの」を数えず、この clone の分だけを見る形にした
