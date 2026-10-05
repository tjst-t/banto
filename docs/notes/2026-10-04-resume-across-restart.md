# 起こし直しをまたいで続ける——今の作りと実測（2026-10-04）

Backlog のストーリー resume-across-restart の検討。Fork「起こし直しをまたいで続ける」。

## 今の作り（コードを読んで分かったこと。起こし直しの実地では未確認）

- **途中だったターン**：人の発言（と積んだ届いたもの）は記録に残る。AI の返事は記録されず、resume-point も更新されない
  （`turn-runner.ts`——resume-point と返事はターンの最後に1回だけ書く）。「ターンが始まった」は Event Store に残らない
  （`ThreadTurns` はメモリだけ）ので、起き直した host は走っていたターンがあったことを知らない。新しい会話の最初の
  ターンは session id（`system/init` で分かる）も残らない
- **返事待ちの札**（runInBackground のサブエージェント等）：起動時に `deliverLostReply` が「途中で終わりました」を
  届け、AI が起きる（`cli.ts`）
- **判断待ち**：起動時に `expireOrphanedJudgments` が期限切れにする
- **Subagent**：走っている仕事の記録（`RunLog.running`）はメモリだけ。終わったものだけ `runs.jsonl`。ACP の `session/load`
  で続きから頼む口（`sessionId`）はもうある
- **起こす仕組み**：起動後に `deliveries.resumeAll()` が、届いていて起こしていない Thread のターンを回す。ここに
  「途中で切れました」を届ければ続きのターンを始められる
- **Factory の仕様の前提**（v4-modules.md §4.5「記録と再開」）：「Factory が起き直しても Subagent は走り続けている」。
  host を起こし直すと両方止まるので、この前提は host の起こし直しでは成り立たない

## 実測（2026-10-04、プローブ `.worktrees/resume-probe/banto/probes/`。偽の Anthropic API で、本物のモデルは使っていない）

本物のモデルを使わなかった理由：サブエージェントの Bash には `CLAUDE_CODE_OAUTH_TOKEN` が渡らない（CLI が外す）。
API に送られた要求の中身（＝モデルが見るもの）を記録した。

### Agent SDK（query、0.3.281＝CLI 2.1.281。banto core と同じ版）

| ケース | 結果 |
|---|---|
| Bash の tool の途中で kill → `resume` | 成功。CLI が切れた tool_use に `tool_result(is_error)`「[Tool call interrupted: … outcome is unknown. Check whether it took effect …]」と、合成の assistant「No response requested.」を足してから新しい発言を続ける |
| 文を流している途中で kill → `resume` | 成功。流れていた途中の文は CLI の記録にも API の要求にも残らない |
| `resumeSessionAt`＝前のターンの最後の assistant の uuid | 切れたターンを丸ごと落としてきれいに続く。切れたターンの人の発言の uuid を渡すと、古い発言と新しい発言が1つにまとまる（使わない） |
| 新しい会話の最初のターンを途中で kill → `system/init` の session id で `resume` | 成功（記録ファイルは API に送る前に書かれる） |
| `system/init` を受けた直後に kill | 失敗「No conversation found with session ID」（記録ファイルが無い）。`options.sessionId` で id を先に決められる |
| SIGTERM と SIGKILL | 会話の連なりは同じ |
| http の MCP の tool の途中で kill | Bash と同じ |

**CLI の版で切れた tool の扱いが変わる**：同じ記録を CLI 2.1.280（claude-agent-acp に同梱）で resume すると、合成の
tool_result を作らず、切れた tool_use を黙って落とす（呼んだ痕跡が残らない）。→ 切れた tool のことは CLI に任せず、
banto が自分で再開の文に書く。

Bash の子は CLI と別のプロセスグループにいる——CLI のグループだけに SIGKILL すると sleep が生き残った。systemd が
cgroup ごと止めるなら問題ない。

### ACP（サブエージェント）

