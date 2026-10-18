# 2026-10-18 期限の切れた GitHub のログインが AI に渡る——持ち主が作った値で渡す（Backlog #405）

決まったことは `docs/specs/v4-modules.md` §2.1「banto が置く秘密は、持ち主が作った値で渡す」・§2.4「使えるトークン」、
`docs/specs/v4-architecture.md` §2.5「持ち主が、自分の置いた秘密から渡す値を作る口」、`docs/specs/v4-security.md` §3 の表。
ここは経緯と、決めたことの理由。

## 報告（ansible-nas の Base Thread、2026-10-18）

- runCommand の `envSecrets` で `repositories-github-tjst-t`（種別 `oauth-token`、持ち主 `repositories`、
  `format: github-app-user-token/1`、欄は accessToken・expiresAt・refreshToken・refreshTokenExpiresAt）を受け取り、
  JSON から accessToken を取り出して git push に使っていた
- 09:22 UTC は通り、11:19 UTC は `Invalid username or token` で断られた。accessToken の期限は 09:50:43Z だった
- 向こうの AI は refresh token に触らなかった（取り直すと GitHub が refresh token も替え、AI は Vault に書けないので、
  Repositories の鍵を無効にしてしまう）——正しい判断
- 頼まれたこと：渡す前に持ち主が取り直す／accessToken だけを渡す／取り直せなければはっきり断る

## 原因（コードで確かめた）

- Repositories の `AccountManager.tokenFor` は「期限の5分前を切っていたら取り直し、Vault に書き戻す」が、呼ぶのは
  Repositories 自身が GitHub を使うとき（clone・publish・「確かめる」・`push_branch` 等）だけ
- vault-kit の `resolveAlias`・`resolveAliases` は種別を見ずに置いてある値を返す。Shell は Vault へ直接
  `resolveAliases` を呼ぶ
- だから Repositories がしばらく GitHub を使わないと、AI には切れた値が渡る。同じ JSON に refresh token も入っていた

## 決めたこと（と理由）

1. **持ち主でない呼び元には、持ち主が作った値を渡す**。期限を見る・取り直す・何を渡すかは持ち主が決める。
   Vault は値の形を知らない（今の「Vault は banto が置く秘密の中身を知らない」を保つ）
2. **Repositories は access token の文字列だけを返す**——使う側は `GH_TOKEN` にそのまま入れられ、refresh token が
   持ち主の外へ出なくなる。前の JSON の形に頼った使い方は替わる（いま知っているのは ansible-nas だけ）
3. **残り 30 分を切っていたら取り直す**。自分で使うときの5分より長いのは、受け取った側がコマンドの中でしばらく
   使うため。8時間のうちの30分なので、取り直しが増えすぎない
4. **作れなければ断る、置いてある値に落とさない**——持ち主が `presentOwnedSecret` を持たない・もう登録されていない
   ときも（2回目のレビューで改めた）
5. **Vault → 持ち主の中継は承認を聞かない**、ただし呼び元は役割 `vault` を満たす同梱の banto 本体の Module だけ。
   値の最後の受け手は `resolveAlias` の承認を通っている。持ち主は「呼び元がいまその秘密を預かっている Vault か」を
   確かめる
6. 持ち主自身（輪を作らないため・自分の組が要るため）と人の管理操作（Vault をまたぐ移動が値を丸ごと運ぶため）は、
   今までどおり置いてある値を受け取る

## Fable のレビュー（1回目）を受けて変えたこと

判断は「このままでは入れない」。直したもの：

- **Vault には中継の口が無く、依存も空**（宣言に合言葉も無い）——Vault に合言葉を渡し、`presentsOwnedSecret` の口に限って
  依存の確かめを外す、と決めた（Vault に持ち主を名指しで依存させない）。security の表に「Vault が侵されたときに広がる面」
- **「その Module はありません」という断りの文は core に無い**（依存に無いときと同じ文）——中継の一般の決まりとして
  `[dev.banto/noSuchModule]`・`[dev.banto/noSuchTool]` の印を足す
