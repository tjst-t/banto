# Repositories：今あるフォルダをリポジトリにする画面（folder-adopter、Backlog #502）

2026-10-21。チャットを Project にする画面（v4-architecture.md §2.2「チャット」・v4-frontend.md §6.53）のリポジトリの欄。
仕様は v4-modules.md §2.4「core との境目」と v4-frontend.md §6.2「「Project にする」の画面に Module が差し出すリポジトリの欄」。

## 決めたこと（仕様に書いたもの）の理由

- **押すのは core の画面、Module の画面は頼まれて動く**（request `dev.banto/adopt-folder`）。モックの「Project にする」の
  画面はボタンが1つ（名前・フォルダ・リポジトリを決めて1回押す）。folder-provider のように Module の画面が自分のボタンで
  動いてから core に返す形だと、押すところが2つになる
- **頼むのはフォルダを移したあと**。台帳はフォルダの場所を覚えるので、リポジトリにしてから置き場へ移すと台帳が古くなる。
  だから順は「core が Project にする（移す）→ Module に頼む」。頼んだあとで失敗しても Project にはなっている——それを
  減らすために、押せるかを先に通知で言わせる（`dev.banto/folder-adopter-state`）
- **名前は core の欄の値**（「フォルダとリポジトリの名前」、モック）。Module の画面に同じ欄を持たせない（2箇所で打たせない）。
  打ち替えは hostContext の渡し直しで届き、Module が GitHub に同じ名前があるかを確かめ直す
- **もう git のリポジトリならコミットしない**。チャットのフォルダは普通は git でないが、試作で AI が git init していることは
  ありうる。そのときに中身を勝手にコミットすると、人の作業の途中を固めてしまう
- **最初のコミットの名前・メールは人の git の設定のまま**。無ければ git の決まり（自動で作る／`user.useConfigOnly` なら断る）に
  任せ、代わりの名前を作らない（規則2）。断られたら作りかけの `.git` を消す
- **GitHub に上げるのは今の公開の口**（`start_publish`）——資格情報の渡し方・push を止める設定の確かめを2箇所に持たない
- **host から画面への request** は AppBridge の `request` に、どんな object も通す schema（ext-apps の
  `McpUiResourceTeardownResultSchema` = `record<string, unknown>`）を渡し、形は banto の側（`parseAdoptedFolder`）で確かめる。
  zod や SDK を frontend の依存に足さずに済む（規則10）。待つのは 15 分（request の既定 60 秒では push が終わらない）

## 却下した案

- **Module の画面に「リポジトリにする」ボタンを持たせ、終わったら core に返す**（folder-prepared と同じ向き）：押すところが
  2つになり、フォルダを移す前にリポジトリにしてしまう（上）
- **core が Repositories の道具（`adopt_folder`・`start_publish`）を直接呼ぶ**：core が Repositories を名指しすることになる
  （v4-modules.md の「core との境目」に反する）
- **既にリポジトリのフォルダでも中身をコミットする**：上の理由で採らない

## 試験の範囲（2026-10-21 時点）

- 単体：`adopt.test.ts`（本物の git——init・最初のコミット・.gitignore・空のフォルダ・既存のリポジトリ・断る・名前が無いとき
  元に戻す）、`server.test.ts`（名乗り・口・script が読めること）、core の `ui-apps.test.ts`（`/api/ui-folder-adopters`）、
  frontend の `canvas-folder-adopter.test.ts`（通知と結果の読み方）
- E2E：`e2e/specs/repositories-folder-adopter.spec.ts`——本物の Repositories・git・偽の GitHub・本物のサンドボックスの口で、
  画面が見せる値と結果（GitHub に上げる／手元だけ／作らない）を見る。**「Project にする」の画面はまだ無い**（chat-frontend、
  chat-promote-core に依存）ので、core の側はこの試験の中の小さな host が同じ口で話す。**ModuleCanvas の受け口
  （`folderAdopter`・`onFolderAdopterState`・`adoptFolderRef`）を画面から見るのは chat-frontend の E2E**

## 間欠的に落ちる試験の記録（直していない・スコープ外、規則6・7）

`packages/modules/repositories` の `clone.test.ts`「非公開は選んだアカウントのトークンで clone する——…」が、Module の
試験を全部まとめて回すと時々「資格情報の窓口が残っている」で落ちる。計測（2026-10-21）：全部で 1/5、`adopt.test.js` を
除いても 1/6、`clone.test.js` だけなら 0/3。窓口（`banto-git-cred-*`）を**共有の一時フォルダで数えている**ので、
同時に走る別のファイル（publish・branch-sync の試験）が作った窓口を拾っていると読む（今回の変更は窓口を作らない）。
Factory の試験のコマンドには入っていない Module。直すなら、数える先を試験ごとのフォルダに分ける