| | claude-agent-acp 0.81.1 | opencode 1.18.32 |
|---|---|---|
| tool の途中で kill → 新しいプロセスで `session/load` → `session/prompt` | 成功。切れた tool_use は黙って落とされる（2.1.280 の動き） | 成功。`tool_result(is_error)`「[Tool execution was interrupted]」を合成 |
| 再生される履歴の切れた tool_call | `pending` のまま | `in_progress` のまま |
| `session/new` の直後（最初の prompt の前）に kill | `session/load` が「Resource not found」 | load できる |

### 確かめていないこと

- 本物のモデルが、合成の tool_result や banto の「途中で切れました」の文をどう受け取るか
- 稼働中と同じ形（systemd の起こし直し・Project のコンテナの中の Module）での通し

### 実測の根拠の注記

- 「CLI 2.1.280 は切れた tool_use を黙って落とす」の直接のログ（`tmp/R-SIGKILL-altcli`）は残っていない。同じ動きは
  B（claude-agent-acp、同梱の 2.1.280）の API の要求ログ（#9、tool_use が消え文だけ）で確かめられる
- `resumeSessionAt` は旧い鎖を消さず、同じファイルに新しい鎖を足す（parentUuid で分かれる）

## 決定とレビュー（2026-10-04）

- ユーザーの決定は Memory「起こし直しをまたいで続ける」と仕様 v4-architecture.md §2.5 の同名の節
- Fable のレビューで直したこと：最後まで行ったかを `turn.ended` ではなく resume-point の更新で見る（終わり際に落ちた
  ターンを「切れた」にしない）／会話の id は resume-point に書かず別の出来事にする（走行中の Fork・Clear の防御を
  崩さない）／実行中だった呼び出しは CLI の記録から引く（Event Store に二重に持たない）／Module の札の判定を
  Thread の続きより先に行う（二重に扱わない）／承認待ちだった呼び出し・予約した Fork を文面で書き分ける／
  記録の無い最初のターンは発言を積み直さずに走らせ直す口が要る／覚え直した札は最後の届け1回だけ／
  上限は `turn.started` の `attempt` から数える。未確認の4点は仕様の「まだ確かめていないこと」

## タスクの分け方（Backlog の resume-across-restart の子にする。2026-10-04 時点で Backlog に書けず、控え）

稼働中の Backlog が通し番号（`number`）の入った一覧を読めない版だったため、splitStory が断られた。反映後にこのとおり足す。

| id | 題 | 待つもの | 完了条件 |
|---|---|---|---|
| resume-restart-measure | 確かめ：鎖の選び方・KillMode・コンテナの Module の生死・本物のモデルの受け取り | — | 仕様の「まだ確かめていないこと」4点の結果をこのノートに表で書き、食い違いは仕様を直した |
| resume-turn-events | Event Store にターンの始まり・会話の id・終わりを残す | measure | 既存の fold・store の試験が通る。偽の Runner で途中で止めて起動し直すと切れたターンが1件だけ見つかる。resume-point を書いたあと・Clear のあとは0件 |
| resume-message-by-message | AI の発言を書き終えるごとに記録する | turn-events | 走っている最中にリロードしても吹き出しの数が記録と一致（実ブラウザの E2E で件数）。止めたターンの記録が二重にならない。turn-stop の試験が通る |
| resume-thread-turn | 起き直したら切れたターンを自動で続ける（上限つき） | turn-events・message-by-message | 偽の Runner で：tool の途中で止めて起動し直すと人が何もせず続きが最後まで走る。続けて2回切れると受信箱に1件。Clear・閉じたあとは続けない |
| resume-module-contract | Module の「続けられる」約束と札の覚え直し | turn-events | 名乗らない Module は今どおり。名乗った Module の「続ける」札は残り後で1回だけ届けられる。Thread の続きはその判定のあと |
| resume-subagent | Subagent を起こし直しのあと続ける | module-contract | 別のデータ置き場の host で、本物の Claude Code の仕事の途中で起こし直しても結果が届く。記録のファイルに資格情報が無い |
| resume-factory | Factory を同じ約束に乗せる | subagent・factory-runtime | 実装の段の途中で起こし直しても最後まで進む |
| resume-light-update-wait | 更新の「待つ」を続けられないものだけ待つ形に | thread-turn・subagent | 実行中の tool が無ければ待たずに起こし直しへ進み、起き直したあと続く |

