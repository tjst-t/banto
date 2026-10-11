# 2026-10-08 Project の実行場所を VM・別のサーバに広げる検討

Fork「実行環境を VM・別サーバに広げる検討」。仕様は `docs/specs/v4-security.md` §1「Project の実行場所——別のサーバ」。

## 問い

Project の実行環境を、今の Incus のシステムコンテナだけでなく VM・別のサーバでも使えるようにできないか（ユーザー）。

## 今の作りで、コンテナに頼っているところ（コードを読んで洗い出した）

- `packages/container/src/project-container.ts`：作る・起こす・止める、Project の根と banto のコードと Module の置き場を
  **host と同じパスで**マウント（`raw.idmap` で持ち主を揃える）、node を `incus file push`、資源の上限 `limits.*`、
  host に届くアドレス（ブリッジの host 側）、コンテナのアドレス（Publish 用）、cgroup の数え（上限の知らせ）
- `core/src/cli.ts`：`incus exec` で Module を起こし標準入出力を繋ぐ（env は `--env`）、Module の置き場を中に見せる、
  Vault の ssh-agent の窓口を Module の置き場の中（`<置き場>/s`）に立てる、Shell のホームに設定を写す
- host の側で Project の根を直接触るもの：Runner（Claude Code の CLI）の cwd・CLI の記録の置き場の鍵
  （`http/app.ts`・`delivery/turn-continuation.ts`）、Repositories（clone・削除・ブランチを送る口）、フォルダ選び
  （`GET /api/fs/directories`）、広すぎる根の判定
- 流れの口（アーキ §5.8）は host が Module の置き場の UNIX ソケットへ host の側のパスで直接繋ぐ

## 3つの候補の当てはめ（◎そのまま／△替わりが要る／×成り立たない）

| 今の仕組み | Incus の VM | SSH の別のサーバ | 別のサーバの Incus |
|---|---|---|---|
| Module を起こして標準入出力 | ◎（incus-agent） | ◎ ssh | ◎ リモートの incus exec |
| Project の根を同じパスで | △ virtiofs、`raw.idmap` 不可 | × 向こうにある | × 同じ |
| Module の置き場を同じパスで | △ virtiofs | × 向こうに置く | × 同じ |
| host で根に触るもの | ◎ | × 作り直し | × 同じ |
| 中から banto（/relay・Claude） | ◎ | △ 入口が閉じている→SSH の逆向きトンネル | △ |
| Vault の ssh-agent（ソケット） | × virtiofs を越えない | × 転送が要る | × |
| Publish | ◎ | △ LAN で届けば | △ |
| 資源の上限・知らせ | △ メモリは割り当て、CPU の時間の上限・プロセス数が効かない | — | ◎ |
| 起こす速さ | △ 数十秒 | ◎ | ◎ |

この Project のコンテナには `/dev/kvm` が無く、VM は試せなかった。`poc/10-project-vm/probe.sh`（host 用）は未実行。

## 決まったこと（ユーザー）

1. **本命の場面**は「containerlab で Proxmox を試し、その上で VM を動かす」。banto の host 自体が VM なので、今の
   コンテナでも Proxmox が2段目・その上の VM が3段目、Incus の VM だと3段目・4段目になる。物理サーバなら1段目・2段目で
   仮想化支援が効く。→ **Incus の VM（案1）はこの目的に効かないので優先しない**
2. **まず案2（SSH で入るサーバ丸ごとを Project の箱）を作り、あとでそのサーバの中の Incus のコンテナ（案3）を足せる形に**
3. 本番の物理サーバは banto の host と同じ LAN の Ubuntu（これから組む）。試験にはまず別の VM を立てる
4. 案2の作りの8点（登録と選び方・向こうに置くもの・SSH の接続1本・host が根に触っていたものの扱い・閉じ込め・
   最初は作らないもの・Publish・試験）は提案どおり（「8点ともおすすめでよい」）

## 実行場所を Module にしなかった理由

Vault・Publish・Backlog の「窓口1本＋実装が複数」の形も考えたが、実行場所は Module を起こす側なので Module にすると
自分を起こせない。閉じ込めは core が持つと決めている（v4-security §1）。core の中の差し替え口にする。

