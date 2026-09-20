# Infisical Cloud に繋がらなかった件と、Vault 管理画面の一覧（2026-09-20）

## 1. Infisical Cloud に繋がらない——`401 Invalid credentials`

設定画面から Infisical Cloud（US）に繋ごうとして、保存が
`[URL=https://app.infisical.com/api/v1/auth/universal-auth/login] [StatusCode=401]
Invalid credentials` で落ちた。

### 切り分けでやったこと（と、やらなくて済んだこと）

**エラー文からは何も絞れない**ことを、先に30秒で確かめた（規則15-2）。
存在しない Client ID と、実在の Client ID ＋でたらめな Secret を、それぞれ
login の口に直接投げる小さなスクリプト：

```
[架空のID + 架空の秘密] 401 {"message":"Invalid credentials","error":"UnauthorizedError"}
[実在のID + 架空の秘密] 401 {"message":"Invalid credentials","error":"UnauthorizedError"}
```

**同じ**。Infisical は「identity が無い」と「Secret が違う」を区別しない。
つまり画面のエラーを読んでも、どのフィールドが悪いかは永久に分からない
——**エラー文を睨むのをここでやめられた**。

リージョンは `~/.infisical/infisical-config.json` の `LoggedInUserDomain` が
`https://app.infisical.com/api` だったので、US で合っていた（EU 取り違えを除外）。

### 本当の原因

**Token Auth の access token を、Universal Auth の Client Secret 欄に入れていた。**

Machine Identity には Universal Auth と Token Auth の両方が付いていて、人が作って
いたのは Token Auth のトークン（`banto-token`）。Token Auth のトークンは Bearer と
して直接使うもので、`/api/v1/auth/universal-auth/login` は通らない。
`Last Login Method: Token Auth` / `Number of Uses: 0` が、その証拠として画面に出ていた。

Universal Auth のパネルから Client Secret を作り直して繋がった。

### 残した穴（直していない）

`config-app.ts` は clientId・projectId・environment を `.trim()` するのに、
**clientSecret だけ生のまま**送り、`settings-store.ts` もそのまま保存する。
今回の原因ではなかったが、貼り付けに改行が混じると**同じ 401** になる。
スコープ外なので触っていない（規則7）。直すなら1行。

### 却下した案：1本の Module から dev/staging/prod を全部見る

`environment` は接続設定の1フィールドで、`InfisicalConnection.scope` に畳まれて
全呼び出しに乗る。複数環境を1本で扱うなら、詰まるのは **alias カタログの置き場**：
`InfisicalAliasStore` は alias のメタデータを Infisical の中の `secretComment` として
**いまの環境に**書いているので、「カタログをどの環境に置くか」を先に決めないと
成立しない。さらに alias ごとの環境をどこに記録するか、`VaultBackend` の
`group/key` という2階層の契約（組み込み Vault と共用）に環境をどう乗せるかが続く。

**採らなかった。** 環境ごとに Module を1本ずつ立てれば、コード0行で済む
（2026-09-15 に「2本目が混ざらない」ことは押さえてある）。代償は資格情報を
環境の数だけ入れること。利点として、**環境をまたいだ取り違えが構造的に起きない**。

## 2. Vault 管理画面の一覧に、置き場（グループ）を出す

**きっかけ**：Infisical に 32 件の秘密があるのに、全部「どこにも紐付いていない」
と出ていて、**それがどのフォルダに在るのか画面から分からなかった**。
使える範囲は置き場からの導出値（2026-09-13 の決定）なので、導出値だけ出して
元を隠すと、人は Infisical を直に見に行くしかない。

見せ方は `groupLabel`（この Project 専用／Global／別の Project 専用）で、
**本当の名前は `title` に入れて読めるようにした**。既定のグループ名は projectId
（UUID）なので、そのまま出しても人には意味が無いため。

## 3. 「共通」を Global に

instance 全体の設定を人が既に Global と呼んでいるので、そちらに寄せた。
**片側だけ変えない**——一覧・保存先の選択肢・置き場のラベル・窓口の設定画面の
見出しまで揃えた。2026-09-15 に「保存先の言葉と一覧の言葉を揃える」という直しが
入っているので、ここで片方だけ変えると同じ穴を開け直すことになる。

仕様と tool の語彙（`shared`／「共通グループ」）は変えていない。変えたのは
人に出す言葉だけ。

## 4. 既定の絞り込みを「この Project から使える」にした

Vault は banto 全体に1本なので、絞らないと他の Project の秘密が全部並ぶ。
既定が拾うのは **その Project 専用＋Global**——`resolveAlias` が素の名前で引ける
範囲（Project ＞ Global の既定）と**わざと一致させた**。画面の既定が
「いまここで名前を書けば通るもの」と同じになる。