## 実装の最初の確かめ（resume-restart-measure、2026-10-05）

### M4. host が止まったとき、コンテナの中の Module とその子は止まるか

プローブ `banto/probes/m4-incus-exec.mjs`。この Project のコンテナの中の Incus に使い捨てのコンテナ（rs-probe）を立て、
banto と同じ形（`incus exec <名前> -- /bin/sh -c "exec node …"`、stdio は pipe、tty なし）で「Module」を起こした。
Module は子を2つ持つ（同じプロセスグループの `sleep 600` と、別グループの `sleep 600`）。呼び出し元の `incus` クライアントを
止めて中を数えた。

| 呼び出し元への信号 | Module（node） | 同じグループの子 | 別グループの子 |
|---|---|---|---|
| SIGTERM | 2秒以内に止まった | **残った**（10秒後も） | **残った** |
| SIGKILL | 2秒以内に止まった | **残った** | **残った** |

- **Module は host と一緒に止まる**（仕様の見込みどおり）。Module は起き直した host が起こし直す
- **Module が起こしたコマンドは止まらずに残る**（親を失って動き続ける）。Shell の `runCommand` の長いコマンドは、起こし直したあとも
  コンテナの中で走り続け、結果はどこにも返らない。続きの AI が同じコマンドを流し直すと二重に走る
- → 「結果は分かりません。確かめてから進めてください」の文面は正しい。加えて「まだ動いているかもしれない」ことを書く。
  残ったコマンドを Module が起き直したときに片づけるか（Shell が起こしたプロセスを覚えておいて止める）は別に決める

### M1〜M3（2026-10-05、プローブ `banto/probes/m-sdk.mjs`・`m3-host.mjs`・`m3.mjs`。偽の API、SDK 0.3.281）

**前提の訂正**：`rewindTo`（`resumeSessionAt`）は「次のターン以降も渡し続ける」のではない——`thread.resume_point_updated`
のたびに消える（`fold.ts`）。巻き戻したターンが最後まで行けば次からは付かない。**起こし直しで切れたときだけ残り、次の
ターンでもう一度渡される**。

**M1：巻き戻したあと、`resumeSessionAt` 無しで resume したとき CLI はどの鎖から続けるか**

| ケース | 次のターンの要求に入った発言 |
|---|---|
| 巻き戻したターン3が完了 | TURN1・TURN3（新しい鎖） |
| ターン3を SIGKILL | TURN1・**TURN2**（取り消した古い鎖が戻る） |
| ターン3をプロセス木の全部に SIGTERM | TURN1・TURN3（新しい鎖、CLI が終わり際に書く） |
| 同じ `resumeSessionAt` を渡す（SIGKILL・SIGTERM とも） | TURN1 だけ（ターン2もターン3も入らない） |
| SIGKILL のあと `getSessionMessages` の鎖の最後の uuid を渡す | 失敗「No message found with message.uuid of: …」 |

CLI はターンの終わりに書く `last-prompt`（`leafUuid`）の行で鎖を選んでいる（その行を消すと古い鎖に戻った）。SIGKILL では
書かれない。`getSessionMessages` は新しい鎖を返し、CLI は古い鎖を選ぶ——**SDK の読む口と CLI の選び方が食い違う**。
→ **切れたターンが巻き戻しの上にあったら、`resumeSessionAt` を保ったまま続ける**（今の作りのまま）。そのとき切れたターンの
人の発言と途中の作業は CLI から消えるので、**続きの文に切れたターンの人の発言（と届いたもの）を入れ直す**

**M2：記録の無い最初のターン**

- `system/init` 直後の SIGKILL で記録ファイルは10回中10回できない
- resume すると `system/init` は来ず `result`（`subtype: error_during_execution`・`num_turns: 0`・`errors: ["No conversation found with session ID: …"]`）
  のあと例外。使っていない id と同じ形