## Fable のレビュー（1回目、2026-10-08）と直したこと

判断は「高の4点を反映してからでないと実装に進まないことを勧める。大筋（8点）は変えずに足せる」。直したこと：

- 高1 **Claude の中継は今 `subagent-settings` が開くたびに新しいポートで待ち受ける**ので、決まったトンネルでは届かない
  → 先に `claude-login-relay-owner`（core に常設、2026-09-27 に決めた形）を入れ、別のサーバはそれに依存する
- 高2 **SSH が切れても向こうの Module は生き残る**（sshd が気づくまで約2時間）→ 起動役が向こうのユーザーの systemd の
  単位（`banto-mod-<接続名>`）で包み、起こす前に残っていれば止める。落とすときは `systemctl --user stop`。`ServerAlive*`
- 高3 **同じ SSH ユーザーに Project を複数置くと Service が互いの unit を孤児として消す・ポートがぶつかる** → 最初の版は
  1つの実行場所に Project は1つ（複数は向こうのコンテナの段で）。※元の仕様は「複数置いてよい（分けられない）」だった
- 高4 **ssh-agent の窓口は名前が動的で、誰が向こうのパスに付け替えて転送を張るかが無い** → host の中継が応答を書き換え、
  転送を張る・外す。張る前に向こうのファイルを消す（`StreamLocalBindUnlink` に頼らない）
- 中：根の正規化が host の realpath で毎ターン呼ばれる（Project の記録に `runtime` を持ち、向こうで1回だけ正規化）、
  Repositories の突き合わせから別のサーバを外す（`listProjects` に `runtime`）、トンネルの先を中継だけの専用の待ち受けに
  （向こうの 127.0.0.1 は全ユーザーに開く）、env は標準入力の最初の1行（ログインシェルの出力が MCP を壊すので
  「`ssh true` が空」を前提に）、前提の確かめの一覧、版の鍵は中身のハッシュ・起こすたびに照合（向こうのコードは
  読み取り専用にできない）、合言葉は `inContainer` と同じ刻印、`ssh` の設定を固定（`-F /dev/null`・`ForwardAgent=no` 等）、
  E2E の入れ子では linger が断られるので `user@<uid>` を起こしておく
- 低：上限の一括反映を host の Project だけに、Project を閉じても向こうの置き場は消さない、Shell のホームの送り直し、
  `MaxSessions` を前提の確かめに

## Fable のレビュー（2回目）と直したこと

前回の17点は15点が解消・2点が一部。判断は「この仕様で実装に進んでよい（A は claude-login-relay-owner に着手する前に反映）」。
新しい指摘を反映：A 中継の送り元の縛りはコンテナの段のもの、別のサーバでは実行場所ごとの専用の待ち受けが送り元の代わり
（§2 と Backlog 157 の完了条件）／B 照合は接続を張ったとき1回、送り直しは新しい置き場に展開して切り替える／C linger が無い
ことは断らず受信箱の注意、断るのは `/run/user/<uid>/bus` が無いときだけ（本番と試験で同じ規則）／D アーキ §5.8 に転送の手元の
端へ繋ぐと1行／E core が自分のために Vault の窓口を立てる形／F 起動役が XDG_RUNTIME_DIR・DBUS_SESSION_BUS_ADDRESS を組み立てる。

## 登録と選び方を作ったときに決めたこと・却下した案（2026-10-10、Backlog `remote-runtime-registry`）

画面はモック（abb6ef82）のまま（ユーザー「UIはばっちり」）。実装で決めたことと、選ばなかった形：

- **名前を id にした**。モックは id と名前を分けていたが、Project の記録の `remote:<名前>`（仕様の書き方）と `remote:<id>`
  （タスクの書き方）の両方を満たし、外すときは使っている Project が無いことを確かめるので名前が宙に浮かない。名前は
  置き場のフォルダ名にも入るので、英小文字・数字・`-` に絞った
- **known_hosts は記録から書き出す写し**にした（記録を真実にする。規則3）。known_hosts のファイルそのものを真実にする案は、
  一覧に指紋と「いつ確かめたか」を出すのに毎回ファイルを読むことになり、鍵が変わったときの「いま返ってきた鍵」を置く
  場所が別に要るのでやめた。`HostKeyAlias` で1行に決めたのは、`[host]:port` の書き方や名前と IP の揺れで照合が外れないため
