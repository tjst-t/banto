# Phase 0 本実装（`banto/`）の進捗記録・引き継ぎ（2026-09-05時点）

**このメモの目的**：セッションをまたいでも、CLAUDE.md→このメモを読めば
「どこまで進んだか・次に何をやるか」に追いつけるようにする。決定そのものは
既存の`docs/specs/*.md`に書いてある通り——ここは進捗と、実装中に見つかった
不具合・その場での判断だけを追う（`mock/README.md`のモック版に相当するものの、
本実装＝`banto/`向け）。

## 位置づけ

CLAUDE.mdの3段（PoC→モック→本実装）のうち、**Project／Thread／Fork／Memory／
文脈使用量の観測については、すでに「3. 本実装」に入っている**——モックの型
（Canvas・設定面・承認ゲート等）に乗るとPhase 1で確認できた部分から、
実バックエンド（`banto/packages/core`）・実フロントエンド（`banto/apps/frontend`、
`mock/`のコピー＋実データ配線）・E2E（`banto/e2e`、Playwright）を実際に組んで
実測している。**Module GUI・設定画面（Module/Vault/Role/Credential/Runtime既定）
はまだモックのまま**——`banto/apps/frontend/lib/feature-flags.ts`の
`CONNECTED_FEATURES`が「どこが実データに繋がっているか」の唯一の真実（規則3）。
そこがfalseのものは、まだモックの型のまま先に進んでいないという意味。

## 進め方（多セッション前提、段を飛ばさない）

Project/Thread close・reopen（A8）、文脈使用量（F2/F3）、Memory（G1〜G3・G5）、
判断待ちの一元化・滞留通知（A6/A7）の4つを順に配線する計画で進めている。
各Stageは実ブラウザで確認できてから次へ進む（規則13）。

| Stage | 内容 | 状態 |
|---|---|---|
| 0 | 繋がっていないUIを`CONNECTED_FEATURES`で隠す（mock由来の全機能が対象） | **完了** |
| 1 | Thread/ProjectのA8（close/reopen） | **完了** |
| 2 | 文脈使用量の永続化と表示（F2/F3） | **完了** |
| 3 | Memory（G1〜G3・G5） | **完了** |
| 3.5 | **system promptをbanto自前に**（§2.3）＋その過程で出た **Memoryの持ち主をProjectへ**・**Global Memory新設**・**Fork のセッション分岐**（2026-09-05に追加） | **完了** |
| 4 | 判断待ちの一元化・滞留通知（A6/A7） | 受信箱は完了。残りは `docs/tasks.json` |

Phase 0の完了条件（`docs/requirements.md`）は「F2の観測が実際に走り、文脈サイズと
圧縮の発火回数を数値で返す」＋「判断待ちが1画面に出る」。

- **文脈サイズ**：Stage 2で満たした（実測で数値が返る）
- **圧縮の発火回数**：`compactionCount`は記録しているが、**実測16ターンすべて0**
  ——1M contextなので自動コンパクションが一度も起きていない。**機構が動いた
  実績が無い**ので、意図的に長い会話で1回発火させて数える（`docs/tasks.json`）
- **判断待ちが1画面に出る**：**満たした**（2026-09-05、受信箱を実データに接続。
  E2E `inbox.spec.ts`）

## Phase 0 の残り

**一覧は `docs/tasks.json` に移した**（決定・2026-09-05）。残りを知りたければ
そこだけを見る——ここに写しを置くと、いつか片方だけ古くなる（規則3）。

このノートが持つのは**経緯**（なぜそうしたか・踏んだ罠）で、
**いま何が残っているか**は tasks.json が持つ、という分担にした。

### Stage 3.5でやったこと（2026-09-05、詳細は別ノート）

`docs/notes/2026-09-05-system-prompt-and-memory-ownership.md` に経緯がある。要点：

- **`claude_code`プリセットをやめ、coreがsystem promptを全文組み立てる**（§2.3）
  ——System prompt 3,515→2,605トークン、**SDK側の記憶（`Memory files` 155）が消えた**
- **Memoryが一度もsystem promptに入っていなかった**（記録もUIもあるのにRunnerへ
  渡す経路が無かった）——今回の層3で解消
- **Memoryの持ち主をProjectへ**（仕様どおりに実装を直した）。走行中に別の枝で
  増えた分は**ターンに添えて届ける**（§2.3、`<banto-turn-context>`）
