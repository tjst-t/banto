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
