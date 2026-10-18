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
