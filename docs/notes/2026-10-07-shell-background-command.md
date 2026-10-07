# Shell で待たずにコマンドを流す——終わったら頼んだ Thread に届ける（2026-10-07）

Backlog #224 `long-run-done-notify`。決めた形は `docs/specs/v4-modules.md` §2.3「待たない形」・
`docs/specs/v4-architecture.md` §2.5「2.」（Shell の形）・§4.2・`docs/specs/v4-security.md`「Shell の待たない形の
コマンドは、コンテナの中の systemd で動く」に書いた。ここは経緯・理由・選ばなかった案・確かめたこと。

## 何に困っていたか（Backlog の本文から）

2026-10-06、Fork「間欠的に落ちる試験を直す」で数時間かかる E2E の繰り返しを流したかった：

- Shell の `runCommand` は1回で終わる契約で、終わるまでターンが止まる。裏で流した分（`&`）は終わっても知らせが無く、
  Shell が切れると結果も返らない
- Service で流すと動き続けるが、終わったことを会話に届ける口が無い
- 見張りのサブエージェント（runInBackground）を立てたが、コマンドの許可で断られて結果を読めなかった

## ユーザーが決めたこと（2026-10-07）

1. `runCommand` に `runInBackground: true`（runSubagent と同じ形・名前）。すぐ返し、AI はターンを終えられる
2. コマンドはコンテナの中の systemd のユーザー単位（`systemd-run --user`）で Shell から切り離す
3. 出力はファイルに。終わったら終了コード・末尾 50 行・全出力のファイルの場所を札で届けて AI を起こす
4. 起こし直しをまたぐ（`resumesAfterRestart`）。動いていれば見張りを続け、終わっていれば届ける。記録が無ければ「途中で終わりました」
5. サイドバーの印は既存の deliversLater とカードの題で出す（runInBackground のときだけ「あとで届ける」）
6. 承認は今の runCommand と同じ
7. Service には何も足さない
8. 一覧（`listCommands`）と止める口（`cancelCommand`、頼んだ Thread からだけ）を足す

**仕様の食い違い（規則8）**：`v4-modules.md` §2.3 は「tool はこれ1本だけ。`listProcesses`/`killProcess` のような、
プロセスを識別子で参照する tool は意図的に作らない。バックグラウンド実行・後からの操作が要る用途は Service 側で扱う」
と書いていた。ユーザーの決定（上の 1・8）がこれを改めるので、§2.3 を書き換え、改めたことと理由を本文に残した
（以前の文は「（改訂・2026-10-07、ユーザー。以前は…）」として）。§2.1 の比較表も「寿命はコマンドが終わるまで」に直した。
Service との線は「止めるまで動き続けるもの（登録して名前で操作する）」で引き直した——Shell の待たない形は終われば済む。

## 実装で決めたこと（と理由）

### 終わり方は起動役がファイルに書く

Service の `log-wrapper.js` と同じ形の起動役（`background-wrapper.js`）を `systemd-run --user --collect` で起こし、起動役が
`/bin/sh -c <command>` を走らせて `exit.json` に終了コード・信号・止められたか・時間切れか・出力の末尾を書く。
理由：`--collect` の単位は終わると消えて終了コードが引けない（頼みに書かれた事実）。`sh -c '<cmd>; echo $? > exit'` の形
（頼みの例）は、コマンドの文字を包むシェルに埋めることになり（エスケープの誤り・`systemctl show` での露出）、止められた
ときと区別できない。node の起動役なら、止められた（SIGTERM を受けた）・時間切れ・起こせなかったを分けて書ける。

- **コマンドは単位に書かない**——置き場の `job.json` から起動役が読む
- 起動役は子を**自分のプロセスグループ**で起こし、止める・時間切れのときはグループごと（孫まで）止める。systemd の
  `stop` は cgroup ごと SIGTERM（`TimeoutStopSec=10s` で SIGKILL）
- `--property=Type=exec`：起動役を exec できたところで `systemd-run` が返る（起こせなければ失敗で返る）。そのうえで
  Shell は `started.json` が現れるまで待ってから「流しました」と返す——AI に「流した」と言ってから黙って失敗させない
- **見張り**：Shell は届ける約束をしたコマンドを 2 秒ごとに見る。`exit.json` があれば終わり、無くて起動役の pid が
  居なければ（開始時刻で使い回しを見分ける——Subagent の `process-group.ts` と同じ手）「途中で終わった」。systemd に
  状態を聞かない——試験で systemd を差し替えても同じ道を通る
- 状態の語彙：`running`／`exited`／`timedOut`／`cancelled`（cancelCommand）／`stopped`（外から——人の `systemctl stop`・
  コンテナの停止）／`lost`（記録が無い）。cancelCommand は `job.json` に止めると頼んだ時刻を先に書くので、起動役の
  「止められた」がどちらからかを分けられる

