# 2026-10-20 別のサーバの Project の Backlog の push を Repositories が引き受ける（Backlog #466）

仕様は `docs/specs/v4-modules.md` §2.4「ブランチを送る口」の「別のサーバの Project」（と §4.4 Backlog の「Vault の SSH 鍵で送る」、
`docs/specs/v4-security.md` §1 の「host が Project のフォルダに直接触っていたもの」の表・§3 の中継の表、`v4-frontend.md` §6.49 の 6.）。
ここは決め方・採らなかった案・踏んだもの。

## 起きていたこと

2026-10-20、sakutei開発（containers、実行場所 baremetal。中継には #369 で届くようになった）で、Backlog が書いたあと Repositories の
`push_branch` を中継で呼ぶと、`branch-sync.ts` が「この Project は別のサーバで動いています」の `handled: false` を返し、Backlog は
向こう（Project のコンテナの中）の根で素の `git push` を流して、資格情報が無いので `could not read Username` で失敗した。
`handled: false` は 2026-10-11（`remote-runtime-host-side`）に「根は向こうのパスで、この機械の同じ文字列のフォルダは別物」として
入れたもので、そのときの仕様の表は「向こうの git の設定と Vault の SSH 鍵で送る」だった（食い違いの経緯は
`docs/notes/2026-10-08-remote-runtime.md`「host が Project のフォルダに触っていたものを合わせたとき」。鍵で送る道は #296 で入った
が、origin が https だと効かない）。

## ユーザーの決定（2026-10-20）

**案A——Repositories が別のサーバの Project の push（と fetch）も引き受ける。資格情報はコンテナ（向こう）に入れない。**
machine と containers の両方が対象。この機械のコンテナ（host-container）の振る舞いは変えない。

## 実装者が決めたこと

### 運び方：bundle を中継で運び、host の使い捨ての bare リポジトリから送る

- 向こうのリポジトリとの間は、core の実行場所の接続（SSH の多重化した接続。containers はコンテナの中で `incus exec`）で
  `git bundle` を運ぶ。core に中継の口を4本足した（`relayProjectGitOrigin`・`…Bundle`・`…Unbundle`・`…Track`）。Repositories は
  Module の置き場の `branch-sync/w-*/repo.git`（毎回作って消す）に取り込み、そこから送る・取ってくる
- **追跡の ref を合わせる口（`…Track`）は、作っている途中で要ると分かった**：この機械では `git push origin` が
  `refs/remotes/origin/<b>` を進め、Backlog はそれで「まだ送っていない」を数える（`store.ts` の `syncState`）。使い捨ての置き場から
  送ると向こうの追跡の ref は動かないので、送ったあと「n 件まだ送っていない」と出続ける（次に取ってくるまで）。送れたコミットに
  合わせる口を足した。合わせられなくても送れたことは変わらないので、投げずに文言に添える（投げると Backlog が自分の git で送り
  直そうとして、嘘の失敗を出す）
- **大きさ**：中継の本文は 10MB（`RELAY_BODY_MAX_BYTES`）なので、base64 で収まる 6MB を上限にした。banto 自身の `backlog`
  ブランチ（690 コミット）の bundle が 1.26MB（実測）

採らなかった運び方：

- **差分の bundle（相手が持っているコミットを除く）**：送るたびに origin の先端を聞き（`ls-remote`）、向こうにそのコミットがあれば
  `^<先端>` で除く——host の置き場にもそのコミットが要るので、毎回 origin から取ってくることになり（使い捨てなら全部）、運ぶ量が
  移るだけ。host に置き場を持ち続ければ（キャッシュ）差分で済むが、状態が増える。いまの大きさでは要らない——上限を越えたときの
  案として仕様の「まだ決めていないこと」に置いた
- **向こうの git から host へ git の話し方で送る**（中から banto への道に git の口を足し、向こうの `git push` の先を host にする）：
  道（中継のトンネル）に HTTP の git を載せる口を新しく作ることになり、向こうの git の設定（insteadOf・hooks）が送る動きに効く。
  bundle なら向こうでする仕事は「作る・取り込む」だけで済む
- **core が host で git を走らせる**（core が資格情報を持つ）：資格情報は Repositories のもの（core は Repositories を名指しで知らない）
- **bundle をファイルで渡す**（core が Repositories の置き場に書く・Repositories が core の置き場を読む）：Module の置き場に core が
  書く口を作ることになる。中継の口なら呼べる相手と Project の決め方が今の線（`relayCallerProject`）に乗る

### どこへ送るか・何を信用するか

