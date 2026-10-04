# Repositories：既にある Project を開く口・GitHub App の Install の分かりにくさ（2026-10-04）

仕様は `docs/specs/v4-modules.md` §2.4（「一覧」の Project の列、「アカウント」の使い方・Install 先・Install のページ）、
`docs/specs/v4-frontend.md` §6.2「画面から『この Project を開いて』」。段階5は本物の GitHub で公開でき、つまずきは
「GitHub App を自分のアカウントに Install していなかった」だった（Install 後は公開も非公開の clone も通った）。
作業は worktree（`.worktrees/repositories-polish`、ブランチ `fork/repositories-polish`、main の 27bd594e から）。

## 1. 既にある Project を開く口（`dev.banto/open-project`）

- **確かめの画面は出さない**。`open-new-project`・`close-projects` は作る・閉じるので人に確かめさせたが、移るのは
  軽く戻れる。確かめの画面を挟むと、Project 名を押すたびにダイアログが出て、押した意味が二重になる
- その代わり**どの面の画面からでも、人が押した直後だけ**受ける。既存の2つは、確かめの画面が人の目を通すので入口・
  設定の面からは直後でなくても受ける。ここは確かめが無いので、押したこと自体を確かめの代わりにする（会話の中の画面だけ
  でなく、入口・設定の画面も勝手に人を移動させられない）
- **閉じた Project は断る**（黙って再開しない）。core の既存の振る舞いに合わせた——閉じた Project を開くのは「閉じたものの
  一覧」で人が「再オープン」を押したときだけで、再開は Module の起動を伴う。一覧の側も、閉じた Project の名前は押せない
  形のまま。無い Project も理由を返す
- 新しい Project の画面の「既にある Project を開く」（段階4）は core 自身の画面の中の動きで、Canvas からの頼みではない
  ので、この口は使わない（もう core が開いている）
- 却下：画面の hostContext に Project の一覧を載せ、画面がリンクを作る——一覧を第三者の画面に渡すことになる（§6.2 で
  載せないと決めている）。Repositories は中継で引いた id を、押されたときに頼むだけ

## 2. GitHub App の Install の分かりにくさ

### slug の取り方（調べて決めた）

- `GET /user/installations`（App のユーザーのトークン）の各インストールには `app_slug`・`client_id`・`permissions`・
  `account`（`type` つき）が入る（GitHub の REST の文書のスキーマで確かめた）。Install のページは
  `https://github.com/apps/<slug>/installations/new`
- ただし**どこにも Install していないと一覧が空で、slug が分からない**——ユーザーがつまずいたのはまさにこの状態
- デバイスフローのトークンでは `GET /app`（App の JWT が要る）は使えず、client ID から slug を引く口も無い
- そこで：**インストールの返事の slug を正**とし、返事が空のときのために設定に「App のページ」（任意）の欄を置く。
  Install されていれば設定の値は使わない（規則3——返事があるのに覚えた値を使うと、App の名前を変えたときに食い違う）。
  欄は `https://github.com/apps/<slug>`（App の設定の「Public link」）か slug を受ける
- 返事の `client_id` が設定の client ID と違うインストールは数えない（その App のものだけ）

### 出すもの

- ブラウザでログインのアカウントの行に、Install 先（アカウント・Organization）と Administration・Contents の権限。
  設定の面を開いたとき・ログインしたとき・「確かめる」で取り直す。「確かめる」は login の確かめと**同じトークンで**
  Install 先も返す（トークンを2回取ると、期限の近いログインで更新が2回走る——段階2の E2E が「更新はちょうど1回」を
  見ていて気づいた）
- 足りない権限は行ごとではなく1行で（プローブの撮影で、行ごとだと同じ文が3回並んで読めなかった）
- どこにも Install されていなければ「Install されていません——Install する」。slug が分からなければ「App のページを入れると
  開けます」
- 公開の画面の「GitHub App が <owner> に入っていません」にも Install のページの手を添える
- client ID の欄の下に「GitHub App の使い方」（はじめて・別のアカウント・Organization）。client ID が無い間は開いておく

## 踏んだこと

- **段階5で公開の手順の一覧に付けた `.steps` の見た目が、client ID の欄の「作り方の手順」（同じ class）にも効き、番号が
  消えていた**。公開の側を `.pub-steps` に分けた
- **新しい worktree で core のビルドが落ちた**——main に足された依存（`@simplewebauthn/server`）が、`cp -al` で写した
  node_modules（写しの元＝共有の作業ツリーの node_modules にも無い）に無かった。worktree の中で `npm ci` を回した。
  `npm ci` は node_modules を消してから入れ直すので、`cp -al` の硬いリンクを書き換えない（共有側のファイルはリンクの数が
  減るだけ。stat で確かめた）
- **新しい worktree で frontend のビルドが `next/font/google` で落ちた**（Module not found
  `@vercel/turbopack-next/internal/font/google/font`）。この環境から curl では fonts.googleapis.com に届くが、Turbopack の
  取得は通らない。前の worktree の `.next/cache` を写すと通った——**以前に取れた font の写しがあるときだけビルドできる**。
  新しい worktree では `.next/cache` を写す必要がある（人に伝える）

## 試験

- Module：96本（`installs.test.ts` 2本）。壊して落ちることを6か所（設定の slug を返事より優先・ほかの App のインストールも
  数える・持ち主に Install のページを添えない・slug を確かめない・PAT のアカウントでもインストールを読む・確かめるで
  Install 先を返さない）
- 画面の lib：26本（`canvas-open-project.test.ts` 1本を足した）。壊して落ちることを3か所（押した直後でなくても・閉じた・無い）
- E2E：Repositories の spec 7本（1.5分）。段階2の試験に Install 先・権限・Install のページ（slug が返事に無いときは設定から、
  あれば返事から）・使い方を、段階5の試験に Project 名から移ることを足した。壊して落ちることを2か所（移らない・Install 先を
  出さない）

## 行の「…」のメニューが枠の外にはみ出す（2026-10-04、ユーザー）

- 下のほうの行で「…」を押すと、メニューが画面の枠の下にはみ出して見えなかった。メニューはいつも「…」の下に開いていた
- 開いたあとに寸法を測り（`placeRowMenu`）、下に入りきらず上のほうが広ければ上に開く。どちらにも入りきらなければ広いほうに
  開いて高さを抑え、中をスクロールさせる。入口・設定の面の画面は枠の高さが決まっていて中でスクロールするので、
  枠（`window.innerHeight`）を基準にする
- E2E：同じ行を枠の下端に寄せたとき上に、上端に寄せたとき下に開き、どちらも枠に収まることを見る。最後の行は下に別の中身が
  あって下端まで来ないことがあるので、最初の行を寄せる。直しを外すと落ちることを確かめた