### 出力は1つのファイルに、出た順で

頼みは「stdout と stderr はファイルに残す」「全出力のファイルの場所」。stdout と stderr を**1つの `output.log` に出た順で**
書いた。理由：届けるのは「末尾 50 行」で、ビルドや試験の失敗は stdout と stderr が交互に出る——別のファイルだと、どちらの
末尾を届けるかで片方の終わりが欠ける。端末で見えるのと同じ並びで、AI が grep・tail する先も1つで済む。待つ形が
`stdoutFile`／`stderrFile` を分けているのとは揃えていない（待つ形は返り値が stdout と stderr を分けて持つので、それに合わせて
いる）。2つの管を1つに書くので、同じ瞬間に両方へ出た行の前後は保証しない。

- 保存は 64 MiB まで（待つ形の `saveBytes` と同じ）。越えても止めない。届ける末尾は手元に持った後ろ（128K 文字）から作る
  ので、保存を越えても本当の終わり
- **届ける末尾**：50 行（ユーザー）、1行は 1,000 文字で切り（「この行の残り n 文字を省きました」）、全体で 16,000 文字まで
  （新しい行から数える）。`\r` で書き直す進捗は最後の姿だけ。届けた本文は会話に積まれて AI の文脈にそのまま入るので、
  1通を膨らませない（MCP の stdio は 10 MiB まで、Claude Code は MCP の結果を約 10 万文字で先頭から切る）
- 本文は JSON で**終了コードを先頭に**（待つ形と同じ理由）。Subagent の届け方（JSON）に揃えた

### 置き場：Shell の Module の置き場の `commands/<commandId>/`

頼みは「Shell の HOME、または適切な置き場」。Shell のホーム（`<置き場>/home`）ではなく、その親（`BANTO_MODULE_DATA_DIR`、
Subagent の `running/` と同じ所）の `commands/` にした。理由：ホームは host が人の git の設定を写し直す所で、コマンドも
`HOME` として書き換える（`rm -rf ~/.cache` 等）。記録が消えると届けられなくなる。置き場は host のディスクで、コンテナの
中から同じパスで見える（AI が `grep` できる）。終わったものは新しい 20 件だけ残す（待つ形の出力と同じ数）。

### 秘密：tmpfs のファイルを起動役が読んで消す

`systemd-run --user` の単位は Shell の環境を継がない。秘密（envSecrets）とコマンドの環境（`buildChildEnv` のもの——Claude の
ログインの中継の変数を含む）を、**コンテナの中の tmpfs（`/run/user/<uid>/banto-shell/<id>.env.json`、0700 の下に 0600）**に
置き、起動役が起動してすぐ読んで消す。頼みの例（0600 のファイルを EnvironmentFile で読ませて起動後に消す）と同じ考えで、
違いは2つ：

- **EnvironmentFile ではなく起動役が読む**——EnvironmentFile は systemd が exec の前に読むので、Shell が「いつ消してよいか」
  を知る手が無い（`started.json` を待って消すことはできるが、その間はファイルが残る）。起動役が読んだ直後に自分で消せば、
  残る時間が一番短い。環境全体を JSON で渡せるので、改行を含む値のエスケープ（Service が踏んだ `\\n` の扱い）も要らない
- **置き場を host のディスクにしない**——Module の置き場は host のディスク。`/run/user/<uid>` はユーザーの systemd が作る
  tmpfs で、コンテナが止まれば消える

`--setenv` は `systemctl show` の `Environment=` に出るので使わない（実測で、起動役の単位の `show` に秘密が出ないことを確かめた）。
`secretFiles` は待つ形と同じく書き出して、コマンドのあと起動役が消す。起動役が消せずに終わったとき（SIGKILL）は、Shell が
終わりを見たときに消す。

### 一覧も頼んだ Thread の分だけ（判断）

`listCommands` は**呼んだ Thread が流したものだけ**を出す（Thread の印が無い呼び出し——人の画面など——は全部）。理由：

- 止められる範囲（`cancelCommand` は流した Thread からだけ）と揃う。一覧に出るのに止められないものを AI に見せない
- 同じ Project の Fork は Shell を共有する。親の Thread のコマンドが一覧に出ると、Fork の AI が自分のものと取り違えて
  待つ・止めようとする
- 他の Thread の出力を隠す意味は無い（同じコンテナで root）——これは事故を防ぐ線で、権限の線ではない

### 止める口の縛り

`cancelSubagent` と同じ：host が刻む Thread の印（`dev.banto/thread`）の Project と Thread が、流したときと同じときだけ。
印が無ければ断る（fail closed）。Module が中継で流したものは、流した Module（`dev.banto/callerModule` の接続名）からだけ。

### 起こし直しをまたぐ

