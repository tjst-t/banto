# Banto開発の Memory の棚卸し（2026-10-16、Fork「Memory の棚卸し」）

ユーザーが了承した案（2026-10-15）：219件を「取り消す 24件／まとめる 約150件→約34件／残す 約17件」に分ける。
取り消しと改めるは `revise_memory`（Backlog #330）で頼み、人がカードで許す。番号は道具が入ったあとの土台の指示の [#番号]。
以下の「元」は 2026-10-15 時点の Memory の並び順（1 = 取り消し済みのオンライン診療）。

## 取り消すだけ（理由：経過だけ・訂正だけ・済んだ予定・置き換わった）

9, 15, 99, 101, 128, 144, 158, 161, 168, 171, 175, 177, 179, 181, 183, 188, 189, 201, 207, 208, 212, 213

（15 の「コンテナから GitHub へ push できる」と 101 の「host に残すメモリ 4GiB」は、下のまとめた行に入れた）

## まとめた行（元 → 新しい行の全文）

### M1 Service（元 2・3・4・5・6・7・11 の (1)(3)(4)）
Service（長く動かす Module、決定・2026-09-27）：Environment Module は廃止し「どこで動かすか」は Project のコンテナ、長く動かすのは Service、外に見せるのは Publish。tool は pm2 型の startService（初回は登録と起動）・stopService（登録は残す）・restartService・removeService・listServices・readServiceLogs。登録済みの名前で中身が違えば断る（removeService してから）。登録の大元は Module が持ち、systemd のユーザー単位（ubuntu、linger）はその写し——消されたり書き換えられたら作り直す。起こし直すのは異常終了だけ（Restart=on-failure、上限は systemd の既定）。人が systemctl stop したものは止めたまま「外から止められた」と出す。desired（running/stopped）は Module が覚える。ログはファイル。envSecrets の値はコンテナの中の 0600 のファイル（EnvironmentFile）だけに置き、マスターには alias 名だけ。

### M2 Claude ログインの中継（元 10・11 の (2)）
Claude ログインの中継（決定・2026-09-27、#157 で実装）：core が1本だけ常設し、Project のコンテナの環境に住所と Project ごとの合言葉（ANTHROPIC_BASE_URL・CLAUDE_CODE_OAUTH_TOKEN・CLAUDE_CODE_SUBSCRIPTION_TYPE・CLAUDE_CODE_RATE_LIMIT_TIER）を入れる。合言葉は Project ごとに固定で、Project 設定の「Claude のログインを使わせる」を切って入れ直したときだけ替わる。送り元はその Project のコンテナに縛る。認証の形は CLAUDE_CODE_OAUTH_TOKEN のまま（ANTHROPIC_AUTH_TOKEN だと API キー扱い）。仕様 v4-security.md §2。

### M3 Publish（元 13・14・17・18・67）
Publish（決定・2026-09-27〜10-03）：窓口 Module 1本（publishService・unpublishService・listPublished）＋出し方ごとの実装。公開する対象は Service の登録（サービス名とポート）から選び、待ち受けていなければ断る。公開のたびに会話の中のカードで人が承認し、どこまで届くかを出す（「承認をすべて自動で許可する」なら通る）。最初の出し方は Caddy のサブドメイン `<サービス名>-<Project id の先頭8文字>.banto.tjstkm.net`（*.banto.tjstkm.net はワイルドカード DNS で 192.168.1.47）。前の認証は実装ごとに持ち、既定は banto のログイン：banto のセッションの Cookie は公開先に送らず、Caddy がその公開先だけの短い通行証を確かめ、無ければ banto に回して渡す（oauth2-proxy と同じ形、通行証は確かめたあと外す）。公開中の Service が removeService されたら公開もやめる。

### M4 banto の更新（元 8 は別に残す。元 19・90・91・92・98）
banto の更新（決定・2026-09-28〜10-05）：稼働中は ~/.local/share/banto-release の clone（REL）の versions/<commit> を current の symlink で動かす。更新の本体は banto/scripts/update.mjs（install.sh も同じものを呼ぶ）で、新しい版を別のフォルダで組み、出来てから current を替え、起きなければ前の版に戻す（前の版は1つ残す）。設定画面の「更新」からはログインした人だけが押せ、押す前にパスキー（step-up）と、今の版→release の最新のコミットの件数・題を出す。「AI が止まるまで待って更新」と「すぐ更新」（途中で切れる会話を出して確かめる）。unit は banto-update.service 1本（oneshot、polkit で start と banto-host・banto-frontend の restart だけ許す、setup-update.sh）、待つかは request.json、進み具合は state.json。空くまで待つのは GET /api/admin/activity と host のスクリプト restart-when-idle.mjs。更新したら画面も新しくする：ページの組み立ての印（NEXT_PUBLIC_BANTO_BUILD）と GET /banto-build が違えば、更新の面は自動で読み込み直し、ほかのタブは帯で案内（e5d5c1d0）。画面はモック 690dc705 の形。仕様 v4-architecture.md §2.5。

