# Infisical の回数制限と runCommand の envSecrets（2026-10-18、Backlog #389）

決まったことは `docs/specs/v4-modules.md`「Infisical の回数制限」。ここは経緯と採らなかった案。

## 何が起きていたか

ansible-nas の Base Thread（c04700af-…）から報告。envSecrets に Vault の alias を25件渡すと毎回、
「alias "generated/JELLYFIN_API_KEY" は見つかりませんでしたが、読めていない Vault があります：vault-infisical（…StatusCode=429 Rate limit exceeded. Please try again in 13 seconds）」。23件なら通る。

コードで数えた alias 1件あたりの Infisical への往復：

| どこで | 何を |
|---|---|
| 窓口 `lookupAlias` → `crossAliases` → vault-infisical `listAliases` | 紐付けた版・グループごとに listSecrets（recursive） |
| vault-infisical `resolveAlias` → kit `listAll` | 同じ一覧をもう一度 |
| 同 `getSecret` | 1回 |
| 同 `markUsed` → `find` | フォルダの listSecrets を1回 |
| 同 `markUsed` → `writeComment` | updateSecret を1回 |

版付きのグループが1つあると 2+2+1+1+1 = 7 回。25件で約175回。

SDK（@infisical/sdk 5.0.2）も 429 を4回試し直すが、待つのは 1・2・4・8 秒の決め打ちで、Infisical が言う秒数を見ない。

## 確かめ方

`banto/packages/modules/shell/src/infisical-rate-limit.integration.test.ts`——Shell → 実 HTTP の中継 → 窓口 → vault-infisical
（相手は回数制限つきの偽の Infisical）。30件で一覧（recursive）が1回、フォルダの読み直しが0回。
分け合いを外した dist で回すと「一覧の読み出しが 60 回（alias 30 件）」で落ちることを確かめた。

## 採らなかった案

- **窓口に `lookupAliases(names[])` を足し、Shell が1回でまとめて引く**——Shell→窓口の呼び出しが変わると、承認のカード
  （「shell が vault-directory の lookupAlias」）と、それを数える E2E（relay-approval・auto-approve-all）が変わる。
  しかも在りかを1回で引いても、`resolveAlias` 側の一覧の読み直しは残るので、それだけでは足りない
- **`resolveAliases` でまとめて値を引く**——承認は alias の単位（grants.ts）なので、まとめると承認の形が変わる
- **窓口の `crossAliases` を数秒持つ**——Infisical に当たる回数は vault-infisical 側の分け合いで足りる。持つ場所を2つにしない
- **一覧で読んだ値を `getSecret` の代わりに使う**——一覧の値は空かどうかを見たらすぐ捨てる決まり（2026-10-06）。手元に値を残すことになる
- **使った日の書き込みを間引く**——書き込みは件数に比例して残る（30件で updateSecret 30回）。試し直しで抜けられる量なので今回は触らない。
  これで足りなくなったら次の候補

## 残っていること

- 値の読み出し（getSecret）と使った日の書き込み（updateSecret）は alias の数だけ出る。27件なら54回。Infisical Cloud の制限
  （プランで違う）に当たれば待って試し直す。1回の呼び出しで30秒を超えて待つことはない
