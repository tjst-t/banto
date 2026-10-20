# 別のサーバを実行場所にする前の下ごしらえ（runtime-setup.sh）

決まりは `docs/specs/v4-security.md` §1「実行場所の下ごしらえのスクリプト」。ここは使い方。

## 打つもの

向こうのサーバ（Ubuntu 24.04・26.04、amd64・arm64）で、sudo できるユーザーか root として：

```
curl -fsSL https://banto.tjst-t.dev/runtime-setup.sh | sudo bash -s -- --pubkey "ssh-ed25519 AAAA… banto"
```

公開鍵は、banto の設定「実行場所」→「別のサーバを登録」で「新しい鍵を作る」を押すと出る（その下に、公開鍵を入れた
この1行も出る）。既にある鍵なら、Vault の画面で公開鍵を見る。

| オプション | 意味 |
|---|---|
| `--pubkey <公開鍵>` | banto がこのサーバに入る SSH の公開鍵。何度でも渡せる |
| `--pubkey-file <ファイル>` | 公開鍵をファイルから（1行に1つ） |
| `--user <名前>` | banto 専用のユーザー（既定 `banto`）。無ければ作る |
| `--mode containers` / `--mode machine` | 動かし方。`containers`（既定）は Incus も入れる、`machine` は入れない |

## すること（7段。何度打っても壊れない）

1. このサーバを確かめる（root・Ubuntu 24.04／26.04・CPU）。cloud-init が動いていれば終わるまで待つ
2. 前提の道具を入れる：sudo・openssh-server・openssh-client・git・curl・ca-certificates・tar・tmux・rsync・dbus-user-session・gpg
   （`containers` は btrfs-progs も）
3. ユーザーを作り（パスワードは設定しない）、`/etc/sudoers.d/banto-<ユーザー>` でパスワード無しの sudo を許す（`visudo -c` で確かめる）
4. 公開鍵を `~<ユーザー>/.ssh/authorized_keys` に足す（入っていれば足さない。ほかの鍵は消さない）
5. sshd：`/etc/ssh/sshd_config.d/00-banto.conf` に `AllowTcpForwarding yes`・`AllowStreamLocalForwarding yes`・`MaxSessions 20`。
   `sshd -t` が通らなければ元に戻して止まる
6. linger を入れ、ユーザーの systemd を起こす
7. `containers` なら Incus を Zabbly から入れ（鍵の指紋を確かめる。24.04 は lts-6.0、26.04 は stable）、まだなら
   `incus admin init --minimal`、ユーザーを incus グループに入れ（incus-admin には入れない——入っていれば外す）、incus-user の口を
   起こし、ユーザーの systemd を新しいグループで起こし直す

最後に、登録の画面に入れる値（ホスト・ユーザー・ポート・host 鍵の指紋）を出す。区画の設定（proxy device の許可・uid の対応）と
置き場 banto は、登録するときに banto が sudo -n で整える。

## 止まったとき

どの段で何が足りないかと直し方が出る。直してから同じ1行を打ち直す（済んだものは飛ばす）。