- **走らせる前に `getSessionInfo(id)` が `undefined` かで記録の有無が分かる**（文言に頼らない）
- 記録が無ければ、同じ `options.sessionId` を渡して resume 無しで走らせ直せる。記録が有るのに同じ `sessionId` で新しく走らせると
  「Session ID … is already in use」（result 無しで exit 1）
→ **最初のターンは banto が session id を先に決めて `options.sessionId` で渡す**（`system/init` を待たずに記録できる）。
起き直したら `getSessionInfo` で記録の有無を見て、無ければ同じ id で走らせ直し、有れば resume

**M3：host（親）が止まったとき**

- host に SIGTERM（host は保存して `process.exit(0)`。SDK は exit で起こした CLI に SIGTERM）：bash・sleep は 250ms 以内に消え、CLI は
  2〜2.5秒孤児で生きて記録に `tool_result(is_error):"Exit code 137"` を書いた（resume すると AI はそれを見る）
- host に SIGKILL（落ちたとき）：CLI・bash・sleep が全部生き残り、孤児の CLI は tool を最後までやって **API にもう1回要求を出し**
  返事を記録に書いた（約2分）
→ 落ちたあとに孤児の CLI が同じ記録に書き続けうる。**systemd が cgroup ごと刈る（`KillMode=control-group`）ことを前提にし、
起き直したときにそれを確かめる**（設定は host で確認待ち）。banto の Runner は組み込みの Bash を使わない（tool は Module 経由）
ので、Bash の子の形は banto とは違う

## 実装の1つめ：ターンの進み具合を残す（resume-turn-events、2026-10-05）

仕様 §2.5「1. Thread のターンを続ける」のうち、`turn.started`・`turn.session_known`・`turn.ended` を書くこと、
切れたターンを見分けること（`findInterruptedTurns`）、新しい会話の session id を host が先に決めること。続ける処理は次。

実装で決めたこと（仕様の該当の箇条に反映）：

- **`turn.started` は発言を積むより先**：あとにすると「このターンで積んだ発言」が seq から引けない（直前の
  user の並びを推すことになる）。先に書いて発言の前に落ちた場合は、発言の無い切れたターンになる——人の発言は
  HTTP の要求の中にしか無かったので、どちらでも失われる。届いたものは待ち行列に残っているので、`resumeAll` が起こす
- **始めた時刻は出来事の ts**：payload に同じ時刻をもう1つ持たない（規則3）
- **`turn.session_known` は毎ターン書く**（resume のターンでは resume-point と同じ id）：`system/init` まで行ったか
  の印にもなる。1ターン1件
- **閉じて開き直した Thread**：閉じた時点で走っていたターンは続けない（印は消えない）
- **終わりは `runThreadTurn` の finally で1回**：done→completed、stopped→stopped、それ以外（error・例外・呼び出し
  側が読むのをやめた）→failed。書けなければログに残す（起き直したら切れたターンに見える）

試験で確かめたこと：偽の Runner が `system/init` のあと返らない（＝host がそこで止まった）状態から、開き直した
store で1件。`system/init` の前に止まっても先に決めた id で1件。resume-point を書いたあと（返事の記録）で止まったら
0件。開き直したあと Clear したら0件。実装の該当行を1つずつ壊して（17か所）、どれも試験が落ちることを見た。

気づいたこと（未決）：

- 偽の Runner でしか通していない。banto の host から本物の SDK に `options.sessionId` を渡して走らせたことはまだ無い
  （`system/init` がその id を名乗ること・記録ファイルがその名前になることは、ここでは確かめていない）
- 1ターンにつき Event Store の書き込みが3件増える（started・session_known・ended）

## Fable のレビューを受けた直し（2026-10-05）

1. **何も積まずに切れたターン**：`InterruptedTurn.stackedMessages`（`startedSeq` より後ろの user の発言の数）を足した。
   0 なら続けない——AI にはまだ何も渡っておらず、届いたものは待ち行列に残っていて `resumeAll` が起こす。人の発言は
   HTTP の要求の中にしか無かったので、どちらにしても残っていない（続けても空のターンになる）
