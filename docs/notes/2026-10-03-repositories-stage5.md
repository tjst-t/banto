# Repositories Module の段階5——GitHub に公開（2026-10-03）

仕様は `docs/specs/v4-modules.md` §2.4「GitHub に公開」、`docs/specs/v4-security.md` §3「banto 本体で動く Module が
GitHub に push する」。段階4は `2026-10-03-repositories-stage4.md`（ユーザーが確かめて決定：置き場の外は消せない・
Project が使っていれば名前を打たせる・reflog は「数えていない」）。ここは**なぜそうしたか・却下した案・踏んだこと**の記録。

**作業の場所**：運用ルール（ユーザー決定・2026-10-03）で、この段階から Fork の開発は共有の作業ツリーではなく
worktree（`.worktrees/repositories-publish`、ブランチ `fork/repositories-publish`、main の c38e1aff から）で行った。
build・E2E・コミットはすべて worktree の中。

## 範囲

- 公開の画面：一覧の「このマシンにだけ」の行の「GitHub に公開」（ダイアログ）、GitHub の行の「…」→「GitHub への
  push」、Project の画面の入口「この Project を GitHub に公開」（launcher）
- 決めるもの：アカウント・持ち主（自分・Organization）・名前・公開範囲・説明
- する事：空のリポジトリを作る → origin → いまのブランチを upstream つきで push → 台帳。push の失敗では作ったものを
  消さず、push だけやり直せる

## 決めたこととその理由・却下した案

### どの Project か——host の刻印（`forProject`）で

依頼は「Project の画面からどの Project かを知る口は、既存の Canvas の hostContext `dev.banto/project` を調べて使う」。
調べた結果：hostContext の `dev.banto/project` は `{id, name}` だけで Root を持たず、**画面が自分で言う値**。一方、
Thread の画面・Project の画面から押した呼び出しには host が `{admin: true, forProject: <id>}` を刻む（core の
`beginCanvasCall`、2026-09-28 から）。Module はこの刻印の Project を中継の `relayListProjects` で引いて Root を得る。
- 却下：hostContext の id を画面が Module に渡す——画面は別の Project の id を名乗れる（今は Module 自身の画面なので
  害は小さいが、刻印があるのに申告を使う理由が無い）
- banto 全体の設定から開いた入口（刻印に Project が無い）は「Project の画面の中で開くか、一覧から」と言う
- Root がリポジトリの下のフォルダ（monorepo）でも、そのリポジトリの行を引く（段階4の「使っている Project」と同じ見方）

### origin がもうあるなら断る

選択肢は「断る」「別の名前の remote（`github` 等）にする」。**断る**を採った：台帳は origin を正としてリモートの場所を
覚える（§2.4、段階1）。別名の remote を足すと「この行のリモートはどこか」が2つになり、一覧・clone し直し・削除の
「リモートに無いブランチ」の見方がずれる。GitHub の外の origin を持つリポジトリを GitHub にも置きたいなら、人が
remote を整理してから（ミラーは今の範囲の外）。

### 「作れるアカウント」の見分け

依頼は「書けるアカウントだけ」。GitHub には「このトークンでリポジトリを作れるか」を直接聞く口が無いので、分かるものだけ
分かる形にした：
- classic PAT：`GET /user` の `X-OAuth-Scopes`（`repo` なら作れる、`public_repo` だけなら公開のものだけ）
- GitHub App のユーザーのトークン：`GET /user/installations` の、その持ち主のインストールの `permissions.administration`
- Organization：`GET /user/memberships/orgs/{org}` の role が admin なら作れる。メンバーは `GET /orgs/{org}` の
  `members_can_create_repositories`
- **fine-grained PAT は前もって知る口が無い**——「作ってみるまで分からない」（`unknown`）と言って選ばせる。却下：
  分からないものも外す——fine-grained PAT のアカウントでは何も公開できなくなる。作れないと言い切れるもの（`no`）だけ外す
- 押して断られたら、GitHub の言葉（`Resource not accessible by integration` 等）を、何をどこで足すかに読み替える

### 送るのはいまのブランチだけ

モックには「ほかのブランチも送る」の切り替えがあったが、入れなかった——ほかのブランチを送るかは公開の後でも決められ
（`git push`）、最初の公開で送るものを増やすと、間違えて公開したくないブランチを公開範囲「公開」で出してしまう。
画面は「ほかのブランチ（…）は送りません——あとで git push で送れます」と言う。§2.4 の「まだ決めていないこと」に
「ほかのブランチを送る手」を置いた。

### push の送り先・TLS を変える設定があれば push しない