- **持ち主が `resolveAlias` を呼び直すと、その中継が Project ごとの承認に掛かり2枚目のカードが出る**——Vault が今の値を
  引数で渡す形にした。列に並ぶ前に読まれた値が古いことがあるので、持ち主は「自分が最後に置いた組」を優先する
- **持ち主の記録が無い `oauth-token` は穴のまま残る**——持ち主でない呼び元には断る
- 監査は Vault → 持ち主の中継の行で追う（`presentedBy` を alias の行に添える仕組みは無い）、Vault で移したあとの断りの文、
  参照の元の名前を言い換える、呼び元の刻印が無ければ断る、名前は宣言の名前で比べる、取り直しは戻さない、持ち主を呼ぶのは
  確かめと承認のあと

## 採らなかった形

仕様の「採らなかった形」に4つ（Vault が JSON を読む・期限を注記に書く・裏で定期的に取り直す・Shell が持ち主を呼ぶ）。
もう1つ：**AI に Repositories の道具（「GitHub のトークンをくれ」）を足す**——AI 向けの道具を持たない決まり（§2.4）と、
`envSecrets` で秘密を渡す今の道（承認・監査・値が AI の文脈に出ない）から外れる。

## 確かめていないこと

- GitHub App のユーザー用トークンを git の https で使うときのユーザー名（`x-access-token` で通るか）は、実装のときに
  本物で確かめる

## Fable のレビュー（2回目）を受けて変えたこと

判断は「このままでは入れない」。直したもの：

- **「刻印の無い呼び出しは断る」は、今動いているリモート MCP の OAuth を壊す**——core は窓口で在りかを引いてから金庫の
  `resolveAlias` を直接（中継を通さず）呼んでいて、刻印が無い。刻印が無いのは banto 自身のコードだけなので、置いてある値を
  返すことにした
- **「持ち主がいない・口が無いなら置いてある値」は穴を開け直す**——Repositories を外すだけで refresh token 込みの値が AI に
  渡る。断ることにした。これで印（`noSuchModule`・`noSuchTool`）も要らなくなったので外した（第三者の呼び元に Module の
  有無を教える心配も消えた）
- **持ち主が「最後に置いた組」をメモリに持ち続けることを決まりとして書いた**（§2.4。ログインし直し・外す・Vault で消す・
  起こし直しでの扱い）。security の表にも
- 依存の確かめを外す範囲（Project の縛りは残す）と host の順序、Vault が `callId` を添えること、`importOwnedSecret` は
  持ち主の無いものを無いまま運ぶこと

## Fable のレビュー（3回目）を受けて変えたこと

判断は「`${secret:…}` を決めてから」。直したもの：

- **起動のときの差し込み `${secret:…}` も刻印なしの直接の道で、`oauth-token` を Module の環境・リモート MCP の見出しへ丸ごと
  渡す**——差し込まないことにした（正当な使い道が無い）
- **`admin` の例外が広い**——Module の画面から中継で来た呼び出しにも `admin` が付き、外から入れた Module に refresh token が
  渡りうる。刻印のある呼び出しは持ち主でない呼び元として扱い、窓口の移動は新しい `exportOwnedSecret`（`assertHuman`）に移す
- **持ち主の記録が無い行は、持ち主自身の読みも断られる**——明記し、入れる前に本番で数えることにした
- `presentOwnedSecret` の `name`・`group` は窓口の `lookupAlias` と同じ形で渡す

実装の条件（Backlog #405 の完了条件に入れる）：Vault が `resolveAliases` の途中で持ち主を待つ間に、持ち主が同じ Vault へ
`putSecret` で書き戻せること・GitHub の往復を含めて中継の時間の上限に収まることを、試験で確かめる。

## Fable のレビュー（4回目）

判断は「1行足してから入れてよい」。足したもの：窓口の移動の中の読みは、写したあとの確かめの読みも `exportOwnedSecret`
（`resolveAlias` のままだと持ち主でない呼び元として Repositories を呼び、在りかが違うで断られて移動が止まる）。
`${secret:…}` の種別の確かめは差し込みの解決でだけ（共有の引き方に入れるとリモート MCP のログインが自分で断られる）。
`exportOwnedSecret` は `oauth-token` だけを受ける。
