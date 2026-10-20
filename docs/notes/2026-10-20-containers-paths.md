# 2026-10-20 containers の道（Backlog #369）

仕様は `docs/specs/v4-security.md` §1「別のサーバの中のコンテナ」の「道」と、その下の「実装済み（#369）」。ここは決め方・
採らなかった案・踏んだもの。

## 起きていた不具合（直す理由）

containers の実行場所の Project で、Module の `BANTO_HOST_MCP_URL` が `http://127.0.0.1:<VM のトンネルの番号>/relay` のまま
コンテナの中に渡っていた。コンテナは自分のネットワーク名前空間を持つので VM の 127.0.0.1 には届かず（fetch failed）、Vault の値・
Repositories・Backlog の push が全部失敗していた。`preparedInContainer` が machine の `preparedFrom` の `bantoOrigin` をそのまま
使い、鍵の窓口（`socketPathInside`）は「まだ見せられません」で断っていた。

## 実装者が決めたこと

- **トンネルはコンテナを用意するときに張る**（親の接続を張るときの `-R` にしない）。決まったパスの UNIX ソケットは、張る前に
  置き場（`/run/user/<U>/banto/p-<id>/`）を作り、前の接続が残したソケットを消す要がある（sshd の `StreamLocalBindUnlink` は no、
  `docs/notes/2026-10-08-remote-runtime.md`）。親を張る前には向こうで何も流せないので、張ったあと `-O forward -R` で頼む。鍵の
  窓口と同じ `addForward` を通す。接続ごとに1回（`conn.tunnel`）
  - 却下：親の接続の引数に `-R <パス>:…` を入れ、張る前に別の ssh で消す——接続を2回張ることになり、`ExitOnForwardFailure` が
    UNIX ソケットの側の理由を出さない（前の実測）
- **中のポートは 29839**（全コンテナで同じ）。コンテナはそれぞれ自分のネットワーク名前空間を持ち、`bind=instance` の口は中の
  127.0.0.1 にしか出ないので、Project ごとに番号を変える理由が無い。よく使われる番号（3000・5173・8000・8080 等）を避け、Linux の
  一時のポートの範囲（既定 32768〜60999）の外にした——前から動いているコンテナに初めて装置を足すとき、中で一時のポートとして
  取られていると待ち受けられない。中のサービスがこの番号で待ち受けるとぶつかる——人に言うのは、ぶつかったときの理由の文で
  足りると判断した
- **鍵の窓口の中のパスは `/run/banto-a-<印>.sock`**（仕様の案は `/run/banto/…`）。Incus の forkproxy は待ち受けの親のフォルダを
  作らない（`main_forkproxy.go` に mkdir が無い）。コンテナを起こし直すと中の `/run` は空になるので、`/run/banto/` にすると、残った
  装置（接続が切れて外せなかったもの）があるとき、Incus がコンテナを起こすときに待ち受けられない。`/run` そのものは必ずある
  - 却下：装置を足す前に中で `mkdir /run/banto`——起こし直したあとに無くなるのは同じ
- **前の接続の鍵の窓口の装置は、次の接続で最初にコンテナを用意するときに外す**。接続が切れたときには Incus を呼べない（呼ぶ口が
  その接続）。同じ接続で用意し直す（`forget` のあと）ときは外さない——いま使っている窓口を外してしまう
- **`security.uid/gid` は向きで番号を変える**。頼みは「中の番号（`ProjectContainerSpec.inside`）から取る」だったが、Incus の
  forkproxy のソースを読むと、`security.uid/gid` は**繋ぐ側の**名前空間で落とす番号で、`bind=instance`（中で待ち受けて VM へ
  繋ぐ）では VM の側——VM のユーザーの U でないと、sshd が作ったトンネルのソケット（U の持ち物・0600）に繋げない。中の番号を
  使うのは、`bind=instance` の UNIX の待ち受けの持ち主（`uid`/`gid`、中の名前空間で付く）と、`bind=host`（流れの口・公開）の
  `security.uid/gid`。どちらも宣言（`uid`/`gid`/`inside`）から取り、1000 を決め打ちしない（`proxyDevice`）。#457 で中の番号を U に
  すると、両方とも U になる
  - 読んだところ：`cmd/incusd/main_forkproxy.go`——子（待ち受け）は listen の pid の名前空間へ、親（繋ぐ）は connect の pid の
    名前空間へ、それぞれ user namespace が違えば `CLONE_NEWUSER` も足して setns する。親は待ち受けの fd を受け取ったあと
    `switch_uid_gid(security.uid, security.gid)`。子は fd を渡したあと `os.Chown(listen, uid, gid)`・`os.Chmod(listen, mode)`
- **置き場を作る台本に `umask 077` を足した**（machine の転送も通る）。`/run/user/<U>/banto/` の途中のフォルダを `mkdir -p` が
  既定の権限（0755）で作るため。machine の `<置き場>/s` は 0700 の置き場の中なので、振る舞いは変わらない