### M5 Fork を作る（元 16・40・56・169・170）
Fork を作る（決定・2026-09-27〜10-11）：AI は core の tool start_forks で1回に5本まで立てられ（名前と最初の指示）、親のターンが最後まで行ったら立つ（途中で終わったら立てず受信箱に知らせる）。Fork の中からも立てられる（連鎖は届けものの maxHop 10 と1回5本で抑える）。人はヘッダの「Fork を開く」・発言の下の「ここから Fork」・サイドバーの「＋ 新しい Fork」と行の「…」の「ここから Fork…」で作り、どれも名前を聞く（空なら連番）。始め方は「会話を引き継ぐ」か「まっさらで始める」（Clear した状態）。Project だけを宛先にした send_message の Fork もまっさら。Base と Fork の違いは「Base は閉じられない・Project の主の会話」だけ。サイドバーの「閉じた Fork（N）」の行は無い（左下の履歴）。仕様 v4-frontend.md §6.7・§6.32、v4-architecture.md「AI が Fork を立てる」。

### M6 Fork を全面に（元 164・166）
前面の会話は1枚（決定・2026-10-10、1bd91290）：デスクトップでも携帯と同じく、前面の1枚（Fork があれば Fork、無ければ Base）がサイドバーの右を全部使い、隠れた Base は捨てずに残す（panel-stack は同じ親・同じ key）。URL は ?fork=。Canvas は前面の会話の横（会話は左 1/3）。Escape が閉じるのは Canvas だけで、Fork から Base へは ← かサイドバー。仕様 v4-frontend.md §6.7・§6.9・§6.28。

### M7 会話の見え方（元 20・21）
会話の見え方（決定・2026-09-28）：書きかけは Thread ごとに localStorage に残す。Fork・Canvas の開閉で面が作り直されても読んでいた場所へ戻す（同じ Project の画面にいる間だけ、Thread を開いたら一番下）。turnAnchor は bottom（返事が伸びれば下を追い、人が上へスクロールしたらやめる）。会話のランタイムは key で捨てて作り直さず、同じランタイムに記録を流し込む。

### M8 設定の出し方（元 26・105）
設定の出し方（決定・2026-09-30・10-05）：設定は ?settings=1 でいまの画面の上に重ねて開き（下の画面は inert で生かす）、閉じれば戻る。設定を開いたままサイドバーで別の Project の名前を押すと設定はその Project の層に替わる。Thread の行（Base・Fork）を押したら設定を閉じてその会話を出す（threadNavHref）。仕様 v4-frontend.md §6.16。

### M9 Repositories：役割と置き方（元 22・23・27・33・34・36・37）
Repositories（画面は「リポジトリ」、決定・2026-09-29〜10-01）：git の操作は作らず AI は Shell で git を打つ。「開発を始める・リポジトリを置く」を担う。banto 全体に1本（banto 本体で動く、scope instance）で既定の Module に入り消せない。GitHub の API は自分で2〜3本だけ呼び、GitHub 公式 MCP サーバは繋がない（Issue・PR は Shell の gh、トークンは GH_TOKEN）。core は Repositories を名指しで知らない——新しい Project の画面は「手元のフォルダを選ぶ」と、Module が `_meta` で「フォルダを用意できる」と名乗って差し出す画面のタブだけを持ち、Module が返したフォルダを root に core が Project を作る（「Project も作る」は core の新しい Project の画面をフォルダ入りで開く、dev.banto/open-new-project）。banto 全体の Module の画面（launcher）はどの Project からでも開ける。

### M10 Repositories：台帳と一覧（元 24 の (3)・28・29・30・31・32・54・59・63）
Repositories の台帳と一覧（決定・2026-09-30〜10-03）：clone・新規作成の既定の置き場は ~/banto（設定で変えられる、同名は <名前>-2 を提案）。台帳に置き場所・アカウント・リモートの場所（GitHub 以外も）を書き、フォルダが消えたら clone し直せる（origin と食い違えば origin を正とする）。好きな場所のフォルダはそのまま Import でき、持ち主が登録アカウントでなければ「読むだけ」（あとで行の「…」からアカウントを指定できる）。一覧は「Project で使っている」「Project はまだ無い」の2つの表で、「このマシンにだけ」を先、あとは名前順。一覧から URL で clone・新しいリポジトリ（git init）ができ、「Project も作る」は既定オン。既にあるものは「もう手元にあります（場所）」で clone させない。clone 先にあれば remote が一致すれば使い、違えば断る。「一覧から外す」と「このマシンから削除」：削除の前に push していないもの（未 push のコミット・未コミット・追跡していない・stash）を確かめて警告し、承知で消せる。reflog だけのコミットは数えないと毎回出す。置き場の外から Import したものは消せない。Project が使っていればリポジトリ名を打たせ、「Project も閉じる」（既定オン、core の閉じる確認を開く）。

