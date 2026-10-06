# 2026-10-06 GitHub のログインが「client ID を知りません」で更新できなくなる——書き戻しの承認と持ち主

決まったことは `docs/specs/v4-architecture.md` §2.5「host は中継の宛先に『呼び元の Module』を刻む」「呼び元の Module が
持ち主のものだけを書き換える口」、`docs/specs/v4-security.md` §3 の表「持ち主のものだけを書き換える口」、
`docs/specs/v4-modules.md` §2.1 B節 `putSecret`・Infisical の注記・§2.4「使えるトークン」。ここは経緯・測ったこと・
決めたことの理由・却下した案。

## 症状（本番、ユーザー報告）

Repositories の GitHub のアカウント（ブラウザでログイン＝GitHub App のデバイスフロー）が、しばらくすると更新のたびに
「GitHub がこの client ID を知りません」で失敗し続け、ログアウトしたように見える。

## 測ったこと（ユーザー、本物の GitHub）

- デバイスフローのトークンは **client secret 無しで refresh できた**（文書どおり。今のコードの頼み方は正しい）
- 本物の GitHub は **無効な refresh token にも `incorrect_client_credentials`** を返す（`bad_refresh_token` ではない）。
  `github.ts` の `explain` はこれを「client ID を知りません」と訳していた——**探す場所を間違えさせる文言**だった
  （規則15-6 の逆：嘘のエラーを人が信じる）

## 原因

refresh すると GitHub は古い refresh token を無効にする。その後の Vault への書き戻し（Repositories → 金庫の `putSecret`
の中継）は、**AI のターンの中で起きると人の承認を要した**——Backlog が項目を変えるたびに Repositories の
`fetch_branch`・`push_branch` を中継で呼び、そこで `tokenFor` が走る。承認が切れる・断られる・banto を起こし直して
カードが無効になると書けず、**Vault には無効な古い鍵だけが残る**。以後の更新は毎回 `incorrect_client_credentials`。
しかも以前のコードは書けなかったとき投げて終わっていたので、GitHub から受け取った新しい組も失われていた。

## 決めた直し方（ユーザー承認済み）

条件：banto の根っこの仕組みを触るので慎重に。**このためだけのパッチを core に入れない**（「putSecret なら」「repositories
なら」と名指しする分岐を書かない）——一般の仕組みとして作る。

1. **host が中継の宛先に呼び元の Module を刻む**（`dev.banto/callerModule`）
2. **vault-kit の `putSecret` に持ち主**（置いた Module。置き換えは持ち主からだけ）
3. **承認を聞かない口の種類を足す**（`dev.banto/callerOwned`。`valueFree` と同じ形——名乗りを信じるのは同梱の宛先だけ）
4. **Repositories の守り**：書けなかった組をメモリに持って次に使い書き直す／`incorrect_client_credentials` を更新では
   「更新の鍵が無効」と訳す
5. 裏での定期的な更新は作らない

## 実装で決めたこと（と理由）

### 刻む名前は宣言の名前（`identity.moduleName`）

接続名（`shell-<projectId>`）ではなく宣言の名前（`shell`）にした。

- 承認の粒度が宣言の名前（`CallerIdentity.moduleName` の注記「承認の粒度はこちら」）。持ち主も「どのコードが置いたか」の
  印なので、同じ粒度に揃える
- 接続名は host のプロセスの名付けの都合で、Project の id を含む。持ち主は Vault（Infisical では複数のホストで共有しうる）に
  残るので、host の内部の名付けを外に書かない
- banto 全体の Module（Repositories・窓口）では2つは同じ。違いが出るのは Project ごとの Module だけで、いま `putSecret` を
  呼ぶ Project ごとの Module は無い

### 印の名前は `dev.banto/callerOwned`

既存の `dev.banto/valueFree`（tool の性質をそのまま言う形容）に合わせた。刻印のほうは既存の `dev.banto/caller`（誰の
ための呼び出しか）と混ざらないよう `dev.banto/callerModule`。

### 承認を飛ばす条件に「呼び元が banto 本体で動いている（コンテナの中ではない）」を足した

