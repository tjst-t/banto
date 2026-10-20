# 2026-10-20 containers との間で Project を移す（Backlog #464）

仕様は `docs/specs/v4-security.md` §1「Project を別の実行場所へ移す」の末尾「`containers` との間で移す」（Fable のレビュー2回を
反映したもの）。ここは実装者が決めたこと・測っていないこと・踏んだもの。

## 形

- `runtime/project-move.ts`：`targetRuntimeProblem` の「containers との間はまだ移せない」を外した（`containers` の移す先は、
  コンテナを用意する口 `deps.containers` が無ければ断る）。片側（`Side`）に `inside`（コンテナの名前と、書く側なら中の番号）と
  `rsyncRemote.path`（`--rsync-path`）を足し、展開・印・`git worktree repair`・tar の読み出し・大きさの数えを、その側に応じて
  中で流す（`onSide`）
- `runtime/remote-ssh.ts`：`prepareMoveTarget`（移している Project・移す先の根でコンテナを用意し、根と写す Module の置き場を
  見せ、inode で見えていることを確かめる）と `closeMoveTarget`（実行場所を指して接続と待ち受けを閉じる。`release` の後ろ半分を
  `closeConnectionOf` に分けた）
- `runtime/remote-containers.ts`：台本（`inodePairsScript`・`cleanupContainerScript`・`ensureRsyncInsideScript`・
  `insideRootCommand`）と `moduleDiskName`（`preparedInContainer` の中にあった装置の名前の付け方を外に出した——用意するときと
  Module を起こすときで同じ装置になるように）
- `cli.ts`：`releaseModules` に `stopContainer` を通す・`containers` の口を `remoteSsh` に繋ぐ
- 画面：見積もりの `sizeNote`（移す元のコンテナが止まっているとき「起こしたあとに数えます」）。移す先の一覧は前から
  全部の実行場所を出していた（`containers` も。断っていたのは core）

## 実装者が決めたこと

- **移す先のコンテナを用意するのは、Module を畳む前**（進み具合の `preparing` の段、Service を止める `stopping` より前）。
  初めての VM では土台のイメージ作りで数分かかる——その間、元の Module は動いたまま（Service を止めてから数分待たせない）。
  用意に失敗したら、元には何もしていない
  - 却下：畳んでから用意する——失敗したときに Service を止めたままにする時間が長くなるだけ
- **移す元の大きさは中の root で数える**（見積もり・移すときとも）。VM のユーザーの `find` は、中の root が作った 0700 の
  フォルダに入れず、写す（中の root の tar）と数が合わなくなる。中で数えるとき、装置が付いていなければ中の rootfs を数えて
  しまうので、**移すときは読む前に、写すフォルダが全部中から見えていること（VM と中の inode が同じ）を確かめ、見えて
  いなければ移さない**（仕様の「移す先は VM の側で数える」の理由と同じ穴を、移す元の側で塞いだ）。移す先は仕様どおり VM で数える
- **読み終えたら止める**のは、全部を写し終えたところ（件数の確かめの前）。途中で失敗したら、読み始めていればそこでも止めて
  残す（`releaseModules({stopContainer: true})`——`release(stop)`。止められなければ今どおり受信箱）
- **移す先のコンテナの片づけは、VM の `incus` で直に**（`cleanupContainerScript`、片づけの台本と同じ1回ずつの SSH）。
  多重化した接続（`RemoteSshRuntime`）を張ると、繋ぐたびの前提の確かめとコードの照合が走る——起き直したときの片づけで、
  消すためだけにそれをしない。札 `user.banto.owner` がこの banto のデータの置き場のものだけに触る（無い・ほかのものなら何もしない）。
  居たことがあるか（`previousLocations` に同じ実行場所があるか）で、消すか止めて残すかを決める（仕様どおり記録しない）
  - 片づけの順：接続を閉じる → コンテナを消す／止める → 作った根・置き場を `rm -rf`（VM のユーザー）→ 退かせた置き場を `mv` で戻す
  - started より前（根・置き場を作った段）で失敗したときは、コンテナに触らない（まだ用意していない）
