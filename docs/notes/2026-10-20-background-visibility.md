# 裏の仕事の見え方——サブエージェント・Shell の待たないコマンド・Service（2026-10-20）

ユーザー：「Shell とか Service とかバックグラウンドで動くけど、Launcher が無いものについて、状況とか進捗が分かるようにしてほしい。
あと SubAgent だけど、Launcher を見ても Tool の呼び出し状況は分かるけど、何をしているのか全然分からない」。

決めた形は仕様に書いた：アーキ仕様 §4.1「仕事の画面で、いま何をしているかを分かるようにする」・§4.2「札の手がかりを Module が
あとから足す・結果で画面を名乗る」、`v4-modules.md` §2.3「人の画面——バックグラウンドのコマンド」・§4.2「人の画面——サービス」、
`v4-frontend.md` §6.33。ここは調べたことと比べた案。

## 調べたこと（いまの作り）

- **サブエージェント**：この Project の Subagent の `runs.jsonl` の直近 50 件で、経過 1,779 件のうち **1,522 件（86%）の題が「Terminal」**、
  次が「cd /home/…」157 件、「Preparing file…」20 件、「Read File」9 件。163 件の経過を持つ1件は全部「Terminal」だった
  - 理由：claude-agent-acp（同梱の版の `acp-agent.js` の `toolCallNotification`・`streamedInputRefinement`）は、tool の入力が流れて
    くる途中で仮の題の `tool_call`（`status: pending`）を出し、入力が揃ったところで本当の題・種類・`locations`・`rawInput` を
    `tool_call_update` で送る。Subagent（`acp-run.ts` の `onUpdate`）は `tool_call_update` を completed／failed の判定にしか使っていない
  - 同じ版が送ってくる `sessionUpdate` の種類：`agent_message_chunk`・`agent_thought_chunk`・`plan`・`tool_call`・`tool_call_update`・
    `usage_update`・`subagent_spawned`・`async_task_*`・`compaction_*` など。拾っているのは message・tool_call・tool_call_update（終わりだけ）・usage
  - 途中の発言は区切りなく連結（記録の例：「…調べています。Now the existing branch-sync tests…共有の決まりを…」）
  - サイドバーの題はカードの名乗り「`{agent}` に頼んだ仕事」、一覧の題は頼んだ文の頭 80 字
- **Shell の待たないコマンド**：サイドバーの印（題は呼び名）はあるが、Shell は画面を持たないので押すと Thread へ移るだけ。
  状態・出力は `listCommands` と出力のファイルだけ
- **Service**：人の画面は仕様で未決のまま。Thread に紐付かないのでサイドバーにも出ない
- Backlog で近いもの：#124「tool の進捗（notifications/progress）を会話のカードに出す」

## 比べた案とユーザーの選択

サブエージェント：

- 案1（小）：取りこぼしを拾う・呼び名だけ
- 案2（中）：案1＋画面の上に「いまの状況」（やること一覧・最後の発言・触ったファイル）、経過の畳み
- **案3（採用）**：案2＋小さいモデルの要約をサイドバーにも出す。**ただし要約は人がボタンを押したときだけ**（ユーザー）——自動・定期では作らない

Shell と Service：

- **案A（採用）**：それぞれに入口の画面、サイドバーの1件から Shell の画面へ
- 案B：案A＋サイドバーの1行に進み具合を流す（Module が進み具合を host に伝える口が要る。#124 と同じ根）
- 案C：Module を跨いだ「裏で動いているもの」1枚の画面（core が Module の状態を集める口——2026-10-03 に避けた方向）

## 下書きで決めたこと（実装者の判断。違えば直す）

- **Shell の画面は tool の定義ではなく結果で名乗る**（`dev.banto/view`）。定義に `ui.resourceUri` を書くと待つ形の `runCommand` の
  会話のカードまで Module の画面になり、いまの専用のカード（承認の段から結果まで1枚）が使えなくなるため
- **サブエージェントの返り値の `text` は変えない**——途中の発言を経過に入れても、AI に返る返答は連結のまま。最後の発言だけにすると
  AI が受け取るものが変わるので、別に決める
- 要約は走っている仕事だけ・材料は banto 側から見えたことだけ・本体のログインの中継を通す（エージェントが OpenCode でも）
- Service の画面から新しいサービスは登録しない（見る・動かすまで）。公開の URL は出さない（Publish の画面にある）
- 札の要約はメモリだけ（起こし直しで消えてよい）