- **鍵が変わったことは、ssh の断りを見てから `ssh-keyscan` で引く**。繋ぐたびに先に `ssh-keyscan` して比べる案は、
  `StrictHostKeyChecking=yes` が同じことをするので往復が1回増えるだけ
- **`IdentitiesOnly=yes` には公開鍵のファイルを渡す**。`IdentityFile=none` で既定の鍵を止める案は、`IdentitiesOnly=yes`
  （仕様）と一緒に使うと agent の鍵も出さなくなるので、仕様の言葉どおりにできなかった
- **転送は実際に頼んで確かめる**。`sshd_config` を読む案は `Match` や Include の順で外れる。最初は `-R` を2本まとめて頼んだが、
  `ExitOnForwardFailure` は最初の断りで終わるので UNIX ソケットの側が分からなかった（実測）——1本ずつ別の接続で頼む
- **`MaxSessions` だけはファイルを読む**（root でないと `sshd -T` が使えない）。何本あれば足りるかは本当の起動で決まるので、
  いまは既定の 10 を下回ったら注意にとどめた
- **本当の起動ができるまでは、別のサーバの Project の Module を起こさない・会話を断る・根を変えさせない**。作った直後に
  画面が Module の用意を頼むので、何もしないとこの機械のコンテナで向こうのパスを根にした別物が立とうとする（規則2）。
  受信箱には Module ごとではなく Project ごとに1件にした（Module の数だけ並ぶのを避ける）。会話の本体の作業ディレクトリを
  host の空のフォルダにする（仕様）のは、本当の起動と一緒に入れる——いま入れると、道具の無い会話が始まるだけ
- **Project の設定の置き場**：モックは「セキュリティ境界」の節に読むだけで出したが、本物ではその節はまだモックのまま
  隠れている（繋がっていない入口を出さない）。根を出している「一般」の Root パスの上に置いた

### レビューで直したこと（2026-10-10）

- **登録の直後に known_hosts が無かった**：`register` は `check` と同じ一時の置き場（`.probe-<乱数>`）で繋いで消していたので、
  `remote-runtimes/<名前>/known_hosts` は次に繋ぐまで書かれなかった（E2E がそこで落ちた）。登録の接続から恒久の置き場に書き
  出す形に揃えた（「繋ぐたびに記録から書き出す」の1回目が登録）。登録しなかったら消す
- **見るもの 6 の食い違い**：別のサーバの Project で止めるのは Project ごとの Module だけで、banto 全体の Module（Vault 等）は
  今までどおり繋がる——Project の箱に置かないので、それが正しい。spec が「何も繋がらない」を見ていたのを、「Project ごとの
  Module が無い・banto 全体のもの以外が無い・この Project のコンテナが作られない・受信箱に1件」を見る形に直した
- **環境の罠**：この作業環境（サブエージェント）は HOME が 109 バイトあり、E2E を素の HOME で回すと Vault の
  「鍵の窓口のパスが長すぎて作れません（Unix ソケットは 107 バイトまで）」で先に落ちる。コードの欠陥ではない——
  `sudo -n -E -u ubuntu env HOME=/home/ubuntu PLAYWRIGHT_BROWSERS_PATH=<元の HOME>/.cache/ms-playwright npx playwright test …`
  で回す

## Module の起動を作ったときに決めたこと・却下した案（2026-10-10、Backlog `remote-runtime-ssh`）

仕様の形（v4-security.md §1「実装の形（Module の起動）」）にした理由と、選ばなかった形：

- **実行場所は振り分け役（`runtime/router.ts`）で足した**。`Runtime` の口を Project ごとに選ぶ形（cli が2つの実行場所を持って
  呼び分ける）は、cli の中の `runtime.` の呼び出し全部に分岐が要る。振り分け役なら cli の呼び出しはそのままで、別のサーバで
  作らないもの（上限・資源の見張り・Publish の宛先）を1か所に書ける