- **Global Memory新設**（当初`Instance Memory`、同日改名）。Phase 0では人が書くだけ
- **Fork Threadが親と同じSDKセッションで走っていた**——`forkSession`で分岐する
  よう修正（ユーザー報告起点）
- スナップショットに**版**を入れた（形が変わったら読まずにログから作り直す）

### 受信箱を実データに繋いだときに見つけたこと（2026-09-05）

- **5秒ごとのポーリングが、判断待ち中のThreadを壊した**——
  `Duplicate key toolCallId-… in useResources`（assistant-uiのランタイムが、
  tool呼び出し待ちの最中の再描画でresourceを二重登録する）。**間隔を10分に
  延ばすと再現しなくなる**ことで、再描画が引き金だと確かめた。
  → **定期ポーリングをやめ、出来事で取り直す**形にした（起動時・判断待ちの
  発生時・答えた時・受信箱を開いた時）。判断待ちは必ずこのブラウザが
  走らせているターンから生まれるので取りこぼさない

  > **【訂正・2026-09-06】この診断は間違っていた。** ポーリングは引き金の一つを
  > 引いていただけで、原因ではない。ポーリングを消したあとも、承認するたびに
  > 同じ `Duplicate key toolCallId-…` で落ちる（ユーザー報告）。
  > 真因と直し方は
  > `docs/notes/2026-09-06-duplicate-toolcallid-on-approval.md` に書いた。
  > 「間隔を延ばしたら再現しなくなった」は**再現しにくくなっただけ**で、
  > 犯人の証明にはなっていなかった（規則1——測る前に犯人を決めない）。
  > 出来事で取り直す形自体は正しいので、そのまま残す。
- **「答えるとバッジが0になる」では見られない**——答えた直後にAIがターンを
  続けて別の判断待ちを出しうる（実測）。E2Eは**その判断待ちのidがhost側で
  決着したか**で見る
- **同じ文言がThread側のカードにも出る**ので、E2Eの一覧の検証は
  受信箱ダイアログの中に限定して引く（規則14の具体化）
- 受信箱の行から遷移するとき、**Linkと`onOpenChange(false)`の二重push**で
  シートが開いたままになった。開閉はURL（`?overlay=inbox`）が持っているので、
  遷移だけに任せる（機構を1つに保つ）

### Stage 4 の設計メモ（何をどう作るか。やること一覧は `docs/tasks.json`）

- **F1しきい値検知**：`turn-runner.ts`でターン終了後、直近の`usage`列を見て
  「contextUsageの割合が閾値を超えた状態がKターン続いている」を判定、
  `raiseJudgment({threadId, source:"alarm", ...})`。答えは次のターンの
  promptに前置きしてThreadへ返す
- **滞留判定＋通知送出**：`InboxStore.listOpen()`のうち`createdAt`から閾値超えの
  ものを定期チェック、`judgment.notified`イベント追加。フロントは
  `showBrowserNotification`の呼び出し元を作る
- **スコープ外**：A6のFactory由来の判断待ち（Factory自体が未実装、Phase 2）。
  本物のWeb Push（Service Worker）も——ブラウザNotification APIに縮小し、
  タブが開いている間だけ（ユーザー確認済み）

## Stage 0〜3で実際にやったこと（要点）

- **`CONNECTED_FEATURES`**（`banto/apps/frontend/lib/feature-flags.ts`）を新設。
  実装本体は消さず、入口だけをフラグでガードする方式。値そのものが現在の
  接続状況の一次情報——このファイルを読めば今何が実データに繋がっているか分かる
- **A8**：`packages/core/src/http/app.ts`に4ルート追加
  （`/api/threads/:id/close`・`/reopen`、`/api/projects/:id/close`・`/reopen`）。
  フロントは`closeProject`/`reopenProject`等で real/mock分岐（Clearと同じ形、
  ローカルに楽観コピーを持たず取り直す）
- **F2/F3**：`fold.ts`に`usage.recorded`イベント（`contextUsage`は`unknown`のまま
  保存、規則12）、`ThreadState.usage: UsageEntry[]`。`ContextUsageMeter`が
  `thread.real`なら`thread.usage`最新値を表示。ターン完了直後にローカル即時反映
  ＋リロード時は永続化値から復元
  - **踏んだ罠**：`getContextUsage()`の実際の戻り値は`SDKContextUsage`
    （事前の想定）ではなく`SDKControlGetContextUsageResponse`（camelCase、
    `categories`に`kind`フィールドが無い）だった。生データをログ出力して
    確認してから直した——型定義だけで判断せず実測する（規則1）