## レビューで直したこと（2026-10-21）

下書きをレビューに掛け、指摘を全部仕様に反映した。上の「下書きで決めたこと」のうち、結果で名乗る名前（`dev.banto/view`）・
要約の作り手・Service のログの口は、ここで改めた。

- **サイドバーから Shell の1件を開く仕組み**：下書きの「toolCallId で開く」は動かない。toolCallId から画面を組めるのは定義に
  `ui.resourceUri` を持つ tool だけ（`http/turn-runner.ts` の `UiToolBinding`→`uiToolCalls`、画面の `inlineViewByToolCallId`）で、
  結果の `dev.banto/*` は host が外す（`stripBantoMeta`）。→ 結果の `_meta["dev.banto/backgroundView"] = { resourceUri, select }` を
  host が `markAwaiting` で札の手がかりに写し（`reply.awaiting` に残る）、サイドバーは入口を `canvasView`＝`select` で開く
  （`dev.banto/open-surface` の launcher・Subagent の `{ runId }` と同じ形）。会話のカードの「画面で見る」は `shell-command-card.tsx` が
  結果の本文の `commandId` で同じ形に開く。名前は既存の `dev.banto/view-state` と紛らわしいので `backgroundView` にした
- **要約の置き場**：サイドバーは Event Store を畳んだ `awaitingReplies[].work` から `backgroundItemsOf` で作るので、「手がかりに載せる」
  では記録に混ざるか、呼び元ごとに食い違う。→ host のメモリの表（`replyTo` → 要約）を `backgroundItemsOf` の1か所で重ねる。
  記録に残るのは `resourceUri`・`select` だけ。Event Store・read model の形は変えないので `SnapshotProjection` の版は上げない
- **要約を作るのは core**：Module が中継へ `/v1/messages` を直に送る案はやめた——OAuth のログインで素の Messages API を呼べるかが
  未確認・見出しの付け方を Module が知ることになる・モデルの版の写しが Module に増える。→ host の口 `relaySummarizeBackgroundWork`
  （`relayUpdateBackgroundWork` を置き換え）で core が `askSmallModel` を呼ぶ。札は `get()` で持ち主だけ照らし（回数を数えない・
  `finalOnly` でも受ける）、宛先が Module・届け済み・`replyTo` 無しは「作って返すが置かない」。同時に1つ・10 秒あける。
  `askSmallModel` が最初の行だけを返すので、全文を返す選択を足すより「1行・2文まで」と指示するほうを選んだ（口を増やさない）
- **記録の大きさ**：題 300 字・説明 200 字・1件 16 KiB、画面は `getRun` の差分取り（`sinceStep`）。コマンドの全文が記録と要約の材料に
  残ることは「秘密の扱い」として書き、隠す仕組みは作らない（`envSecrets` の規則に頼る）
- **起こし直しのあと続けた仕事**：前の分の経過を失うのは受け入れ、画面にそう出す。`toolsInFlight` の題も本当の題にする
- **人が止めたコマンド**：AI が自分で止めたと誤らないよう、`cancelRequestedBy: "human"` を残し、知らせを「人が画面で止めました」に
- **Service のログ**：AI の口 `readServiceLogs` に `beforeByte` を足す案はやめ、画面用の `readServiceLog`（`admin`、`serialize` に
  並ばない、大きさと世代を返す）を別に作る——AI の口の形を画面の都合で変えない。回ったら画面は読み直す
- **Shell の画面の細部**：alias 名を job.json に（値は書かない）、題が無いときは 80 字（カードと揃える。通知の 40 字は据え置き）、
  文字の切れ目で切るのは tool・行の頭に揃えるのは画面
- **経過の細部**：触ったファイルは `kind` で数える（edit・delete・move／read、他は数えない）・根は仕事の cwd・前の版の経過は終わった
  仕事なら済み・AI に返る `toolCalls` と進み具合も本当の題に
- **要約の競合**：作っている間に終わった仕事の要約は捨てる。作っている印は Module が持つ（窓が二つでも1つ）
- AI に見せる文（`describeBackgroundItems`・`closeForkDroppedNote`）に要約は入れない
- 古くなる文を直した：`v4-modules.md` §2.3 の Palette の入口、`v4-frontend.md` §6.33 の「画面を持たない tool なら Thread へ移るだけ」。
  コンテナの外の Shell は入口の資源を `ListResources` に出さない
