# Thread に届ける——サブエージェントの待たない形と、Thread 間のメッセージの共通の口（2026-09-25）

ユーザー：「サブエージェントを非同期で動かして、完了したら通知する仕組みを作ってほしい。ただしこれは Project や
Thread 間の通信と、できれば同じ仕組みにしたい。可能？」

決まったことは `docs/specs/v4-architecture.md` §4.1・§4.2、`v4-security.md` §3、`v4-frontend.md` §6.8。
ここには経緯と、採らなかった案を残す。

## 決めたこと（ユーザーに聞いたもの）

- **届いたら AI を自動で起こす**（「置いておく」「送り手が選ぶ」も出した）。完了を人が見に行くまで AI が
  止まっているのでは、待たない形にする意味が半分になる
- **最初に作るのは共通の口＋サブエージェントの待たない形**。Thread 間の送信（宛先の一覧・Project を
  またぐ許し方）は決めることが多いので、次に同じ口の上に作る

## 採らなかった案

- **MCP の Tasks**（長い tool 呼び出しを task にして、終わったら知らせる MCP の仕組み）——Claude Code
  2.1.281 がクライアントとして名乗らない（実測・2026-09-24）。名乗っても、それは「同じ呼び出しの続き」で、
  Thread 間のメッセージには使えない
- **CLI の「長い MCP 呼び出しを背景に回す」仕組み**（`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`・
  `CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND`・`CLAUDE_AUTO_BACKGROUND_TASKS`。2.1.281 の本体に名前がある）
  ——§4.1 が「作る前に見る」としていたもの（規則12）。背景の仕事は **CLI のプロセスの中の状態**で、banto は
  1ターン＝1プロセスでターンが終わると閉じる（§2.3）。使うにはターンをまたいで CLI を生かす形に変える
  ことになり、しかも Thread 間には使えない
- **Module に Thread の id を渡し、Module が id で届ける**——Module（中の AI は root で合言葉を読める）が
  好きな Thread を指せてしまう。別の Project の AI を起こして仕事をさせられる。**返信用の札**
  （Slack の `response_url` と同じ形：呼び出し元に結びついた、期限と回数のある印）にした
- **画面をポーリングして、host が始めたターンに気づく**——受信箱で一度踏んでいる（5秒ごとの取り直しの
  再描画が assistant-ui のランタイムを壊した、2026-09-05）。host から画面への出来事の流れにした
- **届いたものを「受信箱に置くだけ」にし、ターンは人が始める**——上の「自動で起こす」と逆
- **A2A の push 通知**——境界の外（別の組織のエージェント）のための protocol。banto の中では発見も
  認証も要らない（§4.2「A2A は使わない」）

## 決めた値（仮置き）

- ホップ 10・同じ Thread を届いたもので起こすのは1時間に 20 回まで・札は 24 時間・5回まで。
  どれも根拠のある値ではない——サブエージェントが仕事を頼み直す連鎖を普通に回せて、暴走は1時間で
  止まる、という程度。困ったら変える

## 作ったときに踏んだこと（2026-09-25）

- **待たない形でも、資格情報の用意は呼び出しの中で済ませる**。最初は「呼び出しを返してから、背景で起こして鍵を
  引く」形にしていたが、Vault の中継（と初回の承認）は **host が「どの会話のための呼び出しか」を知っている間**
  （tool 呼び出しの最中）しか通らない——返したあとでは承認カードの出し先が無く、断られる。背景に回すのは
  エージェントを走らせる部分だけにした
- **host が一瞬で終えたターンに、画面が繋ぎに行くと「走っていない」と返る**——繋ぎ直しの道だけでは画面が
  更新されない。「届いたもので始まったターンが終わった」知らせで、記録から1回取り直すようにした
- 同じ Thread のターンが2本走るのを、以前は画面だけが防いでいた（host には何の守りも無かった）。host が
  自分でターンを始めるようになったので、host に鍵を置いた
- **最初は、走っている間に人が送ると 409 で断っていた**——フル E2E の `turn-lifecycle-abandoned` が落ちて気づいた：
  判断待ちに答えた直後に送った発言が、前のターンが終わりきる前だったので断られ、消えた（その試験はまさに
  「送ったつもりで消える」を防ぐためのもの）。**断らずに並ばせる**形に改めた（Claude Code が走行中の入力を
  溜めるのと同じ）。届いたもので起こすほうは、人が並んでいれば横取りしない

## Module から呼ぶとき（2026-09-26、ユーザー）