Module の申告（自己申告と宣言 `declaration.ts` の両方）に `resumesAfterRestart: true`。問い（`resumeAfterRestart`）には
札の指紋で記録を引き、Thread が合えば「続ける」。答えを返したあと見に行く——終わっていればすぐ届け、動いていれば見張る。
起動役が記録無しで消えていた（コンテナが起こし直された）ものも「続ける」と答えて、Shell から「途中で終わりました」（出力の
途中まで・理由つき）を届ける——host の「途中で終わりました」より手がかりが多い。

- **問われなかった記録のコマンドは止めない**（Subagent は問われなかった仕事を止める）。問われないのは、host がもう
  「途中で終わりました」を届けた・札が切れた等。Subagent と違って、コマンドは人が意図して流した長い処理（ビルド・試験）で、
  止めると取り返しがつかない。一覧に出て、流した Thread から止められる
- 届けられなかったもの（host が落ちていた）は記録に結果が残る（ファイルから導けるので、Subagent のように結果を写さない
  ——規則3）。起き直した host に問われたら届ける

### コンテナの外では断る

`BANTO_IN_CONTAINER` が無い Shell（試験で banto 本体と同じ所に立てたもの）は、待たない形を理由つきで断る。人の機械の
systemd にコマンドを残さないため。待つ形はそのまま。

## 実測

- **新しいコンテナには `/run/user/<uid>` が無い**（E2E の1回目で落ちた：`EACCES: mkdir '/run/user/1000/banto-shell'`）。
  ユーザーの systemd を立ててから秘密のファイルを置くように直した（`launcher.prepare()`）
- **入れ子のコンテナ（E2E）では logind に繋がらない**：使い捨てのコンテナ（`banto-base` のイメージ、この Project の
  コンテナの中の Incus）で、root の `loginctl enable-linger ubuntu` も `loginctl list-users` も「Access denied」
  （journal に `systemd-logind.service: Unexpected error response from GetNameOwner(): Connection terminated`）。
  PID 1 には繋がり、`sudo -n systemctl start user@1000.service` で `/run/user/1000/bus` が立ち、`systemd-run --user` も
  `systemctl --user stop` も動いた。linger が入らなければ `user@<uid>.service` を直に起こす形にした（ログに残す）。
  稼働中の Project のコンテナ（入れ子でない）では linger は入っている（`Linger=yes`）
  - **Service の `ensureUserManager` は linger だけなので、E2E のコンテナでは systemd を用意できないはず**（確かめて
    いない。Service に触らない決定なのでそのまま）
- 本物の systemd（この Project のコンテナ）でのプローブ（コミットしない）：`BackgroundCommands` を `SystemdLauncher` で
  動かし、プローブのプロセスが終わったあとも単位が動き続け、別のプロセスから終了コード 7・出力を読めた。`systemctl --user
  show` に秘密が出ない（`Environment=` 無し）、環境のファイルは起動直後に消えている、cancel で `stopRequested`・
  `signal: SIGTERM`、終わった単位は `--collect` で消えた

## 試験

- 単体（`packages/modules/shell/src/background.test.ts`、13本）：本物の起動役を、systemd の代わりに Shell から切り離した
  子として起こす（`DetachedLauncher`）。名乗り・すぐ返って終わったら届く（50 行・stdout と stderr が1つ・終了コードが先頭）・
  秘密が置き場に残らず札そのものも書かない・長い1行を切る・時間切れ・断るもの・一覧と止める口の縛り・外から止められた／
  記録無しで消えた・**起こし直しをまたぐ**（Shell を捨てて立て直し、問いに答えて届ける。問われなかったものは止めない）・
  届けられなかったものを問われたら届ける・tailLines・20 件だけ残す・起動役の信号の窓（下）
- E2E（`e2e/specs/shell-background.spec.ts`）：本物の経路（コンテナの中の Shell → コンテナの中の systemd）で、待たずに流す
  → ターンが終わる → サイドバーの印（題はコマンド）→ AI の listCommands → 終わると届いて AI が起き、届いた出力（コマンドの
  文字には無い語）を読んで返す → 印が消える → 出力のファイルを次の runCommand で読める → もう1本を cancelCommand で止めると
  「止めました」が届いて AI が起きる → 一覧が cancelled・exited

## 見つけた穴：起動役の信号の受け口が遅かった

壊して落ちるかを回している間に、単体の「外から止められました」が1回だけ「途中で終わりました」で落ちた（間欠——規則6）。
起動役は started.json を書いて子を起こしてから SIGTERM の受け口を置いていた。受け口を置く前に来た信号は既定の動き
（その場で終わる）になり、終わり方を書けず、自分のグループで起こした子（`sleep`）も残る。プローブ（started.json を見た
直後に SIGTERM を送る、コミットしない）で **30 回中 30 回**書けなかった。受け口を `main` の最初に置いて 0/30 になった。
回帰試験（同じことを 10 回、子が残らないことも見る）を足した。`cancelCommand` は止めると頼んだ時刻を先に書くので、
この窓に当たっても「止めました」になるが、人の `systemctl stop`・コンテナの停止は「途中で終わりました」に化けていた。