### M11 Repositories：アカウントとログイン（元 24 の (2)・38・50・52・79）
Repositories のアカウント（決定・2026-09-29〜10-04）：アカウントは Repositories の設定で登録し、名前は GET /user の login。PAT（fine-grained、Vault に預ける）とブラウザログイン（GitHub App のデバイスフロー、トークン8時間・自動更新、既存の oauth-token の置き方）の両方。外すとき PAT は Vault に残し、ブラウザログインは消す。どのリポジトリにどのアカウントかは台帳が覚える。GitHub 向けの clone はこのマシンの git の設定を読まない（GIT_CONFIG_GLOBAL/SYSTEM=/dev/null、GIT_LFS_SKIP_SMUDGE=1）、SSH は Module が持つ GitHub の host 鍵で StrictHostKeyChecking=yes、人の ~/.ssh は触らない。配るときは banto 公式の GitHub App（Any account、Organization の持ち物）の client ID を既定に入れ、設定で差し替えられる。受信箱に知らせる中継の口 relayRaiseNotice は同梱の banto 全体の Module だけ。

### M12 サブエージェント（元 35・70・113）
サブエージェント（決定・2026-10-01〜10-06）：runSubagent を呼ぶと会話に Fork と同じ形のカードを出し、押すと Launcher（ui://banto-subagent/runs）がその仕事を選んで Canvas で開く（待つ形と runInBackground の両方）。AI から止める cancelSubagent は頼んだ Thread からだけ（requestedBy の Project・Thread が一致したとき）、Module から頼んだものは呼び元の接続名が一致したとき。runSubagent の cwd は Project root の中のフォルダだけ、schema を渡すと JSON を確かめ3回まで直させて structured で返す。仕様 v4-architecture.md §4.1。

### M13 Thread 間・Project 間のメッセージ（元 39・41・44）
Thread 間・Project 間のメッセージ（決定・2026-10-01〜10-02）：banto-thread の list_threads（中身は読まない）と send_message。宛先は Project と Thread、Thread を指さなければまっさらな新しい Fork を立てて届ける。届いたものには送り元が付き、返事は送り元の Thread に戻る。同じ Project の中は自由。Project をまたぐ送信は毎回会話のカードで承認し、「以後聞かない」で宛先の「受け取ってよい Project」に足す。受け取ったメッセージの送り元の Thread へ24時間以内に送るものは承認なし（届くたびに数え直す、返信かどうかは見ない）。仕様 v4-architecture.md §4.2。

### M14 停止ボタン（元 42・102）
停止ボタン（決定・2026-10-01・10-05）：押した瞬間に画面が止まり host のターンも止める。AI がまだ何も出していないうちに止めたら送った発言を取り消して入力欄へ戻す（記録からも次の文脈からも消す、resumeSessionAt）。書き始めてから止めたものは「（ここで止めました）」と残す。画面を離れただけでは止めない。止めたときに出ていた承認カードは消さず、答え済みの形（「止めたので答えませんでした」）で残す。届いたものを一緒に積んだターンは取り消さない。

### M15 E2E の土台（元 43・142・143・147・153）
E2E の土台（決定・2026-10-01〜10-09）：同じ機械の E2E は /tmp/banto-e2e.lock で一度に1回（待つ）。worker ごとに core を1本で既定2並列（BANTO_E2E_WORKERS、画面は共有）。spec ファイルの替わり目で banto を回の始めの姿に戻す（Project を畳み、足した Module を外し、Vault と受信箱を戻す）。偽の Infisical・偽の GitHub を立てる。片づけ役（run-reaper・own-host-reaper）は回の cgroup の外のユーザーの systemd の単位で起こし、Playwright が居なくなったら core と画面と回のコンテナを消す（コンテナの使い回しはしない、BANTO_E2E_KEEP_SPEC_CONTAINERS=1 で止められる）。incus グループが無ければ sudo -n -E -u で起こし直す。所要時間は spec-timing-reporter。経緯 docs/notes/2026-10-08-e2e-parallel.md。

### M16 コンテナの資源上限（元 45・46・47・53・101 の数値）
Project のコンテナの資源上限（決定・2026-10-02〜10-05）：既定はコンテナを起こすときにその host で計算——メモリ＝host の全メモリから 4GiB を残した残り、CPU＝コア数−1（最低1）、プロセス数＝8192。banto 全体用のコンテナにも付け、サブエージェントはその Project の枠に入る。banto 全体の設定「コンテナ」で残す量を、Project の設定でその Project の値を下げることだけでき、保存すると起こし直さずに効く。全 Project の合計は Incus の区画では掛けられない（実測）ので host の側を守る（system.slice の CPUWeight=1000・MemoryLow=4G、banto の unit に OOMScoreAdjust=-800、手順 docs/runbooks/host-resource-protection.md）。

