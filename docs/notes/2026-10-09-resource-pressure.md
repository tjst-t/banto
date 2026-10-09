# 2026-10-09 資源の逼迫：Module が止まった本当の原因と、段1の頭

Fork「資源の逼迫」（2026-10-08〜）。ユーザーの問題提起：「Project の中で並列に処理しすぎると資源が逼迫して Module が死ぬ。
可視化して、逼迫したら共倒れせずに交通整理したい」。大筋（組に分ける→守る→交通整理の3段）は Memory にある。

## 段0：原因を確かめた（ユーザーが host のログを書き出した）

### カーネルの OOM（`journalctl -k`、9/25 以降 21 件）

- 10/2 に資源の上限を入れる前（9/29〜10/1）：host 全体のメモリが尽き（global_oom）、chrome-headless・開発サーバ
  （banto-demo-web・banto-mock）・docker の node などが止められた
- 上限を入れた後（10/5〜10/8）：banto 開発の Project の中で 13 件。**11 件は E2E の入れ子のコンテナが自分の上限に当たり、
  中の node（MainThread、350〜500MB）が止められたもの**（試験用の Module で本番ではない）、2 件は Fable のレビューの
  わざとの試し（banto-review-oom）
- **本番の Module・サブエージェントが OOM で止められた記録は 0 件**

### banto の記録（`~/banto-host.log`、時刻なし 335 行）

Module が「止まりました」74 回：

| 理由 | 回数 | 起き方 |
|---|---|---|
| ping に 2 回続けて答えなかった | 30 | 同じ瞬間に、その Project の shell・service・filesystem・subagent が全部そろって |
| 接続が閉じた | 44 | 数本〜十数本まとめて。直前に「コンテナが使えない：Shutting down」「区画を引くのに失敗」——incusd が止まった |

ping の時間切れの直後には「Received a response for an unknown message ID」（中身 `{}`＝遅れて届いた ping の返事）が、
**コンテナの外の banto 本体で動く Module（vault-local・skills・publish-caddy・subagent-settings 等）にも同時に**出ていた。
コンテナの中が混んでいただけなら外の Module には出ない。

**読み**：Module は答えていた。banto 本体（host のプロセス）の event loop が止まり、再開したとき期限の来た
時間切れのタイマーが溜まった返事より先に回って、遅れた返事を捨てていた。

### 再現（2026-10-09、本物の MCP の stdio）

小さな MCP サーバを子プロセスで起こし、本物の `Client.ping` を送った直後（setImmediate）に本体を 3 秒止める、を3回：

- 直す前：`ping に 2 回続けて答えませんでした（MCP error -32001: Request timed out）`＋「unknown message ID」2 件——本番と同じ形
- 直した後：落とさない。「本体が止まっていたので数えません」が3回（止まり 2750〜2999ms／待った 3000ms）

（同期で止める・20ms 後のタイマーで止める形では、返事が時間切れより先に読まれて再現しなかった。止まる位置で順番が変わる）

## 段1の頭で入れたもの（ユーザー「その形で進めて」）

- `packages/core/src/host-stall.ts`：250ms ごとのタイマーの遅れを止まりとして残す（100ms 未満は揺れとして捨てる、10分覚える、
  1 秒以上はログ「本体が N 秒止まっていました」）
- `modules/liveness.ts`：ping が失敗したら setImmediate で同じ回のタイマーを回し切ってから、送ってから失敗までの時間から
  本体の止まりを引き、残りが上限（10 秒）に満たなければ数えずにすぐもう一度送る。止まりが 0 のすぐの失敗（接続の異常）は今どおり数える
- `host-health.ts`：`GET /api/admin/host-health`（本体の止まり・`/proc/pressure/*`・MemAvailable）。資源の画面が読む予定
- `~/banto-host.log` の行の頭に ISO 8601 の時刻（console.log・info・warn・error を包む）

## 分からないまま残ったこと

- banto 本体が止まった理由（本体の中の重い同期処理か、host の CPU の詰まりで順番が回らなかったか）。時刻が付いたので、
  次に起きたら「本体が N 秒止まっていました」の時刻と、そのときの `/api/admin/host-health` の pressure で切り分ける
- 記録に時刻が無かったので、10/5 のメモリの直し（状態の写し 121MB→6MB、同期の JSON 化が軽くなった）の前か後かは分からない

## 段1の残り（2026-10-09、ユーザー「この形でよい」、モック dc5f55c3）

- `packages/core/src/resources.ts`：host が `/sys/fs/cgroup/lxc.payload.<区画>_<コンテナ名>` を直接読む（incus exec を通さない）。
  10 秒ごと（E2E は `BANTO_RESOURCES_INTERVAL_MS=2000`）。上限に当たった知らせ（`container-pressure.ts`）の数えもこの読み方に替えた
- 内訳：`.lxc` のプロセスを `/proc` の親子でたどる（Module のサーバ・サブエージェント・Module の子のコマンド）、`app.slice` の
  `banto-shell-*`＝コマンド・`banto-<名前>`＝Service、`lxc.payload.*`＝入れ子のコンテナ、`system.slice`＝その他。
  この Project のコンテナ（`/sys/fs/cgroup` が根に見える）で実物を読み、Module 239MB・Service 1.3GB（mock の dev サーバ2本）・
  入れ子 33MB・その他 446MB と、コンテナの anon 2.1GB とほぼ合うのを確かめた
- 混んでいるかの仮の区切り：メモリの some avg10 ≥ 10%、CPU の full avg10 ≥ 10%、使っている量が上限の 90% 以上（この機械は
  MemAvailable < 1 GiB も）。段3で実物を見て決め直す
- 口：`GET /api/admin/resources`、`/api/events` の hello の `resources` と `resources.busy`（変わったときだけ）
- E2E `resources.spec.ts`：上限を 1 GiB にして中でメモリを 95% まで掴むと、サイドバーに印・行が「混んでいる」・理由
  「メモリが上限の 96% に達しています」、放すと印が消える
