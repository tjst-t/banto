# Shell 専用のホーム（2026-09-23）

## 発端

ユーザー「SHELL MCP でも DNS 引けなかったけど、それも直した？」。

名前解決の穴（`/etc/resolv.conf` の実体が `/run` にあり Landlock が辿った先で弾く）は、
Skill の取り込みで直した ruleset の導出が Shell にも効く。**Shell の実物の ruleset** で、
名前解決の1行だけを抜いたものと比べた：

| | 直す前 | 直した後 |
|---|---|---|
| `getent hosts github.com` | FAIL | OK |
| `curl https://github.com` | 000 | 200 |
| `git ls-remote https://…` | `cannot exec 'remote-https'` | 同じ |

git は HTTPS を `git-remote-https`（`/usr/lib/git-core`）に任せる。exec の profile は PATH の隣の
`lib` を読み取りだけ許していたので起動できない——その置き場だけに実行を許した（別コミット）。

## そのあとに出た、もっと大きい穴

`GIT_CONFIG_GLOBAL=/dev/null` で `ls-remote` は通ったが、`clone` は checkout で
`~/.config/git/ignore` を読めずに落ちた。測り直すと：

| いまの Shell（Project の根がホームでないとき） | |
|---|---|
| `git commit`（ローカルでも） | 落ちる（`unknown error occurred while reading the configuration files`） |
| `npm view` | 落ちる（`~/.npm/_logs` に書けない） |

**Shell は host の HOME（人のホーム）を継いでいた。** 閉じ込めでホームは読めないので、
ホームの設定を読みに行く道具は全部落ちる。

## 決めたこと（ユーザー、2026-09-23）

選択肢を実測で並べた：

| | 案A：Shell 専用のホーム | 案B：`~/.gitconfig` だけ読み取りで見せる |
|---|---|---|
| `git clone` | 通る | 通る |
| npm | 通る | 落ちたまま |
| 資格情報（gh の取り出し役） | 写さない（Vault から） | 見えても動かない（`~/.config/gh` が読めない） |

ユーザー「案Aかな。ユーザの Home の設定をそのまま引き継ぐのはどうかな？ ただ資格情報が
使えないか。ほかにもユーザが自分の Shell と同じ状態を期待したら、困るよな」。

**ホームをそのまま引き継がない**——名前解決が通ったいま、読めるものは持ち出せる
（`~/.ssh`・`~/.config/gh`・`~/.config/banto` の合言葉）。「完全に同じ」は閉じ込めと
両立しないので、**違いを小さく・見えるように・違ったときに理由が分かるように**する。

**Dev Containers と同じ形**（規則12）：ローカルの `.gitconfig` を写し、資格情報は写さずに
取り出し役と ssh-agent をホストへ転送する。banto では：

1. Project ごとに書けるホーム（Shell の Module の置き場の中）
2. 人が選んだ設定だけを host が写す（既定 `~/.gitconfig`・`~/.config/git`）。git の設定からは
   `credential.*`・`include` を**git 自身で**外し、人のホームを指す値は向け直す。資格情報の
   置き場は一覧に足せない
3. HTTPS の資格情報は Vault から取りに来させる——**次の仕事**（`shell-https-credential-forwarding`）
4. 閉じ込めで弾かれたら、結果に理由を添える（`confinementNote`）

## 実装で踏んだもの

- **`npm config get cache` が人のホームを返した**（E2E）。`npx` の下から起こした host は
  `npm_config_cache=~/.npm`・`npm_config_userconfig=~/.npmrc` を継ぎ、HOME より強い。
  本番の host（`node` で直に起動）には無いことを `/proc/<pid>/environ` で確かめた。
  **人のホームを指す `npm_config_*` だけ**を Shell のコマンドから落とす
- `npm config get cache` はこの npm では「protected」で値を返さない——試験は
  `npm cache verify` で実際に書かせて、置き場を見る形にした
- 写す元を試験で差し替える口 `BANTO_SHELL_HOME_SOURCE`（E2E だけ。本物の人の設定を試験に使わない）

## ついでに直した間欠（規則6・ユーザーの方針「起票で済ませず直す」）

`sidebar.spec.ts` の「見張りが1フレームも測れていない」がフル E2E 3回中1回落ちた
（単独では5回とも緑）。**幅は全部正しく**、測る窓が遷移の速さ次第だった（遷移が速いと
5フレームで終わり「6以上」に届かない）。着いた後の30フレームまで見る形にした——
遅れて幅が戻る壊れ方も捕まるので、試験は緩まず強くなる。

## 見つけたが決めていないもの

- **worktree を根にした Project では git が使えない**（`shell-worktree-project-git`）。
  `.git` の実体が根の外。直すには本体のリポジトリ全体を許すことになる
