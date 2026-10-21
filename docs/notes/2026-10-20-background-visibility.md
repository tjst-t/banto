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

## core と画面の実装で決めたこと（2026-10-21、Backlog #489）

- **手がかりは `resourceUri`・`select` ではなく別の `view: { resourceUri, select? }` に写した**。定義の画面（`resourceUri`＋toolCallId で
  会話のカードと同じ画面）と、結果で名乗った入口（`canvasView`＝`select`）を画面が見分けられないため。toolCallId は起こし直しの問い
  （`restart-recovery.ts`）にも使うので、名乗ったときに消す案は採らなかった。定義に画面がある tool では `view` を写さない（定義が先を
  core の1か所で決める）
- **中継（`host-relay-endpoint.ts`）の `markAwaiting` には写さない**。そこで返事待ちになる札は宛先が Module で、サイドバーに出ない
- **要約の口は同梱の Module だけ**（`maySummarizeBackgroundWork`）。前例（受信箱・出来事・本体を取ってくる口）に合わせた。人の本体の
  ログインで作り使用量もそこに数えるので、第三者のコードに開かない。コンテナの中のサブエージェントは頼める。道具用のコンテナは不可
- **Project の決まらない頼みは断る**。本体のログインの中継（`runnerEnvFor`）は Project で鍵を分けるので、札の Project か呼んだ Module の
  Project を使う。どちらも無いときに process.env のまま呼ぶ（別の経路へ落ちる）のはやめた
- **10 秒は失敗した回からも数える**。ログイン切れのまま押し続けても小さいモデルを叩き続けない
- **`backgroundItemsOf` は表を引く関数を必ず受ける**（省略できない引数）。AI に見せる文を作る呼び元（`validateCloseFork`・
  `dropCloseIfDue`・`settleClose`）は `WITHOUT_SUMMARIES` を明示して渡す——表を渡して「文の側で使わない」にすると、文の作り方を
  変えたときに要約が AI に漏れうる。仕様の「全部に効かせる」は「全部が選んで渡す」と読んだ
- **試験用の Module は目録の隠れた1本**（`e2e-bgv`、`e2e/fixtures/background-view-module`）。要約の口が同梱だけなので、
  出来事の試験（`e2e-events`）と同じく同梱の扱いで入れる。最初は `e2e-background-view` にしたが、Incus がコンテナに繋ぐ置き場の
  パスを1つのファイル名に写すので、HOME の深い機械では 255 字を越えて「file name too long」で起きなかった（`subagent` で 253 字）
  ——名前を短くした
- **狭い画面の境目は携帯の Drawer と同じ**（`useIsMobile`、768px 未満）。一覧の1件を押したら Drawer も閉じる（`onNavigate`）

## Subagent の要約ボタンの実装で決めたこと（2026-10-21、Backlog #490）

- **道具の引数は `summarizeRun({ id })`**（仕様の書き方。`getRun`・`cancelRun` と同じ名前の引数）。頼みの文には `{ runId }` とあったが、
  同じ画面から呼ぶ admin の道具でそろえた
- **`summarizeRun` は答えが来るまで待つ**。すぐ返して画面の取り直しで拾う案もあったが、待てば失敗をその呼び出しのエラーで返せる
  （単体で見やすい）。他の窓・開き直した画面は記録の `summarizing` を取り直しで見る。答えが来ないままにはならない——中継の呼び出しは
  MCP の上限（60 秒）で切れ、失敗として記録に残る
- **作っている間に終わったときの印は `finish` が付ける**（`summaryDiscarded`）。届いてから付けると、終わった記録（`runs.jsonl` に
  書いたあと）を書き直すことになる。終わった時点で「作っている途中の要約は捨てる」が決まるので、そこで付けて一緒に書く
- **材料は古い経過から落とす**。core が上限で尻を切ると一番新しい経過（いま何をしているか）が消える。並びは古い順のまま
- **画面の断り書きは「小さいモデル」**（モックは「Haiku」）。モデルは core が持つ（`SMALL_MODEL`）ので、Module の画面に名前を写さない
- **「サイドバーにも出ています」は Module が推す**（core の答えは `{ summary }` だけ）：待たない形で Thread が頼んだ、走っている仕事。
  札が済んだあと（届け済み）に置かれなかった場合とは食い違いうるが、走っている間は札は返事待ちのまま