ユーザーの条件は「宛先が同梱・呼び元も同梱・呼び元の Module の刻印がある」。**ここに1つ足した**（厳しくする方向）。
Project のコンテナの中で動く同梱の Module（Backlog・Shell 等）は、中で AI が root で中継の合言葉を読め、その Module の名で
中継を呼べる。承認なしで `putSecret` を通すと、AI が「backlog」の名で新しい oauth-token を共通の置き場に作れる（名前の
先取りで、後から Repositories のログインが「backlog が置いたもの」で断られる）・持ち主の無い既存のもの（リモート MCP の
OAuth のログイン）を引き取って自分の値に替えられる。既存の線（`mayRaiseNotice`・`mayReadCallerProject` はコンテナの
中を断る）と同じ扱いにした。いま承認を飛ばしたいのは banto 本体で動く Repositories だけなので、困るものは無い。

### 持ち主の記録が無い既存の oauth-token は「次に置き換えた Module が持ち主になる」

ユーザーの提案は「持ち主の無いものは今までどおり置き換えられるが、承認なしの対象にはしない（承認を聞く）」。
**提案どおりには作れなかった**——承認を飛ばすかを決めるのは host で、host は持ち主を知らない（持ち主の確かめは宛先が
するから、宛先が名乗れるのは同梱だけ、という線そのもの）。host が飛ばすと決めた時点で、宛先には「承認された呼び出し」と
「印で飛ばした呼び出し」の区別がつかない。作るなら次のどれかが要る：

- (a) host が「印で飛ばした」ことを宛先に刻む（2つ目の刻印）。宛先は持ち主の無いものをそのときだけ断る
- (b) 宛先が「この呼び出しは承認が要る」と返し、host が聞いてからやり直す（新しい往復の取り決め）
- (c) host が宛先の持ち主の記録を読む（host が Vault を知る——名指しの分岐になる）

(c) は条件に反する。(a)(b) は core に新しい取り決めを足すうえ、**本番の救いにならない**：(a) では、持ち主の無い
Repositories のログイン（今あるものは全部これ）を AI のターンで書き戻そうとすると、聞かれずに断られる——今より悪い
（今は聞かれて、答えれば書ける）。

そこで「持ち主の無いものは、次に置き換えた Module が持ち主になる」にした。引き取れるのは、**承認を飛ばせる呼び元**
（banto 本体で動く同梱のコード——何を書くかは banto のコードが決めていて、AI が名乗れない）か、**人が承認した呼び出し**
（外から入れた Module・コンテナの中の Module は今までどおり聞かれる）か、人が画面で押した同梱どうしの操作だけ。
持ち主の無いものは、この変更より前に置かれた有限の集まりで、次の書き込みで持ち主が決まって減っていく。
Module を介さない呼び出し（呼び元の Module の刻印が無い）では持ち主は決まらない（今までどおり置き換えられるだけ）。

本番で今あるログイン（持ち主無し）は、この変更で**ログインし直さずに**次の書き戻しで Repositories のものになる。
ただし報告の時点で既に Vault の鍵が無効になっているアカウントは、一度だけブラウザでログインし直す必要がある
（GitHub 側で無効になった鍵は戻らない）。

### 人の画面から直接（呼び元の Module が無い）でも、持ち主のあるものは置き換えられない

ユーザーの決め方「違えば断る」のまま。人が直したいときは、持ち主の Module の画面で操作する（Repositories ならログインし
直す——Repositories の画面からの中継なので呼び元は repositories）か、Vault の画面で消してから。

### Repositories の新しいログインは、窓口を通さず金庫へ直接置く

**設計の段で見落としていた点**（実装で見つけた）。Repositories は、初めてのログインの組を窓口（`vault-directory`）の
`putSecret` で置き、更新の書き戻しは金庫の `putSecret` へ直接呼んでいた。中継の刻印はすぐ手前の呼び元なので、窓口経由で
置くと**持ち主が `vault-directory` になり、Repositories からの直接の書き戻しが「vault-directory が置いたもの」で断られる**。

却下した案：

- **入れ子の中継で、いちばん外側の呼び元を刻む**——窓口のような「頼まれて転送するだけ」の Module には合うが、一般には
  B が A の名で C を書けることになる（混乱した代理人）。刻むのは常にすぐ手前の呼び元にした