- **env を最初の1行で渡すのに、StdioClientTransport を継いで `send` に1行を渡した**。`send` は JSON-RPC の形を見ずに
  `JSON.stringify＋改行` を書くので、起動役への1行がそのまま書ける。自前の Transport を書く案・子プロセスの stdin（private）に
  直に書く案は、SDK と同じものを二重に持つか、SDK の中身に頼ることになる
- **起動役を2段にした**（仕様の `systemd-run --user --scope` から変えた。規則8で記録し、仕様も直した）：入れ子の試験の相手で
  `--scope` は「Job failed」、`--pipe`・`--wait` は「Access denied」で断られた（30 秒のプローブで測った）。ふつうの
  `systemd-run --user` だけが通る——Shell の待たない形と同じ。SSH のセッションの cgroup（logind の session-N.scope か、
  入れ子では sshd の下）のプロセスを、ユーザーの systemd（user@<uid>.service の下）が自分の単位に移せない・AddRef の呼び元を
  確かめられない、が理由と見ている（本番の Ubuntu で `--scope` が通るかは確かめていない——通っても、通らない相手がある以上
  同じ形にする）。2段目（単位の中）との受け渡しは Unix ソケット（`/run/user/<uid>/banto/`、0700）。env をファイルに書いて
  単位に読ませる案（Shell の待たない形の形）は、仕様の「ファイルにも載らない」に反するのでやめた。名前付きパイプ（FIFO）
  2本の案は、外側が開く前に内側が書くと詰まる・向こうに残る、の扱いがソケットより面倒
- **ソケットは半分だけ閉じられる形に**（`allowHalfOpen`）：host が標準入力を閉じると外側がソケットの書く側を閉じるが、
  既定のままだと内側の書く側まで閉じ、Module の最後の出力が落ちた（単体試験で見つけた）
- **起動役は1バイトずつ読む**。node の stream で読むと、最初の1行の後ろの MCP のやり取り（initialize）まで読んでしまい、
  `stdio: inherit` で渡した Module に届かない。読み過ぎた分を中継する形は、起動役がずっと間に挟まる
- **版の鍵の計算を coreutils で再現できる形にした**（`sha256sum` の出力を並べたもののハッシュ）。向こうで node のスクリプトで
  照合する案は、照合する側のコードも向こうで書き換えられる。tar のハッシュを比べる案は、展開したあとの書き換えを見られない
- **node と起動役は版の中に入れた**（`bin/node`・`banto-launcher.mjs`）。別に置いて版の鍵から外すと、そこだけ照合されない
- **送るのは Module のパッケージから辿れる依存だけ**。node_modules を丸ごと（1.5GB、Next.js・Playwright・TypeScript を含む）
  送る案はやめた。辿った結果は約 1GB——大半は Subagent のエージェントの実行ファイル（OpenCode の写し3つ・Claude の
  エージェント）。要るときだけ送る形は、Module の宣言に「何を使うか」が無いので作っていない
- **Terminal の tmux は、core が起こす前に断る案をやめ、Module に `BANTO_NO_SUDO=1` を渡して Module が開いたときに断る形にした**。
  core が起こす前に断ると入口（ランチャー）ごと消え、人は「Terminal を開く」ことができずに受信箱のお知らせだけを見る
  （完了条件の「Terminal を開くと理由と入れ方つきで断る」にならない）。Terminal は元から別のサーバ向けの断りの文を持っていたが、
  先に `sudo -n apt-get install` を試していた——sudo できないユーザーの `sudo -n` も向こうの記録に残る（仕様の「向こうで sudo
  しない」に反する）。印は「sudo しない箱」の意味だけで、実行場所の種類は Module に渡さない
- **Service の linger**：ユーザーの systemd のバスがあれば linger を入れようとしない形にした（Shell の待たない形と同じ順）。
  以前は linger が無ければ必ず `sudo -n loginctl enable-linger` を試し、失敗したら Service ごと使えなかった——入れ子の試験の
  相手（バスはあるが linger は無い）でも、linger を入れていない本番のサーバでも
- **鍵の窓口を閉じていない**（仕様と違う。規則8で記録）：Vault に窓口を閉じる口が無い。足すと vault-kit の口・2つの金庫の
  実装・中継の可視性に触るので、この段では作らなかった。多重化した接続は張ったあと鍵を使わないので、閉じないことで
  使える鍵が増えるわけではない（Vault の使い回しのまま、Vault が終わるときに落ちる）

