# tool 呼び出し・承認まわりの全体見直し（2026-09-06）

ユーザーの「tool call の周りの実装がだいぶ怪しくないか」という指摘を受けて、
4つの観点（フロントの状態機械／host の承認機構／実際に起きうる筋書き／
仕様との突き合わせとテストの穴）で見直した。主要な指摘は、報告を鵜呑みにせず
コードで裏を取っている（規則1）。

## 根っこは1つ

**「判断待ちが、答えられないまま終わる」という状態が設計に無い。**

その証拠に、`JudgmentLiveness` は `live | answered | timed_out` の3状態を持ち
`timeoutJudgment()` も fold も書いてあるのに、**本番コードから一度も呼ばれない**
（呼び出しは `inbox/store.test.ts` だけ）。だから：

- 答えられなかった判断待ちは永久に `live`
- `canUseTool` の Promise は永久に未解決、`query()` の子プロセスも残る
- 毎ターンの turn-context に死んだ問い合わせが注入され続ける
- host を再起動すると「答えても何も起きない」幽霊カードになる

以下の個別の穴は、ほとんどがこの一点から派生している。

## 確実に壊れるもの（コードで裏を取った）

### 1. ターンの生死が「このブラウザが読んでいるか」でしか分からない

`live.done` は SSE の `done`/`error` を**自分で読んだときだけ**立つ
（`lib/backend/adapter.ts:289,294`）。`run()` に `finally` が無いので、

- 「停止」を押した（`abortController.abort()` → ランタイムが break）
- パネルがアンマウントされた（Fork を畳む・別 Project へ移る・
  デスクトップで Canvas を開くと Base が SpineTab に置き換わる）
- SSE が切れた／`reader.read()` が投げた

のいずれでも `done` は false のまま残る。その Thread は：

- `hasLiveRealRun()` が永久に true → リロード復元が抑止され、
  **生きている判断待ちのカードが二度と出ない**（受信箱に答える口は無い）
- 次の送信で `!live || live.done` が偽 → **新しいターンを起こさない**。
  閉じた iterator を読んで即座に抜け、**前のターンの parts をそのまま
  新しいメッセージに yield する**（＝プロンプトが host に届かないまま消え、
  同じ toolCallId が2つのメッセージに並ぶ）

### 2. 判断待ち中に composer から送信できる

assistant-ui の `isRunning` は「最後のメッセージが running」でしか true に
ならないので、`requires-action` の間は **Send が押せる**。押すと上の 1 の経路に
入り、加えて同じ SSE を2つの run が食い合う。

### 3. permissionMode は host に保存されるが、ターン実行が読んでいない

`turn-runner.ts:114` は `input.permissionMode`（＝HTTPボディ）、
`runner/adapter.ts:157` は `opts.permissionMode ?? "auto"`。
`thread.permissionMode` を読む箇所は**存在しない**（grep 済み）。

つまり「選んだ値は host が持つ」（§6.4、2026-09-06 の改訂）は**半分だけ**で、
効くのは依然ブラウザの申告値。とくに **Fork Thread は host 側に値を持たないので
毎回 `auto` に戻る**——親で `default` にして承認ゲートを効かせていた人が、
fork した瞬間に自動承認で走らせることになる。安全側に倒れない既定への転落＝規則2。

### 4. 「答えられない承認」に 200 を返す

`app.ts:354` は `pendingApprovals.resolve()` の**戻り値を捨てている**。
存在しない id でも、既に answered でも、解決先が無くても 200 `{ok:true}`。
しかも `answerJudgment`（＝受信箱から消える）を**先に**実行する。
フロントはそれを成功と解釈して「回答：許可する」を出す。

host 再起動後・二重回答・Elicitation の3経路すべてでこれを踏む。

### 5. エラー経路だけ、今日直した穴が残っている

`adapter.ts:291` の error 分岐だけ `status: { type: "running" }` を固定で
yield している。判断待ちが未回答のままエラーが来ると、カードが「回答済み」化して
答える口が消える（2026-09-06 に直したのと同じ形）。

### 6. 走行中に Clear すると、黙って取り消される

`thread.cleared` で `resumePoint` が消えるが、走行中のターンは終了時に
`updateResumePoint(sessionId)` を**無条件に**追記する（`turn-runner.ts:184-186`）
ので復活する。画面には Clear の横線だけ残り、次のターンは畳む前の文脈を引き継ぐ
——「畳んだのに畳まれていない」という、いちばん気づきにくい嘘。