### M17 資源の逼迫（元 103・146・148・150・151・152・155・159・167）
資源の逼迫（決定・2026-10-05〜10-11）：段0（原因の確かめ）・段1（見張りと画面）・段2a（仕事の組と天井）は済み、残りは段2b（Module を banto-modules.slice の名前つき scope で起こす）と段3（deliversLater の仕事の順番待ち・Factory の同時件数を下げる・AI と受信箱に知らせる・host 全体の逼迫で控える、区切りは資源の画面の実物で決める）。見張りは host から cgroup のファイルを直接読む（ResourceWatch、incus exec は使わない）、画面は設定の「資源」とサイドバーの印、上限に当たったら受信箱。仕事（Shell・サブエージェント・Factory のテスト）は banto-work.slice（コンテナの75%・プロセス70%、oom_score_adj +500、oom.group）、Service は banto-work-services.slice。本体の止まりは host-stall.ts で測り、ping の時間切れは本体の止まりを引いて数える。止まりの原因は Agent SDK の process.report.getReport() だった（claude の場所を起動時に1回だけ探す、excludeNetwork）。採らない：Module の oom_score_adj を下げる・MemoryLow・MemoryHigh。仕様 v4-security.md §1・v4-architecture.md §5.4-0、経緯 docs/notes/2026-10-09-resource-pressure.md。

### M18 Backlog の形と tool（元 48・49・51・64・93）
Backlog（決定・2026-10-02〜10-04）：Project ごとにつけ、窓口1本＋バックエンド（最初は tasks.json）。種類はストーリー・タスク・バグ（タスクはストーリーにぶら下げる、ストーリーは自動では閉じない）、依存（dependsOn）、マイルストーン・並び順＝優先順・優先度3段・ラベル・doneWhen・done と dropped（resolution）・refs・threads。エピック・スプリント・ポイント等は入れない。id（slug）とは別に通し番号 number（#42、再利用しない）。AI の tool は listItems・getItem・createItem・updateItem・splitStory・moveItem（消す tool は無い）、番号でも指せる。画面はモック 643f9292 の形（次にやる／すべて／バグ／閉じたもの、状態の輪、Peek）。

### M19 Backlog の置き場（元 81・82・190）
Backlog の正本の置き場（決定・2026-10-04・10-14）：コードとつながらない orphan ブランチ `backlog` の tasks.json。Module は作業ツリーも index も使わず git の低レベルのコマンド（compare-and-swap の update-ref）で1件ごとに1コミット、push は変更のたびに自動で試み失敗しても書き込みは止めない。origin が無ければ push も注意もしない。root が git でなければ断って git init を案内する。別のサーバの Project では、Backlog の設定で選んだ Vault の SSH 鍵で Vault に ssh-agent を立ててもらい push・fetch する（https の origin には効かない）。

### M20 携帯の入力とナビ（元 55・57・58）
携帯（決定・2026-10-02〜10-03）：Drawer は AppShell に1つ（MobileNavProvider）、≡ はどの面でもヘッダの左端。Drawer で Fork のある別 Project を選んだら閉じずに目次を開く。キーボードが出る端末（hover: none かつ pointer: coarse、useTouchKeyboard）では Thread を移っても入力欄に焦点を当てず（止めて取り消した発言を戻すときは当てる）、Enter は改行で送るのは送信ボタンだけ。

### M21 サイドバーの印（元 60・61・73・75・77）
サイドバーの印（決定・2026-10-03〜10-04、仕様 v4-frontend.md §6.33）：AI が動いている Thread の行はアイコンが回る（開いていない Project は頭文字が回る）。AI が返したあと開いていない Thread は太字（受信箱のレビュー待ちを使う）。裏の仕事（deliversLater の札の awaiting）は Thread の行の下に薄い1行（1件は題、2件以上は「バックグラウンドで n 件」、押すと一覧）、開いていない Project は件数の丸。Module は _meta["dev.banto/waitingOn"] で人を待っていると名乗れ、その行は人の番の色で上に出す（「あなたの答えを待っています（n 件）」）。文言は「〜待ち」にしない。

### M22 サイドバー3段（元 180）
サイドバーは3段（決定・2026-10-12、仕様 v4-frontend.md §6.39）：上（見出し・受信箱・検索）の下に薄い線、Project 一覧だけがスクロール、一番下の1行に履歴・設定・テーマ。スクロールバーは .sidebar-scroll（Chrome 121 以降は scrollbar-width の要素で ::-webkit-scrollbar を読まない）。携帯の Drawer も同じ NavPanel。