### 試験の作り（E2E `remote-runtime-ssh.spec.ts`）

- **「SSH が黙って切れる」は、向こうの sshd のセッションを SIGSTOP してから host の親の ssh を SIGKILL で落として作る**。
  host だけを落とすと、向こうの sshd が FIN を受けて Module に標準入力の終わりが届き、前の Module が自分で終わる——起動役の
  「残っていれば止める」を通らない。sshd を止めておけば、前の Module は生き続け、繋ぎ直したときの起動役が止める
- Terminal は目録から入れる（banto 全体の宣言に入る）ので、試験の終わりに外す
- **サブエージェントは `fake-host`（本体のログインを使う形）で呼ぶ**。最初に書いた `fake` は既定の鍵を Vault に聞く
  （`lookupAlias`）ので、人への承認が出て誰も答えず 180 秒で切れた。`ANTHROPIC_BASE_URL` も渡らない（本体のログインを
  共有しないエージェント）——Claude の中継を通ることを見るなら `fake-host`
- **登録の spec（`remote-runtime-registry.spec.ts`）の「向こうに置き場ができた」は `incus exec` で見る**。その spec は途中で
  向こうの host 鍵を変えるので、試験の側の known_hosts で `ssh` すると「REMOTE HOST IDENTIFICATION HAS CHANGED」で何も返らない

## ソケットの転送を作ったときに決めたこと・却下した案（2026-10-11、Backlog `remote-runtime-sockets`）

仕様の形（v4-security.md §1「ソケットの転送」）にした理由と、選ばなかった形：

- **向こうの端を「Module の置き場の `s` の同じ名前」から「向こうの置き場の `s`」に変えた**（仕様の書きぶりから変えた。規則8で
  記録し、仕様も直した）：`<置き場の根>/<ハッシュ>/modules/shell-<Project の id>/s/a-xxxxxx` は既定の置き場の根で約 115 バイト
  あり、sshd が bind できない（Unix ソケットは 107 バイトまで）。host の Module は `viaDirectoryFd`（フォルダの番号越し）で
  長いパスでも待ち受けられるが、sshd にはその逃げ道が無い。向こうのユーザーは全部の Module で同じなので、Module ごとの
  フォルダに分けても閉じ込めの意味は無い——向こうの置き場（0700）の下で十分
- **流れの口の先は symlink にした**：向こうの Module は長いパス（Module の置き場）で待ち受ける。connect は symlink を辿り、
  上限が掛かるのは渡したパスだけなので、向こうの置き場の `s` に短い symlink を置いて sshd にはそちらへ繋がせる。Module の
  待ち受けの場所を変える案（`STREAM_SOCKET_RELATIVE_PATH` を別のサーバだけ変える）は、Module に実行場所を知らせることになる
- **流れの口の転送は札を出すときに張る**（Module を起こしたときに全部張る案はやめた）：流れを名乗らない Module にまで転送を
  張ることになる。`-L` は繋ぐたびに向こうの待ち受けを引くので、Module が起こし直されても張り直さなくてよい
- **Vault が窓口を閉じたことは、host の側の窓口のファイルが消えたことで知る**（1 秒ごと）。Vault は窓口を落とすとき
  （値の置き換え・終わるとき）ファイルも消す。Vault に「閉じた」と知らせる口を足す案は、vault-kit の口・2つの金庫の実装・
  中継の可視性に触る（前の段で窓口を閉じる口を足さなかったのと同じ理由）
- **応答の書き換えは「呼び元の `socketDir` の直下を指す `socketPath`」だけ**：tool の名前（`startSshAgent`）で見る案は、
  Vault の実装が増えるたびに host が名前を覚えることになる。`socketDir` は host が刻んだもの（呼び元の申告ではない）なので、
  その直下のパスを返すのは窓口を立てた宛先だけ
- **30 秒のプローブで先に確かめたこと**（入れ子のコンテナの中で ssh を自分に繋いで）：`-O forward`／`-O cancel` は `-R`・`-L` の
  両方で UNIX ソケットに効く。`-O cancel` のあとも窓口のファイルは両側に残り、消さずに張り直すと
  「remote port forwarding failed for listen path」で断られる——張る前に消すのは要る

