# 閉じた Project が実行場所を占めないようにする（2026-10-13、Backlog `runtime-release-closed`）

仕様は `docs/specs/v4-security.md` §1「閉じた Project は数えない」。形（案A）はユーザーが決めた。ここは実装で決めたことの理由。

## 閉じるとき、unit を disable するだけでなく止めて消す

- 仕様の言葉は「自動起動を切る（disable）」。既存の `disableAllServices`（移す前に使う）は登録を「止めておきたい」に
  書き換えるので、再開したときに Service が戻らない——仕様の「登録はそのまま、再開して起きれば登録から作り直す」に合わない。
  そこで Service の Module に `suspendAllServices` を足した
- **止める**のは、閉じた Project の Service が動いたままだと次に来た Project の Service と `ports` がぶつかるから（実行場所が
  空いたことにならない）。この機械のコンテナの Project は閉じるとコンテナごと止まるので、揃う
- **unit の写しを消す**のは、再開したときに起こし直すため。`reconcile` は「unit があって止まっているもの」を人が止めたものと
  見なして起こさない。消しておけば「unit が無かった・動かしておきたい」になり、作り直して起こす。消さなくても、次に来た
  Project の Service の Module が自分の孤児と見なして消す（印が宣言の名前だけなので）——どちらにしても残らない
- 止められなかったら閉じない（502）。却下：閉じてから受信箱で知らせる——実行場所は空いたことになり、次に来た Project と
  ぶつかる状態を作る（規則2）

## 閉じた Project を、先を取られた実行場所から移すとき

`#263` の移す本体は、元の実行場所で Service の Module を起こして `disableAllServices` を呼び、`systemctl --user list-units
'banto-*'` で動いているものを数えていた。元を別の Project が使っていると、前者は相手の unit を孤児として止めて消し、後者は相手の
Service を「動いているもの」に数えて移せなくなる。閉じた Project で元を別の Project が使っているときは、どちらも飛ばす
（閉じたときに止めてある）。

## 外すときは閉じた Project も数える

実行場所の登録を外すと、閉じた Project は再開も移すこともできなくなる（繋ぐ先が無い）。外すときだけ `includeClosed` で数える。
