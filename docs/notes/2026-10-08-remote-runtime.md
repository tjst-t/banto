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