- **根の段に空・`.`・`..` があれば、正規化の前に断る**。正規化は「存在する最も深い親を `cd -P`、まだ無い段はその後ろに付ける」
  なので、無い段に `..` が残ると、1段ずつ作るときに意味が変わる
- **根と Module の置き場は `mkdir -m 700` で作る**（`createOnlyDirScript` そのまま）。machine の移す先は `mkdir -p`（umask の
  まま）。中のユーザーは VM のユーザーと同じ番号なので書ける
- **重なりは `containersRootProblem` だけで見る**（作るときと同じ）。閉じた Project の根は、移す先がその中でも断る——machine・
  この機械の「閉じた Project の根の中へは移せる」（2026-10-14）とは違う。`containers` では作る・再開するときも閉じた Project を
  丸ごと数えているので、それに揃えた（決まりは2つあるが、`containers` の中では1つ）
- **`s` しか無い置き場は、`containers` でも空と見なす**（退かせずに使う。片づけでは `s` を残す——今どおり）
- **戻すときの rsync は、移す元が `containers` のときも中に要る**（送り手が中で動く）。仕様は移す先の側だけを書いているが、
  同じ手（無ければ中の root で `apt-get install rsync`）を移す元のコンテナにも使う。VM の rsync はどちらの側でも見ない
  （中で動くので要らない）。この機械（banto 本体）の rsync は今どおり要る
- `--rsync-path` は `incus exec <c> --user <U> --group <G> -- rsync`（移す先）・`incus exec <c> -- rsync`（移す元）。`--env` で
  HOME 等は渡さない（rsync の受け手・送り手は要らない）
- **閉じ込めの注意（`confinementNote`）は `containers` へは出さない**——移った先もコンテナの中で動く
- 用意するときの入れ子（`nesting`）は Project の設定（`projectNesting`）、仮想化（KVM）は今どおり実行場所と Project から引く

## 測っていないこと

- **rsync の往復の標準入出力を `incus exec` が素通しするか**（仕様は「実装の前に実機で測る」）。実機（Incus の VM）が手元に
  無いので測っていない。試験（`project-move-containers.test.ts`）は、本物の rsync を偽の ssh・偽の incus（中で流すものを
  この機械でそのまま走らせる）の上で走らせ、`--rsync-path` に渡した `incus exec … rsync` が受け手として起き、そろえられることまでを
  見ている——Incus の `exec` の中継（websocket）を通ったときに往復が詰まらないかは見ていない。**実機で測るまで、前に居た場所へ
  `containers` に戻す形は確かでない**
- 本物の Incus で：動いているコンテナに移す先の Module の置き場の disk device を足すこと・作り直したフォルダを付け直すこと・
  中で `apt-get install rsync` が通ること・tar を `incus exec` に流したときの速さ（大きい Project）
- E2E の SSH の相手には Incus が無い——`containers` の本物の E2E は無い（既存の移す E2E が壊れていないことだけを見た）
- 初めての VM で土台のイメージを作っている間、コードを送る帯（`code.transfer`）は「その実行場所の Project」に出るので、まだ
  移ってきていない Project の会話には出ない。会話には移す帯の「移す先を用意しています」だけが出る（画面は変えていない）

## 踏んだもの（人に上げる・規則8）

- **`git worktree repair` は、元の根が同じパスで見えていると、元のほうを直す**（git 2.43 で確かめた）。写した worktree の
  `.git` ファイルは元の根の `.git/worktrees/<名前>` を指したままなので、そこが在れば git はそちらを辿り、写した先の印は元を
  指したまま・元の印のほうが書き換わる。本物の移し方では、移す先から元の根は見えない（別の機械・コンテナの中）ので当たらない
  ——試験の偽の VM はこの機械なので当たった（試験では repair を中のユーザーで流したかだけを見る）。同じ機械の上で元の根が
  見える移し方（試験・入れ子の SSH の相手の E2E 等）では、元の worktree の印を書き換えている見込み。直すなら repair の前に
  worktree の `.git` を新しい根へ書き換える形だが、#464 の外なので触っていない