**当てるのは初回だけ**にした。人が「すべて」に変えたあと、再読み込みのたびに
巻き戻すと、絞り込みが人の手から離れる。

**0 件のときに、既定で隠していることを言う**（規則2）。既定の絞り込みを入れた
以上、「0 件」が「まだ何も預けていない」に見えてはいけない。

## 踏んだもの

**テンプレート文字列の中にバッククォートを書いて、ビルドを壊した。**
`manage-app.ts` は画面まるごとが1つのテンプレート文字列なので、コメントに
`` `server.ts` `` と書くと**そこで文字列が終わる**。`tsc` は 100 行離れた場所を
指すので、エラーの位置からは原因が読めない。この Module には
「窓口の画面も、バッククォート混入と capabilities の取り違えをしない」という
試験が既に在る——**同じ穴を過去にも踏んでいる**。

**列を足したら、行全体の `toContainText` は当てにならない。**
一覧の行に「Global（どの Project からでも）」が居るので、置き場の列を
`toContainText("Global")` で見ても**必ず通る**。列を名指し（`td` の nth）で
`toHaveText` にした（規則14）。

## 確かめたこと

- `@banto/module-vault-directory` の単体試験 40 件——通った
- `vault-directory.spec.ts` 8 件（反復はここだけ・規則15-3）
- フル E2E **99 件、9.5 分、全部通った**（コミット前の1回・規則15-4）

---

# 追記：一覧の見た目を詰めた（同日）

前半で足した列を実機で見たところ、**名前が1文字ずつ縦に流れていた**。
`CLOUDFLARE_ACCOUNT_ID` のような名前の行が10行分の高さになり、表として読めない。

## 原因

表が自動幅（`table-layout` 既定）で、`td.name` に `word-break: break-all` が
掛かっていた。列が増えて名前の列に割り当てられる幅が狭まると、`break-all` が
**どこでも改行してよい**と解釈して縦に積む。列を足した分だけ悪化する形だった。

## 直し方で迷ったところ

**JS で文字列を切る**（`name.slice(0, 20) + "…"`）のは簡単だが、採らなかった。
切ると DOM に短い文字列しか無いので、**人が選んでコピーしたときに切れたものが
取れる**。秘密の名前はコピーして使うもの（コマンドに貼る）なので、これは壊れている。

CSS の省略（`overflow: hidden` ＋ `text-overflow: ellipsis` ＋ `white-space: nowrap`）
なら、DOM には全文が在って見た目だけ畳まれる——コピーは全文。
そのうえで `title` にも入れて、マウスを乗せれば読めるようにした。

## 語を短くした

説明つきの語（「ログイン情報（OAuth）」「Global（どの Project からでも）」）は、
**badge の幅をそのまま列幅にする**ので、名前の列を押し潰していた。
意味は列の見出し（「種別」「使える範囲」）が既に言っているので、badge は1語にした。

「別の Project（先頭8桁）」だけは、短くすると**同じ文字列の選択肢が絞り込みに
並ぶ**（id ごとに別の key を持っていたため）。key も `other` の1つにまとめて、
「他の Project のもの」をまとめて絞れる形にした。

## グループ列は、言い換えをやめた

前半では `groupLabel`（「この Project 専用（HOME）」）を出していたが、
**backend での本当の名前**に変えた。人がこの列を見る目的は
「Infisical のどのフォルダに在るか」なので、**突き合わせられない言い換えは役に立たない**。

## 踏んだもの

**またバッククォートでビルドを壊した。** CSS のコメントに `word-break` と
書いただけで、テンプレート文字列がそこで終わる。今日2回目。`tsc` のエラーは
100行離れた場所を指すので、毎回エラーの位置からは原因が読めない。

## 確かめたこと

- 単体 40 件
- `vault-directory.spec.ts` 8 件。CSS が当たっていることだけでなく、
  **行の実際の高さが1行分に収まっていること**（`boundingBox().height < 44`）と、
  **セルの `textContent` が全文のままであること**を見ている——
  「CSS が当たっている」と「1行に見える」は別（規則14）
- フル E2E 99 件（語とグループ列を変えた時点で1回）

## 訂正：「残した穴」は同日に塞いだ

上の「### 残した穴（直していない）」は、書いた時点の話。ユーザーの指示で
同日に直した（`00568af2`）。`toConfig` で `input.clientSecret.trim()` にして、
改行・前後空白つきの Secret を機械で押さえる試験を足してある。
**落とすのは画面ではなく `toConfig`**——`setConnectionSettings` は tool としても
叩けるので、画面だけ直すと口が開いたままになる。