- **窓口の `putSecret` も `callerOwned` を名乗る**——窓口は持ち主を確かめない（確かめるのは金庫）ので、名乗ると窓口に
  頼める誰もが、窓口の名で置かれたもの（リモート MCP の OAuth）を承認なしで書き換えられる
- **書き戻しも窓口経由にする**——窓口への中継は承認に掛かる（上と同じ理由で名乗れない）ので、直したいものが直らない

採った形：新しく置くときも金庫へ直接。どの金庫かは窓口に聞く（`getDefaultVault`——人が設定画面で選ぶ既定の Vault）。
置き場（グループ）は金庫が決めるので、置いたあとで窓口の `lookupAlias` で引く（今までと同じ）。

窓口の `target()` は「設定の既定が繋がっていなくても、繋がっている Vault が1つならそれに置く」が、こちらは設定の既定に
そのまま置く（繋がっていなければ中継が「繋がっていない」で断り、ログインは「保存していません」と言う）。窓口の決め方を
Repositories に写すと、同じ判断が2か所になる（規則3）ので写さなかった。食い違うのは「既定に選んだ Vault が繋がって
いない」ときだけで、そのときは理由つきで断る。

リモート MCP の OAuth（`core/src/oauth/provider.ts` → `cli.ts` の `putSecretThroughVault`）は今までどおり窓口を通す。
host → 窓口は中継ではない（直接）ので呼び元は無く、窓口 → 金庫の中継で持ち主は `vault-directory` になる。置き換えも
同じ道を通るので、持ち主が合って壊れない。出所は `host` なので、承認は前から「banto 自身の同梱 Module どうし」で飛んでいる。

### 書けなかったときの扱い

以前は「GitHub からは新しいトークンを受け取りましたが、Vault に置けませんでした。もう一度ログインしてください」と
投げていた。いまは：

- 取り直した組を**先にメモリに持つ**（プロセスのメモリだけ。秘密の第二の置き場をディスクに作らない）
- 書ければメモリから捨てる。**書けなければ投げずにトークンを返す**——GitHub が出した使えるトークンで、頼まれた仕事は
  進められる。受信箱に1件（`github-save:<login>`、開いている間は積まれない）
- 次に呼ばれたら、メモリの組を使い、まず置き直す。期限が来ていればメモリの組の refresh token で取り直す（Vault の
  鍵はもう無効なので使わない）
- もう一度ログインしたら新しいログインが正（メモリの組は捨てる）。外したら捨てる（あとで置き直さない）
- 受信箱に出せなかったときは黙る（置き直しと一緒に次にまた出す）。投げると、使えるトークンを持っているのに仕事が止まる

### 偽の GitHub を本物に合わせた

`test-fakes.ts` の偽の GitHub（単体・E2E が共有）は、無効な refresh token に `bad_refresh_token` を返していた。本物どおり
`incorrect_client_credentials` にした。使った鍵が無効になるのは前から本物どおり。

### ついでに見つけたもの：vault-infisical が oauth-token を読めていなかった

`infisical-alias-store.ts` の `parseComment` は注記の種別を `secret`・`ssh-identity`・`file` の3つしか受けず、banto が
置いた `oauth-token` の注記を「banto の注記ではない」として捨てていた。Infisical では、一覧に種別 `secret`・用途に
注記の JSON が出て、**`putSecret` の置き換えが「人が預けた秘密です（secret）」で断られていた**——Infisical を既定の
Vault にしていると、回った鍵を一度も書き戻せない（同じ症状のもう1つの入口）。持ち主を注記に入れて読み戻すのに
どのみち要るので、この変更で直した（直す前の実装で試験が落ちることを確かめてから直した）。

## 試験