- **送り先は向こうの `remote.origin.url`（リポジトリの段、書かれた形）の GitHub の場所で、URL は host で組む**。origin の値は中の
  AI が書ける申告だが、この機械の Project でも根の `.git/config` はコンテナの中から書けて、Repositories は origin の場所へ送る
  （台帳の owner/name は origin に合わせて直す）——同じ扱い。守りはブランチごとの承認（中継のゲート）のまま
- **方式はアカウントで決める**：この機械では origin の方式とアカウントが合わなければ断る（origin の URL のまま送るので、合わないと
  「資格情報が通らない」という嘘の失敗になる）。ここは URL を host で組むので、その理由が無い
- **ユーザーの段の設定は読まない**（`git config --local`）：向こうのユーザーの `~/.gitconfig` によくある
  `url."git@github.com:".insteadOf https://github.com/` で断らないため。この機械の Project も、`syncBlockers` は人の設定を読まない
  環境で読んでいる（リポジトリの段だけ）
- **断る設定を変えた**：この機械の Project の `syncBlockers` は `url.*`・`http.*`・`remote.origin.(pushurl|proxy|receivepack|uploadpack)`。
  ここで断るのは `remote.origin.pushurl`・`url.<x>.insteadOf`・`url.<x>.pushInsteadOf` だけ——どれも「向こうの git が送る先」と
  「ここが送る先」が食い違う設定で、どちらが正しいか決められない。`http.*`・proxy・receivepack・uploadpack は、送る git（host の
  使い捨ての置き場）が読まないので、トークンの行き先を変えない
- **bundle は信用しない**：上限（core が読むのをやめる・Repositories も確かめる）、取り込むのは `refs/heads/<b>` だけ、
  `transfer.fsckObjects` を通す。壊れた bundle は取り込めずに止まる（単体試験）

### 向こうの git を誰として動かすか

- containers は `incus exec <c> --user <中の番号>`（v4-security.md §1 の条件3）。bundle を作る・取り込む・設定を読む、のどれも
  リポジトリの中身を解釈するので、VM のユーザーでは動かさない（中の root が仕込んだ `core.fsmonitor`・hooks で VM のユーザー
  ＝incus グループを動かせる）
- machine は VM のユーザー（Project の箱そのもの——AI も同じユーザー）
- それでもフックと fsmonitor は止める（`-c core.hooksPath=/dev/null -c core.fsmonitor=false`）：中の権限で動くだけだが、Backlog の
  同期のたびに人のフック（reference-transaction 等）を走らせない。単体試験で、フックが走らないことを見ている

### アカウントの決め方

向こうのリポジトリは台帳に無い。候補は (a) origin の owner/name から台帳の行を引く、(b) Project の設定に持つ、(c) clone したときの
記録を使う。**(c) → (a) → 持ち主と同じ login の順**にした。

- (c) #425（core の「clone」のタブ）は Project の記録の `start` に `{kind: "clone", url, account}` を持つ。人が選んだアカウントで、
  Organization のリポジトリでも決まる。core が Module に渡す Project の姿に `clonedFrom` として載せた（終わった clone だけ）。
  clone のあとで origin を別の場所にしたら使わない（URL の場所が origin と同じときだけ）
- (a) この機械に同じリポジトリを置いていれば、人がそこで決めたアカウント。行どうしで違えば決めない（どちらが正しいか分からない）
- 持ち主と同じ login：Import のときと同じ決まり
- (c) だけにしなかった理由：sakutei開発は #425 より前に作った（「選ぶ」で根を選んだ）ので記録が無い。(b) は画面が要る（新しい面は
  モックで先に試す決まり）——上の3つで決まらないときは `handled: false` で、Backlog の Vault の SSH 鍵の道（#296）が残る

### 間欠的に落ちた試験（規則6）

- Repositories の単体試験を全部流すと、clone の試験「非公開は選んだアカウントのトークンで clone する」が **12 回中 4 回**
  「資格情報の窓口が残っている」で落ちた（残っていたのは、その試験が作っていない名前の窓口）。窓口は `XDG_RUNTIME_DIR` に作り、
  試験は置き場の前後の差で見ていた。`node --test` は試験のファイルを別のプロセスで並べて走らせ、branch-sync・publish の試験も同じ
  置き場に窓口を開く——この変更で branch-sync の試験が窓口を多く開くようになり、重なりやすくなった。clone の試験のプロセスの
  `XDG_RUNTIME_DIR` をそのプロセスだけの一時の場所にして、**12 回中 0 回**

### 踏んだもの

