---
id: imp-0007
type: improvement
kind: incident
origin: agent
class: spec-drift
status: open
refs: [task-0034, spec-environment, adr-0010]
---

## 何が起きたか

task-0034 の実装後に `spec-environment` §3.1（`env.*` Tool 契約の表）と実装を突き合わせたところ、**食い違いが11か所**あった。うち8か所は実装を spec に寄せて解消したが、**3か所は設計判断が要る**ため、黙ってどちらかに寄せずここに積む（P3）。

発見の経緯：`workdir` の spec 反映が残っていると引き継ぎに書いたが、確認したら §2 は決定34 起票時（`6f8e60b`）に既に更新済みだった。逆に §3.1 の表と実装がずれていた。

## 解消済み（実装を spec に寄せた）

spec が設計の真実なので、機械的な差は実装側を直した（`f26c6f3` の後続コミット）。

| spec §3.1 | 実装（修正前） | 対応 |
|---|---|---|
| `env.provision` 出力に `healthcheck: {ok, detail?}` | 返していなかった | provision が疎通まで見て返すようにした |
| 出力の `profile` | `profileName` | `profile` に統一 |
| `env.list` の `state` | `live: boolean` | `state: live / torn-down / teardown-failed` に。**畳み損ねを畳み済みと同じに見せない** |
| `env.list` の `projectTag?` フィルタ | 無し（`taskId` のみ） | 両方に対応 |
| `env.verify` 出力 `{exit, logPath, logTail, ...}`（平ら） | `{run: {exit, ...}}`（入れ子） | 平らにした |
| `env.verify` の `cmd` 必須 | 任意だった | 必須に |

**`env.verify` の `exit` の扱いはこの過程で決めた**：環境が立たない・healthcheck が通らないなど**走らせるところまで到達しなかった場合も 0 にしない**。0 を返すと「確かめていない」が「通った」と読める（I2）。理由は `failure` に入り、本文にも「検証まで到達しませんでした」と出る。

## 判断が要る（未解消）

### (1) `env.collect` の回収先を誰が決めるか

- **spec**：入力 `envId`、出力 `{dest}` ——**Environment Pool が決めて教える**
- **実装**：入力 `envId, dest` ——呼び出し側が決める
- 論点：Pool が決めるなら置き場の規約（`<dataDir>/collected/<envId>/` 等）が要り、番頭は結果のパスを受け取るだけで済む。呼び出し側が決めるなら、番頭が「この worktree に集めて」と言えるが、**場所の砦（決定36g）を通さないと任意のパスへ書ける穴になる**。後者を採るなら砦を通す配線が要る

### (2) `repoPath` / `taskId` の必須・任意

- **spec**：`env.verify` / `env.provision` の入力で `repoPath` と `taskId` が必須の位置にある
- **実装**：どちらも任意
- 論点：アドホック（`driver` + `config` 直指定・決定34e）では `repoPath` は要らない——プロファイルを読まないため。spec の表が**プロファイル経由の形しか書いていない**のが実態に合っていない。表を「プロファイル経由なら `repoPath` 必須」と条件つきに直すのが素直だが、表の書式をどうするかは決めていない

### (3) `env.list_profiles` が spec に無い

- 実装で足した（そのリポジトリで使えるプロファイル一覧。上限で弾かれたものは理由つきで返る）
- 論点：無いと番頭は `profile` に何を渡せるか知る手段がない（`place.list` を足したのと同じ理由）。spec §3.1 の表に足すべきだが、**Tool を1本増やす判断**なので勝手に確定させない

## 提案

(1) は spec 側（Pool が決める）に寄せるのが安全側だと考える——砦の配線が要らず、番頭が任意のパスを指せる穴も開かない。(2)(3) は spec の表を実態に合わせて改訂する。いずれも1本の task にまとめられる規模。
