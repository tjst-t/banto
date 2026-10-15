# 2026-10-15 変換役 `documents`（LibreOffice）を作る（Backlog #304 office-converter）

仕様：`docs/specs/v4-modules.md` §2.2「変換役（LibreOffice）」、`docs/specs/v4-security.md` §2「同梱の道具用のコンテナの作り」。

## 最初に Incus の中で測ったこと

道具用のコンテナと同じ土台（`banto-base-…`）・同じ idmap（`both 1000 1000`）・入れ子無しの箱を1台作り、中の root で測った
（測ったあと消した）。

| やったこと | 結果 |
|---|---|
| 一般ユーザー（uid 1000）で `bwrap --unshare-all …` | `Creating new namespace failed: Permission denied`（`kernel.apparmor_restrict_unprivileged_userns=1`。Fable の実測と同じ） |
| root で `bwrap --unshare-all --uid 65534 --gid 65534 --proc /proc …` | `Can't mount proc on /newroot/proc: Operation not permitted` |
| 同じで `--proc` を外す | 動くが、中から nobody の持ち物のフォルダに**書けない**——中の 65534 は作った user namespace の中だけの番号で、外から見ると root（0）。能力は無いので nobody のフォルダに書けず、root の持ち物を読める形 |
| root で user namespace を作らずに（`--unshare-net --unshare-ipc --unshare-pid --unshare-uts --unshare-cgroup-try`）`--proc /proc`、中で `setpriv --reuid=65534 --regid=65534 --clear-groups --inh-caps=-all --bounding-set=-all --no-new-privs` | 動く。`id` は 65534、能力はすべて 0、`/proc` は自分の PID の名前空間だけ、名前は引けない（通信できない）。作ったファイルは外から見ても 65534 の持ち物 |

→ **仕様に書いてあった `bwrap --unshare-all --uid 65534 --gid 65534` はやめ、下の形にした**（規則8：仕様の文を直して、ここに残す）。
目的（中の LibreOffice を本当に nobody にする・ネットワーク無し）は同じで、むしろ書いてあった形では「nobody に落ちた」が
名ばかりだった。

### LibreOffice を囲いの中で動かすまでに踏んだもの

- `/tmp` に書けない → `ERROR: no valid pipe path found.`。bwrap が作る tmpfs は root の 0755 → `--perms 01777 --tmpfs /tmp`、
  `TMPDIR` も作業フォルダの中に
- `terminate called after throwing an instance of 'com::sun::star::uno::RuntimeException'`。`/etc/fonts` だけ見せると落ち、`/etc` を
  まるごと見せると動く。strace で見ると **`/etc/…` のどれを開いても EACCES**——bwrap が `--ro-bind /etc/fonts` のために自分で作る
  親の `/etc` が 0700（root の持ち物）で、nobody が辿れなかった。`--perms 0755 --dir /etc` を先に置いて直った
- `/usr/lib/libreoffice/share/registry` などは `/etc/libreoffice` への記号リンク（Debian の作り）→ `/etc/libreoffice` も読み取り専用で見せる

### 罠の文書で確かめたこと

`r:link`（埋め込みでなくリンク）で `http://<箱のアドレス>:47999/img.png` と `file:///root/secret.png`（赤い PNG）を指す docx。

| | http の取りに来た数 | PDF の画像の数 |
|---|---|---|
| 囲いの外（root のまま `soffice --convert-to pdf`） | 2（OPTIONS と GET） | 1（file:/// の画像を埋め込んだ） |
| 囲いの中（プロファイルつき） | 0 | 0 |

xlsx（式だけで `<v>` の無いもの、`=B2*C2`・`=SUM(D2,7)`）を `xlsx:Calc Office Open XML` で書き出すと `<v>1200</v>`・`<v>1207</v>` が
入った。docx→PDF 約1.2秒、xlsx の計算し直し 約1.0秒、pptx→PDF 約1.2秒、pdftoppm の1ページ 31ms。5件を並べて頼むと1件ずつ、
Project の間で順番に回った（待ち 0・1.3・2.6・4.0・5.2 秒）。打ち切り（1.5秒）で囲いの中の `sleep` 2本とも消えた。

## 決めたこと（仕様に書いたもの以外の理由）

- **`documents` 全体を中の root で起こす**（`meta.toolsContainer.runAsRoot`）。変換を起こす部分だけを root にする方法は、箱の中の
  一般ユーザーから root に上がる道（sudo）を外してあるので無い。受けるのは道具用の箱だけにした
- **道具用のコンテナの Module は使うときに起こす**。`resolveInstanceModuleClients` は起動のときだけでなく、画面の一覧（設定の
  Canvas・Skill）を出すたびに banto 全体の Module を全部起こしていた——そのままだと初めての banto で、画面を開いただけで
  LibreOffice 一式（約600MB・2分半、この機械で測った）を入れ始める
- 中継は**宛先が繋がっていなければ権限を確かめる前に起こしてもらう**（`connectOnDemand`）。起こせるのは呼び元の依存にある
  道具用のコンテナの Module だけ（呼べない宛先のために apt を走らせない）。20 秒待って起きなければ「入れています／起こしています」で
  断る——数分の apt の間、FileSystem の頼みを握ったままにしない
- `relayListTargets` にまだ起きていない宛先も載せる（`onDemandTargets`）。載せないと FileSystem は役割で宛先を引けず、名前を
  決め打ちするしかない
- FileSystem は**変換役の版と印を置き場に覚える**（`converter.json`）。覚えないと banto を起こし直したあと、変換したものを読むだけの
  ために `describe` を呼んで変換役（道具用のコンテナ）を起こすことになる。印は変換の返事に毎回付くので、変換役が入れ直されたら
  次の変換で覚え直す（そのときまでは前の印で引いた写しを返す——中身はそのファイルを変換したものに変わりない）
- 変換役は**待っている間も途中経過を送る**。順番を待つ時間は 60 秒を超えうる（1件 60 秒まで×前の待ち）——送らないと中継の
  上限（MCP の既定 60 秒）で切れる

## 採らなかった案

- 仕様のとおり `--unshare-all --uid 65534`（上の表——`/proc` が付かず、nobody が名ばかり）
- 変換役を起動のときに起こす（初めての banto で画面を開く前から apt が走る。使わない人にも約600MB）
- FileSystem から変換役の名前を `documents` と決め打ちする（同じ役割を別の実装が名乗れる。`relayListTargets` に載せて引く）

## まだやっていないこと

- 画面（pptx・xlsx の表・docx の「元に近い見た目で見る」・ページの画像への切り替え）は変換役をまだ使っていない（#306 ほか）
- `readDocument`（AI の側）
- 7MB を超えるものの受け渡し（1回限りの札つきの一時置き場、Backlog の別のタスク）