- **Memory（G1〜G3・G5）**：`POST /api/threads/:id/memory`（追記、文字数上限超えは
  400）・`.../memory/:seq/invalidate`（無効化）。`createSdkMcpServer`＋`tool()`
  （SDK標準機能、独自の中継シムは不要）で`remember_decision` toolをRunnerに
  常時アタッチ。フロントはProject設定に「Memory」セクションを新設
  - **副産物の修正**：Project設定の入口（gearアイコン）がinstance設定
    （`/settings`、全部mock）と同じ`CONNECTED_FEATURES.settings`に相乗りして
    いたため、Stage 1で実装済みのProject終了/再開が到達不能になっていた。
    新設の`projectSettings`フラグで入口を分離し、まだ未接続の
    project-modules/overrides/securityはnavから個別に隠した

## Stage 3のあとに見つけた3段重ねの不具合（2026-09-05、ユーザー報告起点）

「AIにMemory関係のツールが見えていない」の調査から、独立した3つの原因が
連鎖して出た。**全て修正・実機確認済み**（隔離ホストで再現→修正→再確認、
実daemon（port 4737）も再起動して反映済み）。

1. **`remember_decision`が見えない**——SDKの既定でMCP toolはtool searchの
   裏に遅延ロードされる。1toolだけのserverで、systemPromptの一文だけでは
   検索が誘発されず、agentから恒常的に見えなかった。
   `createSdkMcpServer({..., alwaysLoad: true})`で解決（`memory-tool.ts`）。
   **filesystem/shell/vaultは同じ遅延ロードのままで正しい**——実タスクが
   あればagentが自発的に検索して発見・呼び出すことを実機確認済み（deferする
   設計は妥当、直す必要は無い）
2. **cwdが一度もProjectに渡っていなかった**——`RunThreadTurnInput.cwd`は
   フィールドとして存在したが、`app.ts`の`/api/threads/:id/messages`ハンドラが
   一度も値を設定していなかった。Runnerのセッションcwdはhostプロセス自身の
   起動時cwdのまま——`claude_code`プリセットのsystemPromptがこれを元に
   環境情報を組み立てるため、AIが見ている作業ディレクトリの認識がProjectと
   食い違っていた（Shell/FileSystem Module自体はLandlockでProject rootに
   正しく閉じ込められているので、境界を越えて読めていたわけではない——
   Runner本体の認識だけがズレていた）。`app.ts`で`cwd: normalizeProjectRoot(project.root)`
   を渡すよう修正
3. **`~/`のような未展開のrootがイベントログに残っていた**——`store.ts`の
   `normalizeProjectRoot`（`~`展開・絶対パス検証・`realpathSync`）は
   **Project作成時にしか通らない**。このロジックが入る前（2026-09-04より前）に
   作られたProjectのイベントは、生文字列（`"~/"`）のまま今も残っている。
   修正②でこの生文字列がそのままspawnのcwdに渡り、存在しないディレクトリで
   ネイティブバイナリの起動が失敗——ユーザーが実際に踏んだエラー
   （`Claude Code native binary ... failed to launch`、glibc/musl絡みの
   診断文だが実際の原因はcwdが存在しないディレクトリだったこと）。
   `app.ts`側でも`normalizeProjectRoot`を防御的に通すよう修正、失敗時は
   プロセスを巻き込まずSSEの`error`イベントとして返す
   （`res.writeHead`は既にSSEヘッダを送信済みなので、失敗時に`json(res,500,...)`
   は使えないことに注意——`res.write`でTurnStreamEvent形式のerrorを書く）

**教訓として持ち越すべきこと**：`normalizeProjectRoot`は「作成時に1回だけ
正規化すれば以降は全経路が正規化済み文字列だけを見る」という設計
（store.tsのコメント）だったが、**コードの前後関係（正規化ロジックが後から
追加された）でこの前提から外れたデータが実際に残った**。真実は一箇所という
前提そのものは正しいが、「過去のイベントは前提を満たさないことがある」を
考慮に入れる必要がある場面が今後も出うる——rootを実ファイルシステムパスとして
使う経路（cwd・`BANTO_PROJECT_ROOT`環境変数でのModule起動）は、読み出し側でも
防御的に正規化するのが安全側。

## 検証の型（次のセッションでも同じ形を使う）

**実daemon（port 4737、ユーザーの本物のデータ）を直接実験台にしない。**
隔離ホストで再現・確認してから、必要なら実daemonを再起動して反映する：

