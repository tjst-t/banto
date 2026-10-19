# 実行場所の登録で、足りないものを banto が入れる（2026-10-19）

決まったことは `docs/specs/v4-security.md` §1「足りないものは banto が入れる」。ここは経緯。

## きっかけ

- ユーザーが banto-ct-test（cloud-init の Ubuntu。`sudo -n` が通る・Incus 6.0.6・グループ `ubuntu adm cdrom sudo dip lxd incus-admin incus`）を
  `containers` で登録しようとすると、「足りないものがあるので登録できません。向こうで上のコマンドを打ってから、確かめ直してください」で止まった。
- 原因：`incus-admin` に入っていると Incus は区画 `user-1000` ではなく `default` に繋がる。`containers-host.ts` はこれを「人が直すしかない
  もの」として `sudo gpasswd -d ubuntu incus-admin` を見せて断っていた（2026-10-18 のノート `2026-10-18-containers-register-prepare.md` の
  「banto から incus-admin を外すことはしない（人のサーバのグループを勝手に減らさない）」）。
- `machine` は登録でも一度も sudo せず、道具・linger・sshd の設定を全部人に打たせていた。
- ユーザー：「banto として、containers でも machine でも、登録したときに足りないものがあれば自動で入れる仕組みを」。incus-admin は案A
  （banto が `gpasswd -d` で外し、ユーザーの systemd と SSH を繋ぎ直してから確かめ直す）。

## 2026-10-18 の決定を覆したこと

- 「banto から incus-admin を外すことはしない」→ 外す。VM は banto 専用の決まり（§1「別のサーバの中のコンテナ」）なので、人がこのユーザーで
  Incus を管理しない前提にした。確かめの一覧で「外します（このユーザーで Incus を管理しているなら、別のユーザーで登録してください）」と出す。
- 「`machine` では banto は別のサーバで sudo しない」→ 登録・人の「確かめ直す」のときだけは、`sudo -n` が通れば入れる。通るなら AI は
  もともと root になれるので、AI に新しく渡すものは無い。Module を起こすとき・繋ぐたびに sudo しない決まりは残す。

## Fable のレビュー（1回、2026-10-19）で直したこと

- **（高）「incus グループだけにする」が sudo グループまで外すと読めた**——外すのは `incus-admin` だけ、ほかのグループは触らない、と明記。
  実装も `gpasswd -d <user> incus-admin` だけ。
- **（高）sshd の drop-in の名前が仕様（90-banto.conf）・実装（00-banto.conf）・画面の文（banto.conf）でばらばら**——同じ鍵は最初の値が
  効くので 90 では `50-cloud-init.conf` に負ける。全部 `00-banto.conf` に揃えた。
- **（中）「sudo を絶対パスで」の根拠**——向こうのログインシェルと `~/.bashrc` を書き換えられれば sh ごとすり替えられるので守りにならない。
  理由は「PATH を当てにしない・sudoers で決まったコマンドだけを許す形に揃える」とし、守りの根拠は「machine の AI はもともと root、
  containers の AI は VM のユーザーのホームを見られない」に一本化した。
- **（中）sshd と Incus を `sh -c` の台本で打っていた**——sudoers で `sh -c` を許すのは ALL と同じ。項目ごとのコマンドに分け、ファイルは
  `tee` に標準入力で渡す形にした（sshd：tee → `sshd -t`（落ちたら rm）→ reload ssh、無ければ sshd）。
- **（中）Zabbly の鍵を VM の curl・gpg で確かめていた**——host で取って確かめ、中身を VM の `tee` に渡す形にした（VM に要るのは apt だけ）。
- **（中）抜けていた項目**：cloud-init の待ち（`timeout 600 cloud-init status --wait`、失敗でも先へ）、apt の上限（lock 5 分＋入れる時間で
  15 分）、`incus-user.socket`（incus-admin を外したあと繋がらなければ起こす）、bus が無いときの `dbus-user-session`、`NEEDRESTART_MODE=l`。
- **（中）二重に押すと apt が2本走る・失敗すると何をしたか消える**——同じ実行場所の準備は1本ずつ（作成・再開・移すと同じ鍵）、失敗の文に
  それまでに行ったことを添えた。裏で進める形は未決に置いた。
- **（中）改訂で古くなった文**（tmux は別のサーバでは入れない・`BANTO_NO_SUDO` の根拠・`machine` で sudo しない理由）を直した。
- **（低）machine の1項目ごとの引き直しはやりすぎ**——machine は全部打ってから1回引き直す（実装はもともとそう）。
- **（低）仕様の「きっかけ」は検討ログ**——このノートに移した。

## 未決

- パスワードの要る sudo（画面で1回入れて `sudo -S`）。今回は対応しない。
- 登録・確かめ直しを裏で進め、行に進み具合を出す形。
