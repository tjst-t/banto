# 実行場所の SSH 鍵を core だけが使える置き場へ（Backlog #361）

2026-10-17。仕様は `docs/specs/v4-security.md` §1「向こうとの道」の「鍵の置き場は core だけが使える」と、
`docs/specs/v4-modules.md` の「グループが唯一の真実」の表。移し方は `docs/runbooks/runtime-ssh-key-move.md`。

## 何が穴だったか

Fable が案A（VM の中で Project ごとに Incus のコンテナ）の草案をレビューして見つけた（S1）。案A に限らず、今の
「サーバ丸ごと 1 Project」にもある。

- 実行場所を登録する画面で選べる鍵は、Vault の `ssh-identity` のうち scope が `shared`（共通の置き場）のもの
- 共通の置き場はどの Project からも使える。だから、どの Project の AI でも Shell の `sshIdentity` 等でその鍵の
  ssh-agent を開かせ、その実行場所に SSH のユーザーとして入れた（例：この機械の Project の AI が banto-dev-vm に）

## 決めたこと

- **置き場は Vault のグループ `banto-runtime`**（`@banto/module-contract` の `RUNTIME_KEYS_GROUP`）。scope は `runtime`
- **刻印 `{host: true}` を足す**——core が自分のために直に呼ぶときだけ。Vault（vault-kit）は、この刻印には `runtime` の
  置き場だけを見せて使わせ、ほかの刻印（Project・banto 全体）には `runtime` を見せない
- core は**窓口（vault-directory）を通さず**、Vault の実装に直に `listAliases`／`getPublicKey`／`startSshAgent` を呼ぶ。
  窓口から Vault の実装への呼び出しは中継を通り、中継が継ぐ刻印は Project か banto 全体だけなので、`{host}` を
  通すには中継の台帳まで変えることになる。core はもともと Vault の実装に直に `getPublicKey` 等を呼んでいたので、
  一覧も直に読むだけで済む
- 抜け道を塞ぐ：`banto-runtime` を共通の置き場・Project の置き場にできない／参照で指せない（作る口・参照ごと移す口・
  前から在る参照を辿る口）／Module・AI はそこに置けない（人の管理面からだけ）
- 登録の画面にはこの置き場の鍵だけを出し、`/api/runtimes/identities` は置き場の名前も返す（画面が「どこに置けば
  よいか」を言えるように。名前は1箇所、規則3）。ほかの鍵が渡されても前提の確かめで Vault が断る
- **既にある登録は自動で移さない**。移すまで繋がず、理由を出す（規則2）。人が Vault の管理画面で鍵を移す
  （名前はそのままなので、登録も Project もそのまま戻る）

## 却下した案

- **core が人の刻印（`{admin: true}`）で鍵を使い、置き場の絞りは core の中でだけ行う**：契約を変えずに済むが、
  Vault の側では「人が管理画面から触っている」と区別がつかず、判定が材料の在る場所（Vault）に無くなる
  （2026-09-15 の「判定は材料が在る場所で行う」と逆）。監査にも人の操作として残る
- **専用のグループを作らず `unbound`（どこにも紐付いていない置き場）を core に使わせる**：`unbound` の画面は
  「未割当——紐付けてください」で、直そうとして紐付けると Project の AI に使えるようになる。置き場が意味を
  名乗らないので、紐付けを断る理由も書けない
- **既にある登録の鍵を、起動のときに自動で `banto-runtime` へ移す**：その鍵を Project の AI が向こうで git push に
  使っていた（Backlog の送る鍵等）場合、黙って壊れる。移すかどうか・Project 用に別の名前で残すかは人が決める

## 試験

- 単体：`packages/vault-kit/src/runtime-group.test.ts`（見えない・使えない・紐付けられない・参照で引き込めない・
  Module から置けない・core の刻印は `runtime` だけ）、`packages/module-contract/src/meta.test.ts`（刻印の読み取り）
- E2E：`remote-runtime-registry.spec.ts` の 7（画面に共通の鍵が出ない・宛先に直に渡しても断り sshd に入らない・
  その Project の AI は Shell の `sshIdentity` でも Vault の窓口でも使えない・共通の鍵は今までどおり使える）。
  実行場所を使う他の spec は、鍵を `banto-runtime` に置くように直した。`remote-backlog-ssh-push.spec.ts` は
  送る鍵を別の名前で預ける（実行場所の鍵が Backlog の選択肢に出ないことも見る）

## 追記：反映したら banto-dev-vm・kaggle-vm が黙って繋がらなくなった（Backlog #375）

host へ反映したら、前から登録してあった banto-dev-vm・kaggle-vm の鍵が前のグループにあったため繋がらず、その2台の Module
（Shell・FileSystem・Browser・Backlog・Factory・Subagent）が全部消えた。人に見えたのは host のログの「…"banto-runtime" へ移して
ください」だけ。手順書はあったが画面から辿れなかった。

決めたこと（仕様は v4-security.md §1「向こうとの道」・v4-frontend.md §6.43）：

- **受信箱に実行場所ごとに1枚**、鍵がどこにあるかを言うカード。読める Vault のほかの置き場に1つだけあるときだけ「移す」
- **「移す」は Vault の窓口の `migrateAlias` を人の画面の操作として呼ぶ**——Vault の管理画面の「移す」と同じ口なので、参照があれば
  断る等の検査も同じ。core が Vault の実装に直に移す口を足す案は却下（同じ操作の検査が2か所になる）
- **step-up は求めない**：Vault の管理画面の「移す」が求めていない。こちらだけ求めると同じ操作に2つの基準ができる。
  求めるべきだと決めるなら、両方同時に変える
- **どこにあるかは各 Vault の人の管理面の一覧（`{admin: true}`）で読む**。core の印（`{host: true}`）は実行場所の鍵の置き場しか
  見せないので、外にある鍵は見えない。読むのは値の返らない口だけ
- **移す元はカードの記録を信じず、押したときに読み直す**（押すまでの間に人が手で動かしたかもしれない）
- 「繋がらない」お知らせ（#338）・Module ごとのお知らせとは重ねない——鍵が理由なら、こちらが理由を言う
- 登録の画面に `banto-runtime` に鍵を作る入口（Vault の `generateSecret` を置き場を決めて呼ぶ）。前は「先に Vault で作って
  ください」と言うだけで、置き場の名前を正しく綴って作る手間を人に残していた
- 鍵の名前の前の「$」は、JSX の中に `${k}` を文字のまま書いていた不具合（テンプレート文字列の名残）