## host が Project のフォルダに触っていたものを合わせたとき（2026-10-11、Backlog `remote-runtime-host-side`）

- **#247・#248 で済んでいたもの（重ねて作らず、確かめただけ）**：別のサーバの根を読み直しで realpath に通さない（`getProject`）・
  作るときに向こうで正規化した文字列を持つ・`listProjects` の `runtime`・Repositories の突き合わせから外す（`hostFolderProjects`）・
  ブランチを送る口の `handled: false`・`applyLimits` を host の Project だけに（`runtime/router.ts`）
- **Runner の作業ディレクトリを store の1つの関数（`runnerCwd`）にした**。ターンの始まり（`http/app.ts`）と続き
  （`delivery/turn-continuation.ts`）がそれぞれ根を正規化していた形のまま、両方に「別のサーバなら」を書く案はやめた——
  2箇所が食い違うと、続きが CLI の記録を別の置き場で探して「記録が無い」になる（規則3）。置き場の名前は Project の id で
  決まるので、起こし直しても同じ
- **システムプロンプトの実行場所の行は、別のサーバの Project にだけ足す**。全 Project に「実行場所：この機械のコンテナ」を
  足す案は、全 Project のプロンプト（キャッシュの前方一致）を変えるだけで、AI に新しく伝えることが無い
- **Project の設定の「Module」の広すぎる根の警告が、別のサーバの Project でも host で判断していた**のを向こうで判断するように
  した（「一般」と新しい Project の画面は #247 で向こうになっていた）
- **Backlog の push と `sshIdentity`（仕様と実態の食い違い。規則8で記録し、人に上げる）**：仕様の表は「Backlog の push は
  向こうの git の設定と、Vault の SSH 鍵（`sshIdentity`）で送る」と書くが、Backlog は `sshIdentity` を持たない（Shell の
  `runCommand` の引数）。Repositories が `handled: false` を返したあと Backlog が走らせるのは、向こうの Project の根での
  素の `git push`——資格情報は**向こうのユーザーの git・ssh の設定**（`~/.ssh` の鍵・資格情報の取り出し役）次第。
  E2E は origin を向こうの bare リポジトリ（ファイルのパス）にして、資格情報の要らない形で「向こうから push する」ことだけを
  確かめた。origin が GitHub の ssh のときに Vault の鍵で送らせるには、Backlog に ssh-agent の窓口を渡す形（宣言に
  `sshIdentity` 相当を足す等。ソケットの転送そのものは Backlog `remote-runtime-sockets` で入った）を決める必要がある——このタスクでは作らない

## Project を別の実行場所へ移す（2026-10-11、ユーザー）

ユーザー「既存の Project を別の実行環境に移す機能もあるといい」。案：写して切り替える・元は残す・動いていれば断る。会話の
続きが切れる件は、作業ディレクトリを全 Project で揃える案もあったが、ユーザー「Claude の会話記録もコピーするのではだめか」で
記録を写す形に。Runner の作業ディレクトリは別のサーバだと `runner-cwd/<id>` なので、写すのはこの機械のコンテナが関わるときだけ。
写した記録から再開できるかは作るときに最初に測る。仕様は v4-security.md §1「Project を別の実行場所へ移す」。

Fable のレビュー（2026-10-11）で直したこと：高——Shell・Terminal のホームは写さない（置き場から除く）／Service は core が登録を
書かず一般の印 `.banto-moved.json` を置き Service Module が全件止める・元の unit は disable／移す先に置き場が残っていれば
`.before-<日時>` に退かせる／入口は「一般」の実行場所の欄／`runtime_move_started` で受付を止め届いたものは留め、途中で落ちたら
起き直しで片づける。中——動いているものの数え方（host・繋がっている Module・Service と tmux は実行場所で直接）、`git worktree
repair`、会話の記録は全 Thread の全 resumePoint の分だけ（丸ごと写さない）、移す先を押さえる、根は先に作って正規化し重なりを断る、
Claude の合言葉を替える。低——イベント名を snake_case、戻るとき元のコンテナが再利用される、ソケットの除外、Terminal の控え、
Repositories の一覧。
