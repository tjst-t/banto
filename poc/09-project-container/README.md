# PoC 09：Project ごとのシステムコンテナ（Incus）

**捨てる前提のコード**。決めるための計測だけ（`docs/notes/2026-09-25-dev-environment.md`）。

問い：Project のもの（ファイル・Shell・FileSystem・サブエージェント・入れた道具）を Project ごとの
システムコンテナ1つに入れ、banto 本体（会話・Claude のログイン・Vault・設定）はホストに残す形が成り立つか。

## 環境（2026-09-25）

- Ubuntu 24.04.4・kernel 6.8。Incus 6.0.0（Ubuntu の universe）→ **6.0.6 LTS（Zabbly の `lts-6.0`、推奨パッケージなし）に上げた**（中の Docker のため、下）
- `incus admin init --minimal`：置き場 `default`（`dir`）、ブリッジ `incusbr0`
- banto を動かすユーザーは **`incus` グループ**（権限を絞った使い方）。`incus-user` が
  `user-1000` という制限つきの区画を自動で作る：
  - ホストのフォルダを見せられるのは `/home/ubuntu` の下だけ（`restricted.devices.disk.paths`）
  - ホストの uid/gid 1000 をコンテナに対応させてよい（`restricted.idmap.uid/gid`）
  - 入れ子（中で Docker 等）は許可、**proxy デバイスは禁止**、ネットワークは `incusbr-1000`
- イメージ：`images:ubuntu/24.04`

## 結果

| 問い | 結果 |
|---|---|
| 作る（初回、イメージのダウンロード込み） | **23 秒** |
| 停止／起動 | **0.76 秒／0.19 秒** |
| コマンド1回の上乗せ（`incus exec … true`） | **50 ms** |
| 置き場 | 1台 848 MB（`dir` はイメージを丸写しする。btrfs/zfs なら写しの共有で小さくなる） |
| Project のフォルダを**同じ絶対パス**で見せる | できる（`disk` デバイス） |
| ファイルの持ち主 | **両方向で揃う**——中の uid 1000 ＝ホストの 1000。中の root はホストでは 1000000（一般ユーザー）。ただし `raw.idmap "both 1000 1000"` と、ホストの `/etc/subuid`・`/etc/subgid` に `root:1000:1` が要る（権限を絞った区画では `shift=true` が使えない：「制限つきのパスでは shift を使えない」） |
| banto の Module を中で起こし、ホストから MCP（標準入出力）で話す | **できる**。FileSystem を `incus exec … node server.js` で起こし、接続まで 239 ms、`listDirectory` が通る（`module-stdio.mjs`）。node はホストの実行ファイルを中に置き、banto のコードは読み取り専用でマウント |
| 中のエージェントが、ホストの Claude ログイン中継を使う | **できる**。本物の Claude Code CLI が中継経由で答えた（5 秒、`claude-in-container.mjs`）。合言葉なしは 401。中継は 127.0.0.1 ではなく**ブリッジ側のアドレスで待ち受ける**必要がある（proxy デバイスが禁止のため） |
| 前回の抜け道（docker.sock・`/run/user/1000/bus`） | **中に存在しない** |
| ホストの秘密（`~/.claude`・`~/.ssh`・`~/.config/banto`） | **中に存在しない** |
| ホストのプロセス | 見えない（中の 14 個だけ） |
| ホストのサービス | **0.0.0.0 で待ち受けているものには届く**（banto の API 4737・画面 4175・SSH 22 など。LAN から届くのと同じ範囲）。127.0.0.1 だけのものには届かない |
| 中で root として `apt install`（build-essential・rustc・cargo・python3-venv） | **できる**。50 秒（ユーザーがファイアウォールの許可を足したあと） |
| uid 1000 で Project の中で `cargo new`→`cargo build`→実行 | **できる**（ビルド 247 ms） |
| 同じく C（`cc`）・Python（venv に `pip install requests`） | **できる** |
| できたファイルの持ち主（ホスト側） | すべて uid 1000 |
| 中で Docker（`security.nesting=true`、`apt install docker.io`） | **入るが、既定のネットワークではコンテナを起こせない**：`open sysctl net.ipv4.ip_unprivileged_port_start file: reopen fd 8: permission denied`。`--network host`（この sysctl を書かない）なら動く。**原因は権限（AppArmor）**：AppArmor の記録しない拒否を一時的に記録させて捕まえた——Incus が生成するコンテナのプロファイルの `deny /sys/[^fdck]*{,/**} wklx,` が、runc の書き込みを `/sys/net/ipv4/ip_unprivileged_port_start` として拒否（runc は CVE-2025-52881 の修正で `/proc` を付け直して fd から開き直すため、AppArmor にはパスが `/sys/…` に見える）。`deny` は許可の規則を足しても上書きできず、権限を絞った区画では低い層の設定も変えられない。**上流の Incus は直している**（PR #2624：入れ子を許したコンテナでは `/proc`・`/sys` の保護を外す。6.19・6.0.6 LTS）。Ubuntu の 6.0.0 には入っていない |
| 中で Docker（Incus 6.0.6 に上げたあと） | **動く**：既定のネットワークで `hello-world`、中のコンテナから外へ、port 公開。入れ子を許したコンテナのプロファイルから `deny /sys/[^fdck]…` が消え、**入れ子を許していないコンテナには残る**ことも確かめた |
| 再起動（中で Docker のコンテナが動いている） | 11 秒（Docker が中のコンテナを止めるのを 10 秒待つ）。**Incus を上げた直後の1回だけ `incus restart` が5分以上返らなかった**（再現せず）——banto は停止に上限を付けて、超えたら強制停止する |

## 外に出られない（→ 2026-09-25 ユーザーが許可を足して解決。ただし再起動で消える）

Docker が入っている機械では、Docker がホストの転送（iptables の FORWARD）を既定で DROP にするため、
**Incus のコンテナは IPv4 で外に出られない**（Incus の文書にある既知の衝突）。この機械は IPv6 の外向きの
経路も無い。文書どおりの対処は `DOCKER-USER` に Incus のブリッジの許可を足すことだが、
**ホストのファイアウォールを変える操作は、自動モードの安全装置に止められた**——人の判断に上げ、
ユーザーが `incusbr-1000` の分を実行した。**iptables の規則は再起動・Docker の再起動で消える**——恒久化は未決。

## 踏んだこと（プローブの誤り）

- `apt-get update` は取得に失敗しても 0 を返す——「IPv6 なら通る」と一度誤認した。`install` で確かめる
- 転送のポートを文字列で `net.connect` に渡すと、Node はソケットのパスとして扱う
- **`spawnSync` で子を待つと、同じプロセスで動いている中継も止まる**——子の問い合わせが返らず時間切れに
  見えた。非同期の `spawn` にする