- 使い捨ての置き場から送って先を越されると、git は `[rejected] (fetch first)` の行を porcelain で標準出力に出し、標準エラーには
  「the remote contains work that you do not have locally」とだけ言う（この機械のリポジトリでは「behind its remote counterpart」）。
  標準エラーしか読まないので、「origin のブランチが先に進んでいます」に読み替える言い方に足した
- fetch で bundle のファイルを読むのは file の転送扱いで、`protocol.file.allow=never`（取ってくる git の環境の既定）だと
  「transport 'file' not allowed」で断られる。bundle を取り込むときだけ戻した（ファイルはこの Module が書いたもの）

## 試験（2026-10-20）

- 単体：module-contract 52・core 1181（うち skipped 2、fail 0）・Repositories 117・Backlog 54、すべて通った。足したもの——
  `core/src/runtime/remote-git.test.ts`（台本を本物の sh と git で流す：origin の設定の読み方・ユーザーの段を読まない・bundle は
  そのブランチだけ・取り込むのは追跡の ref だけ・合わせる・フックが走らない・壊れた bundle・名前の形・大きさ・この機械の Project
  は断る）、`remote-ssh-project-run.test.ts`（偽の ssh・偽の incus：machine は VM のユーザーでそのまま、containers は
  `incus exec --user U --group G` と中のホーム、バイトのまま、上限、時間切れ、接続が無い）、`host-relay-endpoint.test.ts`（呼べる
  相手と Project の決まり方）、Repositories の `branch-sync.test.ts`（偽の GitHub に本物の git で：clone の記録のアカウントで
  送る・取ってくる・追跡の ref・トークンが向こうに出ない・使い捨ての置き場が残らない・先を越された・まだ無い・断る設定・
  GitHub の外・git でない・方式はアカウントで・アカウントの決め方・上限・壊れた bundle）
- E2E（machine。SSH の相手に Incus は無いので containers は単体まで）：足した `remote-backlog-repositories-push.spec.ts`
  （向こうの origin は偽の GitHub——向こうからは届かない場所。createItem で送れる・追跡の ref が合う・listItems が ahead 0・
  GitHub の側で進めたあとの createItem が取り込んでから送る・PAT が向こうに無い）が通った（1回目は試験の側の読み方——root から
  `git -C` で読んで safe.directory に断られていた——を直して2回目）。前からある `remote-backlog-ssh-push.spec.ts`（GitHub の外の
  origin で Repositories が引き受けず、Vault の SSH 鍵で送る道）・`remote-runtime-host-side.spec.ts` も通った

## 実機で確かめること（まだ）

- containers（sakutei開発）：Backlog の書き込みが送れる（返事に「送れませんでした」が出ない・GitHub の backlog ブランチが
  向こうの手元と同じ）、「まだ送っていない」が 0 になる、ほかの手元で進めたあと書くと取り込んでから送れる。コンテナの中に
  トークンが無い
- machine の別のサーバ：同じ

## レビューを受けて直したこと（2026-10-20、別のサブエージェントのレビュー）

上の「どこへ送るか・何を信用するか」で「origin の値は申告だが、この機械の Project と同じ扱いで、守りはブランチごとの承認のまま」と
書いたのは**誤り**（訂正）。この機械の Project はアカウントが台帳の行（人が決めたもの）に固定されているが、別のサーバの Project は
origin からアカウントまで決まっていた——origin を `github.com/alice/secrets` に書き換えると、clone の記録が合わずに次の段へ進み、
持ち主と同じ login の alice が選ばれる（非公開の中身を取ってくる・書ける）。承認のカードにはブランチ名しか出ていなかった。

### H1：送り先とアカウントを Project ごとに固定し、承認のカードに出す（呼び元の決定）

- 最初に引き受けたときに、決まった送り先・アカウント・決まり方を Project の id ごとに覚え（`remote-targets.json`）、以降は origin が
  違えば断る（次の段へ進まない。GitHub の外へ書き換えても断る——引き受けないにすると Backlog の自前の道に落ちる）。clone の記録が
  あって場所が違えば最初から断る
- **カードに出す形**：中継のゲートは Repositories に聞く前にカードを作るので、送り先を知らない。採った形——Repositories に
  `branch_target`（値を返さない）を足し、Backlog が先に引いて `push_branch`・`fetch_branch` の引数 `repository`・`account` に載せる。
  名乗った引数（`auditArgs`）なので、今のゲートのまま**カードに出て、コンテナからの呼び出しでは承認の鍵にも入る**。Repositories は
  名乗りがいま決まる送り先と同じときだけ引き受ける（AI が直に呼んで嘘を名乗っても、カードに出たものしか通らない）。この機械の
  Project は名乗らないので、鍵は今までと同じ（前の承認がそのまま効く）