2. **人が止めた直後に落ちる窓**：止めると決めた時点（`abortTurn.abort()` の前）で `turn.ended("stopped")` を書く。
   印の出来事を足すより単純なので、終わりを前に出した。書いたら finally では書かない（二重にしない）。書けなかったら
   CLI は止め、finally がもう一度書こうとする
3. **Clear の防御の穴**（前からある）：新しい会話の最初のターン・Fork の最初のターンを走行中に Clear すると、
   resume-point に自分の会話が無い（新しい会話は undefined、Fork は親から借りた id）ので、Clear が捨てる側に入るのは
   それだけ。終わりに来た resume-point の更新（新しい会話・分けた会話の id）がそのまま入り、Clear を取り消していた。
   Clear のとき最後のターンの `assignedSessionId`・`knownSessionId` も捨てた側に入れる
4. **Fork の最初のターンも session id を先に決める**：下の実測 F1 で SDK が受けることを確かめた
5. 小さいもの：画面に出す走り始めた時刻を `turn.started` の ts にそろえた（`TurnEventBus.setStartedAt`。`begin` は
   始まりを書くより前に呼ぶので、時刻はあとから直す）／`turn.started` が resume-point・巻き戻しの位置を写して持つ理由
   （続けるには始めたときの値が要る。Thread の値は終わり・Clear・取り消しで変わる）を型に書いた／Fork の最初の
   ターンかは `ownsSession === false` から分かることを型に書いた
6. 試験の穴：健全性検査の中断・例外・呼び出し側が読むのをやめたターンが failed になること、Fork が親の
   `lastTurn` を引き継がないこと

壊して落ちるかは、上の直しの該当行を12か所壊して見た。最初の版では3か所（発言の数に AI の発言も数える・走り始めた
時刻をそろえない・既定の終わり方を completed にする）で試験が落ちなかったので、試験を直してから全部落ちることを見た。

### F1：`forkSession` と一緒に `sessionId` を渡したら（2026-10-05、`banto/probes/m-sdk.mjs F1`。偽の API、SDK 0.3.281＝CLI 2.1.281）

| ケース | 結果 |
|---|---|
| 新しい会話に `sessionId: A` | `system/init` の id＝A、記録は `A.jsonl` |
| `resume: A`・`forkSession`・`sessionId: F` | `system/init` の id＝F、記録は `F.jsonl`。A の記録は1行も変わらない。最初の要求に TURN1（親の発言）が入る＝親の会話を引き継ぐ |
| `resume: F`（`sessionId` 無し） | `system/init` の id＝F、要求に TURN1・TURN2・TURN3 |
| `resume: A`・`forkSession`・`sessionId: G` を `system/init` で即 SIGKILL（5回） | 5回とも `G.jsonl` が**ある**が、中身は `mode`・`atis-latch` の2行だけ。`getSessionInfo(G)` は5回とも `undefined` |
| そのあと同じ `sessionId: G` で分け直す | 失敗「Session ID … is already in use」（exit 1、result 無し） |
| そのあと G を resume | 失敗「No conversation found with session ID: …」（`error_during_execution`） |
| そのあと新しい `sessionId: H` で分け直す | 成功。要求に TURN1・新しい発言 |
| `resume`（`forkSession` 無し）に `sessionId` | CLI が断る「--session-id can only be used with --continue or --resume if --fork-session is also specified」（adapter の試験で、断る行を外して見た） |

→ Fork の最初のターンでも先に決めた id で会話が分かれる。ただし**会話を書く前に切れた Fork は、新しい会話（M2：記録
ファイルができない）と違って中身の無い記録が残る**ので、同じ id では走らせ直せない。`getSessionInfo` が `undefined` を
返すところは同じなので、続ける処理は「記録が無い」を見たら、Fork の最初のターンなら新しい id で分け直す必要がある
（仕様 §2.5「会話の記録が無い」に註、決めるのは続ける処理）

## 実装の2つめ：書き終えた発言ごとに記録する（resume-message-by-message、2026-10-05）

仕様 §2.5「書き終えた発言ごとに記録する」の項。決めたことは仕様に反映した。ここは理由と、選ばなかった案。

### 吹き出しの単位：1ターンの AI の発言は1つ（fold でまとめる）