```bash
mkdir -p /tmp/banto-verify-data /tmp/banto-verify-config-dir
cat > /tmp/banto-verify-config-dir/config.json <<'EOF'
{ "dataDir": "/tmp/banto-verify-data", "port": 4739, "authToken": "verify-token-xxx" }
EOF
cd banto/packages/core
BANTO_CONFIG_PATH=/tmp/banto-verify-config-dir/config.json nohup node dist/cli.js > /tmp/banto-verify-host.log 2>&1 &
# ... curl や Playwright で確認 ...
kill <pid>; rm -rf /tmp/banto-verify-data /tmp/banto-verify-config-dir /tmp/banto-verify-host.log
```

**実daemonの再起動**（systemd管理外、`kill -9`＋`nohup`）：

```bash
ps aux | grep "cli.js" | grep -v grep   # port 4737のPIDを確認（lsofで裏取り）
kill -9 <pid>
cd banto/packages/core && nohup node dist/cli.js > ~/banto-host.log 2>&1 & disown
curl -s http://127.0.0.1:4737/healthz
```

データはイベントログに永続化されているので消えない。ただし**ユーザーの実際の
会話に影響する**（進行中のターンがあれば中断）ので、再起動前に必ず確認を取る。

## 既知の間欠（直していない、規則6により記録のみ）

`e2e/specs/project-thread-fork.spec.ts`・`thread-lifecycle.spec.ts`・
`context-usage.spec.ts`が、スイート一括実行時にたまに最初のアシスタント応答
待ちで60秒タイムアウトする。**単独実行では毎回成功**——実API呼び出しの
レイテンシに起因すると見られ、Stage 0〜3のどの変更とも無関係（各修正の前後で
同じ発生パターンを確認した）。待ちを延ばす・リトライを足す対処はしていない。

### 訂正（2026-09-05、原因を特定して直した）

**上の「実APIのレイテンシに起因すると見られ」は誤りだった。** 間欠でもなく、
**製品の不具合でもなかった**——**テスト側の待ち条件の穴**だった。直した。

> **`await expect(page.getByText(/Base Thread —/)).toBeVisible()` は、
> 別の Project の Base Thread にも一致する。**

一括実行では先行 spec が作った Project が既に表示されているので、この待ちは
**新しい Project への遷移を待たずに即座に通る**。その状態で composer に入力すると
**前の Project の composer に打ち込むことになり**、直後に新 Project へ遷移して
入力ごと消える。だから「送信した形跡が core に無い」。

**まさに規則14 が言っている型の穴**（「操作が通った」だけでは見たことにならない
——画面が提示している中身まで見る）。直前に Fork の履歴で同じ失敗をして規則14 を
足したのに、**同じ穴が別の場所に残っていた**。

切り分けの記録（この結論に至るまでに測ったこと）：

- スイート一括実行 **4回中4回**、`project-thread-fork` と `thread-lifecycle` が
  同じ形で失敗（「たまに」ではない）。単独では毎回通る（7〜11秒）
- **3 Project 目で必ず落ちる**。順序や、先行 spec が AI ターンを含むかは無関係
- **core 側のログにターンの痕跡が無い**——`POST /api/threads/:id/messages` 自体が
  届いていない。ここで「フロントで送信が落ちている」と分かった
- ブラウザのコンソールに計器を入れて確定：入力の1.5秒後に
  **ThreadRuntime が別の threadId で mount し直されていた**（前の Project の
  Base Thread → 新 Project の Base Thread）。入力値はその瞬間に消えていた
- 2026-09-05 の system prompt 置き換えが原因ではないことも確認済み
  （`instanceMemory: false` に戻しても同じように落ちた）

**直した内容**：`project-thread-fork` / `thread-lifecycle` / `context-usage` /
`memory` の待ちを、**Project 名まで含む完全一致**（`Base Thread — E2E Test Project`）
に変えた。**待ちを延ばす・リトライを足す対処はしていない**（規則6）。

**教訓**：`getByText(/… —/)` のような「画面の型」で待つと、**同じ型の別のものに
一致して素通りする**。E2E の待ちは、その操作で**新しく出るはずの中身**
（名前・件数・値）で待つ。

## 次のセッションが最初に見るべきもの

1. **`docs/tasks.json`**——いま何が残っているか・順序・依存はここが唯一の一覧
2. このファイル（なぜそうしたか・踏んだ罠）
3. `banto/apps/frontend/lib/feature-flags.ts`（今どこが実データに繋がっているかの一次情報）
4. `docs/specs/v4-architecture.md` §10（まだ決まっていないこと一覧）
