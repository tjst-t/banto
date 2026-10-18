# Claude のアカウントの台帳と置き場（Backlog #398）

仕様は `docs/specs/v4-security.md` §2「Claude のアカウントを複数持つ」の 3.・7.・8.。実装で決めた細部とその理由。

## 台帳に置き場の道を書かない

仕様の下書きは台帳の欄に「置き場」を挙げていた。書かずに、種類（`host`／`banto`）と id から決める形にした。

- `host` の置き場は起動のときの `hostClaudeCredentialsPath()`（E2E は `BANTO_CLAUDE_RELAY_CREDENTIALS`、人は
  `CLAUDE_CONFIG_DIR` で変えうる）。道を台帳に写すと、最初の起動のときの道が残り、環境を変えても古いほうを読む（規則3）
- `banto` の置き場は `<データ置き場>/claude-accounts/<id>/` で、id から一意に決まる

仕様の欄の説明はこの形に直した。

## 最初の1つの id は `host`

外せない・人の CLI の置き場、という特別なものなので、乱数の id にせず固定にした。カードの dedupeKey
（`claude-login-upstream-unauthorized:host`）も起こし直しをまたいで同じになる。分ける前のカード
（`claude-login-upstream-unauthorized`）は、最初の1つで通ったときに一緒に閉じる。

## 選び方はまだ「既定の並びの先頭」

Project の並び・閾値での切り替え・429 の送り直しは #401。それまで中継は既定の並びの先頭を使う。
移したあとの既定の並びは `host` だけなので、足すまで今と同じに動く。

## 取り直すかどうかは全部のアカウントで1つ

`relayRefreshDecision`（SDK の版・`BANTO_CLAUDE_RELAY_REFRESH`・置き場を別の道から指す）は全部のアカウントに同じに効かせた。
足したアカウントは banto だけの置き場なので「本物を別の道から指す」の理由は当たらないが、SDK の版の確かめは同じ手順に
掛かるため。分けるかは #400（足すログイン）で要るかを見て決める。

## 取り込み

Factory はローカルの `main`（origin/main と分かれている）の上で作ったので、取り直し役と仕様の節を先に cherry-pick して
積んでいた。GitHub の main へは、このタスクのコミットだけを origin/main の上に載せ直して入れた（ぶつかり無し）。
