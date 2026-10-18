# 秘密をまとめて引く（2026-10-18）

決まったことは `docs/specs/v4-modules.md`「秘密をまとめて引く」。ここは経緯。

- きっかけ：ansible-nas が runCommand の envSecrets に alias を27件渡すと、Infisical の回数制限（429）で断られた（Backlog #389）。
  #389 は一覧の分け合いと 429 の待ちで直したが、(1) コンテナからの `resolveAlias` は alias ごとに承認のカードが出るので、
  「承認をすべて自動で許可する」がオンでも会話が「自動で許可しました」のカード27枚で埋まる（ユーザーの画面写し）、
  (2) 値の読み出しと使った日の書き込みは alias ごとに Infisical へ出る（27件で54回）、が残った。
- ユーザー：「まとめて resolve できる方法があったほうがいい」「vault-local も直せばいい」。resolveAlias は vault-kit に1か所なので、
  vault-kit に足せば両方に効く。
- #389 で採らなかった理由は「承認は alias の単位だから」。承認の単位は alias のまま、カードだけを1回の呼び出しに1枚にする形にした
  （`dev.banto/batchOf` で、まとめた口の要素を1件ずつの口の承認の鍵に写す）。

## Fable のレビュー（2回）で直したこと・却下した案
- 下書きは「第三者の宛先が batchOf を名乗っても普通の tool として扱う」だった。普通に扱うと配列から識別子が拾えず、承認の鍵が
  `scope: {}` の1つに潰れ、一度の許可でどの alias でもまとめて引ける（2026-09-25 に塞いだ穴そのもの）。コンテナからの呼び出しなら断る、に直した。
- 下書きは Infisical の一括更新を `PATCH /api/v3/secrets/batch/raw` と書いていたが、v3 は非推奨で `projectSlug` を要る（banto は projectId しか持たない）。
  `PATCH /api/v4/secrets/batch` に直した。SDK 5.0.2 には一括更新の口が無い。
- `batchOf.tool` の実在と識別子の有無で規則を分けた（`lookupAlias` は識別子を名乗らない）。拾えないと断るのは inputSchema の required な識別子。
- 相乗り（inFlight）を鍵ごとに。重なる2つのまとめた呼び出しで同じ alias のカードを2枚出さない。
- 未決として残したもの：使った日の書き込みを間引く・lookupAlias を valueFree にする（どちらもユーザーが決める）、1件ずつの resolveAlias の
  200字超えの緩さ（Backlog）。