- **E2E の「押さなければ呼ばれない」は、偽の小さいモデルが呼ばれた記録で数える**（`e2e/config.ts` の `FAKE_ONE_SHOT_LOG`、
  `fake-runner.ts` の `oneShot` が1回ごとに1行）。画面に要約が出ないことだけでは、作って置かなかった場合と見分けられない
- **core の `relaySummarizeBackgroundWork` の断りを、投げるのではなく tool のエラー（isError）の文で返すように直した**（仕様 §4.2「2.」は
  もともと isError と書いていたが、#489 の実装は投げていた——Module には「MCP error -32603: 前の要約から…」と頭の付いた文が届き、
  画面に理由をそのまま出せなかった。#490 の E2E で見つけた）。仕様に寄せた（実装を仕様に合わせた。仕様は変えていない）

## Shell の名乗りと会話のカードで決めたこと（2026-10-21、Backlog #492）

- **仕様と実態の食い違い（訂正）**：仕様は「会話のカードの『画面で見る』は専用のカード（`shell-command-card.tsx`、承認の段から結果まで
  1枚）に足す」「定義に `ui.resourceUri` を書くと、その専用のカードが使えなくなる」と書いていた。実際には `shell-command-card.tsx` は
  モックの会話（tool 名 `banto_shell_run_command`）だけで描かれ、本物の会話の `mcp__shell__runCommand` は一般のカード（`ToolFallback`）で
  描かれていた（`human-tool-card.tsx` の分岐は `banto_shell_run_command` しか見ない。E2E も `tool-fallback-trigger` で Shell のカードを
  探している）。定義に書かない理由は「待つ形のカードまで埋め込みの画面になる」に直し、「画面で見る」は一般のカードとは別の1枚にした。
  本物の会話に Shell 専用のカード（承認の段から結果まで1枚）を持たせるかは、この Backlog の外（決めていない）
- **カードは結果の本文から読む**：結果の `_meta`（`dev.banto/backgroundView`）は host が AI に渡す前に外すので、画面も見られない。
  サイドバーの手がかり（`view`）は返事待ちの間だけなので、終わったあともカードから開けるよう本文の `commandId` を使う。どの呼び出しかは
  tool 名（`mcp__<Module名>__runCommand`）・引数の `runInBackground: true`・本文の `commandId` で見る。入口の URI は画面の側も1か所で知る
- **開き方の関数を1つに**：サイドバーの `hrefOf` にあった「入口を `canvasView`＝`select` で」を `lib/backend/background-view.ts` の
  `backgroundViewHref` に出して、カードと共有した。カードの Thread が開いている Fork ならその Fork のまま開く
- **「画面で見る」は折りたたみの外**：最初は一般のカードの下に足したが、tool のカードは「N tool call(s)」の折りたたみの中にあり、
  畳まれたまま（既定）では見えなかった（E2E で 0 件）。inline の画面と同じ決まり（人が見に行く入口は畳める所に入れない、§6.2）で
  `InlineViewForPart` に置き、`OpenableCard`（カードだけの tool の入口と同じ形）にした
- **置き場に無い `commandId`**：一覧と一言。黙って別の1件（広い画面の「一番上を開いておく」）だけを見せない
- **入口が開いたままの「画面で見る」**：入口がすでに開いているとき、別のコマンドの「画面で見る」を押すと URL の `canvasView` は
  替わるのに画面は前のまま（E2E で実測）。見ている場所は `ui/initialize` の hostContext で1回渡るだけで、入口の `ModuleCanvas` は
  作り直されないため（サイドバーの1件・Factory の「経過を見る」も同じ穴を持っていた）。比べた案：(a) 開いている画面に
  `host-context-changed` で新しい場所を送る——Module ごとに受け口が要り、受けない Module（今の Subagent）は黙って替わらない。
  (b) 外からの頼みのときだけ入口の画面を作り直す——Module に手が要らない。(b) を採った。外からかは「URL の値が、画面が自分で
  預けた値と違うか」で見る（画面の中で選び直すたびに作り直さない）