### M23 最後の Thread を開く（元 182）
Project の名前を押すと、その Project で最後に開いていた Thread を開く（決定・2026-10-13、仕様 v4-frontend.md §6.40）：外枠がこの端末の localStorage（banto.lastThread.v1）に覚え、ほかの Project から名前・頭文字を押したときだけ使う。閉じられた Fork なら Base。いま見ている Project の名前なら Base。

### M24 人のログイン（元 65・66・68・69・74・76）
人のログイン（決定・2026-10-03〜10-04、仕様 v4-security.md「人のログイン」）：パスワードは置かず、パスキー（WebAuthn）・「端末を追加」（10分・1回だけの QR とリンク）・host のコマンド `node scripts/login-link.mjs`（`--rotate-machine-token`）で入る。端末ごとのセッションの Cookie（HttpOnly・Secure・SameSite、30日で使えば延びる）。機械のトークンは E2E 等の口として残す。端末を追加・パスキーの追加と削除・締め出しの前に step-up（userVerification required）。リンクで入った直後10分・パスキーで入った直後5分は step-up 済み。Publish の公開先の前の認証も同じログイン（M3）。

### M25 Factory（元 72・78・83・86・87・115・125・130）
Factory（決定・2026-10-03〜10-07、仕様 v4-modules.md §4.5）：Claude Code の Dynamic Workflows の形を借りた自前の Module（Project ごと）。1件の段は worktree→実装（サブエージェント）→テストの関門（落ちたら戻す）→レビュー（別のサブエージェント・完了条件で判定）→マージの列（rebase・テスト・fast-forward）→Backlog を done・片づけ。必ず守るのは worktree・Project で1本の列・Backlog の状態・記録と再開、手順は関数1本で差し替えられる。テストのコマンドが無ければ流さない。流せるのは ready で依存が done のタスク・バグだけ。止まったら頼んだ Thread に知らせ、AI が answerFactory（continue・accept・retry・drop）で答える。既定は同時3件、テスト3回・レビュー2回・rebase 3回・競合の解き直し2回。マージ前に人を待たない。人が見たいのは終わったことと、長引いたときの中身。画面は ui://banto-factory/runs と config。受け入れは本物で通した（試験用 Project「Factory 受け入れ」が残っている）。

### M26 中継の承認の時間（元 80・107）
Module 間中継の承認と時間の上限（決定・2026-10-04・10-06、仕様 v4-frontend.md「Module 間中継の承認」）：AI→Module の呼び出しの上限（60秒）は host が数え、Module の進捗で数え直し、人を待つ間（holdForHuman）は数えない。入れ子の中継では呼び出しが親を持ち、hold は外側にも立てる。承認を聞いた呼び出しが答えの前に終わったら判断待ちを拒否で畳みカードを回答済みにする。

### M27 インストール（元 84・95）
新しいホストへのインストール（決定・2026-10-04〜10-05、手順 docs/runbooks/install.md・仕様 v4-security.md §1「入れ方」）：`curl -fsSL https://raw.githubusercontent.com/tjst-t/banto/release/install.sh | bash -s -- --domain <名前> [--cloudflare-token …]`（banto.tjst-t.dev/install.sh からも転送）。Ubuntu 24.04・26.04、sudo できる普通のユーザー。何度打っても壊れず、決めた値は /etc/banto/install.conf に覚える。トークンが無ければ Caddy の内部 CA。Cloudflare に名前と *.名前 のレコード（印つき）を作る。人の Caddyfile には import の1行だけ。core は 0.0.0.0 で nftables の表 inet banto が外からを落とし、画面は 127.0.0.1:4175。上げる段は update.mjs と setup-update.sh。earlyoom も入れる（M28）。

### M28 earlyoom（元 176・177）
host の earlyoom（決定・2026-10-11〜12）：swap の無い host はカーネルの OOM の前に固まるので、install.sh と手順書で earlyoom（-m 10,5 -s 100 -r 3600 -p、init・systemd・sshd・incusd・caddy 等を避ける）を入れる（この host は手で入れて確認済み、既存の環境はインストーラの打ち直しで入る）。案2（banto が空きと PSI を見て知らせ・重い仕事を控える）は資源の逼迫の段3（M17）。

### M29 Vault の版と空の値（元 110・111・112・126）
Vault の版と空の値（決定・2026-10-06〜10-07、仕様 v4-modules.md §2.1）：Project ごとに Infisical の環境を選ぶのは vault-kit の汎用の「版（variant）」で、名乗った実装だけ紐付けの画面に版の選択が出る（グループの書き方 `<グループ>@<版>`、既定の版は `@` 無し、一覧に出るのは紐付けた版だけ）。値が空の秘密は一覧で空と示し、渡すとき（resolveAlias・envSecrets 等）は理由をつけて断る。まだ紐付けていない版へ移す・参照を置くときは注意を出すだけ。