### 7. Elicitation の判断待ちは、答えても届かない

vault の `requestAlias` は `elicitInput()` を呼び、全 Thread に繋がっている
（`cli.ts`）。しかし `turn-runner.ts:153-162` は elicitation を
`pendingApprovals.register` せず（approval は登録する）、UI は承認と**同じ**
「許可する／拒否する」カードを出す。答えると受信箱からは消え「回答：許可する」と
表示されるが、**答えはどこにも届かず** Module 側は60秒でタイムアウトする。
`mode` / `requestedSchema` / `url` / 3値（accept/decline/cancel）も未使用。規則13違反。

### 8. `syncRestoredThread` が実質6秒で諦める

リロード後に承認したとき、続きは「メッセージ件数が2秒×3回変わらなければ打ち切り」
で取りに行っている。host が assistant メッセージを追記するのは**ターン終了時**
なので、承認後の処理が6秒を超える普通のターンでは**続きが永久に画面へ入らない**。
既存の `judgment-after-reload.spec.ts` はこの窓に依存して通っている＝間欠の素地（規則6）。

## 仕様との食い違い（規則8）

- **「受信箱に答える UI を作らない（§2.4 の決定）」という文言が仕様に無い。**
  `real-inbox-list.tsx` がそう引用しているが、grep すると specs には存在せず、
  §2.4.1 はむしろ「**受信箱・ライブカードのどちらから答えても**、元の tool 呼び出しを
  直接解決できる」と書いている。今日の「誰も答えられない」の直接原因がここ。
  どちらに寄せるか決めて**仕様を更新する**（notes だけにしない）
- **`canUseTool` の `options.toolUseID` を捨てている**（`runner/adapter.ts:160`）。
  SDK が本物の tool_use id を渡してくるのに `approval-N` を合成しているため、
  §2.4.1 が「本実装で詰める」とした tool_use_id 紐付けが**構造的に不可能**。
  `timed_out` の検知（結果の到着で判定）もこれ待ち。`approval-N` は毎ターン1から
  振り直されるので、Thread 内でも衝突する（いま読む側がいないので実害は無い）
- **承認カードに tool の引数が出ていない。** `PendingToolApproval.input` は手元に
  あるのに捨てており、判断待ちの本文は tool 名だけ。`runCommand` を、
  どんなコマンドか見ないまま許可することになる（§6.0 の「呼ぶ前に見せる」に反する）
- **判断待ちに「どのサーバが聞いているか」が出ていない**（§2.4.1 の MUST）。
  `serverName` は Runner で拾っているが SSE に載せていない
- **`bypassPermissions` の確認ダイアログの文言が仕様と逆。**
  「Module 間の呼び出しの確認も出ません」と書いているが、§6.4 は
  「中継の承認ゲートは permissionMode に関わらず常に初回確認する」と決めている

## テストの穴（規則14）

- `inbox.spec.ts` の最終検証「回答：許可する」は、**クライアントのローカル state
  だけで出る**（`human-tool-card.tsx:77-78` の `answeredHere`）。host から1バイトも
  返らなくても緑になる——**幽霊承認を素通りする**
- **拒否（deny）の経路が一度も通っていない**（specs 全体で "拒否" が 0 件）
- **承認する前に tool の引数が見えていること**を誰も見ていない
- host 側に**承認解決の単体テストがゼロ**（`/api/inbox/:id/answer` も
  `PendingApprovalRegistry` も `/permission-mode` もテストが無い）
- `permission-mode-and-two-approvals.spec.ts` の「host 側にも残っている」assert は
  `Array.isArray(inbox)` を見ているだけで**何も検証していない**（死んだ assert）

## その他（確度は低いが記録）

- `app.ts` の catch は SSE のヘッダ送出後でも `json(res, 500, …)` を呼ぶため、
  `ERR_HTTP_HEADERS_SENT` で **host プロセスが落ちうる**（1ターンの失敗が全 Project の
  道連れ＝規則2）。到達経路の頻度は未測
- `SnapshotProjection.save()` が本番から一度も呼ばれない。正しさは壊れないが、
  版管理・アトミック書き出しの機構が**動いていない**（起動時間はイベント数に比例）