- 単体
  - core `host-relay-endpoint.test.ts`（4本足した）：同梱→同梱の印つきの口は聞かず、記録に理由・宛先に host の刻印（呼び元が
    書いた刻印では偽れない）・印の無い口は聞く／呼び元が外の Module・コンテナの中の Module なら聞く／宛先が外の Module なら
    名乗っても聞く／刻印は宣言の名前（接続名ではない）
  - module-contract `meta.test.ts`：`callerModuleOf`・`isCallerOwned`
  - vault-kit `owner.test.ts`（新）：名乗るのは putSecret だけ／持ち主の記録・同じ Module は置き換えられる・違う Module と
    Module を介さない呼び出しは断る／持ち主の無いものは置き換えられ、置き換えた Module が持ち主になる（介さない呼び出しでは
    決まらない）／人が預けた秘密には届かない
  - vault-infisical `infisical-alias-store.test.ts`：oauth-token の注記を種別ごと読み、持ち主も読み戻す・あとから書ける
  - Repositories：`accounts.test.ts`（書けなかった組をメモリで使い、置き直す・起こし直した後は「鍵が無効」・もう一度
    ログイン／外すとメモリの組を捨てる）、`github.test.ts`（更新の `incorrect_client_credentials` の文言・ログインの同じ返事は
    client ID のまま）、`vault.test.ts`（新：新しいログインは金庫へ直接）
- **壊して落ちることを確かめた**（dist を一時的に書き換えて走らせ、元に戻した）：host の印の緩めを外す・コンテナの中を通す・
  外の宛先を信じる・外の呼び元を信じる・接続名を刻む・呼び元の `_meta` を通す（それぞれ対応する試験が落ちる）／vault-kit の
  持ち主の確かめを外す・記録しない・引き取らない・持ち主の無いものを断る・印を外す／Repositories のメモリの組を使わない・
  書けなかったら投げる（以前の形）・更新でも client ID と訳す・新しいログインを窓口経由にする・偽の GitHub を
  `bad_refresh_token` に戻す。vault-infisical は直す前の実装で落ちることを見た
- E2E `repositories.spec.ts` の最後に1本：AI のターン（偽の Runner）で Backlog の項目を変え、その中の Repositories の
  `fetch_branch`・`push_branch` で期限の来たログイン（寿命 60 秒の偽のトークン）を取り直す。出るカードは Backlog →
  Repositories の2枚と Repositories → vault-local の `resolveAlias` の1枚だけで、**`putSecret` のカードは出ない**。書き戻しは
  記録（`relay.call_recorded`）に「呼び元の Module が持ち主のものだけを書き換える口」で成功として残り、次のターンも聞かれずに
  取り直して送れる（偽の GitHub は使った鍵を無効にするので、Vault に最新の鍵がある）

## 試験の環境で踏んだもの（この変更とは別）

- **Repositories の `clone.test.ts`「リダイレクトの先の別の相手には…窓口は閉じる」が、パッケージの全部を並べて走らせると
  ときどき落ちる**（6回中1回。単独では3回とも通る）。この試験は共有の一時フォルダの `banto-git-cred-*` を前後で比べており、
  同時に走る別の試験ファイル（資格情報の窓口を開く）の窓口を「残った」と数えうる。PAT の clone の試験で、この変更は触って
  いない。直していない（規則7）——記録だけ残す
- vault-local の SSH の試験は、作業環境の `TMPDIR` が長いと ssh-agent のソケットのパスが 107 バイトを超えて落ちる
  （`TMPDIR=/tmp` で全部通る）
- vault-infisical の `infisical.integration.test.ts` は本物の Infisical に繋ぐ試験で、この作業環境からは `fetch failed`
  （届かない）で落ちる

## 残した懸念

- **メモリの組は起こし直すと失われる**。書き戻しが失敗し続けたまま起こし直すと、次の更新は「鍵が無効」で断られ、
  もう一度ログインが要る（受信箱には「保存できていません」が先に出ている）。ディスクに持つのは秘密の第二の置き場になる
  ので採らなかった
- **書き戻せていない間に人が Vault の画面でその alias を消すと**、次に使うときメモリの組で置き直し、ログインが戻る
  （Repositories の画面で外したときは捨てる）。消したことを Repositories は知らない。めったに起きないので放置
- **呼び元の Module の刻印は、外から入れた宛先にも渡る**（`dev.banto/caller` と同じ）。渡るのは Module の名前だけ
- 「持ち主の無いものは承認を聞く」を厳密に作るなら、上の (a) が要る。外から入れた Module が `putSecret` に相当する口を
  名乗る（＝承認を飛ばしたい）ようになったら、そのとき考える（いまは同梱の宛先しか名乗りを信じない）