「将来は別の MCP からサブエージェントを呼びたい。いまの仕組みで可能か」→ 確かめると、足りないものが3つあった
（`docs/tasks.json` subagent-from-modules）：中継の時間の上限（MCP の既定 60 秒）・中継には返信用の札が出ない・
**中継の宛先が Project を見ていない**（別の Project のサブエージェントを名前で指せる。いまは届かない）。

ユーザーの決定：待たない形の返事は**呼んだ Module に返す**（大元の Thread ではない）。**banto の外から呼ぶことは
考えない**。返事の口は Thread と同じ仕組みにしたい。

**MCP の Tasks を Module どうしで使う案**も考えた——Module どうしなら両側とも banto のコードで、MCP の標準の
答えになる（規則12）。ただ Thread への返事（AI への道）は CLI が Tasks を名乗らないので使えず、**仕組みが2つに
分かれる**。返信用の札の宛先を広げるほうが、送り手（サブエージェント）を1つの書き方のままにできる。

## 別の Module から呼ぶための残り2つ——呼ぶ Module を作るときにやる（2026-09-26、ユーザー）

3つ挙げたうち、**Project の境界の縛りだけ先に入れた**（`c839c387`、`RelayRegistry.whyNotAllowed`）。残りの2つは
「呼び出す Module がまだいないので、検討内容とタスクをメモして、実際に呼び出す Module を作るときにやろう」（ユーザー）。
次に拾う人のために、調べたことと候補を残す。

### ② 中継の時間の上限と途中経過

- **どこ**：`packages/core/src/relay/host-relay-endpoint.ts` の `relayCallTool`——host が宛先を
  `target.client.callTool({ name, arguments, _meta })` と**オプション無しで**呼んでいる。MCP の SDK の既定の上限は
  60 秒（`DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`、`@modelcontextprotocol/sdk/dist/esm/shared/protocol.js`）。
  途中経過（`notifications/progress`）も呼び出し元へ中継していない
- **AI の道は手当て済み**：`relay/agent-proxy.ts` は `resetTimeoutOnProgress: true` と `onprogress` で途中経過を
  AI 側へ送り、上限を延ばしている。呼び出し元の Module の側（`HostRelayClient.callRelay`）も
  `resetTimeoutOnProgress` を付けている——**抜けているのは host が宛先を呼ぶ1箇所だけ**
- **直し方**：agent-proxy と同じく、`signal: extra.signal`・`resetTimeoutOnProgress: true`・`onprogress` で
  呼び出し元の `progressToken` へ中継する
- **直す前に測る**（規則1——いまはコードを読んだ結論で、実際に切れるところは見ていない）：呼ぶ Module から、
  待つ形の `runSubagent` を偽のエージェントの `[slow 90]` で中継して、60 秒で切れることを確かめてから直し、
  直ったら通ることを見る
- 待たない形（`runInBackground`）はすぐ返るので、この上限には当たらない

### ③ 札の宛先に Module（返事は呼んだ Module に返す——決定済み）

- **いま**：返信用の札（`delivery/reply-handles.ts`）は AI が Module を呼んだときだけ出る（`agent-proxy.ts`）。
  宛先は Thread に固定で、届け先は `ThreadDeliveries.deliver`。中継の呼び出しには札が無いので、
  `runInBackground` は「届ける先がありません」で断られる
- **第一候補**：
  - 札の宛先を `{ Thread }` か `{ Module（接続名） }` にする。中継（`relayCallTool`）でも、宛先の tool が
    `dev.banto/deliversLater` を名乗っていれば札を出し、**呼んだ Module に結びつける**
  - **送り手（サブエージェント）の書き方は変えない**——`relayDeliverToThread` を宛先を問わない名前に広げ、
    host が札の宛先で振り分ける
  - Module 宛ては、呼んだ Module が名乗った**受け口の tool**（例：`_meta["dev.banto/receivesReplies"]: true`）を
    host が呼んで渡す。**先に記録してから渡す**（Thread と同じ）——その瞬間に Module が止まっていても、次に立った
    ときに渡す
  - ループ防止（ホップ・速度）と返事待ちの後始末（止まったら「途中で終わりました」）は Thread と同じものを使う
- **呼ぶ Module を作るときに決めること**：受け口の tool の名前と形・Module 宛ての返事を人にも知らせるか
  （受信箱）・呼んだ Module の後ろにいる Thread（大元の会話）にも知らせるか・ホップ数を Module の連鎖でどう数えるか
- **採らなかった案**：Module どうしで MCP の Tasks を使う——Module どうしなら使えるが、Thread への返事は CLI が
  Tasks を名乗らないので使えず、仕組みが2つに分かれる（上の「Module から呼ぶとき」）