- SSE に heartbeat が無い（hold-the-line 中は無通信。プロキシのアイドル切断に弱い）
- `/permission-mode` と `/answer` が値を検証していない（型の嘘が永続化しうる）
- リロード復元の並び順が新しい順で、会話の時系列と逆
- `lib/mock/palette.ts` が `CONNECTED_FEATURES.settings` を見ており、
  Project 設定が gear からは開くのに Command Palette からは出ない

## これからやること

`docs/tasks.json` に `review-*` として全件を起票した（2026-09-06）。
**順番に全部直す**（ユーザー決定・2026-09-06）。直すものは
**先に「壊した状態で落ちるテスト」を書いてから**直す。

---

## 直した結果（2026-09-06、全20件完了）

**根っこ（「答えられないまま終わる状態が設計に無い」）から順に埋めた。**

### ターンの生死（1件目・他の複数の症状の根）

`LiveTurn.done` を廃し「`liveTurns` に居る＝このブラウザが読んでいる」に一本化。
**途中で分かったこと：`run()` に `finally` を置くだけでは足りない**——判断待ちで
中断しているジェネレータは、捨てられても `return()` されないので finally に
到達しない（実測）。ThreadPanel の解体時に `releaseRealRun()` で明示的に手放す。
host のターンは hold-the-line で生かしたままにし、次に開いたとき復元で拾う。

### 「答えられないまま終わる」を、状態として持てるようにした

- **起動時に `expireOrphanedJudgments()`**——前のプロセスが抱えていた判断待ちを
  期限切れにする。`timed_out` へ遷移する経路が本番に初めて生えた
- **`/api/inbox/:id/answer` を4分岐に**——存在しない=404／決着済み=409／形が不正=400／
  解決先が無い=409(unresolvable)。**決着させる前に確かめる**ので、
  「答えた」という嘘の記録も残らない
- **答えても届かないものには答える口を出さない**（`answerable`）。
  Elicitation 由来がこれにあたる（規則13）

### 真実の場所を直した（規則3）

- **permissionMode**：解決順を「ボディ（このターンだけの上書き）＞ Thread に
  残した値」にし、**Fork は親の選択を引き継ぐ**。以前は fork した瞬間に
  `auto`（自動承認）へ戻っていた
- **走行中の Clear**：切り離したセッションを `abandonedSessions` に覚え、
  そのターンが終了時に同じ session id で戻ってきても復活させない

### 承認の材料を人に見せる（§6.0・§2.4.1 の MUST）

- `canUseTool` の `options.toolUseID`（本物の tool_use id）を使う
- 判断待ちに **tool の引数**と**発信元 Module 名**を載せ、カードに出す
- `bypassPermissions` の確認文言が仕様と逆だったのを直した

### 機構が動いていなかったもの

- **スナップショットの保存**——60秒ごと＋SIGTERM/SIGINT で保存する
  （実装してあるのに本番から一度も呼ばれていなかった）
- **SSE 送出後の例外**——500 を書きに行って `ERR_HTTP_HEADERS_SENT` で
  host ごと落ちる経路を塞ぎ、SSE の error として伝えて閉じる

### テストの穴（規則14）

- `inbox.spec.ts`：承認した tool の**結果の中身**（一意なファイル名）が
  画面に出るまで見る。「回答：許可する」はローカル state だけで出るので、
  以前は幽霊承認を素通りしていた
- `judgment-deny.spec.ts`（新規）：拒否→決着→ターンは正常終了→
  **ファイルの中身が画面にも記録にも出ない**まで
- `turn-lifecycle-abandoned.spec.ts`（新規）：判断待ちを残して別 Project へ
  移り、戻って答え、次も送れるところまで
- host 側の単体テスト5件（409/400/permissionMode の検証・起動時の期限切れ・
  走行中 Clear）

### 測った結果

**core 単体 59件・E2E 11 spec すべて通過。** 直したものはすべて
**先に「壊した状態で落ちるテスト」を書いてから**直している（規則1）。
稼働中のデーモン（4737）にも反映済み。

### やり残し（別タスクとして残す）

`turn-stream-reattach`（走行中の出力そのものへの再接続）と
`app-shell-shared-layout` は、この見直しの範囲を超える設計変更なので
`docs/tasks.json` に残した。