- Event Store には SDK の assistant のメッセージごとに `message.appended` を1件書き、fold が同じターンの分を会話の1件に
  まとめる。**まとめる場所を fold にした理由**：「ターンの最後の AI の記録」を1件として読んでいるところが多い——受信箱の
  「ターンが終わりました」の要約（`cli.ts` の `turnEndSummary`、会話の最後の1件の頭）・一覧の件数と最後の発言
  （`toThreadSummary`）・Fork が親の会話を写すこと・画面の組み直し（`realMessagesToInitial`、1件＝1吹き出し）・最新の
  20 件だけ描く（§6.29、件数）。会話の1件をターンごとに保てば、どれも変えずに済む
- 選ばなかった案：記録は発言ごとの件数のまま返し、画面で連続する AI の発言を1つの吹き出しにまとめる。要約・件数・
  「この Fork を開く」の件数などをすべて直す必要があり、画面と host で「1件」の意味が食い違う
- まとめる条件は「最後のターンの始まり（`lastTurn.startedSeq`）より後ろで、直前の1件も AI の発言」。この仕組みより前の
  記録（`turn.started` が無い）ではまとめない——前は AI の発言が続くことが無かったので同じ結果
- 走っている途中に Clear すると、そのターンのそのあとの発言も Clear の横線より前の吹き出しに入る（前はターンの最後に
  書いたので横線の後ろに出ていた）。Clear が切り離すのはそのターンの会話なので、横線より前のほうが合っている

### 書く単位

- 文は発言が届いた時点。画面つきの呼び出しは結果（次の user の tool_result）が来た時点で、文の無い1件として書く
  ——文まで結果を待たせると、承認待ちの間（人が答えるまで）文が記録に落ちない
- 結果が来ないまま終わった（done・失敗・止めた）呼び出しは最後に結果無しで書く（前も結果無しで残していた）
- 書いてから画面に流す（`await` してから `yield`）。1発言ごとに fsync を待つ——1ターンで発言が多いと（tool を30回呼ぶ
  ターンで 30〜60 件）、流れが fsync の分だけ遅れる。測っていない

### 「ここから Fork」が壊れる穴（洗い出しで見つけた）

前は resume-point → 返事 の順に書いていたので、返事の seq より前にそのターンの resume-point の履歴（`resumePoints`）が
あった。発言ごとに書くと返事が resume-point より前になり、**新しい会話の最初のターン**（Clear のあと・Fork の最初の
ターンも）の返事から分けると「その時点ではまだ会話が無い」と判定され、まっさらな会話で始まっていた（続きのターンは
同じ会話なので見た目は変わらない——履歴は会話が変わったときだけ積む）。履歴の seq をそのターンの始まりの seq にした

### 流し直しの境界

- 走っているターンに乗った画面は、記録から組み直したうえで、そのターンを最初から流し直してもらう。記録にもう入った
  発言がそのまま描かれると2回出る
- 選んだ形：`attached` にターンの始まりの seq を載せ、画面がそのターンの AI の1件を記録から外す。流し直しはそのまま
  全部流す——判断待ち・答えは記録に入らず流し直しにしかないので、流し直しの側を削ると並びが崩れる
- 選ばなかった案：流し直しを「記録に入っていない分だけ」にする。画面は乗ってから記録を取る（取りこぼさないため）ので、
  乗った時点の境界と記録を取った時点の境界がずれ、その間に入った発言が二重か欠けになる。吹き出しも記録の分と流れる
  分の2つに割れる
- 始まりを記録する前（Skill を決めている間）に乗られたら、境界が決まるまで `attached` を待たせる。待つ間に終わった
  ターンを取りこぼさないよう、知らせを受けたその場で途中経過を取り、続きを溜める（単体の試験は記録と終わりを同じ手番で
  書くので、溜めないと必ず `idle` になった）
- 画面が外すのは「始まりより後ろで人の発言の次の AI の1件」。乗ったターンが取り消されて次のターンが返事を書くまでの
  間に記録を取ると次のターンの返事を外してしまうので、記録の `lastTurn` が後ろにあればその始まりより前に限る

