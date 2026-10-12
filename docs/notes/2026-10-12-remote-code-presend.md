# banto を更新したら、別のサーバへ新しい版のコードを先に送っておく（Backlog #278）

2026-10-12。決まったことは `docs/specs/v4-security.md` §1「向こうに置くもの」の「起きたときも先に送る」。
ここは経緯と、選ばなかった案。

## きっかけ

banto を更新して起こし直したあと、qemu-bmc（banto-dev-vm）と Kaggle（kaggle-dev-vm）の Module が繋がらず、ユーザーは
「Subagent が死んだまま戻らない」と受け取った。実際は版が変わったので、次に使うときに新しい版のコード（約 850MB）を
送り直すことになり、送り終わるまで（数分）Module が起きなかった。用意を頼むと両方とも全部繋がった。

## 形

- 待ち受けを始めたら（`app.listen` のあと——鍵は Vault から借りる）、登録済みの実行場所のうち、記録の `runtime` が
  そこの Project が1つでもあるものを `RemoteSshRuntime.queueWarmUp` に並べる
- 登録したときの先送り（#269）も同じ順番に並べる。**一度に1台ずつ**、失敗しても次へ。順番が来るまでに外された実行場所は飛ばす
- 送っている間の表示は #269 のまま（`onCodeTransfer`）——先送りも同じ `syncCode` を通るので、何も足していない

## 選ばなかった案

- **並べて一度に送る**：banto の host の上り線は1本で、取り合うとどれも遅くなる。最初の1台が早く終われば、その Project は
  早く使える
- **閉じた Project しか無い実行場所も送る／送らない**：Project の一覧（`listProjects`）に載っているものは数える（閉じた
  Project も再開できる。外せないのと同じ扱い）。使っていない実行場所には送らない——接続を張りっぱなしにする理由が無い

## E2E

`e2e/specs/remote-code-presend.spec.ts`。起こし直すので自前の host（`own-host.ts`）を使う。「新しい版」は、host のコード
（作業ツリー）を書き換えると共有の core や他の spec に響くので、向こうの `current` を違う名前の版（中身は写したもの）に
差し替えて作る——host から見ると「向こうは前の版のまま」で、更新したあとと同じ食い違い。

確かめ（2026-10-12、1並列）：`remote-code-presend.spec.ts` 1 passed（2.6 分）。登録したときの先送りも同じ順番に通したので、
`remote-code-transfer`・`remote-runtime-registry`・`remote-runtime-ssh` も回して 3 passed（3.8 分）。フル E2E は回していない。