clone（段階3）は clone の前にリポジトリの設定が無いので、人の設定の段を読まなければ済んだ。push はリポジトリの
`.git/config` を読む——そこはフォルダを置いた人が書ける。`url.<x>.insteadOf`・`pushInsteadOf`・`remote.origin.pushurl`
は送り先を同じ GitHub の別のリポジトリに変えられ、一度きりの窓口は「相手（protocol と host）」で絞っているので、同じ
github.com の別のリポジトリへはトークンが渡る。`http.proxy` と `http.sslVerify=false` を組めば TLS を外して読ませられる。
- 却下：環境（`GIT_CONFIG_*`）で上書きする——git の設定は環境から「無し」にできない（足すだけ。`pushurl` は複数持てるので、
  足すと両方へ送る）
- 採った：`config --get-regexp` でリポジトリの段だけを読み（`writeEnv` の環境なので人の段は読まない）、あれば断って
  `git config --unset` で外すよう言う。`http.sslVerify` は環境で true に上書きもできるが、`sslCAInfo` 等は上書きの値が
  決められないので、まとめて断る

### 作ったものを消さない・やり直せる状態はフォルダから

依頼どおり、push に失敗しても作ったリポジトリは消さない。やり直せるかは「origin が GitHub で、いまのブランチが origin に
まだ無い」で導く——「push に失敗した」という印を台帳に置かない（規則3。人が手で push したら、印だけが嘘になる）。
このため、公開の後に作った新しいブランチでも「GitHub への push」から push できる（同じ見方なので）。

## 踏んだこと

- **段階1からの不具合：detached HEAD のリポジトリが一覧で「読めません」になっていた**。`readFolder` は
  `symbolic-ref -q` の「code 1 かつ stderr が空」で detached を見分けていたが、`git()` は stderr が空のとき失敗の文言
  （Command failed: …）を入れて返すので、条件が成り立っていなかった。`symbolic-ref -q` は detached で 1、本当の失敗で 128
  （実測）なので、終了コードだけで見るようにした。公開の判断（detached は断る）を試験していて見つけた。段階4の削除の
  数え方は `readLosses` で別に見ているので影響していなかった
- **公開の画面の関数 `chosenAccount` が、clone の画面の同じ名前の関数を黙って上書きした**——画面の script は1つの scope で、
  同じ名前の関数宣言は後のものが勝つ。clone がアカウント無しで走り、非公開の clone が「資格情報が通りませんでした」に
  なった。単体試験（Module の中の clone）は通り、**E2E の段階3の試験だけが落ちた**。helper に一時的に記録を書かせて
  「helper が一度も呼ばれていない」を確かめ、帯の「別のアカウントで clone する」案内から「アカウント無しで始まった」と
  分かった。公開の画面の関数は `pb` で始め、**同じ名前の関数宣言が2つあれば落ちる試験**を足した（壊して落ちるのを確認）
- 偽の GitHub に push を受けさせた：`git http-backend` は `REMOTE_USER` があるときだけ receive-pack を受けるので、
  資格情報と書き込み権（持ち主・writers）を確かめたうえで `REMOTE_USER` を渡す
- 一覧の入口の spec が `/リポジトリ/` でパレットの項目を引いていて、新しい入口「この Project を GitHub に公開」の説明
  （「…のリポジトリを…」）にも当たる形だった（項目の名前に説明文も入る）。`/^リポジトリ/` にした。ほかの spec には当たらない
  （grep で確認）
- push のやり直しのボタンが無いとき、E2E が click の5分待ちで落ちた（壊して確かめたとき）。押す前に見えることを見て
  5秒で落ちる形にした

## 試験

- Module：88本（`publish.test.ts` 6本、server の入口・刻印・同じ名前の関数の3本を足した）。壊して落ちることを23か所で
  見た（断る4・push を止める設定2・送るもの2・トークンを origin に入れる・やり直せる状態・台帳・やり直しの条件・名前の
  ぶつかり2・持ち主の見分け3・App の断りの読み替え・刻印・Root の下のフォルダ・コミットが無いとき・やめる・detached の
  直し・同じ名前の関数）
- E2E：`e2e/specs/repositories.spec.ts` に1本（全体で7本、1.5分）。1本目の「まだ作っていない」を、公開の画面が開いて
  アカウントが無いと言う形に改めた。壊して落ちることを2か所（公開の警告・push だけやり直すボタン）
- core・画面には触っていない（`forProject` の刻印は 2026-09-28 からある）。全 workspace の型検査は通った

## 残したこと

- 公開したあと、ほかのブランチを送る手（いまは人が git push で）
- origin を足す前に失敗して GitHub にだけ空のリポジトリが残ったとき、それを origin にする手（文言で `git remote add` を
  案内するだけ）
- SSH 鍵のアカウントでの push は、段階3の clone と同じく ssh のコマンドの組み立てまでを試験している（偽の GitHub は ssh を
  話さない）。本物の GitHub での確認が要る
- 既にある Project を Canvas から開く口