### 試験の待ちの前提が変わった

「記録の AI の件数が増えた」は、もうターンの終わりの合図ではない（最初の発言で増える）。E2E の多くがこれを待ちに
使っている。turn-reattach は host に聞く形（`GET …/stream` が `idle`）に直した。ほかの spec の洗い出しは下の「残したこと」。

### 確かめたこと

- core の単体：`http/turn-replies.test.ts`（12本）——書き終えるごとに入ること（途中でログから開き直しても見える）・
  会話ではターンごとに1件・画面つきの呼び出しは結果が揃ってから（画面の無い tool は書かない）・結果の来ないまま
  終わった／失敗したターンの呼び出し・切れたターンの印（最後のターンでなければ断る・前のターンの吹き出しに足さない）・
  止めたときに残りだけ書く・考えただけで止めたら取り消す（記録に AI の発言が無い）・tool を呼んだあとに止めたら
  取り消さない・返事から Fork を分けたときの会話・流し直しの境界。`app.test.ts` に `attached` が境界を待って載せること
- 壊して落ちるか：実装の該当行を22か所壊し、どれも単体が落ちることを見た。最初は2か所（取り消しの判定で tool を数え
  ない・失敗したときに残りの呼び出しを書かない）で落ちず、試験を足した。もう1か所、型で弾かれて試験まで行かなかった
  変異は書き方を変えて回し直した
- E2E：turn-reattach に「走行中にリロードしても AI の吹き出しの数が記録と一致する」を足した（前のターン1つ＋走って
  いるターン。走っている最中・終わったあと・終わってからのリロードの3か所で、画面の吹き出しの数と記録の件数・同じ行が
  2回出ていないことを見る）。画面の「外す」をやめると吹き出しが3つになって落ちることを見た
- 試験の待ちで1回踏んだ：送った直後の「流れ待ちの吹き出し」で件数の待ちが満たされ、まだ始まっていないターンで
  「走っていない」が満たされた（画面は画面つき tool の一覧を待ってから送るので、Module の起動待ちの約5秒、ターンが
  始まらない）。返事の中身を待つ形に直した（規則14）

### 残したこと

- **E2E の「件数でターンの終わりを待つ」**：監査（サブエージェント、読むだけ）で、記録の AI の件数をターンの終わりの
  合図にしている spec を洗った。確実に壊れるもの1本（`subagent.spec.ts` の3ターン目——件数が3になった時点で文がまだ
  空で `JSON.parse` が投げる）、件数のあとに続きの文・resume-point を読む・すぐ次を送るものが十数本。
  `helpers.ts` に `waitTurnEnded`（件数・最後の発言が最後のターンのもの・`lastTurn.outcome`）を足して置き換えた。
  件数のあと一度だけ resume-point を読む2本（fork-from-message・global-memory）は、resume-point が返事より後に
  書かれるようになったので新しく生まれた競走だった
- 1発言ごとに fsync を待ってから画面に流す——長いターンでの遅れは測っていない
- 失敗したターンでも書き終えた発言は残る。新しい会話の最初のターンが失敗すると resume-point が書かれないので、
  次のターンの AI はその発言を知らない（人の発言が残って AI が知らないのと同じ形。前からある）
- `noteInterruptedTurn` は何度呼んでも足す（二度起き直すと2回付く）。一度だけにするかは呼ぶ側（続ける処理）で決める
- **E2E の間欠（この変更とは別、直していない）**：関連 spec をまとめて回した回で `background-work-human.spec.ts` が1回
  落ちた（「待たずに頼みました」が2つ）。2つめは runSubagent の汎用の tool カードの「Result:」欄。画面は送る前に画面
  つき tool の一覧を最大5秒待つ（`UI_TOOLS_WAIT_MS`、待ち切らないのは決めたこと）が、その回は一覧の応答が 5459ms
  （Module の起動待ち・負荷）で、一覧を知らないまま送ったので専用のカードにならなかった。単独では変更あり1回・変更
  なし（main と同じ core と画面）2回とも通り、どれも一覧は 3.5〜3.7 秒。負荷で出る前からの間欠として残す（規則6）