### M30 Vault の値の書き換え（元 127・129・131・132）
Vault の値の書き換え（決定・2026-10-07〜10-08）：「Vault を管理」の行から人の画面だけで値を置き換えられる（replaceSecretValue、AI からは呼べない・値は返さない）。参照の行は元の場所で変える、oauth-token は対象外。SSH 鍵は「相手に登録した公開鍵と合わなくなる」と注意し、貼り付けか Vault の中で作り直し、新しい公開鍵を出す（置き場の ssh-agent は落とす）。値を変えた日時を残して出す。グループ欄から新しいグループを作れる（名前の「@」は断る）。グループの選択肢は名前の順。

### M31 起こし直しをまたいで続ける（元 94・97）
起こし直しをまたいで続ける（決定・2026-10-04〜10-05、経緯 docs/notes/2026-10-04-resume-across-restart.md）：banto 本体がターンの途中で止まって起き直したら、切れたターンを自動で続ける（切れたとき実行中だった呼び出しは banto が書いて届ける）。続けて切れたら（RESUME_CUT_LIMIT=3）やめて受信箱で「続ける」を聞き、その間届いたもので起こさない。書きかけの文は「（起こし直しで切れました）」と残す。承認待ちは無効にする。Module は resumesAfterRestart と名乗れば約束した仕事を「続ける」か「途中で終わりました」で返せる（Subagent・Factory・Shell）。banto-host は KillMode=mixed。

### M32 判断待ちのカード（元 96・119）
判断待ちのカードの答え方（決定・2026-10-05〜10-06、仕様 v4-frontend.md「答え方」）：選択肢を押したらそのまま答えを送る（自由記述のあるものだけ送るボタン）。ボタンは右寄せで最初だけ塗る。tool のカードに assistant-ui の英語の Allow / Deny を出さない（hideApproval）。承認と関係のない tool のカードは自動で開かない（承認を求めるカードとそれを包むまとまりは開く）。

### M33 Module 宛ての返事（元 100・149）
Module 宛ての返事（決定・2026-10-05・10-09、仕様 v4-architecture.md §4.2）：host が中継の上限を数え、宛先の途中経過で数え直す。Module が中継で deliversLater の tool を呼び、呼び元が受け口（_meta["dev.banto/receivesReplies"]）を名乗れば、呼び元に結びついた札を渡す。返事は module-replies.json に残してから渡し、止まった呼び元には次に繋がったときに渡す。頼んだ先が止まった・起こし直したら lost。受信箱にも Thread にも出さない。Project を畳むときは Module を全部台帳から外してから止める。未決：On demand の呼び元に残った返事が渡らない。

### M34 承認をすべて自動で許可（元 104・106）
「承認をすべて自動で許可する」（決定・2026-10-05、仕様 v4-frontend.md §6.4）：Project 全体の設定（approvals.autoApproveAll、GET/PUT /api/projects/:id/auto-approve）。通すのは tool の確認・中継の確認（秘密を返すものも）・Project をまたぐメッセージ・Publish の公開。覚えない（grant を残さない）。カードは「自動で許可しました」で残す。対象外：パスキーの step-up・人が値を入れるもの・Elicitation・自動化を作る/変える/再開する・Memory を取り消す/改める。host は AI のターンからの呼び出しにだけ dev.banto/autoApprove を刻む。

### M35 GitHub ログインの更新（元 109・114）
GitHub ログインの更新（決定・2026-10-06）：host は中継の宛先に dev.banto/callerModule を刻み、宛先の tool が dev.banto/callerOwned を名乗り宛先・呼び元とも同梱で呼び元が banto 本体で動き Project を持たないときだけ承認を聞かない（一般の仕組み）。vault-kit の putSecret は oauth-token の持ち主を残し、置き換えは持ち主からだけ。Repositories は新しいログインを既定の金庫に置き（repositories-github-<login>）、書けなかった組はメモリに持って置き直す。残り：Backlog #219。

### M36 ターンの終わりのまとめ（元 116・117・118・120・121・122）
ターンの終わりのまとめ（決定・2026-10-06〜10-07、仕様 v4-architecture.md §2.2・v4-frontend.md §6.35）：core の report_turn（request・outcome・decisions・nextSuggestions、URL は任意）。Project ごとのスイッチ（thread.turnSummary、既定オフ）。作業をしたターン・長い報告だけで呼び、本文を書き終えてから最後に呼ぶ（呼んだら PostToolUse の continue:false でそこで終わる）。呼び忘れは Stop hook で一度だけ差し戻す（tool を使ったか3分以上のターンだけ）。画面はそのターンの一番下、左の線は決めることがあれば橙・無ければ緑。サブエージェント・Factory の中では出さない。