## 確かめたこと

- 単体：Shell 37 本（＋13：`background.test.ts`）を通した。`background.test.ts` は 13 本を3回続けて回して通った。
  core 584 本（582 通過・2 は前からの skip。宣言に `resumesAfterRestart` を足した）。型検査（shell・core）
- E2E：`shell-background.spec.ts` を1本だけ2回。1回目は落ちた（新しいコンテナに `/run/user/1000` が無い——上の実測）。
  直して2回目は通った（1.1 分）。ログに「linger を入れられませんでした（user@1000.service を直に起こします）」。
  起動役の信号の直し・止める口の文の直しのあと、最後にもう1回通った（1.4 分）。待つ形の用意を切り出したので
  `shell-long-output.spec.ts` も1回回して通った（56 秒）
- 本物の systemd のプローブ（上の「実測」）
- **壊して落ちるか**（単体は `packages/modules/shell/.mut/` に写してビルドし、本物の `dist` は触らない。21 か所、どれも落ちた）：

| 壊したもの | 落ちた試験 |
|---|---|
| あとで届けると言わない（pendingReply） | すぐ返って終わったら届く |
| 札そのものを置き場に書く | 秘密・起こし直し・届け直し |
| 起動役が環境のファイルを消さない | 秘密 |
| stderr をファイルに書かない | 1つのファイルに |
| 末尾の行数・1行・全体の上限を外す（3つ） | 50 行／長い1行／tailLines |
| 止める口で Thread を比べない・止めると頼んだ時刻を書かない・一覧を Thread で絞らない | 一覧と止める口 |
| 外から止めたものも cancelled にする | 外から止められた |
| 問いで Thread を比べない・続けると答えても見張らない・問いを host 以外からも受ける | 起こし直しをまたぐ（と届け直し） |
| 起動役が消えても動いているとみなす | 途中で終わりました |
| resumesAfterRestart を名乗らない | 名乗り |
| secretFiles を消さない（起動役と Shell） | 秘密 |
| 古いものを消さない | 20 件だけ残す |
| 時間切れを効かせない | 時間切れ |
| 札が無くても待たずに流す | 断る |
| 信号の受け口を started.json のあとに置く | 起動役の窓・外から止められた |

- **E2E を壊して落ちるか**（作業ツリーを `~/.cache/bg-mut-copy/` に丸ごと写し、写しの Shell だけ壊してビルドし、写しから
  E2E を回した——本物の dist は触らない）：
  - linger が入らないときに `user@<uid>.service` を起こさない → 1つめのターンで「コマンドを流す用意ができませんでした：
    ユーザーの systemd が立ち上がりませんでした（…loginctl enable-linger: Could not enable linger: Access denied…）」が
    AI に返り、spec が落ちた（理由が AI に届くことも見えた）
  - runCommand のカードの名乗り（`dev.banto/card` の題 `{command}`）を外す → サイドバーの印が「shell に頼んだ仕事」になり、
    spec の「題はコマンド」で落ちた
  - E2E の写しは消した

## 確かめていないこと・残したこと

- **本物のモデル**での通し（AI が実際に runInBackground を選ぶか・届いた末尾 50 行で次の手を決められるか）。偽の Runner だけ
- **banto 本体の起こし直しをまたぐ**のは単体（Shell を捨てて同じ置き場で立て直す）だけ。host を落として起こし直す E2E
  （`subagent-resume-restart.spec.ts` の自前の host の形）は足していない。host 側の問いの仕組みは Subagent と同じ道
  （宣言の `resumesAfterRestart` で問う）なので、Shell の宣言に印が立っていることは core の宣言で見ている
- 稼働中の（入れ子でない）Project のコンテナで、Shell の Module を通した通し（プローブは同じ部品を直に使っただけ）
- 64 MiB を越える出力（保存の上限）を実際に流すこと。上限の分岐は単体で通していない（越えたときに書かないのは起動役の数行）
- Shell だけが起こし直されたとき、届ける約束が切れたままのコマンド（上の「知っている限界」）。host がその札に「途中で
  終わりました」を届けるので AI は止まらないが、結果は届かない
- 返信用の札は返事待ちの間は期限で切れない（`reply-handles.ts`）ので、数時間〜数日のコマンドでも届く見込み——数時間は
  流していない
- Service の `ensureUserManager` が入れ子のコンテナで linger を入れられない件（上の実測）は、Service に触らない決定なので
  直していない。人に上げる