- **流れの口の VM の待ち受けは `<置き場>/s/st-<印>`**（仕様の条件4の例は `/run/user/<U>/banto/p-<Project>/…`）。`bind=host` の装置は
  VM の側で**待ち受ける**ので、コンテナを起こすたびに Incus がそのパスで待ち受け直す。`/run/user/<U>` は tmpfs で、VM を起こし直すと
  `p-<id>/` は無く（linger で作られるのは `/run/user/<U>` まで、それも Incus がコンテナを起こすより後のことがある）、forkproxy は親の
  フォルダを作らないので、コンテナが起きられなくなる。`<置き場>/s` は VM のディスクにあり、コンテナには見せていない（見せるのは
  `<置き場>/code` と `<置き場>/modules/<接続名>` だけ）ので、条件4（VM だけの場所）を満たす。トンネル・鍵の窓口は VM の側では
  **繋ぐ**だけ（繋ぐときにあればよい）なので `/run/user/<U>/…` のまま
  - 流れの口の装置は外さない（待ち受けの置き場がいつもある。繋ぎ直すたびに同じものを `ensureProxy` で確かめる）
  - VM には symlink を置かない（machine は `<置き場>/s/st-<印>` に Module の待ち受けへの symlink を置き、sshd が辿る）——containers
    で sshd（VM のユーザー）に中の置き場を辿らせない

- **実行場所の種類の3つ目（`remote-containers`）**：Project の記録の `runtime` は `remote:<名前>` だけで、動かし方（`machine`／
  `containers`）は実行場所の登録が持つ。答えが分かれる2つの問い（眠らせる・閉じるときに Service を止めるか）だけ、登録を引く口
  （`RemoteModeOf`）を受ける形にした。根の場所・この機械のコンテナかは、どちらの動かし方でも同じ答えなので記録だけで答える——
  Project の記録の層（`project-thread/store.ts`）は登録を知らず、渡す道を作ると関係の無い層に依存が増える
  - 却下：Project の記録に動かし方を写す——真実が2か所になる（規則3）。動かし方は使っている Project がある間は変えないが、
    登録を消して同じ名前で作り直すと食い違う
  - 登録の無い名前（外された）は前の2択どおり `machine` として扱う
- **眠らせる・閉じるときにコンテナを止める**：`RuntimeRouter.release` は `stop` を別のサーバに渡していなかった（machine は止める箱が
  無い）。containers では、接続が無くても止めるために繋ぐ——接続を閉じてもコンテナと中の Service は動いたままなので、banto を
  起こし直したあとに眠らせたときに止まらないことになる。止められなければ接続は閉じたうえで `RuntimeStopError`（呼び元が受信箱で
  言う、この機械と同じ）
- **起こし直したときに眠っている Project のコンテナを確かめるのは、この機械だけのまま**（`stopSleepingContainers`）。containers で
  同じことをすると、起きるたびに眠っている Project の数だけ VM に繋ぐ。眠らせたときに止めてあり、Incus は止まったコンテナを
  勝手に起こさない（`boot.autostart` は付けていない——VM を起こし直すと、止まる前に動いていたものだけを起こす）ので、残すのは
  人が手で起こした場合だけ

## 試験

- `packages/container/src/project-container.test.ts`：`proxyDevice` の番号の向き（`instance`/`host`、TCP と UNIX の待ち受け、中の
  番号は宣言から）、ずっと張る道は用意するたびに合わせる（同じなら触らない・違えば外して付け直す・止めない）、あとから足す道と
  名前で選んで外す
- `packages/core/src/runtime/remote-containers.test.ts`（偽の ssh・偽の incus）：住所が中の 127.0.0.1:29839、`banto-relay` の形と
  Project ごとのトンネル（`-O forward -R <p-<id>/t.sock>:127.0.0.1:<その Project の待ち受け>`、2つの Project で別の待ち受け、置き場は
  0700）、鍵の窓口の転送と装置（p2 のコンテナには出ない・置き場の外は断る）、host の窓口が消えたら転送と装置を外し、トンネルは
  外さない、手放して繋ぎ直すと前の窓口の装置を外しトンネルを同じパスに張り直す。流れの口の装置の形（`bind=host`、繋ぐのは中の
  番号・VM の待ち受けは VM のユーザー）と `-L` の先、VM に symlink を置かない、2回目は張り直さない。手放すとき `stop` ならその
  Project のコンテナだけ止める（stop なしなら動いたまま、接続が無くても繋いで止める、次に用意すると起こす）
- `packages/core/src/runtime/remote-runtimes.test.ts`：実行場所の種類（containers の登録は `remote-containers`、登録が無い名前は
  machine）と、眠らせる・閉じるときの答え
- 直しを外すと落ちることを、組んだ JS を書き換えて確かめた（窓口を閉じても装置を外さない・前の接続の装置を外さない・見張りが
  トンネルも外す、の3つ。最後のは最初の試験では通ってしまったので、トンネルを外していないことを見る行を足した）