### M37 Shell の待たない形（元 123・124・133）
Shell の待たない形（決定・2026-10-07〜10-08、仕様 v4-modules.md §2.3）：runCommand の runInBackground（と呼び名 label）。systemd-run --user で切り離して流し、出力は output.log、終わったら終了コードと末尾50行と outputFile を頼んだ Thread に届けて起こす（起こし直しをまたぐ）。listCommands と cancelCommand は頼んだ Thread からだけ。envSecrets は tmpfs の 0600 のファイルで渡しすぐ消す。Service には足さない。

### M38 Browser の方向（元 135・163・173）
Browser Module（決定・2026-10-08〜10-11）：既存の MCP はマウントせず自作1本（ブラウザ本体・人の画面・AI の道具・通信の記録）。ブラウザは Project のコンテナの中の仮想の画面（Xvfb）で普通の Chromium を画面ありで、自動操作の印を付けずに起こし CDP で繋ぐ——「人が普段使う Chromium に AI も触れる」形で、偽の値を差し込む細工はしない。CAPTCHA は人が解く。AI の Web 検索は WebSearch。WebGL は要らない。人の画面との流れは core の汎用の「流れの中継」（Terminal と共有）。ログイン状態は Project ごとに残し消す操作も持つ。最初はブラウザが出す通信だけ記録する。

### M39 Terminal（元 136・137）
Terminal（決定・2026-10-08、仕様 v4-modules.md §4.6）：Shell には足さず別の Module（人が使い状態を持つ）。打鍵と出力は core の流れの中継に乗せる。シェルは tmux（-L banto-terminal）に持たせ、AI が Shell からそのセッションを読む・打つのは認める（Terminal の道具は人専用のまま）。

### M40 別のサーバ（実行場所）の作り（元 138・139・140・141・160・165・194）
Project の実行場所——別のサーバ（決定・2026-10-08〜10-14、仕様 v4-security.md §1）：目的は containerlab で Proxmox を試すなど入れ子の仮想化が要る仕事（Incus の VM を足す案は採らない）。まず SSH で入るサーバ丸ごとを Project の箱にし（あとで向こうの Incus のコンテナを足せる形）、1つの実行場所に Project は1つ（閉じた Project は数えない）。banto 全体の設定の「実行場所」で登録（SSH の宛先・Vault の ssh-identity・host 鍵の指紋を人が確かめる・前提の確かめ）。新しい Project の一番上で選ぶ（画面はモック d33bb5e3）。フォルダと Module の置き場は向こう、コードと node は banto が送り込む、SSH の接続1本に Module の標準入出力と逆向きのトンネル（中継・Claude の中継・流れの中継）を載せ、向こうに LAN の待ち受けは開けない。Runner の作業ディレクトリは host 側の空のフォルダ。前提の道具（git・ssh・curl・tar）が無ければ断り、特定の Module の道具（tmux）は注意だけ。向こうは丸ごと「その Project の AI のもの」、専用ユーザーを勧め、資源の上限は付けない。資源は設定の「資源」に出す（張ってある接続で読むだけ）。Publish は Caddy から向こうのアドレス:ポートへ。

### M41 移す・戻す・閉じる（元 172・174・186・187）
Project を別の実行場所へ移す（決定・2026-10-11〜10-13、仕様 v4-security.md §1）：Project の設定「一般」の実行場所の欄から移す。フォルダ（.git ごと）と Module の置き場を写し、会話・Memory は移さない。入れた道具・イメージ・動いているものは移らず、動いているもの・走っているターンがあれば断る。元のフォルダは消さない。各 Thread に「root が変わった」を知らせ、Claude の会話の記録は新しい作業ディレクトリへ写す（同じ id で中身が違えば古いほうを .before-<日時> に退かせる）。移す先は「無いか空」か「その Project が前に居た場所」で、前に居た場所へは rsync -a --delete で差分で揃える（触っていたら上書きされるファイルを見せて承知を取る）。閉じたら実行場所は空き、向こうの Service の自動起動を切り、フォルダと置き場は残す。再開するとき実行場所が別の Project に使われていたら断って移す画面へ案内。

### M42 別のサーバへ送るもの（元 196・215）
別のサーバへ送る banto のコード（決定・2026-10-14〜10-15、仕様 v4-security.md §1「向こうに置くもの」）：コード・依存・node を別の鍵（中身のハッシュ）で置き、版は3つの組で前の版と共有する。依存は node_modules の下のパッケージごとの塗り（入れ子も場所ごと）で、向こうに無いものだけ送る（照合は1回のコマンドで）。動かすのに要らないもの（TypeScript 等）は送らない。VM で npm から入れさせる案は採らない。

