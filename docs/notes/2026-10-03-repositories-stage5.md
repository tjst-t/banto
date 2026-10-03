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

## レビューを受けて直したこと（2026-10-03、Fable のレビュー 14件）

push の経路そのもの（refspec・hooks・helper・URL に秘密を置かない）は堅いと確認された。直したのは時間差と見分け方。
上の節のうち、ここで変わったものは仕様（§2.4）が正。

- **push の直前に読み直す**（高）：押した時点の確かめのあと、`.git/config` は書き換えうる（Project の Root はコンテナに
  mount され、中の AI が書ける）。push の直前に `pushBlockers` をもう一度読み、`remote get-url --push --all origin` が組んだ
  URL の1行だけであることを確かめる。**残る窓**（読み直してから git が push の中で設定を読むまで）は §3 にそのまま書いた。
  試験は push の直前の差し込み口（`PUBLISH_HOOKS.beforePush`）で `.git/config` を書き換える
- **submodule への再帰 push**（高、レビューの実測）：`push.recurseSubmodules=on-demand` は submodule をその remote へ
  push し、親の確かめを迂回する（同じ host なら一度きりの窓口がトークンを渡す）。`writeEnv` に
  `push.recurseSubmodules=no`・`submodule.recurse=false` を足した。**どちらか片方だけでも止まる**（実測：
  `push.recurseSubmodules=no` だけを外しても、環境の `submodule.recurse=false` が後から読まれて再帰しない）。両方を外すと
  試験が落ちる。二重の止めとして両方残す
- **資格情報の種類で見分ける**（中）：インストールが読めるかで App のトークンかを当てていたので、読めてしまう PAT を
  「App が入っていない」と誤って断りえた。アカウントの `credential.kind`（pat／app）を渡し、App のときだけインストールを
  見る。試験の App のアカウントは、`ghu_` のトークンを PAT として登録していたのをやめ、ブラウザでログインで登録した
- **push のやり直しで方式が食い違う**（中）：origin が ssh なのに SSH 鍵の無いアカウント（逆も）だと、資格情報が渡らず
  「資格情報が通りませんでした」と嘘を言っていた。push の前に断り、理由を言う
- **公開範囲を描画の中で書き換えていた**（中）：公開のものしか作れない持ち主を一度選ぶと、ほかを選んでも「公開」に
  貼りついた。描画では状態を変えず、効いている公開範囲は関数で導く。持ち主・アカウントを替えたら既定（非公開）に戻す
- **作れたか分からないとき**（中）：要求を送ったあとに切れた・時間切れ・5xx で「名前が使われています→-2」に誘導して
  いた（自分の作ったものを使われていると言い、二重に作らせる）。「作れたかどうか分かりません。GitHub で確かめ、あれば
  git remote add origin …」と言い、名前の確かめ直しは名前がぶつかったときだけ
- そのほか：始める前に「やめる」を見る・origin を足している間のやめる、持ち主の名前の形、origin の URL は GitHub の返事
  から、頼んだ公開範囲で作られなければ止める、Project の入口は Root の一番上を git に聞いて一致する行だけ、台帳に書けない
  ときは段を分ける、Organization ごとの問い合わせを並べる
- **`remote.origin.mirror=true`** は、明示の refspec と組むと git が断るので push しない側に倒れる——試験で固定した
  （ほかのブランチ・タグは届かない）
- **直さなかったもの**：check_publish_name の候補探索（レビューで「そのままでよい」）

### 踏んだこと

- **試験の中で `execFileSync` の `git submodule add` が止まった**（10分）——偽の GitHub は同じプロセスで動くので、同期で
  待つと答えられない（段階2で踏んだのと同じ形）。生死を見て気づいた。偽物に話しかける git は非同期で、20秒で切る
- **E2E の段階3の試験が、別々の場所で4回中2回落ちた**（規則6）。機械が重い時間（別のセッションの大きな E2E と並行）に
  出た。どちらも前の段階からある非同期の順番の不具合だった：
  - 新しいリポジトリの画面：打ったときの確かめ（300ms 後の予約）が、欄を離れたときの「GitHub に聞く」確かめより後に
    走り、結果を上書きして同じ名前の注意を消していた。欄を離れたら予約を取り消す
  - 置き場を既定に戻す：一覧の読み直し（置き場の設定も読む）が戻す前に始まり、戻したあとに返ると古い置き場で
    上書きしていた。置き場を書いたら、それより前に始まった読み直しの置き場は使わない
  - 直したあと 6回中6回通った。待ちは延ばしていない
- E2E の実行番号（ポートの枠）は Playwright の pid そのもので、片づけ役がその pid を見張る。`BANTO_E2E_RUN_ID` を
  自分で決めると片づけ役がすぐに core を止める（Terminated）。ポートの枠が別の実行と重なったら、回し直すしかない

### 試験（レビュー後）

- Module 94本（`publish.test.ts` 12本）。新しい壊し 14か所のうち 13か所が落ちる（生き残りは上の submodule の片方——
  両方を外すと落ちる）
- E2E：Repositories の spec 7本（3.4分）。段階5の試験に、偽の GitHub が受けた持ち主・公開範囲と Organization への作成を
  足した。壊して落ちることを1か所（画面が非公開を頼まない）