- 採らなかった形：
  - **ゲートが宛先に「何を指すか」を聞く口**（宛先が名乗った問い合わせの tool を、カードを作る前に host が呼ぶ）——ゲートに新しい
    機構を足すことになり、問い合わせの中から中継（`relayCallerProject`・`relayProjectGitOrigin`）を呼ぶ呼び出しの台帳まで要る
  - **Repositories が MCP の elicitation で人に聞く**——elicitation は AI のターンの代理サーバに向けて届く（`elicitation-router.ts`）。
    Repositories は中継からしか呼ばれず、その接続には届け先の会話が登録されない
  - **初めて決めるときだけの印を引数に足す**（カードで目立たせる）——印も鍵に入るので、決めたあと印の無い呼び出しでもう一度聞く
    ことになる。目立たせ方は未決として仕様に置いた
- origin は1回の送りで2回読む（`branch_target` と、送る直前の確かめ）。

### M1：bundle の fsck

- 測った（git 2.43.0）：`hash-object --literally` で author にメールの無いコミットを作り、bundle にして `-c transfer.fsckObjects=true`
  で fetch すると終了コード 0 で入る。`git fsck` は `missingEmail` で 4 を返す。取り込んだあと使い捨ての置き場を `fsck --strict` で
  確かめる形にした（置き場にはそのブランチしか無い）。`--strict` は古い履歴の警告どまりのもの（ゼロ埋めのファイルの mode 等）も
  断るが、運ぶのは Backlog が作る一覧のブランチなので受け入れる
- 取ってくる向き（GitHub → 向こう）は確かめない：向こうの git が GitHub から直に取ってくるのと同じもので、読むのは向こうの中の
  ユーザー（守っている境は「中から来たものを host の git が読み、人の資格情報で外へ送る」こと）

### M2・M3・低

- M2：送り先とアカウントが決まったあとの失敗はすべて `handled: true`。origin を読めない（向こうに繋がらない）も `handled: true`——
  Backlog はその向こうで動き、中継も同じ SSH の接続の上を通るので、繋がらないなら自前の道でも送れない（呼び元の考えのとおり）
- M3：host は宛先の進み具合を呼び元へ中継して待ちを数え直していた（`host-relay-endpoint.ts`）が、Repositories が送っていなかった。
  送る口を処理している間、10 秒ごとに送る（試験は上限 200ms・中の仕事 600ms で、送らなければ切れる対照つき）
- L1：取ってくる間、置き場の大きさを 250ms ごとに見て、bundle の上限の 2 倍で git を止める。試験は見張りそのもの（決まった大きさの
  ファイルを置く）と、大きすぎるブランチが向こうへ運ばれないことの2つに分けた——この機械の fetch は見張りの1回より速く終わりうる
  ので、「途中で止まった」を通しの試験で見ると間欠になる
- L2：core は Repositories の tool の名前を知らないまま絞るため、宛先の tool の名乗り（`dev.banto/projectGit`）を host が呼び出しに
  付ける形にした
- L3：EXIT の trap だけだと、TERM で止めたとき一時ファイルが残ることを確かめてから（node で再現）、HUP・INT・PIPE・TERM にも付けた
- L4・L5：置き場のパスを伏せる・起こしたときに置き場を消す（運ぶ前にそれを待つ）

### 人に決めてほしいこと

- 固定した送り先を外す・選び直す口（いまは origin を戻すしか無い。Project を閉じても記録は残る）——画面を作るならモックから
- 承認のカードで「この Project の送り先として初めて決める」を目立たせるか
- 「承認をすべて自動で許可する」がオンの Project では、カード無しで最初の送り先が固定される——それでよいか

### 直したあとの試験（2026-10-20）

- build（24 個）・型チェック：通った
- 単体：module-contract 52・core 1183（skipped 2、fail 0）・Repositories 122・Backlog 55、すべて通った
- E2E：`remote-backlog-repositories-push.spec.ts`（足した 2b——承認のカードに送り先とアカウントが出る・origin を同じ持ち主の別の
  リポジトリに書き換えると「決めてあります」で送らず、書き換えた先には何も届かない）・`remote-backlog-ssh-push.spec.ts`、どちらも通った。
  中継の記録では push_branch・fetch_branch の識別子が `{branch, repository, account}` になっていた