### M43 AI への指示（元 156・157）
Project ごとの「AI への指示」（決定・2026-10-09〜10-10）：Project の設定「一般」の自由文の欄（thread.instruction、GET/PUT /api/projects/:id/instruction）を土台の指示の「この Project 固有の指示」に流し、次のターンから全 Thread に効く。banto 全体の決まりは Global Memory。CLAUDE.md は読まない。自動の要約が起きたら memoryBaselineSeq をその時点に決め直す（thread.compacted）。

### M44 公開サイト（元 191・192・210・217）
公開サイト banto.tjst-t.dev（決定・2026-10-13〜10-15）：Cloudflare Pages（プロジェクト banto、GitHub tjst-t/banto に接続、root_dir site・npm run build・dist・NODE_VERSION=22）。本番ブランチは release（インストールされる版と揃える）、プレビューは main。カスタムドメインは tjst-t.dev ゾーンの CNAME。/install.sh は GitHub の release の install.sh へ 302。Astro Starlight、日本語で始め英語は後から足せる作り。API の操作は Vault の cloudflare-pages-token と CLOUDFLARE_ACCOUNT_ID。

### M45 自動化（元 184・197・206）
自動化（決定・2026-10-13〜10-15、仕様 v4-architecture.md §4.3・v4-frontend.md §6.42）：core に持つ汎用の「きっかけ」＝出どころ＋条件＋届け先（専用の Fork を毎回まっさら／引き継ぐ、または既存の Thread）で、既存の「Thread に届ける」口で起こす。段1（時刻・LAN からの Webhook・今すぐ）は実装済み、段2（Module の出来事）・段3（外の出来事）は未着手。画面は core の画面を Canvas に（canvas=banto:triggers）。最短15分・前の回が終わっていなければ飛ばす・止まっていた間は最新の1回だけ・承認は今どおり。AI が作る・変える・再開するときはどの承認モードでも必ず聞く。終わった回を受信箱に出すかは自動化ごとに選ぶ。細部は docs/notes/2026-10-15-triggers.md・automation-*.md。

### M46 受信箱（元 198・199・200・209 と 201・207 の要点）
受信箱（決定・2026-10-15、仕様 v4-architecture.md §2.4・v4-frontend.md §6.41）：受信箱は「人の番になったもの」だけ。判断待ちが一番上、会話が人に返ってきたもの（裏の仕事も届いたものも残っていない・切れた・失敗した・止めたターン）は全部出し、決めることがあるものは上に寄せる。届くたびの知らせは自動で起こさなかったときだけ、仕組みの異常は人が直すものだけ残す。画面は全面の一覧で、各項目を中身（最後の返事・まとめ・選択肢）まで読めるカードにし、その場で返信・承認に答えられる（Elicitation は会話で）。どのカードからも関係する会話・Project・Module の設定へ移れる（Claude ログイン切れは口なし）。バッジは判断待ち＋決めることのある件数。

### M47 PDF・Office のレビュー（元 202・203・204・205・211・214・218）
PDF・Office のレビュー（決定・2026-10-15、仕様 v4-modules.md §2.2・v4-frontend.md §6.2、Backlog ストーリー #301）：編集はせず、元の見た目で読み、場所を指してコメントを付け AI に返す。画面は ui://banto-filesystem/document、Canvas の CSP は緩めない。PDF は pdf.js（Worker 無し、readFileRange で大きくても開ける）、docx は docx-preview、pptx 等は変換役で PDF、xlsx は変換役で計算し直した値の表。変換役 documents（LibreOffice）は banto 全体に1つ、同梱の道具用のコンテナ（第三者の Module と同居しない）で動き、1件ごとに bubblewrap で囲む（ネットワーク無し）。入出力は最初 7MB まで（超えるものは #311）。FileSystem→documents の中継は statelessTransform で承認なし。コメントは FileSystem が Project ごとに保存し、「AI に返す」は ui/message で入力欄の上に出所つきの添付として置く（送るのは人）。AI 向けに readDocument。道具用のコンテナの Module は使うときだけ起こす。

### M48 運用の事実（元 15 の事実を 71 に足す）
（元 71 を改める）Thread ごとの開発は worktree で行う運用ルール（決定・2026-10-03）：Fork で開発を始めるときは Project の root の中の `.worktrees/<名前>` に `git worktree add .worktrees/<名前> -b fork/<名前>` で作り、そこで作業・テスト・コミットする。root の外には置かない。node_modules は `cp -al` で写す（main の作業ツリーのものは古いことがあるので、新しい worktree のものか npm ci）。コンテナから GitHub への push は Shell の sshIdentity に Vault の github-token（Deploy key、書き込み可）。ローカルの main には他の Fork の未 push のコミットが積まれていることがあるので、push するときは origin/main の上に自分の分だけ載せる。

## そのまま残す
8, 12, 25, 62, 85, 88, 89, 108, 134, 145, 154, 162, 178, 185, 193, 195, 216, 219（と、この棚卸しのあとに足された行）
