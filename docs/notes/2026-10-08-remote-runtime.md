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
